'use strict';

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const config = require('../config');
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');
const { audit, wrap, canAccessOwner } = require('../util');
const { generateToken } = require('../crypto');
const { isAllowed, allowedLabel, getAllowedExtensions } = require('../settings');

const router = express.Router();

const extOf = (name) => (name.split('.').pop() || '').toLowerCase();
const userDir = (ownerId) => path.join(config.storageRoot, String(ownerId));

function normalizeFolder(input) {
  let f = String(input || '/').replace(/\\/g, '/');
  if (!f.startsWith('/')) f = '/' + f;
  const parts = f.split('/').filter((p) => p && p !== '.' && p !== '..');
  return '/' + parts.join('/');
}

async function ensureFolder(ownerId, folder) {
  if (!folder || folder === '/') return;
  const parts = folder.split('/').filter(Boolean);
  let acc = '';
  for (const p of parts) {
    acc += '/' + p;
    await query(
      `INSERT INTO folders (owner_id, path) VALUES ($1, $2)
       ON CONFLICT (owner_id, path) DO UPDATE SET deleted_at = NULL`,
      [ownerId, acc]
    );
  }
}

// 폴더/파일 이름 충돌 시 " (n)" 붙여 유니크한 이름 생성
async function uniqueFileName(ownerId, folder, name) {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = name, n = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const r = await query(
      'SELECT 1 FROM files WHERE owner_id=$1 AND folder=$2 AND original_name=$3 AND deleted_at IS NULL',
      [ownerId, folder, candidate]
    );
    if (r.rowCount === 0) return candidate;
    n++; candidate = `${base} (${n})${ext}`;
  }
}
async function uniqueFolderPath(ownerId, wantedPath) {
  const parent = wantedPath.slice(0, wantedPath.lastIndexOf('/')) || '';
  const name = wantedPath.split('/').pop();
  let candidate = wantedPath, n = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const r = await query(
      'SELECT 1 FROM folders WHERE owner_id=$1 AND path=$2 AND deleted_at IS NULL',
      [ownerId, candidate]
    );
    if (r.rowCount === 0) return candidate;
    n++; candidate = `${parent}/${name} (${n})`;
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { const d = userDir(req.targetOwnerId); fs.mkdirSync(d, { recursive: true }); cb(null, d); },
    filename: (req, file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: { fileSize: parseInt(process.env.MAX_UPLOAD_BYTES || String(2 * 1024 * 1024 * 1024), 10) },
  fileFilter: (req, file, cb) => {
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
    if (!isAllowed(extOf(name))) return cb(Object.assign(new Error(`허용되지 않는 파일 형식입니다. 가능: ${allowedLabel()}`), { status: 415 }));
    cb(null, true);
  },
});

async function resolveOwner(req, res, next) {
  const requested = req.query.ownerId || req.body.ownerId;
  if (requested && Number(requested) !== req.user.id) {
    if (!(await canAccessOwner(req.user, requested))) return res.status(403).json({ error: '해당 계정의 파일에 접근할 수 없습니다.' });
    req.targetOwnerId = Number(requested);
  } else req.targetOwnerId = req.user.id;
  next();
}

const fileRow = (r) => ({
  id: r.id, name: r.original_name, folder: r.folder, size: Number(r.size_bytes),
  mime: r.mime_type, note: r.note || '', createdAt: r.created_at, updatedAt: r.updated_at, noteUpdatedAt: r.note_updated_at,
});

// ── 접근 가능한 계정 목록 ──────────
router.get('/accounts', authenticate, wrap(async (req, res) => {
  if (req.user.role === 'admin') {
    const r = await query('SELECT id, username, display_name, role FROM users ORDER BY role DESC, username');
    return res.json({ accounts: r.rows.map((u) => ({ id: u.id, username: u.username, displayName: u.display_name, role: u.role })) });
  }
  if (req.user.role === 'manager') {
    const r = await query("SELECT id, username, display_name, role FROM users WHERE role='user' ORDER BY username");
    return res.json({ accounts: r.rows.map((u) => ({ id: u.id, username: u.username, displayName: u.display_name, role: u.role })) });
  }
  res.json({ accounts: [] });
}));

// ── 폴더 트리 ──────────
router.get('/tree', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const [ff, fx] = await Promise.all([
    query('SELECT path FROM folders WHERE owner_id=$1 AND deleted_at IS NULL', [req.targetOwnerId]),
    query('SELECT DISTINCT folder AS path FROM files WHERE owner_id=$1 AND folder<>$2 AND deleted_at IS NULL', [req.targetOwnerId, '/']),
  ]);
  const set = new Set();
  for (const row of [...ff.rows, ...fx.rows]) {
    const parts = row.path.split('/').filter(Boolean); let acc = '';
    for (const p of parts) { acc += '/' + p; set.add(acc); }
  }
  res.json({ ownerId: req.targetOwnerId, folders: [...set].sort() });
}));

// 폴더 생성
router.post('/folders', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const folder = normalizeFolder(req.body.path);
  if (folder === '/') return res.status(400).json({ error: '유효한 폴더 경로가 아닙니다.' });
  await ensureFolder(req.targetOwnerId, folder);
  await audit(req, 'create_folder', `owner=${req.targetOwnerId} ${folder}`);
  res.status(201).json({ ok: true, path: folder });
}));

// 폴더 비고
router.patch('/folders/note', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const folder = normalizeFolder(req.body.path);
  const note = String(req.body.note ?? '').slice(0, 2000);
  await ensureFolder(req.targetOwnerId, folder);
  await query('UPDATE folders SET note=$1, note_updated_at=now() WHERE owner_id=$2 AND path=$3', [note, req.targetOwnerId, folder]);
  await audit(req, 'folder_note', `${folder}`);
  res.json({ ok: true });
}));

// 폴더 이름변경/이동 (경로 접두사 치환) — 충돌 시 자동 번호
router.patch('/folders', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const oldPath = normalizeFolder(req.body.oldPath);
  let newPath = normalizeFolder(req.body.newPath);
  if (oldPath === '/' || newPath === '/') return res.status(400).json({ error: '유효한 경로가 아닙니다.' });
  if (oldPath === newPath) return res.json({ ok: true, path: newPath });
  newPath = await uniqueFolderPath(req.targetOwnerId, newPath);
  const oldLike = oldPath + '/%';
  const cut = String(oldPath.length + 1);
  await ensureFolder(req.targetOwnerId, newPath.slice(0, newPath.lastIndexOf('/')) || '/');
  await query(
    `UPDATE folders SET path = $4 || substring(path from $5::int) WHERE owner_id=$1 AND deleted_at IS NULL AND (path=$2 OR path LIKE $3)`,
    [req.targetOwnerId, oldPath, oldLike, newPath, cut]
  );
  await query(
    `UPDATE files SET folder = $4 || substring(folder from $5::int), updated_at=now() WHERE owner_id=$1 AND deleted_at IS NULL AND (folder=$2 OR folder LIKE $3)`,
    [req.targetOwnerId, oldPath, oldLike, newPath, cut]
  );
  await audit(req, 'rename_folder', `${oldPath} -> ${newPath}`);
  res.json({ ok: true, path: newPath });
}));

// 폴더 삭제 (소프트) — 폴더 + 하위 파일 휴지통으로
router.delete('/folders', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const folder = normalizeFolder(req.query.path || req.body.path);
  if (folder === '/') return res.status(400).json({ error: '루트 폴더는 삭제할 수 없습니다.' });
  const like = folder + '/%';
  await query('UPDATE folders SET deleted_at=now() WHERE owner_id=$1 AND deleted_at IS NULL AND (path=$2 OR path LIKE $3)', [req.targetOwnerId, folder, like]);
  await query('UPDATE files SET deleted_at=now(), deleted_with_folder=$4 WHERE owner_id=$1 AND deleted_at IS NULL AND (folder=$2 OR folder LIKE $3)', [req.targetOwnerId, folder, like, folder]);
  await audit(req, 'trash_folder', `${folder}`);
  res.json({ ok: true });
}));

// ── 파일 목록 (+직속 폴더 객체) ──────────
router.get('/', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const folder = normalizeFolder(req.query.folder);
  const files = await query(
    `SELECT id, folder, original_name, size_bytes, mime_type, note, created_at, updated_at, note_updated_at
     FROM files WHERE owner_id=$1 AND folder=$2 AND deleted_at IS NULL ORDER BY original_name`,
    [req.targetOwnerId, folder]
  );
  const prefix = folder === '/' ? '/' : folder + '/';
  // 직속 하위 폴더 경로 수집 (folders 테이블 + 파일 경로)
  const rows = await query(
    `SELECT path FROM folders WHERE owner_id=$1 AND deleted_at IS NULL AND path LIKE $2
     UNION SELECT DISTINCT folder FROM files WHERE owner_id=$1 AND deleted_at IS NULL AND folder LIKE $2`,
    [req.targetOwnerId, prefix + '%']
  );
  const childPaths = new Set();
  for (const r of rows.rows) { const rest = r.path.slice(prefix.length); if (rest) childPaths.add(prefix + rest.split('/')[0]); }
  // 각 폴더가 folders 테이블에 존재하도록 백필 후 note/id/크기/등록일 조회
  const folders = [];
  for (const p of [...childPaths].sort()) {
    await query('INSERT INTO folders (owner_id, path) VALUES ($1,$2) ON CONFLICT (owner_id, path) DO NOTHING', [req.targetOwnerId, p]);
    const fr = await query('SELECT id, note, note_updated_at, created_at FROM folders WHERE owner_id=$1 AND path=$2', [req.targetOwnerId, p]);
    const agg = await query(
      'SELECT COALESCE(SUM(size_bytes),0) AS s, COUNT(*)::int AS c FROM files WHERE owner_id=$1 AND deleted_at IS NULL AND (folder=$2 OR folder LIKE $3)',
      [req.targetOwnerId, p, p + '/%']
    );
    folders.push({
      id: fr.rows[0]?.id, path: p, name: p.split('/').pop(),
      note: fr.rows[0]?.note || '', noteUpdatedAt: fr.rows[0]?.note_updated_at || null,
      createdAt: fr.rows[0]?.created_at || null,
      size: Number(agg.rows[0].s), fileCount: agg.rows[0].c,
    });
  }
  res.json({ folder, ownerId: req.targetOwnerId, folders, files: files.rows.map(fileRow) });
}));

// ── 업로드 ──────────
router.post('/upload', authenticate, wrap(resolveOwner), upload.array('file', 30), wrap(async (req, res) => {
  const folder = normalizeFolder(req.body.folder);
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: '업로드할 파일이 없습니다.' });
  const owner = await query('SELECT quota_bytes, role FROM users WHERE id=$1', [req.targetOwnerId]);
  // 관리자는 무제한, 그 외는 할당량 적용(0=미할당이므로 업로드 불가)
  if (owner.rows[0].role !== 'admin') {
    const quota = Number(owner.rows[0].quota_bytes);
    const used = await query('SELECT COALESCE(SUM(size_bytes),0) AS s FROM files WHERE owner_id=$1 AND deleted_at IS NULL', [req.targetOwnerId]);
    const incoming = req.files.reduce((s, f) => s + f.size, 0);
    if (Number(used.rows[0].s) + incoming > quota) {
      await Promise.all(req.files.map((f) => fsp.unlink(f.path).catch(() => {})));
      const msg = quota === 0 ? '디스크가 할당되지 않은 계정입니다. 관리자에게 문의하세요.' : '저장 용량 할당량을 초과했습니다.';
      return res.status(413).json({ error: msg });
    }
  }
  await ensureFolder(req.targetOwnerId, folder);
  const saved = [];
  for (const f of req.files) {
    const originalName = Buffer.from(f.originalname, 'latin1').toString('utf8');
    const name = await uniqueFileName(req.targetOwnerId, folder, originalName);
    const row = await query(
      `INSERT INTO files (owner_id, folder, original_name, stored_name, size_bytes, mime_type)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [req.targetOwnerId, folder, name, path.basename(f.path), f.size, f.mimetype]
    );
    saved.push({ id: row.rows[0].id, name, size: f.size, folder });
  }
  await audit(req, 'upload', `owner=${req.targetOwnerId} count=${saved.length}`);
  res.status(201).json({ uploaded: saved });
}));

// 허용 확장자 조회 (로그인 사용자)
router.get('/allowed-extensions', authenticate, wrap(async (req, res) => {
  res.json({ extensions: getAllowedExtensions() });
}));

// ── 다운로드 ──────────
router.get('/:id(\\d+)/download', authenticate, wrap(async (req, res) => {
  const r = await query('SELECT * FROM files WHERE id=$1 AND deleted_at IS NULL', [req.params.id]);
  const file = r.rows[0];
  if (!file) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  if (!(await canAccessOwner(req.user, file.owner_id))) return res.status(403).json({ error: '접근 권한이 없습니다.' });
  const disk = path.join(userDir(file.owner_id), file.stored_name);
  if (!fs.existsSync(disk)) return res.status(410).json({ error: '파일 실체가 존재하지 않습니다.' });
  await audit(req, 'download', `file=${file.id}`);
  res.download(disk, file.original_name);
}));

// ── 비고 ──────────
router.patch('/:id(\\d+)/note', authenticate, wrap(async (req, res) => {
  const note = String(req.body.note ?? '').slice(0, 2000);
  const r = await query('SELECT owner_id FROM files WHERE id=$1 AND deleted_at IS NULL', [req.params.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  if (!(await canAccessOwner(req.user, r.rows[0].owner_id))) return res.status(403).json({ error: '권한이 없습니다.' });
  await query('UPDATE files SET note=$1, note_updated_at=now(), updated_at=now() WHERE id=$2', [note, req.params.id]);
  await audit(req, 'update_note', `file=${req.params.id}`);
  res.json({ ok: true });
}));

// ── 이름변경 ──────────
router.patch('/:id(\\d+)/rename', authenticate, wrap(async (req, res) => {
  const newName = String(req.body.name || '').trim().replace(/[/\\]/g, '');
  if (!newName) return res.status(400).json({ error: '이름을 입력하세요.' });
  const r = await query('SELECT owner_id, folder FROM files WHERE id=$1 AND deleted_at IS NULL', [req.params.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  if (!(await canAccessOwner(req.user, r.rows[0].owner_id))) return res.status(403).json({ error: '권한이 없습니다.' });
  if (!isAllowed(extOf(newName))) return res.status(415).json({ error: `허용되지 않는 확장자입니다. 가능: ${allowedLabel()}` });
  const unique = await uniqueFileName(r.rows[0].owner_id, r.rows[0].folder, newName);
  await query('UPDATE files SET original_name=$1, updated_at=now() WHERE id=$2', [unique, req.params.id]);
  await audit(req, 'rename', `file=${req.params.id} -> ${unique}`);
  res.json({ ok: true, name: unique });
}));

// ── 단일 삭제 (소프트) ──────────
router.delete('/:id(\\d+)', authenticate, wrap(async (req, res) => {
  const r = await query('SELECT * FROM files WHERE id=$1 AND deleted_at IS NULL', [req.params.id]);
  const file = r.rows[0];
  if (!file) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  if (!(await canAccessOwner(req.user, file.owner_id))) return res.status(403).json({ error: '삭제 권한이 없습니다.' });
  await query('UPDATE files SET deleted_at=now(), deleted_with_folder=NULL WHERE id=$1', [file.id]);
  await audit(req, 'trash_file', `file=${file.id}`);
  res.json({ ok: true });
}));

async function loadAccessibleFiles(user, ids) {
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter(Boolean);
  if (list.length === 0) return [];
  const r = await query('SELECT * FROM files WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL', [list]);
  const out = [];
  for (const f of r.rows) if (await canAccessOwner(user, f.owner_id)) out.push(f);
  return out;
}

// ── 일괄 삭제 (소프트) ──────────
router.post('/bulk/delete', authenticate, wrap(async (req, res) => {
  const files = await loadAccessibleFiles(req.user, req.body.ids);
  if (files.length === 0) return res.status(400).json({ error: '삭제할 항목이 없습니다.' });
  await query('UPDATE files SET deleted_at=now(), deleted_with_folder=NULL WHERE id = ANY($1::bigint[])', [files.map((f) => f.id)]);
  await audit(req, 'bulk_trash', `count=${files.length}`);
  res.json({ ok: true, deleted: files.length });
}));

// ── 일괄 이동 ──────────
router.post('/bulk/move', authenticate, wrap(async (req, res) => {
  const folder = normalizeFolder(req.body.folder);
  const files = await loadAccessibleFiles(req.user, req.body.ids);
  if (files.length === 0) return res.status(400).json({ error: '이동할 항목이 없습니다.' });
  const owners = [...new Set(files.map((f) => f.owner_id))];
  await Promise.all(owners.map((o) => ensureFolder(o, folder)));
  for (const f of files) {
    const name = await uniqueFileName(f.owner_id, folder, f.original_name);
    await query('UPDATE files SET folder=$1, original_name=$2, updated_at=now() WHERE id=$3', [folder, name, f.id]);
  }
  await audit(req, 'bulk_move', `count=${files.length} -> ${folder}`);
  res.json({ ok: true, moved: files.length });
}));

// ── 공유 링크 ──────────
router.post('/:id(\\d+)/share', authenticate, wrap(async (req, res) => {
  const r = await query('SELECT owner_id, original_name FROM files WHERE id=$1 AND deleted_at IS NULL', [req.params.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  if (!(await canAccessOwner(req.user, r.rows[0].owner_id))) return res.status(403).json({ error: '권한이 없습니다.' });
  const days = parseInt(req.body.expiresInDays || '0', 10);
  const expiresAt = days > 0 ? new Date(Date.now() + days * 86400000) : null;
  const token = generateToken(24);
  await query('INSERT INTO share_links (file_id, token, created_by, expires_at) VALUES ($1,$2,$3,$4)', [req.params.id, token, req.user.id, expiresAt]);
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const base = config.publicApiUrl || `${proto}://${req.headers.host}`;
  await audit(req, 'create_share', `file=${req.params.id}`);
  res.status(201).json({ token, url: `${base}/api/share/${token}`, fileName: r.rows[0].original_name, expiresAt });
}));

// ── 사용량 ──────────
router.get('/usage/summary', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const r = await query('SELECT COUNT(*)::int AS files, COALESCE(SUM(size_bytes),0) AS bytes FROM files WHERE owner_id=$1 AND deleted_at IS NULL', [req.targetOwnerId]);
  const q = await query('SELECT quota_bytes, role FROM users WHERE id=$1', [req.targetOwnerId]);
  res.json({
    ownerId: req.targetOwnerId, fileCount: r.rows[0].files, usedBytes: Number(r.rows[0].bytes),
    quotaBytes: Number(q.rows[0].quota_bytes), unlimited: q.rows[0].role === 'admin',
  });
}));

module.exports = router;
