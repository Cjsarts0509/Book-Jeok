'use strict';

const express = require('express');
const config = require('../config');
const { query, healthStats } = require('../db');
const { hashPassword, encryptSecret, decryptSecret, generatePassword } = require('../crypto');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { audit, wrap } = require('../util');

const router = express.Router();
router.use(authenticate, requireAdmin);

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

module.exports = router;
