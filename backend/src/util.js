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

// 레이트리밋 키: 감사/이상로그와 동일한 '실제 클라이언트 IP'(cf-connecting-ip) 기준.
// 이게 없으면 터널/프록시 홉의 req.ip 로 폴백(그래도 전역버킷화보다는 나음).
function rateKey(req) { return clientIp(req) || req.ip || 'unknown'; }

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
//  - admin   : 모든 계정 접근(외부업체·영업점 포함)
//  - manager : 본인 + 외부업체(role='user') 계정만 접근. 영업점(role='branch')은 접근 불가.
//  - user(외부업체)/branch(영업점) : 본인만
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

module.exports = { clientIp, rateKey, audit, wrap, canAccessOwner };
