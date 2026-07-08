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

// 권한 규칙:
//  - admin   : 모든 계정 접근
//  - manager : 본인 + 일반 사용자(role='user') 계정 접근 (관리자 기능은 불가)
//  - user    : 본인만
// ownerId 소유자에 대한 접근 가능 여부를 판정 (owner 미존재 시 false)
async function canAccessOwner(requester, ownerId) {
  if (Number(ownerId) === requester.id) return true;
  if (requester.role === 'admin') return true;
  if (requester.role === 'manager') {
    const r = await query('SELECT role FROM users WHERE id = $1', [ownerId]);
    return r.rowCount > 0 && r.rows[0].role === 'user';
  }
  return false;
}

module.exports = { clientIp, audit, wrap, canAccessOwner };
