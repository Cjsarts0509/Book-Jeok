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

// 감사 기록. ownerId = '어느 계정의 클라우드에서 벌어진 일인지'.
//  생략하면 resolveOwner 가 세팅한 req.targetOwnerId(대부분의 파일 라우트) → 없으면 본인 계정으로 본다.
//  계정 전환으로 남의 클라우드에서 한 작업도 그 클라우드 기준으로 남아, 계정별 활동 조회가 가능해진다.
async function audit(req, action, detail = '', ownerId) {
  try {
    const owner = ownerId !== undefined ? ownerId : (req.targetOwnerId ?? req.user?.id ?? null);
    await query(
      'INSERT INTO audit_log (user_id, action, detail, ip, owner_id) VALUES ($1, $2, $3, $4, $5)',
      [req.user?.id || null, action, detail, clientIp(req), owner || null]
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
//  - manager : 본인 + 외부업체(role='user')만. 영업점(role='branch') 웹하드는 열람 불가.
//              (재고조사 '전달'은 browse 가 아니라 전용 쓰기 경로로만 허용 — /stock-audit/deliver)
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
