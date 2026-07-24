'use strict';

const express = require('express');
const path = require('path');
const fsp = require('fs/promises');
const config = require('../config');
const { query, healthStats, withTransaction } = require('../db');
const { hashPassword, encryptSecret, decryptSecret, generatePassword } = require('../crypto');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { audit, wrap } = require('../util');
const { getAllowedExtensions, setAllowedExtensions, trashRetentionDays, shareQrEnabled, setSetting } = require('../settings');
const { diskTotalBytes, allocatedBytes, validateAllocation, diskUsage, dirSize } = require('../disk');

function gb(bytes) { return (bytes / 1073741824).toFixed(2) + 'GB'; }

const router = express.Router();
router.use(authenticate, requireAdmin);
// 관리자 2FA 강제(서버측): 2단계 인증을 켜기 전까지 관리 기능 차단(설정은 /api/auth/2fa 로 가능).
// 관리자는 모든 계정 비밀번호를 열람할 수 있어, 비번 단독 보호는 최약점 → 강제.
router.use((req, res, next) => {
  if (!req.user.totp_enabled) return res.status(403).json({ error: '보안을 위해 2단계 인증을 먼저 설정해야 관리 기능을 쓸 수 있습니다.', code: 'need_2fa' });
  next();
});

const userDir = (ownerId) => path.join(config.storageRoot, String(ownerId));

async function uniqueFileName(ownerId, folder, name) {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = name, n = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const r = await query('SELECT 1 FROM files WHERE owner_id=$1 AND folder=$2 AND original_name=$3 AND deleted_at IS NULL', [ownerId, folder, candidate]);
    if (r.rowCount === 0) return candidate;
    n++; candidate = `${base} (${n})${ext}`;
  }
}
async function ensureFolder(ownerId, folder) {
  if (!folder || folder === '/') return;
  const parts = folder.split('/').filter(Boolean); let acc = '';
  for (const p of parts) { acc += '/' + p; await query('INSERT INTO folders (owner_id, path) VALUES ($1,$2) ON CONFLICT (owner_id, path) DO UPDATE SET deleted_at=NULL', [ownerId, acc]); }
}

// GET /api/admin/users  전체 계정 목록
router.get('/users', wrap(async (req, res) => {
  const result = await query(`
    SELECT u.id, u.username, u.display_name, u.role, u.quota_bytes, u.is_active,
           u.created_at, u.updated_at,
           COALESCE(f.cnt, 0) AS file_count, COALESCE(f.bytes, 0) AS used_bytes
    FROM users u
    LEFT JOIN (
      SELECT owner_id, COUNT(*) AS cnt, SUM(size_bytes) AS bytes
      FROM files GROUP BY owner_id
    ) f ON f.owner_id = u.id
    ORDER BY u.created_at ASC
  `);
  res.json({
    users: result.rows.map((r) => ({
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      role: r.role,
      quotaBytes: Number(r.quota_bytes),
      isActive: r.is_active,
      fileCount: Number(r.file_count),
      usedBytes: Number(r.used_bytes),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  });
}));

// POST /api/admin/users  계정 발급
router.post('/users', wrap(async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const displayName = String(req.body.displayName || '').trim();
  const role = ['admin', 'manager', 'user', 'branch'].includes(req.body.role) ? req.body.role : 'user';
  // 관리자는 무제한(quota 0), 그 외는 지정 할당(0=미할당)
  const quotaBytes = role === 'admin' ? 0 : Math.max(0, parseInt(req.body.quotaBytes || '0', 10) || 0);
  let password = String(req.body.password || '').trim();

  if (!/^[a-z0-9._-]{3,64}$/.test(username)) {
    return res.status(400).json({ error: '아이디는 3~64자의 영소문자/숫자/._- 만 사용할 수 있습니다.' });
  }
  const dup = await query('SELECT id FROM users WHERE username = $1', [username]);
  if (dup.rowCount > 0) {
    return res.status(409).json({ error: '이미 존재하는 아이디입니다.' });
  }
  const alloc = await validateAllocation(quotaBytes);
  if (!alloc.ok) {
    return res.status(400).json({ error: `할당 가능한 디스크 용량을 초과했습니다. (남은 용량: ${gb(alloc.available)})` });
  }
  if (!password) password = generatePassword(12);
  if (password.length < 8) {
    return res.status(400).json({ error: '비밀번호는 8자 이상이어야 합니다.' });
  }

  const hash = await hashPassword(password);
  const enc = encryptSecret(password);
  const inserted = await query(
    `INSERT INTO users (username, display_name, role, password_hash, password_enc, quota_bytes)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [username, displayName || username, role, hash, enc, quotaBytes]
  );
  await audit(req, 'create_user', `username=${username} role=${role}`);
  res.status(201).json({
    id: inserted.rows[0].id,
    username,
    password, // 발급 시 1회 평문 반환 (관리자가 전달용)
  });
}));

// GET /api/admin/users/:id/password  비밀번호 열람 (요구사항 3)
router.get('/users/:id/password', wrap(async (req, res) => {
  const result = await query('SELECT username, password_enc FROM users WHERE id = $1', [req.params.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: '계정을 찾을 수 없습니다.' });
  let plain;
  try {
    plain = decryptSecret(result.rows[0].password_enc);
  } catch (err) {
    return res.status(500).json({ error: '복호화에 실패했습니다. 마스터 키를 확인하세요.' });
  }
  await audit(req, 'view_password', `target=${result.rows[0].username}`);
  res.json({ username: result.rows[0].username, password: plain });
}));

// PATCH /api/admin/users/:id/password  비밀번호 변경 (관리자가 임의 변경)
router.patch('/users/:id/password', wrap(async (req, res) => {
  let password = String(req.body.password || '').trim();
  if (!password) password = generatePassword(12);
  if (password.length < 8) {
    return res.status(400).json({ error: '비밀번호는 8자 이상이어야 합니다.' });
  }
  const hash = await hashPassword(password);
  const enc = encryptSecret(password);
  const upd = await query(
    'UPDATE users SET password_hash = $1, password_enc = $2, updated_at = now() WHERE id = $3 RETURNING username',
    [hash, enc, req.params.id]
  );
  if (upd.rowCount === 0) return res.status(404).json({ error: '계정을 찾을 수 없습니다.' });
  await audit(req, 'reset_password', `target=${upd.rows[0].username}`);
  res.json({ ok: true, password });
}));

// PATCH /api/admin/users/:id  계정 수정 (역할/할당량/활성/표시이름)
router.patch('/users/:id', wrap(async (req, res) => {
  const fields = [];
  const values = [];
  let i = 1;
  if (req.body.role !== undefined) {
    fields.push(`role = $${i++}`);
    values.push(['admin', 'manager', 'user', 'branch'].includes(req.body.role) ? req.body.role : 'user');
  }
  if (req.body.quotaBytes !== undefined) {
    // 대상 계정의 역할 확인 (관리자는 항상 무제한 0)
    const roleRow = await query('SELECT role FROM users WHERE id=$1', [req.params.id]);
    const targetRole = req.body.role !== undefined ? req.body.role : roleRow.rows[0]?.role;
    let q = Math.max(0, parseInt(req.body.quotaBytes, 10) || 0);
    if (targetRole === 'admin') q = 0;
    if (targetRole !== 'admin' && q > 0) {
      // 현재 사용량보다 작은 할당량으로는 줄일 수 없음
      const used = await query('SELECT COALESCE(SUM(size_bytes),0) AS s FROM files WHERE owner_id=$1 AND deleted_at IS NULL', [req.params.id]);
      if (Number(used.rows[0].s) > q) {
        return res.status(400).json({ error: `현재 사용량(${gb(Number(used.rows[0].s))})보다 작은 할당량으로 변경할 수 없습니다.` });
      }
      const alloc = await validateAllocation(q, Number(req.params.id));
      if (!alloc.ok) {
        return res.status(400).json({ error: `할당 가능한 디스크 용량을 초과했습니다. (남은 용량: ${gb(alloc.available)})` });
      }
    }
    fields.push(`quota_bytes = $${i++}`);
    values.push(q);
  }
  if (req.body.isActive !== undefined) {
    fields.push(`is_active = $${i++}`);
    values.push(Boolean(req.body.isActive));
  }
  if (req.body.displayName !== undefined) {
    fields.push(`display_name = $${i++}`);
    values.push(String(req.body.displayName).trim());
  }
  if (fields.length === 0) return res.status(400).json({ error: '변경할 항목이 없습니다.' });
  fields.push('updated_at = now()');
  values.push(req.params.id);
  const upd = await query(
    `UPDATE users SET ${fields.join(', ')} WHERE id = $${i} RETURNING username`,
    values
  );
  if (upd.rowCount === 0) return res.status(404).json({ error: '계정을 찾을 수 없습니다.' });
  await audit(req, 'update_user', `target=${upd.rows[0].username}`);
  res.json({ ok: true });
}));

// DELETE /api/admin/users/:id
router.delete('/users/:id', wrap(async (req, res) => {
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ error: '본인 계정은 삭제할 수 없습니다.' });
  }
  const del = await query('DELETE FROM users WHERE id = $1 RETURNING username', [req.params.id]);
  if (del.rowCount === 0) return res.status(404).json({ error: '계정을 찾을 수 없습니다.' });
  await audit(req, 'delete_user', `target=${del.rows[0].username}`);
  res.json({ ok: true });
}));

// GET /api/admin/db-status  DB 상태 (요구사항 7)
router.get('/db-status', wrap(async (req, res) => {
  try {
    const stats = await healthStats();
    res.json(stats);
  } catch (err) {
    res.status(503).json({ connected: false, error: err.message });
  }
}));

// GET /api/admin/backup-status  백업 현황(백업 크론이 남긴 상태 파일 읽기 · 읽기 전용)
router.get('/backup-status', wrap(async (req, res) => {
  const dir = path.join(config.storageRoot, '_backup-status');
  const readJson = async (name) => { try { return JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8')); } catch { return null; } };
  res.json({
    db: await readJson('db.json'), files: await readJson('files.json'), offsite: await readJson('offsite.json'),
    dbList: (await readJson('db-list.json')) || [], filesList: (await readJson('files-list.json')) || [],
  });
}));

// GET /api/admin/audit  감사 로그
router.get('/audit', wrap(async (req, res) => {
  const limit = Math.min(200, parseInt(req.query.limit || '50', 10));
  const result = await query(`
    SELECT a.id, a.action, a.detail, a.ip, a.created_at, u.username
    FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    ORDER BY a.created_at DESC LIMIT $1
  `, [limit]);
  res.json({ logs: result.rows });
}));

// ══════════ 휴지통 ══════════
// GET /api/admin/trash — 삭제된 파일/폴더 목록 (전 계정)
router.get('/trash', wrap(async (req, res) => {
  const days = trashRetentionDays();
  const files = await query(`
    SELECT f.id, f.original_name AS name, f.folder, f.size_bytes, f.deleted_at, u.username, u.display_name
    FROM files f LEFT JOIN users u ON u.id=f.owner_id
    WHERE f.deleted_at IS NOT NULL AND f.deleted_with_folder IS NULL
    ORDER BY f.deleted_at DESC`);
  const folders = await query(`
    SELECT fo.id, fo.path, fo.deleted_at, u.username, u.display_name,
      (SELECT COUNT(*) FROM files x WHERE x.deleted_with_folder=fo.path AND x.owner_id=fo.owner_id) AS file_count
    FROM folders fo LEFT JOIN users u ON u.id=fo.owner_id
    WHERE fo.deleted_at IS NOT NULL
    ORDER BY fo.deleted_at DESC`);
  res.json({
    retentionDays: days,
    files: files.rows.map((r) => ({ id: r.id, name: r.name, folder: r.folder, size: Number(r.size_bytes), deletedAt: r.deleted_at, username: r.username, displayName: r.display_name })),
    folders: folders.rows.map((r) => ({ id: r.id, path: r.path, fileCount: Number(r.file_count), deletedAt: r.deleted_at, username: r.username, displayName: r.display_name })),
  });
}));

// 파일 복원
router.post('/trash/file/:id/restore', wrap(async (req, res) => {
  const r = await query('SELECT * FROM files WHERE id=$1 AND deleted_at IS NOT NULL', [req.params.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: '휴지통에서 찾을 수 없습니다.' });
  const f = r.rows[0];
  await ensureFolder(f.owner_id, f.folder);
  const name = await uniqueFileName(f.owner_id, f.folder, f.original_name);
  await query('UPDATE files SET deleted_at=NULL, deleted_with_folder=NULL, original_name=$1, updated_at=now() WHERE id=$2', [name, f.id]);
  await audit(req, 'restore_file', `file=${f.id} -> ${f.folder}/${name}`);
  res.json({ ok: true, name, folder: f.folder });
}));

// 폴더 복원 (하위 파일 함께)
router.post('/trash/folder/:id/restore', wrap(async (req, res) => {
  const r = await query('SELECT * FROM folders WHERE id=$1 AND deleted_at IS NOT NULL', [req.params.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: '휴지통에서 찾을 수 없습니다.' });
  const fo = r.rows[0];
  // 같은 경로에 활성 폴더가 있으면 새 경로로
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
    // 폴더들 복원 + 경로 치환
    await client.query(`UPDATE folders SET deleted_at=NULL, path=$4 || substring(path from $5::int) WHERE owner_id=$1 AND deleted_at IS NOT NULL AND (path=$2 OR path LIKE $3)`, [fo.owner_id, fo.path, oldLike, newPath, cut]);
    // 그 폴더로 삭제됐던 파일들 복원 + 경로 치환 (삭제 시 deleted_with_folder=최상위 폴더 경로로 통일됨)
    await client.query(`UPDATE files SET deleted_at=NULL, deleted_with_folder=NULL, folder=$3 || substring(folder from $4::int), updated_at=now() WHERE owner_id=$1 AND deleted_with_folder=$2`, [fo.owner_id, fo.path, newPath, cut]);
  });
  await audit(req, 'restore_folder', `${fo.path} -> ${newPath}`);
  res.json({ ok: true, path: newPath });
}));

// 파일 영구삭제
router.delete('/trash/file/:id', wrap(async (req, res) => {
  const r = await query('SELECT * FROM files WHERE id=$1 AND deleted_at IS NOT NULL', [req.params.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: '휴지통에서 찾을 수 없습니다.' });
  const f = r.rows[0];
  await query('DELETE FROM files WHERE id=$1', [f.id]);
  await fsp.unlink(path.join(userDir(f.owner_id), f.stored_name)).catch(() => {});
  await audit(req, 'purge_file', `file=${f.id}`);
  res.json({ ok: true });
}));

// 폴더 영구삭제 (하위 파일 포함)
router.delete('/trash/folder/:id', wrap(async (req, res) => {
  const r = await query('SELECT * FROM folders WHERE id=$1 AND deleted_at IS NOT NULL', [req.params.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: '휴지통에서 찾을 수 없습니다.' });
  const fo = r.rows[0]; const oldLike = fo.path + '/%';
  const files = await query('SELECT id, owner_id, stored_name FROM files WHERE owner_id=$1 AND deleted_with_folder IS NOT NULL AND (deleted_with_folder=$2 OR deleted_with_folder LIKE $3)', [fo.owner_id, fo.path, oldLike]);
  for (const f of files.rows) await fsp.unlink(path.join(userDir(f.owner_id), f.stored_name)).catch(() => {});
  if (files.rowCount) await query('DELETE FROM files WHERE id = ANY($1::bigint[])', [files.rows.map((f) => f.id)]);
  await query('DELETE FROM folders WHERE owner_id=$1 AND deleted_at IS NOT NULL AND (path=$2 OR path LIKE $3)', [fo.owner_id, fo.path, oldLike]);
  await audit(req, 'purge_folder', `${fo.path}`);
  res.json({ ok: true });
}));

// ══════════ 디스크 용량/할당 현황 ══════════
router.get('/disk-info', wrap(async (req, res) => {
  const total = await diskTotalBytes();
  const allocated = await allocatedBytes();
  res.json({ totalBytes: total, allocatedBytes: allocated, availableBytes: Math.max(0, total - allocated) });
}));

// ══════════ 대시보드(요약·경고·추이) ══════════
router.get('/dashboard', wrap(async (req, res) => {
  const [uStat, fStat, total, allocated, loginsR, uploadsR, quotaR, topR, recentR] = await Promise.all([
    query("SELECT count(*)::int AS total, count(*) FILTER (WHERE is_active)::int AS active FROM users"),
    query('SELECT count(*)::int AS c, COALESCE(SUM(size_bytes),0) AS b FROM files WHERE deleted_at IS NULL'),
    diskTotalBytes(), allocatedBytes(),
    query("SELECT to_char(date_trunc('day',created_at),'MM-DD') AS d, count(*)::int AS c FROM audit_log WHERE action='login' AND created_at > now()-interval '13 days' GROUP BY 1"),
    query("SELECT to_char(date_trunc('day',created_at),'MM-DD') AS d, count(*)::int AS c, COALESCE(SUM(size_bytes),0) AS b FROM files WHERE created_at > now()-interval '13 days' GROUP BY 1"),
    query("SELECT u.username, u.display_name, u.quota_bytes, COALESCE(SUM(f.size_bytes),0) AS used FROM users u LEFT JOIN files f ON f.owner_id=u.id AND f.deleted_at IS NULL WHERE u.role<>'admin' AND u.quota_bytes>0 GROUP BY u.id, u.username, u.display_name, u.quota_bytes HAVING COALESCE(SUM(f.size_bytes),0) >= u.quota_bytes*0.9 ORDER BY used DESC"),
    query("SELECT u.username, u.display_name, count(f.id)::int AS c, COALESCE(SUM(f.size_bytes),0) AS b FROM users u LEFT JOIN files f ON f.owner_id=u.id AND f.deleted_at IS NULL GROUP BY u.id, u.username, u.display_name ORDER BY b DESC LIMIT 5"),
    query("SELECT a.action, a.detail, a.created_at, u.username FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 12"),
  ]);
  // 14일 시계열 채우기
  const days = []; const now = new Date();
  const lm = new Map(loginsR.rows.map((r) => [r.d, r.c]));
  const um = new Map(uploadsR.rows.map((r) => [r.d, r]));
  for (let i = 13; i >= 0; i--) {
    const dt = new Date(now.getTime() - i * 86400000); const key = String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
    const up = um.get(key);
    days.push({ date: key, logins: lm.get(key) || 0, uploads: up ? up.c : 0, uploadBytes: up ? Number(up.b) : 0 });
  }
  const used = Number(fStat.rows[0].b);
  // 시스템 실사용(파일시스템 전체) + 앱이 쓰는 캐시 폴더 측정
  const [du, pdfCacheBytes, bundleBytes] = await Promise.all([
    diskUsage(),
    dirSize(path.join(config.storageRoot, '_pdfcache')),
    dirSize(path.join(config.storageRoot, '_bundles')),
  ]);
  const systemBytes = Math.max(0, du.used - used); // 실사용 - 사용자 파일 = DB·OS·변환캐시·압축임시 등
  res.json({
    users: uStat.rows[0],
    fileCount: fStat.rows[0].c,
    storage: {
      diskTotal: total, diskUsed: used, allocated, available: Math.max(0, total - allocated),
      usedPct: total ? Math.round(used / total * 100) : 0, allocPct: total ? Math.round(allocated / total * 100) : 0,
      diskUsedActual: du.used, diskFree: du.free, usedActualPct: du.total ? Math.round(du.used / du.total * 100) : 0,
      systemBytes, pdfCacheBytes, bundleBytes,
    },
    quotaWarnings: quotaR.rows.map((r) => ({ username: r.username, displayName: r.display_name, usedBytes: Number(r.used), quotaBytes: Number(r.quota_bytes), pct: Math.round(Number(r.used) / Number(r.quota_bytes) * 100) })),
    daily: days,
    topAccounts: topR.rows.map((r) => ({ username: r.username, displayName: r.display_name, fileCount: r.c, usedBytes: Number(r.b) })),
    recent: recentR.rows.map((r) => ({ action: r.action, detail: r.detail, username: r.username, createdAt: r.created_at })),
    yara: require('../yara').enabled(),
  });
}));

// ══════════ 허용 확장자 ══════════
router.get('/settings/extensions', wrap(async (req, res) => {
  res.json({ extensions: getAllowedExtensions() });
}));
router.put('/settings/extensions', wrap(async (req, res) => {
  const normalized = await setAllowedExtensions(req.body.extensions || '');
  await audit(req, 'set_extensions', normalized);
  res.json({ ok: true, extensions: normalized.split(',').filter(Boolean) });
}));

// ══════════ 일반 설정 (휴지통 보관일수, 공유 QR) ══════════
router.get('/settings/general', wrap(async (req, res) => {
  res.json({ trashRetentionDays: trashRetentionDays(), shareQrEnabled: shareQrEnabled() });
}));
router.put('/settings/general', wrap(async (req, res) => {
  if (req.body.trashRetentionDays !== undefined) {
    const n = parseInt(req.body.trashRetentionDays, 10);
    if (!Number.isFinite(n) || n < 1 || n > 3650) return res.status(400).json({ error: '보관일수는 1~3650 사이여야 합니다.' });
    await setSetting('trash_retention_days', n);
  }
  if (req.body.shareQrEnabled !== undefined) {
    await setSetting('share_qr_enabled', req.body.shareQrEnabled ? '1' : '0');
  }
  await audit(req, 'set_general_settings', `trash=${trashRetentionDays()} qr=${shareQrEnabled()}`);
  res.json({ ok: true, trashRetentionDays: trashRetentionDays(), shareQrEnabled: shareQrEnabled() });
}));

// ══════════ 영업점 관리 ══════════
router.get('/branches', wrap(async (req, res) => {
  const r = await query('SELECT id, name, sort_order FROM branches ORDER BY sort_order, name');
  res.json({ branches: r.rows });
}));
router.post('/branches', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '영업점 이름을 입력하세요.' });
  const max = await query('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM branches');
  try {
    const r = await query('INSERT INTO branches (name, sort_order) VALUES ($1,$2) RETURNING id', [name, max.rows[0].n]);
    await audit(req, 'add_branch', name);
    res.status(201).json({ id: r.rows[0].id, name });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: '이미 있는 영업점입니다.' });
    throw err;
  }
}));
router.patch('/branches/:id', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '영업점 이름을 입력하세요.' });
  try {
    const r = await query('UPDATE branches SET name=$1 WHERE id=$2 RETURNING id', [name, req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: '영업점을 찾을 수 없습니다.' });
    await audit(req, 'edit_branch', name);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: '이미 있는 영업점입니다.' });
    throw err;
  }
}));
router.delete('/branches/:id', wrap(async (req, res) => {
  const r = await query('DELETE FROM branches WHERE id=$1 RETURNING name', [req.params.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: '영업점을 찾을 수 없습니다.' });
  await audit(req, 'delete_branch', r.rows[0].name);
  res.json({ ok: true });
}));

// ══════════ 공지사항 관리 ══════════
const ALL_ROLES = ['admin', 'manager', 'user', 'branch'];
function sanitizeRoles(input) {
  const arr = Array.isArray(input) ? input : [];
  const roles = ALL_ROLES.filter((r) => arr.includes(r));
  return roles.length ? roles : ALL_ROLES.slice(); // 비어있으면 전체로
}

router.get('/notices', wrap(async (req, res) => {
  const r = await query('SELECT id, title, body, start_at, end_at, created_at, target_roles FROM notices ORDER BY created_at DESC');
  res.json({ notices: r.rows });
}));
router.post('/notices', wrap(async (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: '제목을 입력하세요.' });
  const body = String(req.body.body || '');
  const startAt = req.body.startAt || null;
  const endAt = req.body.endAt || null;
  const targetRoles = sanitizeRoles(req.body.targetRoles);
  const r = await query('INSERT INTO notices (title, body, start_at, end_at, target_roles) VALUES ($1,$2,$3,$4,$5) RETURNING id', [title, body, startAt, endAt, targetRoles]);
  await audit(req, 'add_notice', title);
  res.status(201).json({ id: r.rows[0].id });
}));
router.patch('/notices/:id', wrap(async (req, res) => {
  const fields = []; const values = []; let i = 1;
  for (const [k, col] of [['title', 'title'], ['body', 'body'], ['startAt', 'start_at'], ['endAt', 'end_at']]) {
    if (req.body[k] !== undefined) { fields.push(`${col}=$${i++}`); values.push(req.body[k] === '' ? null : req.body[k]); }
  }
  if (req.body.targetRoles !== undefined) { fields.push(`target_roles=$${i++}`); values.push(sanitizeRoles(req.body.targetRoles)); }
  if (fields.length === 0) return res.status(400).json({ error: '변경할 항목이 없습니다.' });
  values.push(req.params.id);
  const r = await query(`UPDATE notices SET ${fields.join(', ')} WHERE id=$${i} RETURNING id`, values);
  if (r.rowCount === 0) return res.status(404).json({ error: '공지를 찾을 수 없습니다.' });
  await audit(req, 'edit_notice', `id=${req.params.id}`);
  res.json({ ok: true });
}));
router.delete('/notices/:id', wrap(async (req, res) => {
  const r = await query('DELETE FROM notices WHERE id=$1 RETURNING id', [req.params.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: '공지를 찾을 수 없습니다.' });
  await audit(req, 'delete_notice', `id=${req.params.id}`);
  res.json({ ok: true });
}));

// ══════════ 공유 통합 관리 (전 계정) ══════════
router.get('/shares', wrap(async (req, res) => {
  const [fileR, folderR, reqR] = await Promise.all([
    query(`SELECT s.id, s.token, s.expires_at, s.download_count, s.max_downloads, s.created_at, s.reason,
             (s.password_hash IS NOT NULL) AS has_pw,
             CASE WHEN s.file_id IS NOT NULL THEN 'file' ELSE 'zip' END AS kind,
             COALESCE(f.original_name, b.display_name) AS name,
             COALESCE(fo.username, bo.username) AS owner_username,
             COALESCE(fo.display_name, bo.display_name) AS owner_name,
             cu.username AS creator
           FROM share_links s
           LEFT JOIN files f ON f.id=s.file_id
           LEFT JOIN users fo ON fo.id=f.owner_id
           LEFT JOIN zip_bundles b ON b.id=s.bundle_id
           LEFT JOIN users bo ON bo.id=b.owner_id
           LEFT JOIN users cu ON cu.id=s.created_by
           ORDER BY s.created_at DESC`),
    query(`SELECT fs.id, fs.token, fs.label, fs.folder, fs.expires_at, fs.view_count, fs.disabled, fs.created_at, fs.reason,
             (fs.password_hash IS NOT NULL) AS has_pw, u.username AS owner_username, u.display_name AS owner_name
           FROM folder_shares fs JOIN users u ON u.id=fs.owner_id ORDER BY fs.created_at DESC`),
    query(`SELECT ur.id, ur.token, ur.label, ur.folder, ur.expires_at, ur.disabled, ur.uploaded_count, ur.uploaded_bytes, ur.max_files, ur.max_bytes, ur.created_at, ur.reason,
             (ur.password_hash IS NOT NULL) AS has_pw, u.username AS owner_username, u.display_name AS owner_name
           FROM upload_requests ur JOIN users u ON u.id=ur.owner_id ORDER BY ur.created_at DESC`),
  ]);
  const num = (v) => (v == null ? null : Number(v));
  res.json({
    fileShares: fileR.rows.map((r) => ({ id: r.id, token: r.token, kind: r.kind, name: r.name, ownerUsername: r.owner_username, ownerName: r.owner_name, creator: r.creator, hasPassword: r.has_pw, downloadCount: r.download_count, maxDownloads: r.max_downloads, expiresAt: r.expires_at, createdAt: r.created_at, reason: r.reason })),
    folderShares: folderR.rows.map((r) => ({ id: r.id, token: r.token, label: r.label, folder: r.folder, ownerUsername: r.owner_username, ownerName: r.owner_name, hasPassword: r.has_pw, disabled: r.disabled, viewCount: r.view_count, expiresAt: r.expires_at, createdAt: r.created_at, reason: r.reason })),
    uploadRequests: reqR.rows.map((r) => ({ id: r.id, token: r.token, label: r.label, folder: r.folder, ownerUsername: r.owner_username, ownerName: r.owner_name, hasPassword: r.has_pw, disabled: r.disabled, uploadedCount: r.uploaded_count, uploadedBytes: num(r.uploaded_bytes), maxFiles: r.max_files, maxBytes: num(r.max_bytes), expiresAt: r.expires_at, createdAt: r.created_at, reason: r.reason })),
  });
}));
const shareTables = { file: 'share_links', folder: 'folder_shares', upload: 'upload_requests' };
router.delete('/shares/:kind(file|folder|upload)/:id(\\d+)', wrap(async (req, res) => {
  const table = shareTables[req.params.kind];
  const r = await query(`DELETE FROM ${table} WHERE id=$1 RETURNING id`, [req.params.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: '공유를 찾을 수 없습니다.' });
  await audit(req, 'admin_delete_share', `${req.params.kind}#${req.params.id}`);
  res.json({ ok: true });
}));

// ══════════ 용량 트리맵 데이터 (계정 → 폴더) ══════════
router.get('/usage/tree', wrap(async (req, res) => {
  const [total, alloc, accR, folderR] = await Promise.all([
    diskTotalBytes(), allocatedBytes(),
    query(`SELECT u.id, u.username, u.display_name, u.role, u.quota_bytes,
             COALESCE(SUM(f.size_bytes),0) AS used, COUNT(f.id)::int AS files
           FROM users u LEFT JOIN files f ON f.owner_id=u.id AND f.deleted_at IS NULL
           GROUP BY u.id ORDER BY used DESC`),
    query(`SELECT owner_id, folder, COALESCE(SUM(size_bytes),0) AS used, COUNT(*)::int AS files
           FROM files WHERE deleted_at IS NULL GROUP BY owner_id, folder`),
  ]);
  // 디스크 실사용/시스템(사용자 파일이 아닌 실사용분) + 앱 캐시 폴더
  const userTotal = accR.rows.reduce((a, r) => a + Number(r.used), 0);
  const [du, pdfCacheBytes, bundleBytes] = await Promise.all([
    diskUsage(),
    dirSize(path.join(config.storageRoot, '_pdfcache')),
    dirSize(path.join(config.storageRoot, '_bundles')),
  ]);
  const systemBytes = Math.max(0, du.used - userTotal);
  res.json({
    diskTotal: total, allocated: alloc, available: Math.max(0, total - alloc),
    diskUsedActual: du.used, diskFree: du.free, systemBytes, pdfCacheBytes, bundleBytes,
    accounts: accR.rows.map((r) => ({ id: r.id, username: r.username, displayName: r.display_name, role: r.role, quotaBytes: Number(r.quota_bytes), used: Number(r.used), files: r.files })),
    folders: folderR.rows.map((r) => ({ ownerId: r.owner_id, folder: r.folder, used: Number(r.used), files: r.files })),
  });
}));

// ══════════ 주간 리포트 (미리보기 / 즉시 발송) ══════════
router.get('/report/preview', wrap(async (req, res) => {
  const report = require('../report');
  const mailer = require('../mailer');
  const built = await report.buildWeekly();
  res.json({ subject: built.subject, html: built.html, mail: { enabled: mailer.enabled(), ...mailer.config() } });
}));
router.post('/report/send', wrap(async (req, res) => {
  const scheduler = require('../scheduler');
  try {
    const info = await scheduler.runOnce('manual');
    await audit(req, 'send_report', mailer_to());
    res.json({ ok: true, messageId: info.messageId || null });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));
function mailer_to() { try { return require('../mailer').recipients().join(', '); } catch (_) { return ''; } }

module.exports = router;
