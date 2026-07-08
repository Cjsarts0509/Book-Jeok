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

const router = express.Router();

// 업로드 허용 확장자: 엑셀 계열 + 이미지 + 문서 + 프레젠테이션
const ALLOWED_EXT = new Set([
  'csv', 'xls', 'xlsx', 'xlsm', 'xlsb',   // 엑셀에서 만들어지는 확장자
  'jpg', 'jpeg', 'png', 'gif',            // 이미지
  'ppt', 'pptx',                          // 프레젠테이션
  'doc', 'docx',                          // 문서
]);
const ALLOWED_LABEL = 'csv, xls, xlsx, jpg, jpeg, png, gif, ppt, pptx, doc, docx';

function extOf(name) {
  return (name.split('.').pop() || '').toLowerCase();
}

function userDir(ownerId) {
  return path.join(config.storageRoot, String(ownerId));
}

function normalizeFolder(input) {
  let f = String(input || '/').replace(/\\/g, '/');
  if (!f.startsWith('/')) f = '/' + f;
  const parts = f.split('/').filter((p) => p && p !== '.' && p !== '..');
  return '/' + parts.join('/');
}

// 폴더 및 모든 상위 폴더를 folders 테이블에 보장
async function ensureFolder(ownerId, folder) {
  if (!folder || folder === '/') return;
  const parts = folder.split('/').filter(Boolean);
  let acc = '';
  for (const p of parts) {
    acc += '/' + p;
    await query(
      'INSERT INTO folders (owner_id, path) VALUES ($1, $2) ON CONFLICT (owner_id, path) DO NOTHING',
      [ownerId, acc]
    );
  }
}

// 지점_날짜 자동분류: "xxx점_yyyymmdd..." → /yyyy/xxx점
function smartFolderFor(originalName) {
  const base = originalName.replace(/\.[^.]+$/, '');
  const m = base.match(/^(.+?점)_(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  const branch = m[1].replace(/\//g, '');
  const year = m[2];
  return `/${year}/${branch}`;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = userDir(req.targetOwnerId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: { fileSize: parseInt(process.env.MAX_UPLOAD_BYTES || String(2 * 1024 * 1024 * 1024), 10) },
  fileFilter: (req, file, cb) => {
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
    if (!ALLOWED_EXT.has(extOf(name))) {
      return cb(Object.assign(new Error(`허용되지 않는 파일 형식입니다. 가능: ${ALLOWED_LABEL}`), { status: 415 }));
    }
    cb(null, true);
  },
});

// 접근 대상 owner 결정 (권한 규칙 적용)
async function resolveOwner(req, res, next) {
  const requested = req.query.ownerId || req.body.ownerId;
  if (requested && Number(requested) !== req.user.id) {
    const ok = await canAccessOwner(req.user, requested);
    if (!ok) return res.status(403).json({ error: '해당 계정의 파일에 접근할 수 없습니다.' });
    req.targetOwnerId = Number(requested);
  } else {
    req.targetOwnerId = req.user.id;
  }
  next();
}

function fileRow(r) {
  return {
    id: r.id,
    name: r.original_name,
    folder: r.folder,
    size: Number(r.size_bytes),
    mime: r.mime_type,
    note: r.note || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    noteUpdatedAt: r.note_updated_at,
  };
}

// ── 접근 가능한 계정 목록 (admin/manager 전용) ──────────
router.get('/accounts', authenticate, wrap(async (req, res) => {
  if (req.user.role === 'admin') {
    const r = await query('SELECT id, username, display_name, role FROM users ORDER BY role DESC, username');
    return res.json({ accounts: r.rows.map((u) => ({ id: u.id, username: u.username, displayName: u.display_name, role: u.role })) });
  }
  if (req.user.role === 'manager') {
    const r = await query("SELECT id, username, display_name, role FROM users WHERE role = 'user' ORDER BY username");
    return res.json({ accounts: r.rows.map((u) => ({ id: u.id, username: u.username, displayName: u.display_name, role: u.role })) });
  }
  res.json({ accounts: [] });
}));

// ── 폴더 트리 ──────────────────────────────
router.get('/tree', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const [fromFolders, fromFiles] = await Promise.all([
    query('SELECT path FROM folders WHERE owner_id = $1', [req.targetOwnerId]),
    query('SELECT DISTINCT folder AS path FROM files WHERE owner_id = $1 AND folder <> $2', [req.targetOwnerId, '/']),
  ]);
  const set = new Set();
  for (const row of [...fromFolders.rows, ...fromFiles.rows]) {
    // 각 경로의 모든 상위 경로까지 포함
    const parts = row.path.split('/').filter(Boolean);
    let acc = '';
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

// 폴더 삭제 (하위 폴더 및 파일 포함)
router.delete('/folders', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const folder = normalizeFolder(req.query.path || req.body.path);
  if (folder === '/') return res.status(400).json({ error: '루트 폴더는 삭제할 수 없습니다.' });
  const like = folder + '/%';
  // 삭제 대상 파일들의 디스크 파일 제거
  const files = await query(
    'SELECT owner_id, stored_name FROM files WHERE owner_id = $1 AND (folder = $2 OR folder LIKE $3)',
    [req.targetOwnerId, folder, like]
  );
  await query('DELETE FROM files WHERE owner_id = $1 AND (folder = $2 OR folder LIKE $3)', [req.targetOwnerId, folder, like]);
  await query('DELETE FROM folders WHERE owner_id = $1 AND (path = $2 OR path LIKE $3)', [req.targetOwnerId, folder, like]);
  await Promise.all(files.rows.map((f) => fsp.unlink(path.join(userDir(f.owner_id), f.stored_name)).catch(() => {})));
  await audit(req, 'delete_folder', `owner=${req.targetOwnerId} ${folder} files=${files.rowCount}`);
  res.json({ ok: true });
}));

// 폴더 이름변경/이동 (경로 접두사 치환)
router.patch('/folders', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const oldPath = normalizeFolder(req.body.oldPath);
  const newPath = normalizeFolder(req.body.newPath);
  if (oldPath === '/' || newPath === '/') return res.status(400).json({ error: '유효한 경로가 아닙니다.' });
  const oldLike = oldPath + '/%';
  // 하위 폴더/파일 경로 치환
  await query(
    `UPDATE folders SET path = $4 || substring(path from ${'$5'}) WHERE owner_id = $1 AND (path = $2 OR path LIKE $3)`,
    [req.targetOwnerId, oldPath, oldLike, newPath, String(oldPath.length + 1)]
  );
  await query(
    `UPDATE files SET folder = $4 || substring(folder from ${'$5'}), updated_at = now() WHERE owner_id = $1 AND (folder = $2 OR folder LIKE $3)`,
    [req.targetOwnerId, oldPath, oldLike, newPath, String(oldPath.length + 1)]
  );
  await ensureFolder(req.targetOwnerId, newPath);
  await audit(req, 'rename_folder', `owner=${req.targetOwnerId} ${oldPath} -> ${newPath}`);
  res.json({ ok: true });
}));

// ── 파일 목록 ──────────────────────────────
router.get('/', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const folder = normalizeFolder(req.query.folder);
  const result = await query(
    `SELECT id, folder, original_name, size_bytes, mime_type, note, created_at, updated_at, note_updated_at
     FROM files WHERE owner_id = $1 AND folder = $2 ORDER BY original_name`,
    [req.targetOwnerId, folder]
  );
  // 직속 하위 폴더
  const prefix = folder === '/' ? '/' : folder + '/';
  const tree = await query(
    `SELECT path FROM folders WHERE owner_id = $1 AND path LIKE $2
     UNION SELECT DISTINCT folder FROM files WHERE owner_id = $1 AND folder LIKE $2`,
    [req.targetOwnerId, prefix + '%']
  );
  const folders = new Set();
  for (const row of tree.rows) {
    const rest = row.path.slice(prefix.length);
    if (rest) folders.add(prefix + rest.split('/')[0]);
  }
  res.json({
    folder,
    ownerId: req.targetOwnerId,
    folders: [...folders].sort(),
    files: result.rows.map(fileRow),
  });
}));

// ── 업로드 (확장자 검증 + 지점_날짜 자동분류) ──────────
router.post('/upload', authenticate, wrap(resolveOwner), upload.array('file', 30), wrap(async (req, res) => {
  const baseFolder = normalizeFolder(req.body.folder);
  const autoSort = String(req.body.autoSort || '') === '1' || req.body.autoSort === true;
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: '업로드할 파일이 없습니다.' });

  // 할당량
  const owner = await query('SELECT quota_bytes FROM users WHERE id = $1', [req.targetOwnerId]);
  const quota = Number(owner.rows[0].quota_bytes);
  if (quota > 0) {
    const used = await query('SELECT COALESCE(SUM(size_bytes),0) AS s FROM files WHERE owner_id = $1', [req.targetOwnerId]);
    const incoming = req.files.reduce((sum, f) => sum + f.size, 0);
    if (Number(used.rows[0].s) + incoming > quota) {
      await Promise.all(req.files.map((f) => fsp.unlink(f.path).catch(() => {})));
      return res.status(413).json({ error: '저장 용량 할당량을 초과했습니다.' });
    }
  }

  const saved = [];
  for (const f of req.files) {
    const originalName = Buffer.from(f.originalname, 'latin1').toString('utf8');
    let folder = baseFolder;
    let sorted = false;
    if (autoSort) {
      const smart = smartFolderFor(originalName);
      if (smart) { folder = smart; sorted = true; }
    }
    await ensureFolder(req.targetOwnerId, folder);
    const row = await query(
      `INSERT INTO files (owner_id, folder, original_name, stored_name, size_bytes, mime_type)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [req.targetOwnerId, folder, originalName, path.basename(f.path), f.size, f.mimetype]
    );
    saved.push({ id: row.rows[0].id, name: originalName, size: f.size, folder, sorted });
  }
  await audit(req, 'upload', `owner=${req.targetOwnerId} count=${saved.length} autoSort=${autoSort}`);
  res.status(201).json({ uploaded: saved });
}));

// ── 다운로드 ──────────────────────────────
router.get('/:id(\\d+)/download', authenticate, wrap(async (req, res) => {
  const result = await query('SELECT * FROM files WHERE id = $1', [req.params.id]);
  const file = result.rows[0];
  if (!file) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  if (!(await canAccessOwner(req.user, file.owner_id))) return res.status(403).json({ error: '접근 권한이 없습니다.' });
  const diskPath = path.join(userDir(file.owner_id), file.stored_name);
  if (!fs.existsSync(diskPath)) return res.status(410).json({ error: '파일 실체가 존재하지 않습니다.' });
  await audit(req, 'download', `file=${file.id}`);
  res.download(diskPath, file.original_name);
}));

// ── 비고 수정 ──────────────────────────────
router.patch('/:id(\\d+)/note', authenticate, wrap(async (req, res) => {
  const note = String(req.body.note ?? '').slice(0, 2000);
  const result = await query('SELECT owner_id FROM files WHERE id = $1', [req.params.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  if (!(await canAccessOwner(req.user, result.rows[0].owner_id))) return res.status(403).json({ error: '권한이 없습니다.' });
  await query('UPDATE files SET note = $1, note_updated_at = now(), updated_at = now() WHERE id = $2', [note, req.params.id]);
  await audit(req, 'update_note', `file=${req.params.id}`);
  res.json({ ok: true, noteUpdatedAt: new Date().toISOString() });
}));

// ── 이름변경 ──────────────────────────────
router.patch('/:id(\\d+)/rename', authenticate, wrap(async (req, res) => {
  const newName = String(req.body.name || '').trim().replace(/[/\\]/g, '');
  if (!newName) return res.status(400).json({ error: '이름을 입력하세요.' });
  const result = await query('SELECT owner_id, original_name FROM files WHERE id = $1', [req.params.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  if (!(await canAccessOwner(req.user, result.rows[0].owner_id))) return res.status(403).json({ error: '권한이 없습니다.' });
  // 확장자 보존/검증
  if (!ALLOWED_EXT.has(extOf(newName))) {
    return res.status(415).json({ error: `허용되지 않는 확장자입니다. 가능: ${ALLOWED_LABEL}` });
  }
  await query('UPDATE files SET original_name = $1, updated_at = now() WHERE id = $2', [newName, req.params.id]);
  await audit(req, 'rename', `file=${req.params.id} -> ${newName}`);
  res.json({ ok: true });
}));

// ── 단일 삭제 ──────────────────────────────
router.delete('/:id(\\d+)', authenticate, wrap(async (req, res) => {
  const result = await query('SELECT * FROM files WHERE id = $1', [req.params.id]);
  const file = result.rows[0];
  if (!file) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  if (!(await canAccessOwner(req.user, file.owner_id))) return res.status(403).json({ error: '삭제 권한이 없습니다.' });
  await query('DELETE FROM files WHERE id = $1', [file.id]);
  await fsp.unlink(path.join(userDir(file.owner_id), file.stored_name)).catch(() => {});
  await audit(req, 'delete', `file=${file.id}`);
  res.json({ ok: true });
}));

// 선택 파일들에 대한 권한 확인 후 반환
async function loadAccessibleFiles(user, ids) {
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter(Boolean);
  if (list.length === 0) return [];
  const result = await query('SELECT * FROM files WHERE id = ANY($1::bigint[])', [list]);
  const out = [];
  for (const f of result.rows) {
    if (await canAccessOwner(user, f.owner_id)) out.push(f);
  }
  return out;
}

// ── 일괄 삭제 ──────────────────────────────
router.post('/bulk/delete', authenticate, wrap(async (req, res) => {
  const files = await loadAccessibleFiles(req.user, req.body.ids);
  if (files.length === 0) return res.status(400).json({ error: '삭제할 항목이 없습니다.' });
  await query('DELETE FROM files WHERE id = ANY($1::bigint[])', [files.map((f) => f.id)]);
  await Promise.all(files.map((f) => fsp.unlink(path.join(userDir(f.owner_id), f.stored_name)).catch(() => {})));
  await audit(req, 'bulk_delete', `count=${files.length}`);
  res.json({ ok: true, deleted: files.length });
}));

// ── 일괄 폴더 이동 ─────────────────────────
router.post('/bulk/move', authenticate, wrap(async (req, res) => {
  const folder = normalizeFolder(req.body.folder);
  const files = await loadAccessibleFiles(req.user, req.body.ids);
  if (files.length === 0) return res.status(400).json({ error: '이동할 항목이 없습니다.' });
  // 파일별 소유자 스코프 내에서 폴더 보장
  const owners = [...new Set(files.map((f) => f.owner_id))];
  await Promise.all(owners.map((o) => ensureFolder(o, folder)));
  await query('UPDATE files SET folder = $1, updated_at = now() WHERE id = ANY($2::bigint[])', [folder, files.map((f) => f.id)]);
  await audit(req, 'bulk_move', `count=${files.length} -> ${folder}`);
  res.json({ ok: true, moved: files.length });
}));

// ── 공유 링크 생성 (난수 토큰) ─────────────
router.post('/:id(\\d+)/share', authenticate, wrap(async (req, res) => {
  const result = await query('SELECT owner_id, original_name FROM files WHERE id = $1', [req.params.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  if (!(await canAccessOwner(req.user, result.rows[0].owner_id))) return res.status(403).json({ error: '권한이 없습니다.' });

  const days = parseInt(req.body.expiresInDays || '0', 10);
  const expiresAt = days > 0 ? new Date(Date.now() + days * 86400000) : null;
  const token = generateToken(24);
  await query(
    'INSERT INTO share_links (file_id, token, created_by, expires_at) VALUES ($1, $2, $3, $4)',
    [req.params.id, token, req.user.id, expiresAt]
  );
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const base = config.publicApiUrl || `${proto}://${req.headers.host}`;
  await audit(req, 'create_share', `file=${req.params.id}`);
  res.status(201).json({
    token,
    url: `${base}/api/share/${token}`,
    fileName: result.rows[0].original_name,
    expiresAt,
  });
}));

// ── 사용량 요약 ────────────────────────────
router.get('/usage/summary', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const r = await query('SELECT COUNT(*)::int AS files, COALESCE(SUM(size_bytes),0) AS bytes FROM files WHERE owner_id = $1', [req.targetOwnerId]);
  const q = await query('SELECT quota_bytes FROM users WHERE id = $1', [req.targetOwnerId]);
  res.json({
    ownerId: req.targetOwnerId,
    fileCount: r.rows[0].files,
    usedBytes: Number(r.rows[0].bytes),
    quotaBytes: Number(q.rows[0].quota_bytes),
  });
}));

module.exports = router;
