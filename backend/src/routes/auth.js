'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { query } = require('../db');
const { hashPassword, verifyPassword, encryptSecret } = require('../crypto');
const { authenticate } = require('../middleware/auth');
const { audit, wrap } = require('../util');

const router = express.Router();

// 로그인 브루트포스 방어
// skipSuccessfulRequests: 성공한 로그인은 카운트하지 않음 → 정상 로그인은 절대 안 막힘.
// 오직 "실패한 시도"만 카운트하여 무차별 대입만 차단합니다.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '로그인 실패가 너무 많습니다. 15분 후 다시 시도하세요.' },
});

function issueToken(res, user) {
  const token = jwt.sign(
    { sub: user.id, username: user.username, role: user.role },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    secure: config.env === 'production',
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000,
  });
  return token;
}

// POST /api/auth/login
router.post('/login', loginLimiter, wrap(async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!username || !password) {
    return res.status(400).json({ error: '아이디와 비밀번호를 입력하세요.' });
  }

  const result = await query(
    'SELECT id, username, display_name, role, password_hash, is_active FROM users WHERE username = $1',
    [username]
  );
  const user = result.rows[0];
  // 타이밍 공격 완화를 위해 계정 없어도 검증 수행
  const ok = user ? await verifyPassword(password, user.password_hash) : await verifyPassword(password, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinv');
  if (!user || !ok || !user.is_active) {
    await audit(req, 'login_failed', username);
    return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  }

  const token = issueToken(res, user);
  await audit({ ...req, user }, 'login', '');
  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role,
    },
  });
}));

// POST /api/auth/logout
router.post('/logout', authenticate, wrap(async (req, res) => {
  res.clearCookie(config.cookieName);
  await audit(req, 'logout', '');
  res.json({ ok: true });
}));

// GET /api/auth/me
router.get('/me', authenticate, wrap(async (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      username: req.user.username,
      displayName: req.user.display_name,
      role: req.user.role,
    },
  });
}));

// POST /api/auth/change-password  (본인 비밀번호 변경)
router.post('/change-password', authenticate, wrap(async (req, res) => {
  const current = String(req.body.currentPassword || '');
  const next = String(req.body.newPassword || '');
  if (next.length < 8) {
    return res.status(400).json({ error: '새 비밀번호는 8자 이상이어야 합니다.' });
  }

  const result = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  const ok = await verifyPassword(current, result.rows[0].password_hash);
  if (!ok) {
    return res.status(400).json({ error: '현재 비밀번호가 올바르지 않습니다.' });
  }

  const hash = await hashPassword(next);
  const enc = encryptSecret(next);
  await query(
    'UPDATE users SET password_hash = $1, password_enc = $2, updated_at = now() WHERE id = $3',
    [hash, enc, req.user.id]
  );
  await audit(req, 'change_password_self', '');
  res.json({ ok: true });
}));

module.exports = router;
