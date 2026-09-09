'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { query } = require('../db');
const { hashPassword, verifyPassword, encryptSecret, decryptSecret, DUMMY_HASH } = require('../crypto');
const { authenticate } = require('../middleware/auth');
const { audit, wrap, clientIp, rateKey } = require('../util');
const { shareQrEnabled } = require('../settings');
const notify = require('../notify');
const totp = require('../totp');
const QRCode = require('qrcode');

// IP 마스킹 (알림 표시용): 마지막 옥텟/그룹만 가림
function maskIp(ip) {
  if (!ip) return '알 수 없는 위치';
  if (ip.includes('.')) return ip.replace(/\.\d+$/, '.•••');
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + ':•••';
  return ip;
}

// 이상 로그인 감지: 해당 계정에서 처음 보는 IP면 인앱 알림 (최초 로그인은 제외)
async function checkNewLocation(user, req) {
  try {
    const ip = clientIp(req);
    const ua = String(req.headers['user-agent'] || '').slice(0, 300);
    const prior = await query(
      'SELECT (SELECT COUNT(*) FROM login_events WHERE user_id=$1) AS total, (SELECT COUNT(*) FROM login_events WHERE user_id=$1 AND ip=$2) AS sameip',
      [user.id, ip]
    );
    const total = Number(prior.rows[0].total), sameip = Number(prior.rows[0].sameip);
    await query('INSERT INTO login_events (user_id, ip, user_agent) VALUES ($1,$2,$3)', [user.id, ip, ua]);
    if (total > 0 && sameip === 0) {
      await notify.push({
        userId: user.id, type: 'login_new', title: '새로운 위치에서 로그인',
        body: `${maskIp(ip)} 에서 로그인되었습니다. 본인이 아니라면 즉시 비밀번호를 변경하세요.`,
      });
    }
  } catch (err) { console.error('[login-anomaly]', err.message); }
}

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
  keyGenerator: rateKey,
  message: { error: '로그인 실패가 너무 많습니다. 15분 후 다시 시도하세요.' },
});

function issueToken(res, user) {
  const token = jwt.sign(
    // tv(token_version): 로그아웃·비번변경·2FA변경 시 서버에서 올려 기존 토큰을 무효화하는 값
    { sub: user.id, username: user.username, role: user.role, tv: Number(user.token_version || 0) },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn, algorithm: 'HS256' }
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
    'SELECT id, username, display_name, role, password_hash, is_active, totp_enabled, totp_secret, token_version FROM users WHERE username = $1',
    [username]
  );
  const user = result.rows[0];
  // 타이밍 공격 완화를 위해 계정이 없어도 동일한 비용의 검증을 수행(DUMMY_HASH 는 유효한 60자 해시)
  const ok = user ? await verifyPassword(password, user.password_hash) : await verifyPassword(password, DUMMY_HASH);
  if (!user || !ok || !user.is_active) {
    await audit(req, 'login_failed', username);
    return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  }

  // 2단계 인증(TOTP)이 켜진 계정은 6자리 코드 확인
  if (user.totp_enabled) {
    const code = String(req.body.token || '').trim();
    if (!code) return res.status(401).json({ error: '인증 앱의 6자리 코드를 입력하세요.', need2fa: true });
    let sec = '';
    try { sec = decryptSecret(user.totp_secret); } catch (_) { sec = ''; }
    if (!totp.verify(sec, code)) {
      await audit(req, 'login_failed', `${username} (2fa)`);
      return res.status(401).json({ error: '인증 코드가 올바르지 않습니다.', need2fa: true });
    }
  }

  const token = issueToken(res, user);
  // req 를 펼쳐 복사하면 headers 가 따라오지 않아 IP 를 못 읽는다 — 행위자만 따로 넘긴다
  await audit(req, 'login', '', user.id, user);
  await checkNewLocation(user, req);
  // 관리자는 2FA 필수 — 미설정 시 강제 설정 안내
  const mustSetup2fa = user.role === 'admin' && !user.totp_enabled;
  res.json({
    token,
    mustSetup2fa,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role,
      qrEnabled: shareQrEnabled(),
    },
  });
}));

// POST /api/auth/logout
router.post('/logout', authenticate, wrap(async (req, res) => {
  res.clearCookie(config.cookieName);
  // 쿠키만 지우면 localStorage 의 Bearer 토큰이 8시간 그대로 살아있다 → token_version 을 올려 실제로 폐기
  await query('UPDATE users SET token_version = token_version + 1 WHERE id=$1', [req.user.id]);
  await audit(req, 'logout', '');
  res.json({ ok: true });
}));

// GET /api/auth/me
router.get('/me', authenticate, wrap(async (req, res) => {
  const s = await query('SELECT email, notify_email, upload_conflict, totp_enabled FROM users WHERE id=$1', [req.user.id]);
  const row = s.rows[0] || {};
  res.json({
    user: {
      id: req.user.id,
      username: req.user.username,
      displayName: req.user.display_name,
      role: req.user.role,
      email: row.email || '',
      notifyEmail: row.notify_email !== false,
      uploadConflict: row.upload_conflict || 'rename',
      totpEnabled: !!row.totp_enabled,
      qrEnabled: shareQrEnabled(),
    },
  });
}));

// ── 2단계 인증(TOTP) ──────────
// 이미 2FA 가 켜져 있으면 재등록을 막는다(해제 → 재등록 순서만 허용).
//  해제는 비밀번호를 요구하므로, 토큰만 훔친 공격자가 2FA 를 자기 것으로 갈아끼우는 경로가 닫힌다.
//  (프런트도 켜져 있을 땐 '해제'만 노출하므로 동작 변화 없음. 관리자가 인증기를 분실하면 DB 초기화로 해결)
function blockReenroll(req, res, next) {
  if (req.user.totp_enabled) {
    return res.status(403).json({ error: '이미 2단계 인증이 켜져 있습니다. 다시 등록하려면 먼저 해제하세요.' });
  }
  next();
}
// 등록 시작: 새 시크릿을 pending에 저장하고 QR 반환
router.post('/2fa/setup', authenticate, blockReenroll, wrap(async (req, res) => {
  const secret = totp.generateSecret();
  await query('UPDATE users SET totp_pending=$1 WHERE id=$2', [encryptSecret(secret), req.user.id]);
  const url = totp.otpauthURL(req.user.username, secret);
  const qr = await QRCode.toDataURL(url);
  res.json({ secret, otpauthUrl: url, qr });
}));
// 등록 확인: pending 시크릿으로 코드 검증 후 활성화
router.post('/2fa/enable', authenticate, blockReenroll, wrap(async (req, res) => {
  const code = String(req.body.token || '').trim();
  const r = await query('SELECT totp_pending FROM users WHERE id=$1', [req.user.id]);
  const pending = r.rows[0] && r.rows[0].totp_pending;
  if (!pending) return res.status(400).json({ error: '먼저 2단계 인증 설정을 시작하세요.' });
  let sec = '';
  try { sec = decryptSecret(pending); } catch (_) { sec = ''; }
  if (!totp.verify(sec, code)) return res.status(400).json({ error: '인증 코드가 올바르지 않습니다. 앱의 최신 코드를 입력하세요.' });
  // 2FA 활성화 = 인증 상태 변화 → 기존 토큰 폐기(다른 기기/침입자 세션 축출) 후 본인 세션만 재발급
  await query("UPDATE users SET totp_secret=$1, totp_enabled=true, totp_pending='', token_version = token_version + 1 WHERE id=$2", [pending, req.user.id]);
  await audit(req, '2fa_enabled', '');
  const u = await query('SELECT id, username, role, token_version FROM users WHERE id=$1', [req.user.id]);
  res.json({ ok: true, token: issueToken(res, u.rows[0]) });
}));
// 해제: 관리자는 불가(필수). 비밀번호 확인 후 해제.
router.post('/2fa/disable', authenticate, wrap(async (req, res) => {
  if (req.user.role === 'admin') return res.status(403).json({ error: '관리자는 2단계 인증을 해제할 수 없습니다.' });
  const r = await query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
  if (!(await verifyPassword(String(req.body.password || ''), r.rows[0].password_hash))) return res.status(400).json({ error: '비밀번호가 올바르지 않습니다.' });
  // 2FA 해제도 인증 상태의 변화 → 기존 토큰 폐기(본인 세션은 아래에서 재발급)
  await query("UPDATE users SET totp_secret='', totp_enabled=false, totp_pending='', token_version = token_version + 1 WHERE id=$1", [req.user.id]);
  await audit(req, '2fa_disabled', '');
  const u2 = await query('SELECT id, username, role, token_version FROM users WHERE id=$1', [req.user.id]);
  res.json({ ok: true, token: issueToken(res, u2.rows[0]) });
}));

// PATCH /api/auth/settings  (본인 설정: 동일이름 처리 등. 제공된 필드만 갱신)
router.patch('/settings', authenticate, wrap(async (req, res) => {
  const sets = []; const vals = []; let i = 1;
  if (req.body.email !== undefined) {
    const email = String(req.body.email || '').trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: '이메일 형식이 올바르지 않습니다.' });
    sets.push(`email=$${i++}`); vals.push(email);
  }
  if (req.body.uploadConflict !== undefined) {
    sets.push(`upload_conflict=$${i++}`); vals.push(req.body.uploadConflict === 'overwrite' ? 'overwrite' : 'rename');
  }
  if (!sets.length) return res.json({ ok: true });
  vals.push(req.user.id);
  await query(`UPDATE users SET ${sets.join(', ')}, updated_at=now() WHERE id=$${i}`, vals);
  await audit(req, 'update_settings', sets.map((s) => s.split('=')[0]).join(','));
  res.json({ ok: true });
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
  // 비밀번호를 바꾸면 다른 기기/침입자의 기존 세션도 함께 끊어야 의미가 있다 → token_version 증가
  await query(
    'UPDATE users SET password_hash = $1, password_enc = $2, token_version = token_version + 1, updated_at = now() WHERE id = $3',
    [hash, enc, req.user.id]
  );
  await audit(req, 'change_password_self', '');
  // 본인 세션은 유지되도록 새 토큰을 재발급(비번 변경 후 즉시 로그아웃되는 불편 방지)
  const u = await query('SELECT id, username, role, token_version FROM users WHERE id=$1', [req.user.id]);
  const token = issueToken(res, u.rows[0]);
  res.json({ ok: true, token });
}));

module.exports = router;
