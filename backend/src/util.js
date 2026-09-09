'use strict';

const { query } = require('./db');

function clientIp(req) {
  const h = (req && req.headers) || {};   // 요청을 복사해 넘기는 호출부가 있어 방어적으로 읽는다
  return (
    h['cf-connecting-ip'] ||
    (h['x-forwarded-for'] || '').split(',')[0].trim() ||
    req?.socket?.remoteAddress ||
    ''
  );
}

// 레이트리밋 키: 감사/이상로그와 동일한 '실제 클라이언트 IP'(cf-connecting-ip) 기준.
// 이게 없으면 터널/프록시 홉의 req.ip 로 폴백(그래도 전역버킷화보다는 나음).
function rateKey(req) { return clientIp(req) || req.ip || 'unknown'; }

// 감사 기록. ownerId = '어느 계정의 클라우드에서 벌어진 일인지'.
//  생략하면 resolveOwner 가 세팅한 req.targetOwnerId(대부분의 파일 라우트) → 없으면 본인 계정으로 본다.
//  계정 전환으로 남의 클라우드에서 한 작업도 그 클라우드 기준으로 남아, 계정별 활동 조회가 가능해진다.
// actor 를 주면 그 사람이 한 일로 기록한다(로그인처럼 req.user 가 아직 없는 시점용).
async function audit(req, action, detail = '', ownerId, actor) {
  const who = actor || req.user;
  const owner = ownerId !== undefined ? ownerId : (req.targetOwnerId ?? who?.id ?? null);
  const row = { userId: who?.id || null, action, detail, ip: clientIp(req), ownerId: owner || null };
  try {
    // 해시 사슬로 이어 붙인다 — 나중에 누가 조용히 고치거나 지우면 검증에서 드러난다(S5)
    await require('./auditChain').append(row);
  } catch (err) {
    console.error('[audit] 사슬 기록 실패:', err.message);
    // 사슬을 못 써도 기록 자체는 남겨야 한다(사슬 밖 기록은 검증 대상에서 빠진다)
    try {
      await query(
        'INSERT INTO audit_log (user_id, action, detail, ip, owner_id) VALUES ($1, $2, $3, $4, $5)',
        [row.userId, row.action, row.detail, row.ip, row.ownerId]
      );
    } catch (e2) { console.error('[audit] 기록 실패:', e2.message); }
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
