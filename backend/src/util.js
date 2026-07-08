'use strict';

const { query } = require('./db');

function clientIp(req) {
  return (
    (req.headers['cf-connecting-ip']) ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    ''
  );
}

async function audit(req, action, detail = '') {
  try {
    await query(
      'INSERT INTO audit_log (user_id, action, detail, ip) VALUES ($1, $2, $3, $4)',
      [req.user?.id || null, action, detail, clientIp(req)]
    );
  } catch (err) {
    console.error('[audit] 기록 실패:', err.message);
  }
}

// async 라우트 핸들러의 에러를 next 로 전달
function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { clientIp, audit, wrap };
