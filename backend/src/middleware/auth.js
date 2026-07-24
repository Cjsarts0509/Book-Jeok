'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');
const { query } = require('../db');

// 요청에서 JWT 를 추출해 검증하고 req.user 를 채웁니다.
async function authenticate(req, res, next) {
  try {
    let token = req.cookies?.[config.cookieName];
    const header = req.headers.authorization;
    if (!token && header?.startsWith('Bearer ')) {
      token = header.slice(7);
    }
    if (!token) {
      return res.status(401).json({ error: '로그인이 필요합니다.' });
    }

    const payload = jwt.verify(token, config.jwtSecret);
    // 토큰 발급 후 계정이 비활성/삭제되었을 수 있으므로 DB 재확인
    const result = await query(
      'SELECT id, username, display_name, role, is_active, totp_enabled FROM users WHERE id = $1',
      [payload.sub]
    );
    if (result.rowCount === 0 || !result.rows[0].is_active) {
      return res.status(401).json({ error: '유효하지 않은 계정입니다.' });
    }
    req.user = result.rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ error: '인증에 실패했습니다.' });
  }
}

// 관리자 전용 라우트 보호
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
  }
  next();
}

module.exports = { authenticate, requireAdmin };
