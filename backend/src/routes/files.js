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
const { generateToken, hashPassword } = require('../crypto');
const filetype = require('../filetype');
const yara = require('../yara');
const notify = require('../notify');
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
    query('SELECT path, icon, color FROM folders WHERE owner_id=$1 AND deleted_at IS NULL', [req.targetOwnerId]),
    query('SELECT DISTINCT folder AS path FROM files WHERE owner_id=$1 AND folder<>$2 AND deleted_at IS NULL', [req.targetOwnerId, '/']),
  ]);
  const set = new Set();
  const styles = {};
  for (const row of [...ff.rows, ...fx.rows]) {
    const parts = row.path.split('/').filter(Boolean); let acc = '';
    for (const p of parts) { acc += '/' + p; set.add(acc); }
  }
  for (const row of ff.rows) { if (row.icon || row.color) styles[row.path] = { icon: row.icon || '', color: row.color || '' }; }
  res.json({ ownerId: req.targetOwnerId, folders: [...set].sort(), styles });
}));

// 폴더 생성 (선택: 아이콘/색상)
router.post('/folders', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const folder = normalizeFolder(req.body.path);
  if (folder === '/') return res.status(400).json({ error: '유효한 폴더 경로가 아닙니다.' });
  await ensureFolder(req.targetOwnerId, folder);
  const icon = String(req.body.icon || '').slice(0, 8);
  const color = String(req.body.color || '').slice(0, 16);
  if (icon || color) {
    await query('UPDATE folders SET icon=$1, color=$2 WHERE owner_id=$3 AND path=$4', [icon, color, req.targetOwnerId, folder]);
  }
  await audit(req, 'create_folder', `owner=${req.targetOwnerId} ${folder}`);
  res.status(201).json({ ok: true, path: folder });
}));

// 폴더 스타일(아이콘/색상) 설정
router.patch('/folders/style', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const folder = normalizeFolder(req.body.path);
  if (folder === '/') return res.status(400).json({ error: '루트 폴더는 변경할 수 없습니다.' });
  const icon = String(req.body.icon || '').slice(0, 8);
  const color = String(req.body.color || '').slice(0, 16);
  await ensureFolder(req.targetOwnerId, folder);
  await query('UPDATE folders SET icon=$1, color=$2 WHERE owner_id=$3 AND path=$4', [icon, color, req.targetOwnerId, folder]);
  await audit(req, 'folder_style', `${folder}`);
  res.json({ ok: true });
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
    const fr = await query('SELECT id, note, note_updated_at, created_at, icon, color FROM folders WHERE owner_id=$1 AND path=$2', [req.targetOwnerId, p]);
    const agg = await query(
      'SELECT COALESCE(SUM(size_bytes),0) AS s, COUNT(*)::int AS c FROM files WHERE owner_id=$1 AND deleted_at IS NULL AND (folder=$2 OR folder LIKE $3)',
      [req.targetOwnerId, p, p + '/%']
    );
    folders.push({
      id: fr.rows[0]?.id, path: p, name: p.split('/').pop(),
      note: fr.rows[0]?.note || '', noteUpdatedAt: fr.rows[0]?.note_updated_at || null,
      createdAt: fr.rows[0]?.created_at || null,
      icon: fr.rows[0]?.icon || '', color: fr.rows[0]?.color || '',
      size: Number(agg.rows[0].s), fileCount: agg.rows[0].c,
    });
  }
  res.json({ folder, ownerId: req.targetOwnerId, folders, files: files.rows.map(fileRow) });
}));

// ── 업로드 ──────────
router.post('/upload', authenticate, wrap(resolveOwner), upload.array('file', 30), wrap(async (req, res) => {
  const folder = normalizeFolder(req.body.folder);
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: '업로드할 파일이 없습니다.' });
  const owner = await query('SELECT quota_bytes, role, upload_conflict FROM users WHERE id=$1', [req.targetOwnerId]);
  const overwrite = owner.rows[0].upload_conflict === 'overwrite'; // 동일 이름: 덮어쓰기(이전 파일은 휴지통) vs 번호 붙이기
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
  const saved = []; const rejected = [];
  for (const f of req.files) {
    // 경로 구분자·제어문자 제거 (zip-slip/헤더 주입 방어)
    const originalName = Buffer.from(f.originalname, 'latin1').toString('utf8')
      .replace(/[/\\]/g, '_').replace(/[\x00-\x1f]/g, '').trim() || 'file';
    // 매직바이트 검증: 실행파일 위장·확장자-내용 불일치 차단 (데몬 불필요)
    const ft = await filetype.verify(f.path, originalName);
    if (!ft.ok) { await fsp.unlink(f.path).catch(() => {}); rejected.push({ name: originalName, reason: ft.reason }); await audit(req, 'file_blocked', `${originalName} (${ft.reason})`); continue; }
    // YARA 악성 패턴 검사(로컬, 오프라인). 매칭되면 저장하지 않고 삭제.
    const mal = await yara.scanFile(f.path);
    if (!mal.ok) { await fsp.unlink(f.path).catch(() => {}); rejected.push({ name: originalName, reason: `악성 패턴 감지(${mal.rule})` }); await audit(req, 'malware_blocked', `${originalName} (${mal.rule})`); continue; }
    let name;
    if (overwrite) {
      // 덮어쓰기: 같은 이름 기존 파일을 휴지통으로 보내고(30일 복원 가능) 원래 이름 유지
      await query('UPDATE files SET deleted_at=now() WHERE owner_id=$1 AND folder=$2 AND original_name=$3 AND deleted_at IS NULL', [req.targetOwnerId, folder, originalName]);
      name = originalName;
    } else {
      name = await uniqueFileName(req.targetOwnerId, folder, originalName);
    }
    const row = await query(
      `INSERT INTO files (owner_id, folder, original_name, stored_name, size_bytes, mime_type)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [req.targetOwnerId, folder, name, path.basename(f.path), f.size, f.mimetype]
    );
    saved.push({ id: row.rows[0].id, name, size: f.size, folder });
  }
  await audit(req, 'upload', `owner=${req.targetOwnerId} count=${saved.length}`);
  if (saved.length === 0 && rejected.length) return res.status(422).json({ error: `업로드가 차단되었습니다: ${rejected.map((r) => r.reason).join(', ')}`, rejected });
  res.status(201).json({ uploaded: saved, rejected });
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

// ── 압축(ZIP) 번들 ──────────
const BUNDLE_DIR = path.join(config.storageRoot, '_bundles');

async function collectBundleFiles(owner, ids, folders) {
  const rows = new Map(); // id -> row
  if (ids.length) {
    const r = await query('SELECT * FROM files WHERE owner_id=$1 AND deleted_at IS NULL AND id = ANY($2::bigint[])', [owner, ids]);
    r.rows.forEach((f) => rows.set(f.id, f));
  }
  for (const fp of folders) {
    if (fp === '/') continue;
    const r = await query('SELECT * FROM files WHERE owner_id=$1 AND deleted_at IS NULL AND (folder=$2 OR folder LIKE $3)', [owner, fp, fp + '/%']);
    r.rows.forEach((f) => rows.set(f.id, f));
  }
  return [...rows.values()];
}

function stamp14() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}
function sanitizeBaseName(name) {
  const s = String(name || '').trim().replace(/[/\\:*?"<>|]/g, '').slice(0, 80);
  return s || '북적북적';
}

// 오래된 번들 정리: 하루 지났고 유효한(만료 안 된) 공유가 없는 번들 삭제
async function cleanupBundles() {
  try {
    const r = await query(
      `SELECT id, stored_name FROM zip_bundles b
       WHERE b.created_at < now() - interval '1 day'
         AND NOT EXISTS (SELECT 1 FROM share_links s WHERE s.bundle_id = b.id AND (s.expires_at IS NULL OR s.expires_at > now()))`
    );
    for (const b of r.rows) {
      try { fs.unlinkSync(path.join(BUNDLE_DIR, b.stored_name)); } catch { /* noop */ }
      await query('DELETE FROM zip_bundles WHERE id=$1', [b.id]);
    }
  } catch { /* noop */ }
}

// 선택 항목을 압축해 번들로 임시 저장 → { bundleId, name, size }
router.post('/bulk/zip', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const owner = req.targetOwnerId;
  const base = normalizeFolder(req.body.folder || '/');
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Boolean);
  const folders = (Array.isArray(req.body.folders) ? req.body.folders : []).map(normalizeFolder);
  const files = await collectBundleFiles(owner, ids, folders);
  if (files.length === 0) return res.status(400).json({ error: '압축할 파일이 없습니다.' });

  let archiver;
  try { archiver = require('archiver'); }
  catch { return res.status(500).json({ error: '서버에 압축 모듈(archiver)이 설치되지 않았습니다. npm install 후 재시작하세요.' }); }

  // 파일명: (요청된)폴더명_YYYYMMDD_HHMMSS.zip
  const baseName = sanitizeBaseName(req.body.name || (base === '/' ? '북적북적' : base.split('/').filter(Boolean).pop()));
  const zipName = `${baseName}_${stamp14()}.zip`;

  fs.mkdirSync(BUNDLE_DIR, { recursive: true });
  const storedName = generateToken(16) + '.zip';
  const diskPath = path.join(BUNDLE_DIR, storedName);
  const stripBase = base === '/' ? '' : base;

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(diskPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    out.on('close', resolve);
    out.on('error', reject);
    archive.on('error', reject);
    archive.pipe(out);
    const seen = new Map(); // 엔트리명 중복 방지
    for (const f of files) {
      const disk = path.join(userDir(owner), f.stored_name);
      if (!fs.existsSync(disk)) continue;
      let relDir = f.folder.startsWith(stripBase) ? f.folder.slice(stripBase.length) : f.folder;
      relDir = relDir.replace(/^\//, '');
      let entry = (relDir ? relDir + '/' : '') + f.original_name;
      if (seen.has(entry)) {
        const n = seen.get(entry) + 1; seen.set(entry, n);
        const dot = entry.lastIndexOf('.');
        entry = dot > 0 ? `${entry.slice(0, dot)} (${n})${entry.slice(dot)}` : `${entry} (${n})`;
      } else seen.set(entry, 0);
      archive.file(disk, { name: entry });
    }
    archive.finalize();
  });

  const size = fs.statSync(diskPath).size;
  const ins = await query(
    'INSERT INTO zip_bundles (owner_id, stored_name, display_name, size_bytes, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [owner, storedName, zipName, size, req.user.id]
  );
  await audit(req, 'bulk_zip', `owner=${owner} count=${files.length} -> ${zipName}`);
  cleanupBundles(); // 비동기 정리(대기 안 함)
  res.status(201).json({ bundleId: ins.rows[0].id, name: zipName, size });
}));

async function loadBundleForUser(user, id) {
  const r = await query('SELECT * FROM zip_bundles WHERE id=$1', [id]);
  if (r.rowCount === 0) return null;
  const b = r.rows[0];
  if (!(await canAccessOwner(user, b.owner_id))) return 'forbidden';
  return b;
}

// 번들 다운로드 (내 기기로)
router.get('/bundle/:id(\\d+)/download', authenticate, wrap(async (req, res) => {
  const b = await loadBundleForUser(req.user, req.params.id);
  if (!b) return res.status(404).json({ error: '압축 파일을 찾을 수 없습니다.' });
  if (b === 'forbidden') return res.status(403).json({ error: '접근 권한이 없습니다.' });
  const diskPath = path.join(BUNDLE_DIR, b.stored_name);
  if (!fs.existsSync(diskPath)) return res.status(410).json({ error: '압축 파일이 만료되었습니다. 다시 시도해주세요.' });
  res.download(diskPath, b.display_name);
}));

// 번들 공유 링크 생성 (단일 공유와 동일 UX)
router.post('/bundle/:id(\\d+)/share', authenticate, wrap(async (req, res) => {
  const b = await loadBundleForUser(req.user, req.params.id);
  if (!b) return res.status(404).json({ error: '압축 파일을 찾을 수 없습니다.' });
  if (b === 'forbidden') return res.status(403).json({ error: '권한이 없습니다.' });
  const { passwordHash, maxDownloads, expiresAt, notifyInapp, notifyEmail } = await shareOptions(req);
  const token = generateToken(24);
  await query('INSERT INTO share_links (bundle_id, token, created_by, expires_at, password_hash, max_downloads, notify_inapp, notify_email) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [b.id, token, req.user.id, expiresAt, passwordHash, maxDownloads, notifyInapp, notifyEmail]);
  await audit(req, 'create_share', `bundle=${b.id}`);
  res.status(201).json({ token, url: `${shareWebBase(req)}/share.html?t=${token}`, fileName: b.display_name, expiresAt });
}));

// ── 이름 검색 (현재 계정 범위, 폴더/파일 제목 기준) ──────────
router.get('/search', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ query: '', folders: [], files: [] });
  const owner = req.targetOwnerId; const ql = q.toLowerCase();
  const fr = await query('SELECT id, path, note, note_updated_at, created_at, icon, color FROM folders WHERE owner_id=$1 AND deleted_at IS NULL', [owner]);
  const folders = fr.rows
    .filter((r) => (r.path.split('/').filter(Boolean).pop() || '').toLowerCase().includes(ql))
    .slice(0, 300)
    .map((r) => ({ id: r.id, path: r.path, name: r.path.split('/').filter(Boolean).pop() || r.path, note: r.note || '', noteUpdatedAt: r.note_updated_at, createdAt: r.created_at, icon: r.icon || '', color: r.color || '', size: 0 }));
  const like = '%' + q.replace(/[%_\\]/g, (c) => '\\' + c) + '%';
  const files = await query("SELECT * FROM files WHERE owner_id=$1 AND deleted_at IS NULL AND original_name ILIKE $2 ESCAPE '\\' ORDER BY original_name LIMIT 500", [owner, like]);
  res.json({ query: q, folders, files: files.rows.map(fileRow) });
}));

// ── 용량 리포트 (최상위 폴더별 집계) ──────────
router.get('/usage/report', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const owner = req.targetOwnerId;
  const tot = await query('SELECT COUNT(*)::int AS c, COALESCE(SUM(size_bytes),0) AS b FROM files WHERE owner_id=$1 AND deleted_at IS NULL', [owner]);
  const u = await query('SELECT quota_bytes, role FROM users WHERE id=$1', [owner]);
  const byTop = await query(
    `SELECT COALESCE(NULLIF(split_part(folder,'/',2),''),'(루트)') AS top, COUNT(*)::int AS c, COALESCE(SUM(size_bytes),0) AS b
     FROM files WHERE owner_id=$1 AND deleted_at IS NULL GROUP BY top ORDER BY b DESC LIMIT 100`, [owner]);
  const byFolder = await query(
    `SELECT folder, COUNT(*)::int AS c, COALESCE(SUM(size_bytes),0) AS b
     FROM files WHERE owner_id=$1 AND deleted_at IS NULL GROUP BY folder`, [owner]);
  res.json({
    ownerId: owner, fileCount: tot.rows[0].c, usedBytes: Number(tot.rows[0].b),
    quotaBytes: Number(u.rows[0].quota_bytes), unlimited: u.rows[0].role === 'admin',
    folders: byTop.rows.map((r) => ({ name: r.top, fileCount: r.c, bytes: Number(r.b) })),
    tree: byFolder.rows.map((r) => ({ folder: r.folder, used: Number(r.b), files: r.c })),
  });
}));

// ── 사용자 셀프 휴지통 (본인 것, 최근 30일) ──────────
const SELF_TRASH_MS = 30 * 86400000;
router.get('/trash', authenticate, wrap(async (req, res) => {
  const owner = req.user.id;
  const files = await query(
    `SELECT id, original_name AS name, folder, size_bytes, deleted_at FROM files
     WHERE owner_id=$1 AND deleted_at IS NOT NULL AND deleted_with_folder IS NULL AND deleted_at > now() - interval '30 days'
     ORDER BY deleted_at DESC`, [owner]);
  const folders = await query(
    `SELECT fo.id, fo.path, fo.deleted_at, (SELECT COUNT(*) FROM files x WHERE x.deleted_with_folder=fo.path AND x.owner_id=fo.owner_id) AS file_count
     FROM folders fo WHERE fo.owner_id=$1 AND fo.deleted_at IS NOT NULL AND fo.deleted_at > now() - interval '30 days'
     ORDER BY fo.deleted_at DESC`, [owner]);
  res.json({
    days: 30,
    files: files.rows.map((r) => ({ id: r.id, name: r.name, folder: r.folder, size: Number(r.size_bytes), deletedAt: r.deleted_at })),
    folders: folders.rows.map((r) => ({ id: r.id, path: r.path, name: r.path.split('/').filter(Boolean).pop() || r.path, fileCount: Number(r.file_count), deletedAt: r.deleted_at })),
  });
}));
router.post('/trash/file/:id(\\d+)/restore', authenticate, wrap(async (req, res) => {
  const r = await query("SELECT * FROM files WHERE id=$1 AND owner_id=$2 AND deleted_at IS NOT NULL AND deleted_at > now() - interval '30 days'", [req.params.id, req.user.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: '복원할 수 없습니다. (없거나 30일 초과)' });
  const f = r.rows[0];
  await ensureFolder(f.owner_id, f.folder);
  const name = await uniqueFileName(f.owner_id, f.folder, f.original_name);
  await query('UPDATE files SET deleted_at=NULL, deleted_with_folder=NULL, original_name=$1, updated_at=now() WHERE id=$2', [name, f.id]);
  await audit(req, 'self_restore_file', `file=${f.id}`);
  res.json({ ok: true, name, folder: f.folder });
}));
router.post('/trash/folder/:id(\\d+)/restore', authenticate, wrap(async (req, res) => {
  const r = await query("SELECT * FROM folders WHERE id=$1 AND owner_id=$2 AND deleted_at IS NOT NULL AND deleted_at > now() - interval '30 days'", [req.params.id, req.user.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: '복원할 수 없습니다. (없거나 30일 초과)' });
  const fo = r.rows[0];
  let newPath = fo.path;
  const dup = await query('SELECT 1 FROM folders WHERE owner_id=$1 AND path=$2 AND deleted_at IS NULL', [fo.owner_id, fo.path]);
  if (dup.rowCount > 0) {
    let n = 2; const parent = fo.path.slice(0, fo.path.lastIndexOf('/')) || ''; const base = fo.path.split('/').pop();
    // eslint-disable-next-line no-constant-condition
    while (true) { const c = `${parent}/${base} (${n})`; const e = await query('SELECT 1 FROM folders WHERE owner_id=$1 AND path=$2 AND deleted_at IS NULL', [fo.owner_id, c]); if (e.rowCount === 0) { newPath = c; break; } n++; }
  }
  await ensureFolder(fo.owner_id, newPath.slice(0, newPath.lastIndexOf('/')) || '/');
  const cut = String(fo.path.length + 1); const oldLike = fo.path + '/%';
  await query(`UPDATE folders SET deleted_at=NULL, path=$4 || substring(path from $5::int) WHERE owner_id=$1 AND deleted_at IS NOT NULL AND (path=$2 OR path LIKE $3)`, [fo.owner_id, fo.path, oldLike, newPath, cut]);
  await query(`UPDATE files SET deleted_at=NULL, deleted_with_folder=NULL, folder=$3 || substring(folder from $4::int), updated_at=now() WHERE owner_id=$1 AND deleted_with_folder=$2`, [fo.owner_id, fo.path, newPath, cut]);
  await audit(req, 'self_restore_folder', `${fo.path} -> ${newPath}`);
  res.json({ ok: true, path: newPath });
}));

// ── 공유 링크 ──────────
function shareWebBase(req) {
  const o = req.headers.origin; if (o) return o.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  return config.publicApiUrl || `${proto}://${req.headers.host}`;
}
async function shareOptions(req) {
  const password = String(req.body.password || '').trim();
  const passwordHash = password ? await hashPassword(password) : null;
  const mx = parseInt(req.body.maxDownloads, 10);
  const maxDownloads = (Number.isFinite(mx) && mx > 0) ? mx : null;
  const days = parseInt(req.body.expiresInDays || '0', 10);
  const expiresAt = days > 0 ? new Date(Date.now() + days * 86400000) : null;
  return { passwordHash, maxDownloads, expiresAt, notifyInapp: !!req.body.notifyInapp, notifyEmail: !!req.body.notifyEmail };
}
router.post('/:id(\\d+)/share', authenticate, wrap(async (req, res) => {
  const r = await query('SELECT owner_id, original_name FROM files WHERE id=$1 AND deleted_at IS NULL', [req.params.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  if (!(await canAccessOwner(req.user, r.rows[0].owner_id))) return res.status(403).json({ error: '권한이 없습니다.' });
  const { passwordHash, maxDownloads, expiresAt, notifyInapp, notifyEmail } = await shareOptions(req);
  const token = generateToken(24);
  await query('INSERT INTO share_links (file_id, token, created_by, expires_at, password_hash, max_downloads, notify_inapp, notify_email) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [req.params.id, token, req.user.id, expiresAt, passwordHash, maxDownloads, notifyInapp, notifyEmail]);
  await audit(req, 'create_share', `file=${req.params.id}`);
  res.status(201).json({ token, url: `${shareWebBase(req)}/share.html?t=${token}`, fileName: r.rows[0].original_name, expiresAt });
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

// ── 업로드 요청 링크 (소유자 관리) ──────────
router.post('/upload-requests', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const owner = req.targetOwnerId;
  const folder = normalizeFolder(req.body.folder);
  await ensureFolder(owner, folder);
  const label = String(req.body.label || '').slice(0, 100).trim() || (folder === '/' ? '홈' : folder.split('/').filter(Boolean).pop());
  const password = String(req.body.password || '').trim();
  const passwordHash = password ? await hashPassword(password) : null;
  const days = parseInt(req.body.expiresInDays || '0', 10);
  const expiresAt = days > 0 ? new Date(Date.now() + days * 86400000) : null;
  const mf = parseInt(req.body.maxFiles, 10); const maxFiles = (Number.isFinite(mf) && mf > 0) ? mf : null;
  const mgb = parseFloat(req.body.maxGb); const maxBytes = (Number.isFinite(mgb) && mgb > 0) ? Math.round(mgb * 1073741824) : null;
  const token = generateToken(24);
  const r = await query('INSERT INTO upload_requests (owner_id, folder, token, label, password_hash, max_files, max_bytes, expires_at, created_by, notify_inapp, notify_email) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id', [owner, folder, token, label, passwordHash, maxFiles, maxBytes, expiresAt, req.user.id, !!req.body.notifyInapp, !!req.body.notifyEmail]);
  await audit(req, 'create_upload_request', `owner=${owner} ${folder}`);
  res.status(201).json({ id: r.rows[0].id, token, url: `${shareWebBase(req)}/upload.html?t=${token}`, label });
}));
router.get('/upload-requests', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const r = await query('SELECT id, folder, token, label, password_hash IS NOT NULL AS has_password, max_files, max_bytes, uploaded_count, uploaded_bytes, disabled, expires_at, created_at FROM upload_requests WHERE owner_id=$1 ORDER BY created_at DESC', [req.targetOwnerId]);
  res.json({ requests: r.rows.map((x) => ({ id: x.id, folder: x.folder, label: x.label, token: x.token, hasPassword: x.has_password, maxFiles: x.max_files, maxBytes: x.max_bytes != null ? Number(x.max_bytes) : null, uploadedCount: x.uploaded_count, uploadedBytes: Number(x.uploaded_bytes), disabled: x.disabled, expiresAt: x.expires_at, createdAt: x.created_at })) });
}));
router.delete('/upload-requests/:id(\\d+)', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const r = await query('DELETE FROM upload_requests WHERE id=$1 AND owner_id=$2 RETURNING id', [req.params.id, req.targetOwnerId]);
  if (r.rowCount === 0) return res.status(404).json({ error: '요청을 찾을 수 없습니다.' });
  await audit(req, 'delete_upload_request', `id=${req.params.id}`);
  res.json({ ok: true });
}));

// ── 공유 링크 관리 (내가 만든 파일/압축 공유) ──────────
router.get('/shares', authenticate, wrap(async (req, res) => {
  const r = await query(
    `SELECT s.id, s.token, s.expires_at, s.password_hash IS NOT NULL AS has_pw, s.max_downloads, s.download_count, s.created_at,
            f.original_name AS file_name, b.display_name AS bundle_name
     FROM share_links s LEFT JOIN files f ON f.id=s.file_id LEFT JOIN zip_bundles b ON b.id=s.bundle_id
     WHERE s.created_by=$1 ORDER BY s.created_at DESC`, [req.user.id]);
  res.json({ shares: r.rows.map((x) => ({ id: x.id, token: x.token, kind: x.bundle_name ? 'zip' : 'file', name: x.file_name || x.bundle_name || '(원본 삭제됨)', hasPassword: x.has_pw, maxDownloads: x.max_downloads, downloadCount: x.download_count, expiresAt: x.expires_at, createdAt: x.created_at })) });
}));
router.delete('/shares/:id(\\d+)', authenticate, wrap(async (req, res) => {
  const r = await query('DELETE FROM share_links WHERE id=$1 AND created_by=$2 RETURNING id', [req.params.id, req.user.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: '공유를 찾을 수 없습니다.' });
  await audit(req, 'delete_share', `id=${req.params.id}`);
  res.json({ ok: true });
}));

// ── 폴더 단위 공유 (외부인 열람·다운로드 전용) ──────────
router.post('/folder-shares', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const owner = req.targetOwnerId; const folder = normalizeFolder(req.body.folder);
  await ensureFolder(owner, folder);
  const label = String(req.body.label || '').slice(0, 100).trim() || (folder === '/' ? '홈' : folder.split('/').filter(Boolean).pop());
  const password = String(req.body.password || '').trim(); const passwordHash = password ? await hashPassword(password) : null;
  const days = parseInt(req.body.expiresInDays || '0', 10); const expiresAt = days > 0 ? new Date(Date.now() + days * 86400000) : null;
  const token = generateToken(24);
  const r = await query('INSERT INTO folder_shares (owner_id, folder, token, label, password_hash, expires_at, created_by, notify_inapp, notify_email) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id', [owner, folder, token, label, passwordHash, expiresAt, req.user.id, !!req.body.notifyInapp, !!req.body.notifyEmail]);
  await audit(req, 'create_folder_share', `owner=${owner} ${folder}`);
  res.status(201).json({ id: r.rows[0].id, token, url: `${shareWebBase(req)}/folder.html?t=${token}`, label });
}));
router.get('/folder-shares', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const r = await query('SELECT id, folder, token, label, password_hash IS NOT NULL AS has_pw, disabled, expires_at, view_count, created_at FROM folder_shares WHERE owner_id=$1 ORDER BY created_at DESC', [req.targetOwnerId]);
  res.json({ shares: r.rows.map((x) => ({ id: x.id, folder: x.folder, label: x.label, token: x.token, hasPassword: x.has_pw, disabled: x.disabled, expiresAt: x.expires_at, viewCount: x.view_count, createdAt: x.created_at })) });
}));
router.delete('/folder-shares/:id(\\d+)', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const r = await query('DELETE FROM folder_shares WHERE id=$1 AND owner_id=$2 RETURNING id', [req.params.id, req.targetOwnerId]);
  if (r.rowCount === 0) return res.status(404).json({ error: '공유를 찾을 수 없습니다.' });
  await audit(req, 'delete_folder_share', `id=${req.params.id}`);
  res.json({ ok: true });
}));

// ── 인앱 알림 ──────────
router.get('/notifications', authenticate, wrap(async (req, res) => {
  const limit = Math.min(50, parseInt(req.query.limit || '20', 10) || 20);
  const [list, cnt] = await Promise.all([
    query('SELECT id, type, title, body, is_read, created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2', [req.user.id, limit]),
    query('SELECT COUNT(*)::int AS c FROM notifications WHERE user_id=$1 AND is_read=false', [req.user.id]),
  ]);
  res.json({
    unread: cnt.rows[0].c,
    items: list.rows.map((r) => ({ id: r.id, type: r.type, title: r.title, body: r.body, isRead: r.is_read, createdAt: r.created_at })),
  });
}));
router.post('/notifications/read', authenticate, wrap(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.filter((x) => Number.isInteger(x)) : null;
  if (ids && ids.length) await query('UPDATE notifications SET is_read=true WHERE user_id=$1 AND id = ANY($2)', [req.user.id, ids]);
  else await query('UPDATE notifications SET is_read=true WHERE user_id=$1 AND is_read=false', [req.user.id]);
  res.json({ ok: true });
}));

module.exports = router;
