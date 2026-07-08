'use strict';

const express = require('express');
const path = require('path');
const fsp = require('fs/promises');
const config = require('../config');
const { query, healthStats } = require('../db');
const { hashPassword, encryptSecret, decryptSecret, generatePassword } = require('../crypto');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { audit, wrap } = require('../util');
const { RETENTION_MS } = require('../purge');

const router = express.Router();
router.use(authenticate, requireAdmin);

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
  const role = ['admin', 'manager', 'user'].includes(req.body.role) ? req.body.role : 'user';
  const quotaBytes = Math.max(0, parseInt(req.body.quotaBytes || '0', 10) || 0);
  let password = String(req.body.password || '').trim();

  if (!/^[a-z0-9._-]{3,64}$/.test(username)) {
    return res.status(400).json({ error: '아이디는 3~64자의 영소문자/숫자/._- 만 사용할 수 있습니다.' });
  }
  const dup = await query('SELECT id FROM users WHERE username = $1', [username]);
  if (dup.rowCount > 0) {
    return res.status(409).json({ error: '이미 존재하는 아이디입니다.' });
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
    values.push(['admin', 'manager', 'user'].includes(req.body.role) ? req.body.role : 'user');
  }
  if (req.body.quotaBytes !== undefined) {
    fields.push(`quota_bytes = $${i++}`);
    values.push(Math.max(0, parseInt(req.body.quotaBytes, 10) || 0));
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
  const days = Math.round(RETENTION_MS / 86400000);
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
  // 폴더들 복원 + 경로 치환
  await query(`UPDATE folders SET deleted_at=NULL, path=$4 || substring(path from $5::int) WHERE owner_id=$1 AND deleted_at IS NOT NULL AND (path=$2 OR path LIKE $3)`, [fo.owner_id, fo.path, oldLike, newPath, cut]);
  // 그 폴더로 삭제됐던 파일들 복원 + 경로 치환 (삭제 시 deleted_with_folder=최상위 폴더 경로로 통일됨)
  await query(`UPDATE files SET deleted_at=NULL, deleted_with_folder=NULL, folder=$3 || substring(folder from $4::int), updated_at=now() WHERE owner_id=$1 AND deleted_with_folder=$2`, [fo.owner_id, fo.path, newPath, cut]);
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

module.exports = router;
