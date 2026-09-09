'use strict';

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const config = require('../config');
const { query, withTransaction } = require('../db');
const { authenticate } = require('../middleware/auth');
const { audit, wrap, canAccessOwner } = require('../util');
const { generateToken, hashPassword } = require('../crypto');
const filetype = require('../filetype');
const yara = require('../yara');
const officePdf = require('../officePdf');
const { diskGate } = require('../disk');
const { poolRootId, poolUsage } = require('../pool');
const notify = require('../notify');
const { isAllowed, allowedLabel, getAllowedExtensions, trashRetentionDays, shareQrEnabled } = require('../settings');
const QRCode = require('qrcode');

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

// 폴더/파일 이름 충돌 시 " (n)" 붙여 유니크한 이름 생성 (트랜잭션 내에선 q=client.query 전달)
async function uniqueFileName(ownerId, folder, name, q = query) {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = name, n = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const r = await q(
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

// ── 대용량 청크 업로드(Cloudflare 100MB 본문 제한 우회) ──────────
// 파일을 조각으로 나눠 여러 요청으로 받고 서버에서 합침. 조각은 임시폴더에 보관.
const CHUNK_ROOT = path.join(config.storageRoot, '_chunks');
const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHUNK_ASSEMBLE_MAX = parseInt(process.env.CHUNK_MAX_BYTES || String(500 * 1024 * 1024), 10); // 합친 파일 상한(기본 500MB)
const chunkUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { const d = path.join(CHUNK_ROOT, '_staging'); fs.mkdirSync(d, { recursive: true }); cb(null, d); },
    filename: (req, file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: { fileSize: 100 * 1024 * 1024 }, // 조각 하나 최대 100MB
});

async function resolveOwner(req, res, next) {
  const requested = req.query.ownerId || req.body.ownerId;
  if (requested && Number(requested) !== req.user.id) {
    if (!(await canAccessOwner(req.user, requested))) return res.status(403).json({ error: '해당 계정의 파일에 접근할 수 없습니다.' });
    req.targetOwnerId = Number(requested);
  } else req.targetOwnerId = req.user.id;
  next();
}

// diskGate(저장 볼륨 여유공간 가드)는 disk.js 로 이동 — 공개 업로드 링크와 공용.

const fileRow = (r) => ({
  id: r.id, name: r.original_name, folder: r.folder, size: Number(r.size_bytes),
  mime: r.mime_type, note: r.note || '', createdAt: r.created_at, updatedAt: r.updated_at, noteUpdatedAt: r.note_updated_at,
  fav: false, tags: [],
});

// 파일/폴더 목록에 즐겨찾기(fav)와 태그(tags) 정보를 채워 넣는다(뷰어 기준).
async function attachMeta(userId, ownerId, files, folders) {
  const fileIds = files.map((f) => f.id);
  if (fileIds.length) {
    const [fav, tg] = await Promise.all([
      query('SELECT file_id FROM favorites WHERE user_id=$1 AND file_id = ANY($2::bigint[])', [userId, fileIds]),
      query(`SELECT ft.file_id, t.id, t.name, t.color FROM file_tags ft JOIN tags t ON t.id=ft.tag_id WHERE ft.file_id = ANY($1::bigint[]) ORDER BY t.name`, [fileIds]),
    ]);
    const favSet = new Set(fav.rows.map((r) => String(r.file_id)));
    const tagMap = new Map();
    for (const r of tg.rows) { const k = String(r.file_id); if (!tagMap.has(k)) tagMap.set(k, []); tagMap.get(k).push({ id: r.id, name: r.name, color: r.color }); }
    for (const f of files) { f.fav = favSet.has(String(f.id)); f.tags = tagMap.get(String(f.id)) || []; }
  }
  if (folders && folders.length) {
    const paths = folders.map((f) => f.path);
    const favf = await query('SELECT folder_path FROM favorites WHERE user_id=$1 AND folder_owner=$2 AND folder_path = ANY($3::text[])', [userId, ownerId, paths]);
    const favSet = new Set(favf.rows.map((r) => r.folder_path));
    for (const f of folders) f.fav = favSet.has(f.path);
  }
}

// ── 접근 가능한 계정 목록 ──────────
router.get('/accounts', authenticate, wrap(async (req, res) => {
  if (req.user.role === 'admin') {
    const r = await query('SELECT id, username, display_name, role FROM users ORDER BY role DESC, username');
    return res.json({ accounts: r.rows.map((u) => ({ id: u.id, username: u.username, displayName: u.display_name, role: u.role })) });
  }
  if (req.user.role === 'manager') {
    // 담당자는 외부업체만 열람 가능(영업점 웹하드는 안 보임)
    const r = await query("SELECT id, username, display_name, role FROM users WHERE role='user' ORDER BY username");
    return res.json({ accounts: r.rows.map((u) => ({ id: u.id, username: u.username, displayName: u.display_name, role: u.role })) });
  }
  res.json({ accounts: [] });
}));

// ── 재고조사 오차체크 저장(계정별 · 서버 보관) ──────────
// 접근 규칙은 resolveOwner/canAccessOwner 와 동일: 영업점 본인 또는 관리자만.
router.get('/stock-audit', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const r = await query('SELECT data, item_count, updated_at FROM stock_audits WHERE owner_id=$1', [req.targetOwnerId]);
  if (!r.rowCount) return res.json({ data: null });
  res.json({ data: r.rows[0].data, itemCount: r.rows[0].item_count, updatedAt: r.rows[0].updated_at });
}));
router.put('/stock-audit', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const data = req.body.data;
  if (!Array.isArray(data)) return res.status(400).json({ error: '목록 형식이 올바르지 않습니다.' });
  if (data.length > 50000) return res.status(413).json({ error: '항목이 너무 많습니다(최대 5만).' });
  await query(
    `INSERT INTO stock_audits (owner_id, data, item_count, updated_by, updated_at)
       VALUES ($1, $2::jsonb, $3, $4, now())
     ON CONFLICT (owner_id) DO UPDATE
       SET data=EXCLUDED.data, item_count=EXCLUDED.item_count, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [req.targetOwnerId, JSON.stringify(data), data.length, req.user.id]
  );
  await audit(req, 'stock_audit_save', `owner=${req.targetOwnerId} items=${data.length}`);
  res.json({ ok: true, itemCount: data.length });
}));
router.delete('/stock-audit', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  await query('DELETE FROM stock_audits WHERE owner_id=$1', [req.targetOwnerId]);
  res.json({ ok: true });
}));

// ── 재고조사 '전달'(담당자·관리자 → 영업점) ──────────
// 담당자는 영업점 웹하드를 열람할 순 없지만, 결과 오차목록을 특정 영업점 공간의
// 재고조사오차_<년도> 폴더에 '가상 파일(.bjsa)'로 넣어줄 수 있다(browse 아님, 전용 쓰기 경로).
// 영업점이 이 파일을 더블클릭하면 재고조사 화면(사진 촬영·체크)이 그 목록으로 열린다.
router.get('/stock-audit/branches', authenticate, wrap(async (req, res) => {
  if (!['manager', 'admin'].includes(req.user.role)) return res.status(403).json({ error: '권한이 없습니다.' });
  const r = await query("SELECT id, username, display_name FROM users WHERE role='branch' AND is_active ORDER BY username");
  res.json({ branches: r.rows.map((u) => ({ id: u.id, username: u.username, displayName: u.display_name })) });
}));
router.post('/stock-audit/deliver', authenticate, wrap(async (req, res) => {
  if (!['manager', 'admin'].includes(req.user.role)) return res.status(403).json({ error: '권한이 없습니다.' });
  const branchId = Number(req.body.branchId);
  const data = req.body.data;
  const year = String(req.body.year || new Date().getFullYear()).replace(/[^0-9]/g, '').slice(0, 4) || String(new Date().getFullYear());
  if (!Array.isArray(data) || !data.length) return res.status(400).json({ error: '전달할 오차 목록이 없습니다.' });
  if (data.length > 50000) return res.status(413).json({ error: '항목이 너무 많습니다(최대 5만).' });
  const b = await query("SELECT display_name FROM users WHERE id=$1 AND role='branch'", [branchId]);
  if (!b.rowCount) return res.status(400).json({ error: '영업점 계정을 찾을 수 없습니다.' });
  const branchName = b.rows[0].display_name;
  const folder = `/재고조사오차_${year}`;
  await ensureFolder(branchId, folder);
  const now = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}`;
  const name = await uniqueFileName(branchId, folder, `재고조사오차_${branchName}_${stamp}.bjsa`);
  const payload = JSON.stringify({ v: 1, kind: 'stockaudit', branchName, deliveredBy: req.user.username, deliveredAt: now.toISOString(), disc: data });
  const dir = userDir(branchId);
  await fsp.mkdir(dir, { recursive: true });
  const storedName = crypto.randomUUID();
  await fsp.writeFile(path.join(dir, storedName), payload, 'utf8');
  const row = await query(
    `INSERT INTO files (owner_id, folder, original_name, stored_name, size_bytes, mime_type)
     VALUES ($1,$2,$3,$4,$5,'application/x-bookjeok-stockaudit') RETURNING id`,
    [branchId, folder, name, storedName, Buffer.byteLength(payload)]
  );
  await audit(req, 'stock_audit_deliver', `items=${data.length} file=${name}`, branchId);
  notify.push({ userId: branchId, type: 'stockaudit', title: '재고조사 오차 파일이 도착했습니다', body: `${folder} 폴더의 '${name}'를 열어 사진·체크를 진행하세요.` }).catch(() => {});
  res.status(201).json({ ok: true, fileId: row.rows[0].id, folder, name });
}));

// ── 계정별 최근 활동(사이드바 패널) ──────────
// 이 클라우드(owner)에서 벌어진 일들. 누가 했는지도 함께 — 담당자·관리자가 남의 계정에 올릴 수 있으므로.
// 접근 권한은 resolveOwner/canAccessOwner 와 동일(내 계정 또는 접근 가능한 계정만).
const ACTIVITY_ACTIONS = [
  'upload', 'download', 'rename', 'update_note', 'trash_file', 'restore_file', 'self_restore_file',
  'create_folder', 'rename_folder', 'trash_folder', 'folder_note', 'folder_style',
  'bulk_move', 'bulk_copy', 'bulk_trash', 'bulk_zip',
  'create_share', 'delete_share', 'create_folder_share', 'delete_folder_share',
  'create_upload_request', 'delete_upload_request', 'stock_audit_deliver', 'stock_audit_save',
];
const UNDOABLE = new Set(['trash_file', 'bulk_trash', 'trash_folder']);
// 감사기록 detail 에 박아둔 대상 id 들을 뽑는다 ('file=12', 'ids=12,13,14')
function auditFileIds(detail) {
  const out = [];
  const one = /(?:^|\s)file=(\d+)/.exec(detail || '');
  if (one) out.push(Number(one[1]));
  const many = /(?:^|\s)ids=([\d,]+)/.exec(detail || '');
  if (many) for (const t of many[1].split(',')) { const n = Number(t); if (n) out.push(n); }
  return out;
}
// 화면에 보일 detail — 내부 식별자(file=12, ids=…)는 지우고 파일 이름으로 바꾼다
function prettyDetail(detail, nameById) {
  let d = String(detail || '');
  d = d.replace(/(?:^|\s)ids=[\d,]+/g, '').trim();
  d = d.replace(/(?:^|\s)file=(\d+)/g, (m, id) => ' ' + (nameById.get(Number(id)) || `#${id}`)).trim();
  d = d.replace(/^count=(\d+)/, '$1개').replace(/->/g, '→');
  return d;
}
router.get('/activity', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const owner = req.targetOwnerId;
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '30', 10)));
  const r = await query(`
    SELECT a.id, a.action, a.detail, a.created_at, u.username, u.display_name
    FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.owner_id = $1 AND a.action = ANY($2::text[])
    ORDER BY a.created_at DESC LIMIT $3
  `, [owner, ACTIVITY_ACTIONS, limit]);

  // 이름 표시 + '되돌리기' 가능 여부 판정에 필요한 정보를 한 번에 모아 온다
  const fileIds = [...new Set(r.rows.flatMap((x) => auditFileIds(x.detail)))];
  const nameById = new Map(); const inTrash = new Set();
  if (fileIds.length) {
    const fr = await query(
      'SELECT id, original_name, deleted_at FROM files WHERE id = ANY($1::bigint[]) AND owner_id = $2',
      [fileIds, owner]);
    const cutoff = trashCutoff();
    for (const f of fr.rows) {
      nameById.set(Number(f.id), f.original_name);
      if (f.deleted_at && new Date(f.deleted_at).toISOString() > cutoff) inTrash.add(Number(f.id));
    }
  }
  const folderIdByPath = new Map();
  if (r.rows.some((x) => x.action === 'trash_folder')) {
    const fo = await query(
      'SELECT id, path FROM folders WHERE owner_id=$1 AND deleted_at IS NOT NULL AND deleted_at > $2',
      [owner, trashCutoff()]);
    for (const f of fo.rows) folderIdByPath.set(f.path, Number(f.id));
  }

  res.json({
    items: r.rows.map((x) => {
      let undo = null;
      if (UNDOABLE.has(x.action)) {
        if (x.action === 'trash_folder') {
          const id = folderIdByPath.get(String(x.detail || '').trim());
          if (id) undo = { type: 'folder', ids: [id] };
        } else {
          const ids = auditFileIds(x.detail).filter((id) => inTrash.has(id));
          if (ids.length) undo = { type: 'file', ids };
        }
      }
      return {
        id: x.id, action: x.action, detail: prettyDetail(x.detail, nameById), at: x.created_at,
        by: x.display_name || x.username || '알 수 없음', undo,
      };
    }),
  });
}));

// ── 폴더 트리 ──────────
router.get('/tree', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const [ff, fx] = await Promise.all([
    query('SELECT path, icon, color, cover_file_id FROM folders WHERE owner_id=$1 AND deleted_at IS NULL', [req.targetOwnerId]),
    query('SELECT DISTINCT folder AS path FROM files WHERE owner_id=$1 AND folder<>$2 AND deleted_at IS NULL', [req.targetOwnerId, '/']),
  ]);
  const set = new Set();
  const styles = {};
  for (const row of [...ff.rows, ...fx.rows]) {
    const parts = row.path.split('/').filter(Boolean); let acc = '';
    for (const p of parts) { acc += '/' + p; set.add(acc); }
  }
  for (const row of ff.rows) { if (row.icon || row.color || row.cover_file_id) styles[row.path] = { icon: row.icon || '', color: row.color || '', cover: row.cover_file_id || null }; }
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
  await audit(req, 'create_folder', `${folder}`);
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
  // 커버 이미지: 해당 폴더 안의 이미지 파일만 허용, 빈 값이면 해제
  if (req.body.cover !== undefined) {
    const coverId = parseInt(req.body.cover, 10);
    let cover = null;
    if (Number.isFinite(coverId) && coverId > 0) {
      const c = await query('SELECT 1 FROM files WHERE id=$1 AND owner_id=$2 AND folder=$3 AND deleted_at IS NULL', [coverId, req.targetOwnerId, folder]);
      if (c.rowCount) cover = coverId;
    }
    await query('UPDATE folders SET cover_file_id=$1 WHERE owner_id=$2 AND path=$3', [cover, req.targetOwnerId, folder]);
  }
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
  // folders·files 경로를 함께 갱신 — 둘 사이에서 실패하면 파일이 없어진 폴더를 가리켜 목록에서 사라짐.
  // 트랜잭션으로 묶어 둘 다 반영되거나 둘 다 되돌려지도록 보장.
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE folders SET path = $4 || substring(path from $5::int) WHERE owner_id=$1 AND deleted_at IS NULL AND (path=$2 OR path LIKE $3)`,
      [req.targetOwnerId, oldPath, oldLike, newPath, cut]
    );
    await client.query(
      `UPDATE files SET folder = $4 || substring(folder from $5::int), updated_at=now() WHERE owner_id=$1 AND deleted_at IS NULL AND (folder=$2 OR folder LIKE $3)`,
      [req.targetOwnerId, oldPath, oldLike, newPath, cut]
    );
  });
  await audit(req, 'rename_folder', `${oldPath} -> ${newPath}`);
  res.json({ ok: true, path: newPath });
}));

// 폴더 삭제 (소프트) — 폴더 + 하위 파일 휴지통으로
router.delete('/folders', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const folder = normalizeFolder(req.query.path || req.body.path);
  if (folder === '/') return res.status(400).json({ error: '루트 폴더는 삭제할 수 없습니다.' });
  const like = folder + '/%';
  // 폴더·하위 파일을 함께 휴지통으로 — 중간 실패 시 정합성이 깨지므로 트랜잭션으로 묶음.
  await withTransaction(async (client) => {
    await client.query('UPDATE folders SET deleted_at=now() WHERE owner_id=$1 AND deleted_at IS NULL AND (path=$2 OR path LIKE $3)', [req.targetOwnerId, folder, like]);
    await client.query('UPDATE files SET deleted_at=now(), deleted_with_folder=$4 WHERE owner_id=$1 AND deleted_at IS NULL AND (folder=$2 OR folder LIKE $3)', [req.targetOwnerId, folder, like, folder]);
  });
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
  const childList = [...childPaths].sort();
  // N+1 제거: 백필/메타/집계를 각각 한 번의 쿼리로(폴더 수와 무관하게 3쿼리)
  const folders = [];
  if (childList.length) {
    // 1) 없는 폴더 한 번에 백필
    await query(
      'INSERT INTO folders (owner_id, path) SELECT $1, unnest($2::text[]) ON CONFLICT (owner_id, path) DO NOTHING',
      [req.targetOwnerId, childList]
    );
    // 2) 폴더 메타 한 번에
    const meta = await query(
      'SELECT id, path, note, note_updated_at, created_at, icon, color, cover_file_id FROM folders WHERE owner_id=$1 AND path = ANY($2::text[])',
      [req.targetOwnerId, childList]
    );
    const metaByPath = new Map(meta.rows.map((r) => [r.path, r]));
    // 3) 하위 트리 크기/개수 한 번에: 파일 경로에서 prefix 뒤 '첫 세그먼트'로 버킷팅해 GROUP BY
    const agg = await query(
      `SELECT $2 || split_part(substr(folder, char_length($2) + 1), '/', 1) AS bucket,
              COALESCE(SUM(size_bytes),0) AS s, COUNT(*)::int AS c
       FROM files WHERE owner_id=$1 AND deleted_at IS NULL AND folder LIKE $3
       GROUP BY 1`,
      [req.targetOwnerId, prefix, prefix + '%']
    );
    const aggByPath = new Map(agg.rows.map((r) => [r.bucket, { s: Number(r.s), c: r.c }]));
    for (const p of childList) {
      const fr = metaByPath.get(p) || {};
      const a = aggByPath.get(p) || { s: 0, c: 0 };
      folders.push({
        id: fr.id, path: p, name: p.split('/').pop(),
        note: fr.note || '', noteUpdatedAt: fr.note_updated_at || null,
        createdAt: fr.created_at || null,
        icon: fr.icon || '', color: fr.color || '', cover: fr.cover_file_id || null,
        size: a.s, fileCount: a.c, fav: false,
      });
    }
  }
  const fileList = files.rows.map(fileRow);
  await attachMeta(req.user.id, req.targetOwnerId, fileList, folders);
  res.json({ folder, ownerId: req.targetOwnerId, folders, files: fileList });
}));

// ── 업로드 ──────────
router.post('/upload', authenticate, wrap(resolveOwner), wrap(diskGate), upload.array('file', 30), wrap(async (req, res) => {
  const folder = normalizeFolder(req.body.folder);
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: '업로드할 파일이 없습니다.' });
  const owner = await query('SELECT role, upload_conflict FROM users WHERE id=$1', [req.targetOwnerId]);
  const isAdmin = owner.rows[0].role === 'admin';
  const overwrite = owner.rows[0].upload_conflict === 'overwrite'; // 동일 이름: 덮어쓰기(이전 파일은 휴지통) vs 번호 붙이기
  await ensureFolder(req.targetOwnerId, folder);
  // 업로드 시 파일별 제목/비고(선택) — 카메라 업로드 등에서 index로 정렬해 전달
  const titles = req.body.titles !== undefined ? [].concat(req.body.titles) : [];
  const notes = req.body.notes !== undefined ? [].concat(req.body.notes) : [];
  const saved = []; const rejected = [];
  try {
    // 동시 업로드 쿼터 경합(TOCTOU) 방지: 소유자별 어드바이저리 락 + 쿼터 재확인 + 저장을 한 트랜잭션에서
    await withTransaction(async (client) => {
      // 공유 풀(담당자↔영업점) 기준으로 락·검사: 락은 풀 루트에 걸어 형제 영업점 동시업로드도 직렬화
      const qc = client.query.bind(client);
      const rootId = await poolRootId(req.targetOwnerId, qc);
      await client.query('SELECT pg_advisory_xact_lock($1)', [rootId]);
      // 관리자는 무제한, 그 외는 풀 할당량 적용(0=미할당이므로 업로드 불가)
      if (!isAdmin) {
        const pool = await poolUsage(rootId, qc, true);
        const incoming = req.files.reduce((s, f) => s + f.size, 0);
        if (!pool.unlimited && pool.used + incoming > pool.quota) {
          const e = new Error(pool.quota === 0 ? '디스크가 할당되지 않은 계정입니다. 관리자에게 문의하세요.' : '저장 용량 할당량을 초과했습니다.');
          e.status = 413; throw e;
        }
      }
      for (let i = 0; i < req.files.length; i++) {
        const f = req.files[i];
        // 경로 구분자·제어문자 제거 (zip-slip/헤더 주입 방어)
        let originalName = Buffer.from(f.originalname, 'latin1').toString('utf8')
          .replace(/[/\\]/g, '_').replace(/[\x00-\x1f]/g, '').trim() || 'file';
        // 사용자가 제목을 직접 입력했으면 확장자는 유지한 채 파일명 교체
        const title = String(titles[i] || '').replace(/[/\\]/g, '_').replace(/[\x00-\x1f]/g, '').trim();
        if (title) {
          const ext = originalName.includes('.') ? originalName.slice(originalName.lastIndexOf('.')) : '';
          originalName = title.toLowerCase().endsWith(ext.toLowerCase()) ? title : title + ext;
        }
        const note = String(notes[i] || '').slice(0, 2000).trim();
        // 매직바이트 검증: 실행파일 위장·확장자-내용 불일치 차단 (데몬 불필요)
        const ft = await filetype.verify(f.path, originalName);
        if (!ft.ok) { await fsp.unlink(f.path).catch(() => {}); rejected.push({ name: originalName, reason: ft.reason }); await audit(req, 'file_blocked', `${originalName} (${ft.reason})`); continue; }
        // YARA 악성 패턴 검사(로컬, 오프라인). 매칭되면 저장하지 않고 삭제.
        const mal = await yara.scanFile(f.path);
        if (!mal.ok) { await fsp.unlink(f.path).catch(() => {}); rejected.push({ name: originalName, reason: `악성 패턴 감지(${mal.rule})` }); await audit(req, 'malware_blocked', `${originalName} (${mal.rule})`); continue; }
        let name;
        if (overwrite) {
          // 덮어쓰기: 같은 이름 기존 파일을 휴지통으로 보내고(30일 복원 가능) 원래 이름 유지
          await client.query('UPDATE files SET deleted_at=now() WHERE owner_id=$1 AND folder=$2 AND original_name=$3 AND deleted_at IS NULL', [req.targetOwnerId, folder, originalName]);
          name = originalName;
        } else {
          name = await uniqueFileName(req.targetOwnerId, folder, originalName, client.query.bind(client));
        }
        const row = await client.query(
          `INSERT INTO files (owner_id, folder, original_name, stored_name, size_bytes, mime_type, note, note_updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,${note ? 'now()' : 'NULL'}) RETURNING id`,
          [req.targetOwnerId, folder, name, path.basename(f.path), f.size, f.mimetype, note]
        );
        saved.push({ id: row.rows[0].id, name, size: f.size, folder });
      }
    });
  } catch (err) {
    // 트랜잭션이 롤백되면 DB엔 아무것도 남지 않음 → 업로드 임시파일 전부 정리(거절분은 이미 삭제됨=no-op).
    await Promise.all(req.files.map((f) => fsp.unlink(f.path).catch(() => {})));
    if (err.status === 413) return res.status(413).json({ error: err.message });
    throw err;
  }
  await audit(req, 'upload', `${folder} · ${saved.length}개`);
  // 다른 사람(담당자·관리자)이 내 계정에 올리면 소유자에게 인앱 알림
  if (saved.length && Number(req.user.id) !== Number(req.targetOwnerId)) {
    notify.push({ userId: req.targetOwnerId, type: 'upload', title: `파일 ${saved.length}개가 업로드되었습니다`, body: `${req.user.display_name || req.user.username}님이 '${folder}' 폴더에 파일 ${saved.length}개를 올렸습니다.` }).catch(() => {});
  }
  if (saved.length === 0 && rejected.length) return res.status(422).json({ error: `업로드가 차단되었습니다: ${rejected.map((r) => r.reason).join(', ')}`, rejected });
  res.status(201).json({ uploaded: saved, rejected });
}));

// 청크 업로드 시작: 파일 크기로 할당량·형식·크기상한을 미리 확인 후 uploadId 발급.
// (조각을 다 올린 뒤에야 거부되는 낭비를 방지 — 초과면 여기서 즉시 안내)
router.post('/upload/init', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const size = Number(req.body.size) || 0;
  const filename = String(req.body.filename || '');
  if (!isAllowed(extOf(filename))) return res.status(415).json({ error: `허용되지 않는 파일 형식입니다. 가능: ${allowedLabel()}` });
  if (size > CHUNK_ASSEMBLE_MAX) return res.status(413).json({ error: `허용 최대 크기(${Math.round(CHUNK_ASSEMBLE_MAX / 1048576)}MB)를 초과했습니다.` });
  const owner = req.targetOwnerId;
  const ownerRow = await query('SELECT role FROM users WHERE id=$1', [owner]);
  if (ownerRow.rows[0].role !== 'admin') {
    const pool = await poolUsage(owner);
    if (!pool.unlimited && size > 0 && pool.used + size > pool.quota) {
      return res.status(413).json({ error: pool.quota === 0 ? '디스크가 할당되지 않은 계정입니다. 관리자에게 문의하세요.' : '저장 용량 할당량을 초과했습니다.' });
    }
  }
  res.json({ uploadId: crypto.randomUUID() });
}));

// 청크 수신: 조각 하나를 임시폴더에 저장. 소유자·보안 검사는 완료(complete) 시점에 수행하므로 인증만.
router.post('/upload/chunk', authenticate, wrap(diskGate), chunkUpload.single('chunk'), wrap(async (req, res) => {
  const uploadId = String(req.body.uploadId || '');
  const index = parseInt(req.body.index, 10);
  if (!UPLOAD_ID_RE.test(uploadId) || !Number.isInteger(index) || index < 0 || index > 100000 || !req.file) {
    if (req.file) await fsp.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: '잘못된 청크 요청입니다.' });
  }
  const dir = path.join(CHUNK_ROOT, uploadId); // uploadId는 UUID 형식만 허용(경로 조작 방지)
  await fsp.mkdir(dir, { recursive: true });
  await fsp.rename(req.file.path, path.join(dir, `${index}.part`));
  res.json({ ok: true, index });
}));

// 완료: 조각을 순서대로 합쳐 최종 파일 생성 → 매직바이트·YARA·할당량 검사 후 저장. (단일 업로드와 동일 정책)
router.post('/upload/complete', authenticate, wrap(resolveOwner), wrap(diskGate), wrap(async (req, res) => {
  const uploadId = String(req.body.uploadId || '');
  const totalChunks = parseInt(req.body.totalChunks, 10);
  const folder = normalizeFolder(req.body.folder);
  if (!UPLOAD_ID_RE.test(uploadId) || !Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > 100000) {
    return res.status(400).json({ error: '잘못된 완료 요청입니다.' });
  }
  const dir = path.join(CHUNK_ROOT, uploadId);
  const cleanup = () => fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  // 모든 조각 존재 확인
  for (let i = 0; i < totalChunks; i++) {
    if (!fs.existsSync(path.join(dir, `${i}.part`))) { await cleanup(); return res.status(400).json({ error: `일부 조각이 누락되어 업로드를 완료할 수 없습니다 (조각 ${i}).` }); }
  }
  // 파일명·제목·확장자
  let originalName = String(req.body.filename || 'file').replace(/[/\\]/g, '_').replace(/[\x00-\x1f]/g, '').trim() || 'file';
  const title = String(req.body.title || '').replace(/[/\\]/g, '_').replace(/[\x00-\x1f]/g, '').trim();
  if (title) { const ext = originalName.includes('.') ? originalName.slice(originalName.lastIndexOf('.')) : ''; originalName = title.toLowerCase().endsWith(ext.toLowerCase()) ? title : title + ext; }
  if (!isAllowed(extOf(originalName))) { await cleanup(); return res.status(415).json({ error: `허용되지 않는 파일 형식입니다. 가능: ${allowedLabel()}` }); }
  const note = String(req.body.note || '').slice(0, 2000).trim();
  const owner = req.targetOwnerId;

  // 조각 합치기(순서대로 스트림 이어붙임)
  const dest = userDir(owner);
  await fsp.mkdir(dest, { recursive: true });
  const storedName = crypto.randomUUID();
  const finalPath = path.join(dest, storedName);
  try {
    const out = fs.createWriteStream(finalPath);
    for (let i = 0; i < totalChunks; i++) {
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(path.join(dir, `${i}.part`));
        rs.on('error', reject); out.on('error', reject); rs.on('end', resolve);
        rs.pipe(out, { end: false });
      });
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    await fsp.unlink(finalPath).catch(() => {}); await cleanup();
    throw err;
  }
  await cleanup(); // 조각 정리

  // 크기 상한·할당량
  const size = (await fsp.stat(finalPath)).size;
  if (size > CHUNK_ASSEMBLE_MAX) { await fsp.unlink(finalPath).catch(() => {}); return res.status(413).json({ error: `허용 최대 크기(${Math.round(CHUNK_ASSEMBLE_MAX / 1048576)}MB)를 초과했습니다.` }); }
  const ownerRow = await query('SELECT role, upload_conflict FROM users WHERE id=$1', [owner]);
  const overwrite = ownerRow.rows[0].upload_conflict === 'overwrite';
  if (ownerRow.rows[0].role !== 'admin') {
    const pool = await poolUsage(owner);
    if (!pool.unlimited && pool.used + size > pool.quota) {
      await fsp.unlink(finalPath).catch(() => {});
      return res.status(413).json({ error: pool.quota === 0 ? '디스크가 할당되지 않은 계정입니다. 관리자에게 문의하세요.' : '저장 용량 할당량을 초과했습니다.' });
    }
  }
  // 보안 검사(합친 파일 기준, 단일 업로드와 동일)
  const ft = await filetype.verify(finalPath, originalName);
  if (!ft.ok) { await fsp.unlink(finalPath).catch(() => {}); await audit(req, 'file_blocked', `${originalName} (${ft.reason})`); return res.status(422).json({ error: `업로드가 차단되었습니다: ${ft.reason}` }); }
  const mal = await yara.scanFile(finalPath);
  if (!mal.ok) { await fsp.unlink(finalPath).catch(() => {}); await audit(req, 'malware_blocked', `${originalName} (${mal.rule})`); return res.status(422).json({ error: `악성 패턴 감지(${mal.rule})` }); }

  await ensureFolder(owner, folder);
  let name;
  if (overwrite) { await query('UPDATE files SET deleted_at=now() WHERE owner_id=$1 AND folder=$2 AND original_name=$3 AND deleted_at IS NULL', [owner, folder, originalName]); name = originalName; }
  else { name = await uniqueFileName(owner, folder, originalName); }
  const mime = String(req.body.mime || '').slice(0, 100) || 'application/octet-stream';
  const row = await query(
    `INSERT INTO files (owner_id, folder, original_name, stored_name, size_bytes, mime_type, note, note_updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,${note ? 'now()' : 'NULL'}) RETURNING id`,
    [owner, folder, name, storedName, size, mime, note]
  );
  await audit(req, 'upload', `${folder} · ${originalName}`);
  if (Number(req.user.id) !== Number(owner)) {
    notify.push({ userId: owner, type: 'upload', title: '파일 1개가 업로드되었습니다', body: `${req.user.display_name || req.user.username}님이 '${folder}' 폴더에 파일을 올렸습니다.` }).catch(() => {});
  }
  res.status(201).json({ uploaded: [{ id: row.rows[0].id, name, size, folder }], rejected: [] });
}));

// 허용 확장자 조회 (로그인 사용자)
router.get('/allowed-extensions', authenticate, wrap(async (req, res) => {
  res.json({ extensions: getAllowedExtensions() });
}));

// 계정의 최신 변경 시각(리비전) — 다른 세션의 변경 감지용(가벼운 폴링). 값이 커지면 목록이 오래된 것.
router.get('/rev', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const owner = req.targetOwnerId;
  const r = await query(
    `SELECT GREATEST(
       (SELECT max(GREATEST(created_at, updated_at, note_updated_at, deleted_at)) FROM files   WHERE owner_id=$1),
       (SELECT max(GREATEST(created_at, note_updated_at, deleted_at))             FROM folders WHERE owner_id=$1)
     ) AS rev`, [owner]);
  res.json({ rev: r.rows[0].rev }); // null 가능(빈 계정)
}));

// ── 다운로드 ──────────
router.get('/:id(\\d+)/download', authenticate, wrap(async (req, res) => {
  const r = await query('SELECT * FROM files WHERE id=$1 AND deleted_at IS NULL', [req.params.id]);
  const file = r.rows[0];
  if (!file) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  if (!(await canAccessOwner(req.user, file.owner_id))) return res.status(403).json({ error: '접근 권한이 없습니다.' });
  const disk = path.join(userDir(file.owner_id), file.stored_name);
  if (!fs.existsSync(disk)) return res.status(410).json({ error: '파일 실체가 존재하지 않습니다.' });
  await audit(req, 'download', `${file.folder} · ${file.original_name}`, file.owner_id);
  res.download(disk, file.original_name);
}));

// ── 오피스 문서(PPT/PPTX/DOC/DOCX 등) → PDF 완전 레이아웃 미리보기 (LibreOffice, 캐시) ──────────
router.get('/:id(\\d+)/pdf', authenticate, wrap(async (req, res) => {
  const r = await query('SELECT * FROM files WHERE id=$1 AND deleted_at IS NULL', [req.params.id]);
  const file = r.rows[0];
  if (!file) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  if (!(await canAccessOwner(req.user, file.owner_id))) return res.status(403).json({ error: '접근 권한이 없습니다.' });
  const ext = (file.original_name.split('.').pop() || '').toLowerCase();
  if (!officePdf.canConvert(ext)) return res.status(415).json({ error: '변환할 수 없는 형식입니다.' });
  if (!officePdf.sofficeAvailable()) return res.status(501).json({ error: '문서 변환기(LibreOffice)가 설치되어 있지 않습니다.' });
  const disk = path.join(userDir(file.owner_id), file.stored_name);
  if (!fs.existsSync(disk)) return res.status(410).json({ error: '파일 실체가 존재하지 않습니다.' });
  try {
    const pdf = await officePdf.convert(disk, ext, file.stored_name);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="preview.pdf"');
    const rs = fs.createReadStream(pdf);
    // 스트림 오류(캐시 삭제·권한·FD 고갈 등)에 리스너가 없으면 프로세스가 죽음 → 반드시 처리
    rs.on('error', (e) => {
      console.error('[pdf] 스트림 오류:', e.message);
      if (!res.headersSent) res.status(500).json({ error: '문서를 전송하지 못했습니다.' });
      else res.destroy();
    });
    rs.pipe(res);
  } catch (e) {
    // 변환기가 밀려서 거절한 경우(S23)는 서버 오류가 아니라 '지금 붐빔' — 사용자에게 그대로 알린다
    if (e && e.code === 'converter_busy') return res.status(503).json({ error: e.message, code: 'converter_busy' });
    res.status(500).json({ error: '문서를 변환하지 못했습니다.' });
  }
}));

// ── 비고 ──────────
router.patch('/:id(\\d+)/note', authenticate, wrap(async (req, res) => {
  const note = String(req.body.note ?? '').slice(0, 2000);
  const r = await query('SELECT owner_id FROM files WHERE id=$1 AND deleted_at IS NULL', [req.params.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  if (!(await canAccessOwner(req.user, r.rows[0].owner_id))) return res.status(403).json({ error: '권한이 없습니다.' });
  await query('UPDATE files SET note=$1, note_updated_at=now(), updated_at=now() WHERE id=$2', [note, req.params.id]);
  await audit(req, 'update_note', `file=${req.params.id}`, r.rows[0].owner_id);
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
  await audit(req, 'rename', `file=${req.params.id} -> ${unique}`, r.rows[0].owner_id);
  res.json({ ok: true, name: unique });
}));

// ── 단일 삭제 (소프트) ──────────
router.delete('/:id(\\d+)', authenticate, wrap(async (req, res) => {
  const r = await query('SELECT * FROM files WHERE id=$1 AND deleted_at IS NULL', [req.params.id]);
  const file = r.rows[0];
  if (!file) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  if (!(await canAccessOwner(req.user, file.owner_id))) return res.status(403).json({ error: '삭제 권한이 없습니다.' });
  await query('UPDATE files SET deleted_at=now(), deleted_with_folder=NULL WHERE id=$1', [file.id]);
  await audit(req, 'trash_file', `file=${file.id}`, file.owner_id);
  res.json({ ok: true });
}));

// 선택 항목이 모두 한 계정의 것이면 그 계정 id (감사기록을 '어느 클라우드에서'로 남기기 위함)
function soleOwner(files) {
  const owners = [...new Set((files || []).map((f) => Number(f.owner_id)))];
  return owners.length === 1 ? owners[0] : undefined;
}
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
  await audit(req, 'bulk_trash', `count=${files.length} ids=${files.slice(0, 200).map((f) => f.id).join(',')}`, soleOwner(files));
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
  await audit(req, 'bulk_move', `count=${files.length} -> ${folder}`, soleOwner(files));
  res.json({ ok: true, moved: files.length });
}));

// ── 일괄 복사 (실물 파일 복제 + 새 레코드) ──────────
router.post('/bulk/copy', authenticate, wrap(async (req, res) => {
  const folder = normalizeFolder(req.body.folder);
  const files = await loadAccessibleFiles(req.user, req.body.ids);
  if (files.length === 0) return res.status(400).json({ error: '복사할 항목이 없습니다.' });
  const owners = [...new Set(files.map((f) => f.owner_id))];
  // 공유 풀(담당자 공유) 기준 용량 검사 — 관리자는 무제한. 소유자별 유입량을 풀 루트로 합산해 검사.
  const incomingByOwner = {};
  for (const f of files) incomingByOwner[f.owner_id] = (incomingByOwner[f.owner_id] || 0) + Number(f.size_bytes);
  const poolByRoot = {}; const incomingByRoot = {};
  for (const o of owners) {
    const u = await query('SELECT role FROM users WHERE id=$1', [o]);
    if (!u.rows.length || u.rows[0].role === 'admin') continue;
    const pool = await poolUsage(o);
    poolByRoot[pool.rootId] = pool;
    incomingByRoot[pool.rootId] = (incomingByRoot[pool.rootId] || 0) + incomingByOwner[o];
  }
  for (const rid of Object.keys(poolByRoot)) {
    const pool = poolByRoot[rid];
    if (!pool.unlimited && pool.used + incomingByRoot[rid] > pool.quota) {
      return res.status(413).json({ error: pool.quota === 0 ? '디스크가 할당되지 않은 계정입니다. 관리자에게 문의하세요.' : '저장 용량 할당량을 초과했습니다.' });
    }
  }
  await Promise.all(owners.map((o) => ensureFolder(o, folder)));
  let copied = 0;
  for (const f of files) {
    const src = path.join(userDir(f.owner_id), f.stored_name);
    const newStored = generateToken(24);
    try { await fsp.copyFile(src, path.join(userDir(f.owner_id), newStored)); }
    catch { continue; } // 원본 실물이 없으면 건너뜀
    const name = await uniqueFileName(f.owner_id, folder, f.original_name);
    await query(
      `INSERT INTO files (owner_id, folder, original_name, stored_name, size_bytes, mime_type, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [f.owner_id, folder, name, newStored, f.size_bytes, f.mime_type, f.note || null]
    );
    copied++;
  }
  await audit(req, 'bulk_copy', `count=${copied} -> ${folder}`, soleOwner(files));
  res.json({ ok: true, copied });
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
router.post('/bulk/zip', authenticate, wrap(resolveOwner), wrap(diskGate), wrap(async (req, res) => {
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
  await audit(req, 'bulk_zip', `${zipName} · ${files.length}개`, owner);
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
  const { passwordHash, maxDownloads, expiresAt, notifyInapp, notifyEmail, reason } = await shareOptions(req);
  const token = generateToken(24);
  await query('INSERT INTO share_links (bundle_id, token, created_by, expires_at, password_hash, max_downloads, notify_inapp, notify_email, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [b.id, token, req.user.id, expiresAt, passwordHash, maxDownloads, notifyInapp, notifyEmail, reason]);
  await audit(req, 'create_share', `bundle=${b.id}`);
  res.status(201).json({ token, url: `${shareWebBase(req)}/share.html?t=${token}`, fileName: b.display_name, expiresAt });
}));

// ── 검색 고도화 (이름 + 유형·기간·크기·태그·즐겨찾기 필터) ──────────
router.get('/search', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const owner = req.targetOwnerId;
  const q = String(req.query.q || '').trim();
  const exts = String(req.query.exts || '').split(',').map((s) => s.trim().replace(/^\./, '').toLowerCase()).filter(Boolean);
  const dateFrom = String(req.query.dateFrom || '').trim();
  const dateTo = String(req.query.dateTo || '').trim();
  const minSize = parseFloat(req.query.minSize); // MB
  const maxSize = parseFloat(req.query.maxSize); // MB
  const tagId = parseInt(req.query.tagId, 10);
  const favOnly = String(req.query.favOnly || '') === '1';
  const sort = ['name', 'size', 'createdAt'].includes(req.query.sort) ? req.query.sort : 'name';
  const hasFileFilter = q || exts.length || dateFrom || dateTo || Number.isFinite(minSize) || Number.isFinite(maxSize) || Number.isFinite(tagId) || favOnly;
  if (!hasFileFilter) return res.json({ query: '', folders: [], files: [] });

  // 파일 조건 동적 구성
  const cond = ['f.owner_id=$1', 'f.deleted_at IS NULL']; const vals = [owner]; let i = 2;
  // 파일 이름에서 매칭
  if (q) { cond.push(`f.original_name ILIKE $${i} ESCAPE '\\'`); vals.push('%' + q.replace(/[%_\\]/g, (c) => '\\' + c) + '%'); i++; }
  if (exts.length) { cond.push(`lower(substring(f.original_name from '\\.([^.]+)$')) = ANY($${i}::text[])`); vals.push(exts); i++; }
  if (dateFrom) { cond.push(`f.created_at >= $${i}`); vals.push(dateFrom); i++; }
  if (dateTo) { cond.push(`f.created_at < ($${i}::date + 1)`); vals.push(dateTo); i++; }
  if (Number.isFinite(minSize)) { cond.push(`f.size_bytes >= $${i}`); vals.push(Math.round(minSize * 1048576)); i++; }
  if (Number.isFinite(maxSize)) { cond.push(`f.size_bytes <= $${i}`); vals.push(Math.round(maxSize * 1048576)); i++; }
  if (Number.isFinite(tagId)) { cond.push(`EXISTS (SELECT 1 FROM file_tags ft WHERE ft.file_id=f.id AND ft.tag_id=$${i})`); vals.push(tagId); i++; }
  if (favOnly) { cond.push(`EXISTS (SELECT 1 FROM favorites fv WHERE fv.user_id=$${i} AND fv.file_id=f.id)`); vals.push(req.user.id); i++; }
  const orderBy = sort === 'size' ? 'f.size_bytes DESC' : sort === 'createdAt' ? 'f.created_at DESC' : 'f.original_name';
  const files = await query(`SELECT f.* FROM files f WHERE ${cond.join(' AND ')} ORDER BY ${orderBy} LIMIT 500`, vals);

  // 폴더는 이름 검색이 있을 때만(그리고 파일 전용 필터가 없을 때) 함께 매칭
  let folders = [];
  if (q && !exts.length && !Number.isFinite(minSize) && !Number.isFinite(maxSize) && !Number.isFinite(tagId)) {
    const ql = q.toLowerCase();
    const fr = await query('SELECT id, path, note, note_updated_at, created_at, icon, color FROM folders WHERE owner_id=$1 AND deleted_at IS NULL', [owner]);
    folders = fr.rows
      .filter((r) => (r.path.split('/').filter(Boolean).pop() || '').toLowerCase().includes(ql))
      .slice(0, 300)
      .map((r) => ({ id: r.id, path: r.path, name: r.path.split('/').filter(Boolean).pop() || r.path, note: r.note || '', noteUpdatedAt: r.note_updated_at, createdAt: r.created_at, icon: r.icon || '', color: r.color || '', size: 0, fav: false }));
  }
  const fileList = files.rows.map(fileRow);
  await attachMeta(req.user.id, owner, fileList, folders);
  res.json({ query: q, folders, files: fileList });
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

// ── 사용자 셀프 휴지통 (본인 것, 보관기간=관리자 설정) ──────────
const trashCutoff = () => new Date(Date.now() - trashRetentionDays() * 86400000).toISOString();
router.get('/trash', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const owner = req.targetOwnerId; const cutoff = trashCutoff();
  const files = await query(
    `SELECT id, original_name AS name, folder, size_bytes, deleted_at FROM files
     WHERE owner_id=$1 AND deleted_at IS NOT NULL AND deleted_with_folder IS NULL AND deleted_at > $2
     ORDER BY deleted_at DESC`, [owner, cutoff]);
  const folders = await query(
    `SELECT fo.id, fo.path, fo.deleted_at, (SELECT COUNT(*) FROM files x WHERE x.deleted_with_folder=fo.path AND x.owner_id=fo.owner_id) AS file_count
     FROM folders fo WHERE fo.owner_id=$1 AND fo.deleted_at IS NOT NULL AND fo.deleted_at > $2
     ORDER BY fo.deleted_at DESC`, [owner, cutoff]);
  res.json({
    days: trashRetentionDays(),
    files: files.rows.map((r) => ({ id: r.id, name: r.name, folder: r.folder, size: Number(r.size_bytes), deletedAt: r.deleted_at })),
    folders: folders.rows.map((r) => ({ id: r.id, path: r.path, name: r.path.split('/').filter(Boolean).pop() || r.path, fileCount: Number(r.file_count), deletedAt: r.deleted_at })),
  });
}));
// 영구 삭제(본인) — 단일 파일
router.delete('/trash/file/:id(\\d+)', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const r = await query('SELECT stored_name, owner_id FROM files WHERE id=$1 AND owner_id=$2 AND deleted_at IS NOT NULL', [req.params.id, req.targetOwnerId]);
  if (r.rowCount === 0) return res.status(404).json({ error: '항목을 찾을 수 없습니다.' });
  await fsp.unlink(path.join(userDir(r.rows[0].owner_id), r.rows[0].stored_name)).catch(() => {});
  await query('DELETE FROM files WHERE id=$1', [req.params.id]);
  await audit(req, 'self_purge_file', `file=${req.params.id}`);
  res.json({ ok: true });
}));
// 영구 삭제 — 폴더(그 폴더로 삭제된 파일 포함)
router.delete('/trash/folder/:id(\\d+)', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const owner = req.targetOwnerId;
  const r = await query('SELECT path FROM folders WHERE id=$1 AND owner_id=$2 AND deleted_at IS NOT NULL', [req.params.id, owner]);
  if (r.rowCount === 0) return res.status(404).json({ error: '항목을 찾을 수 없습니다.' });
  const p = r.rows[0].path;
  const files = await query('SELECT id, stored_name FROM files WHERE owner_id=$1 AND deleted_with_folder=$2', [owner, p]);
  for (const f of files.rows) await fsp.unlink(path.join(userDir(owner), f.stored_name)).catch(() => {});
  if (files.rowCount) await query('DELETE FROM files WHERE id = ANY($1::bigint[])', [files.rows.map((f) => f.id)]);
  await query('DELETE FROM folders WHERE id=$1', [req.params.id]);
  await audit(req, 'self_purge_folder', `${p}`);
  res.json({ ok: true });
}));
// 휴지통 비우기(대상 계정 전체 영구삭제)
router.post('/trash/empty', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const owner = req.targetOwnerId;
  const files = await query('SELECT id, stored_name FROM files WHERE owner_id=$1 AND deleted_at IS NOT NULL', [owner]);
  for (const f of files.rows) await fsp.unlink(path.join(userDir(owner), f.stored_name)).catch(() => {});
  if (files.rowCount) await query('DELETE FROM files WHERE id = ANY($1::bigint[])', [files.rows.map((f) => f.id)]);
  const folders = await query('DELETE FROM folders WHERE owner_id=$1 AND deleted_at IS NOT NULL RETURNING id', [owner]);
  await audit(req, 'self_empty_trash', `files=${files.rowCount} folders=${folders.rowCount}`);
  res.json({ ok: true, files: files.rowCount, folders: folders.rowCount });
}));
router.post('/trash/file/:id(\\d+)/restore', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const r = await query('SELECT * FROM files WHERE id=$1 AND owner_id=$2 AND deleted_at IS NOT NULL AND deleted_at > $3', [req.params.id, req.targetOwnerId, trashCutoff()]);
  if (r.rowCount === 0) return res.status(404).json({ error: '복원할 수 없습니다. (없거나 보관기간 초과)' });
  const f = r.rows[0];
  await ensureFolder(f.owner_id, f.folder);
  const name = await uniqueFileName(f.owner_id, f.folder, f.original_name);
  await query('UPDATE files SET deleted_at=NULL, deleted_with_folder=NULL, original_name=$1, updated_at=now() WHERE id=$2', [name, f.id]);
  await audit(req, 'self_restore_file', `file=${f.id}`);
  res.json({ ok: true, name, folder: f.folder });
}));
router.post('/trash/folder/:id(\\d+)/restore', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const r = await query('SELECT * FROM folders WHERE id=$1 AND owner_id=$2 AND deleted_at IS NOT NULL AND deleted_at > $3', [req.params.id, req.targetOwnerId, trashCutoff()]);
  if (r.rowCount === 0) return res.status(404).json({ error: '복원할 수 없습니다. (없거나 보관기간 초과)' });
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
  // 폴더 복원과 그 안 파일 복원을 원자적으로(둘 중 하나만 성공해 split-brain 되지 않도록)
  await withTransaction(async (client) => {
    await client.query(`UPDATE folders SET deleted_at=NULL, path=$4 || substring(path from $5::int) WHERE owner_id=$1 AND deleted_at IS NOT NULL AND (path=$2 OR path LIKE $3)`, [fo.owner_id, fo.path, oldLike, newPath, cut]);
    await client.query(`UPDATE files SET deleted_at=NULL, deleted_with_folder=NULL, folder=$3 || substring(folder from $4::int), updated_at=now() WHERE owner_id=$1 AND deleted_with_folder=$2`, [fo.owner_id, fo.path, newPath, cut]);
  });
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
  return { passwordHash, maxDownloads, expiresAt, notifyInapp: !!req.body.notifyInapp, notifyEmail: !!req.body.notifyEmail, reason: String(req.body.reason || '').slice(0, 300).trim() };
}
router.post('/:id(\\d+)/share', authenticate, wrap(async (req, res) => {
  const r = await query('SELECT owner_id, original_name FROM files WHERE id=$1 AND deleted_at IS NULL', [req.params.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  if (!(await canAccessOwner(req.user, r.rows[0].owner_id))) return res.status(403).json({ error: '권한이 없습니다.' });
  const { passwordHash, maxDownloads, expiresAt, notifyInapp, notifyEmail, reason } = await shareOptions(req);
  const token = generateToken(24);
  await query('INSERT INTO share_links (file_id, token, created_by, expires_at, password_hash, max_downloads, notify_inapp, notify_email, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [req.params.id, token, req.user.id, expiresAt, passwordHash, maxDownloads, notifyInapp, notifyEmail, reason]);
  await audit(req, 'create_share', `file=${req.params.id}`);
  res.status(201).json({ token, url: `${shareWebBase(req)}/share.html?t=${token}`, fileName: r.rows[0].original_name, expiresAt });
}));

// ── 사용량 ──────────
router.get('/usage/summary', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const r = await query('SELECT COUNT(*)::int AS files, COALESCE(SUM(size_bytes),0) AS bytes FROM files WHERE owner_id=$1 AND deleted_at IS NULL', [req.targetOwnerId]);
  // 공유 풀이면 사용량/할당량은 풀 전체 기준으로 보여준다(자기 파일 개수·용량은 별도로 함께 반환).
  const pool = await poolUsage(req.targetOwnerId);
  res.json({
    ownerId: req.targetOwnerId, fileCount: r.rows[0].files, usedBytes: pool.used,
    quotaBytes: pool.quota, unlimited: pool.unlimited,
    pooled: pool.memberCount > 1, ownUsedBytes: Number(r.rows[0].bytes),
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
  const r = await query('INSERT INTO upload_requests (owner_id, folder, token, label, password_hash, max_files, max_bytes, expires_at, created_by, notify_inapp, notify_email, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id', [owner, folder, token, label, passwordHash, maxFiles, maxBytes, expiresAt, req.user.id, !!req.body.notifyInapp, !!req.body.notifyEmail, String(req.body.reason || '').slice(0, 300).trim()]);
  await audit(req, 'create_upload_request', `owner=${owner} ${folder}`);
  res.status(201).json({ id: r.rows[0].id, token, url: `${shareWebBase(req)}/upload.html?t=${token}`, label });
}));
router.get('/upload-requests', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const r = await query('SELECT id, folder, token, label, password_hash IS NOT NULL AS has_password, max_files, max_bytes, uploaded_count, uploaded_bytes, disabled, expires_at, created_at, reason FROM upload_requests WHERE owner_id=$1 ORDER BY created_at DESC', [req.targetOwnerId]);
  res.json({ requests: r.rows.map((x) => ({ id: x.id, folder: x.folder, label: x.label, token: x.token, hasPassword: x.has_password, maxFiles: x.max_files, maxBytes: x.max_bytes != null ? Number(x.max_bytes) : null, uploadedCount: x.uploaded_count, uploadedBytes: Number(x.uploaded_bytes), disabled: x.disabled, expiresAt: x.expires_at, createdAt: x.created_at, reason: x.reason })) });
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
    `SELECT s.id, s.token, s.expires_at, s.password_hash IS NOT NULL AS has_pw, s.max_downloads, s.download_count, s.created_at, s.reason,
            f.original_name AS file_name, b.display_name AS bundle_name
     FROM share_links s LEFT JOIN files f ON f.id=s.file_id LEFT JOIN zip_bundles b ON b.id=s.bundle_id
     WHERE s.created_by=$1 ORDER BY s.created_at DESC`, [req.user.id]);
  res.json({ shares: r.rows.map((x) => ({ id: x.id, token: x.token, kind: x.bundle_name ? 'zip' : 'file', name: x.file_name || x.bundle_name || '(원본 삭제됨)', hasPassword: x.has_pw, maxDownloads: x.max_downloads, downloadCount: x.download_count, expiresAt: x.expires_at, createdAt: x.created_at, reason: x.reason })) });
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
  const r = await query('INSERT INTO folder_shares (owner_id, folder, token, label, password_hash, expires_at, created_by, notify_inapp, notify_email, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id', [owner, folder, token, label, passwordHash, expiresAt, req.user.id, !!req.body.notifyInapp, !!req.body.notifyEmail, String(req.body.reason || '').slice(0, 300).trim()]);
  await audit(req, 'create_folder_share', `owner=${owner} ${folder}`);
  res.status(201).json({ id: r.rows[0].id, token, url: `${shareWebBase(req)}/folder.html?t=${token}`, label });
}));
router.get('/folder-shares', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const r = await query('SELECT id, folder, token, label, password_hash IS NOT NULL AS has_pw, disabled, expires_at, view_count, created_at, reason FROM folder_shares WHERE owner_id=$1 ORDER BY created_at DESC', [req.targetOwnerId]);
  res.json({ shares: r.rows.map((x) => ({ id: x.id, folder: x.folder, label: x.label, token: x.token, hasPassword: x.has_pw, disabled: x.disabled, expiresAt: x.expires_at, viewCount: x.view_count, createdAt: x.created_at, reason: x.reason })) });
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

// ── 즐겨찾기(별표) ─ 뷰어 개인 북마크 ──────────
router.post('/favorites/toggle', authenticate, wrap(async (req, res) => {
  const kind = req.body.kind;
  if (kind === 'file') {
    const id = Number(req.body.id);
    const f = await query('SELECT owner_id FROM files WHERE id=$1 AND deleted_at IS NULL', [id]);
    if (f.rowCount === 0) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    if (!(await canAccessOwner(req.user, f.rows[0].owner_id))) return res.status(403).json({ error: '권한이 없습니다.' });
    const del = await query('DELETE FROM favorites WHERE user_id=$1 AND file_id=$2 RETURNING id', [req.user.id, id]);
    if (del.rowCount) return res.json({ ok: true, fav: false });
    await query('INSERT INTO favorites (user_id, file_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user.id, id]);
    return res.json({ ok: true, fav: true });
  }
  if (kind === 'folder') {
    const p = normalizeFolder(req.body.path);
    const ownerId = Number(req.body.ownerId) || req.user.id;
    if (!(await canAccessOwner(req.user, ownerId))) return res.status(403).json({ error: '권한이 없습니다.' });
    const del = await query('DELETE FROM favorites WHERE user_id=$1 AND folder_owner=$2 AND folder_path=$3 RETURNING id', [req.user.id, ownerId, p]);
    if (del.rowCount) return res.json({ ok: true, fav: false });
    await query('INSERT INTO favorites (user_id, folder_owner, folder_path) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [req.user.id, ownerId, p]);
    return res.json({ ok: true, fav: true });
  }
  res.status(400).json({ error: '잘못된 요청입니다.' });
}));

// ── 태그(라벨) ─ 계정(owner)별 정의 + 파일 연결 ──────────
router.get('/tags', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const r = await query(
    `SELECT t.id, t.name, t.color, (SELECT COUNT(*) FROM file_tags ft WHERE ft.tag_id=t.id) AS cnt
     FROM tags t WHERE t.owner_id=$1 ORDER BY t.name`, [req.targetOwnerId]);
  res.json({ tags: r.rows.map((t) => ({ id: t.id, name: t.name, color: t.color, count: Number(t.cnt) })) });
}));
router.post('/tags', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  const color = /^#[0-9a-fA-F]{6}$/.test(req.body.color || '') ? req.body.color : '#118AB2';
  if (!name) return res.status(400).json({ error: '태그 이름을 입력하세요.' });
  try {
    const r = await query('INSERT INTO tags (owner_id, name, color) VALUES ($1,$2,$3) RETURNING id', [req.targetOwnerId, name, color]);
    await audit(req, 'create_tag', `owner=${req.targetOwnerId} ${name}`);
    res.status(201).json({ id: r.rows[0].id, name, color });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: '같은 이름의 태그가 이미 있습니다.' });
    throw e;
  }
}));
router.patch('/tags/:id(\\d+)', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  const color = /^#[0-9a-fA-F]{6}$/.test(req.body.color || '') ? req.body.color : null;
  const sets = []; const vals = []; let i = 1;
  if (name) { sets.push(`name=$${i++}`); vals.push(name); }
  if (color) { sets.push(`color=$${i++}`); vals.push(color); }
  if (!sets.length) return res.json({ ok: true });
  vals.push(req.params.id, req.targetOwnerId);
  const r = await query(`UPDATE tags SET ${sets.join(', ')} WHERE id=$${i++} AND owner_id=$${i}`, vals);
  if (r.rowCount === 0) return res.status(404).json({ error: '태그를 찾을 수 없습니다.' });
  res.json({ ok: true });
}));
router.delete('/tags/:id(\\d+)', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const r = await query('DELETE FROM tags WHERE id=$1 AND owner_id=$2 RETURNING id', [req.params.id, req.targetOwnerId]);
  if (r.rowCount === 0) return res.status(404).json({ error: '태그를 찾을 수 없습니다.' });
  await audit(req, 'delete_tag', `id=${req.params.id}`);
  res.json({ ok: true });
}));
// 파일의 태그 목록 교체 (owner 소유 태그만 허용)
router.put('/:id(\\d+)/tags', authenticate, wrap(async (req, res) => {
  const fr = await query('SELECT owner_id FROM files WHERE id=$1 AND deleted_at IS NULL', [req.params.id]);
  if (fr.rowCount === 0) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  const owner = fr.rows[0].owner_id;
  if (!(await canAccessOwner(req.user, owner))) return res.status(403).json({ error: '권한이 없습니다.' });
  const wanted = (Array.isArray(req.body.tagIds) ? req.body.tagIds : []).map(Number).filter(Boolean);
  const valid = wanted.length
    ? (await query('SELECT id FROM tags WHERE owner_id=$1 AND id = ANY($2::bigint[])', [owner, wanted])).rows.map((r) => r.id)
    : [];
  await query('DELETE FROM file_tags WHERE file_id=$1', [req.params.id]);
  for (const t of valid) await query('INSERT INTO file_tags (file_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, t]);
  await audit(req, 'set_file_tags', `file=${req.params.id} tags=${valid.length}`);
  res.json({ ok: true, tagIds: valid });
}));

// ── 공유 링크 QR 코드 (관리자가 켠 경우에만) ──────────
router.get('/qr', authenticate, wrap(async (req, res) => {
  if (!shareQrEnabled()) return res.status(403).json({ error: 'QR 코드 기능이 비활성화되어 있습니다.' });
  const text = String(req.query.text || '').slice(0, 1024);
  if (!text) return res.status(400).json({ error: '대상 URL이 없습니다.' });
  const qr = await QRCode.toDataURL(text, { margin: 1, width: 220 });
  res.json({ qr });
}));

module.exports = router;
