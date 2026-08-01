'use strict';

// 공유 용량 풀(담당자 ↔ 소속 영업점) 계산 헬퍼.
//  · 영업점 계정(users.manager_id 설정됨)은 담당자의 용량을 함께 나눠 쓴다(파생).
//  · 풀 루트 = 담당자(또는 manager_id 없는 일반 계정은 자기 자신).
//  · 풀 사용량 = 루트 + 소속 영업점 전원의 파일 크기 합, 풀 할당량 = 루트의 quota_bytes.
//  · manager_id 가 없고 자식도 없는 기존 계정은 '자기 혼자 풀' → 기존 동작과 동일(하위호환).
const { query } = require('./db');

// ownerId 가 속한 풀의 루트 계정 id.
async function poolRootId(ownerId, q = query) {
  const r = await q('SELECT manager_id FROM users WHERE id=$1', [ownerId]);
  if (!r.rowCount) return Number(ownerId);
  return r.rows[0].manager_id ? Number(r.rows[0].manager_id) : Number(ownerId);
}

// 풀 할당량/사용량/무제한여부/구성원수. owner 를 넘기면 내부에서 루트로 환산(alreadyRoot=true 면 그대로 루트로 사용).
async function poolUsage(ownerOrRoot, q = query, alreadyRoot = false) {
  const rootId = alreadyRoot ? Number(ownerOrRoot) : await poolRootId(ownerOrRoot, q);
  const [qr, ur, mr] = await Promise.all([
    q('SELECT quota_bytes, role FROM users WHERE id=$1', [rootId]),
    q(`SELECT COALESCE(SUM(size_bytes),0) AS s FROM files
       WHERE deleted_at IS NULL AND owner_id IN (SELECT id FROM users WHERE id=$1 OR manager_id=$1)`, [rootId]),
    q('SELECT COUNT(*)::int AS c FROM users WHERE id=$1 OR manager_id=$1', [rootId]),
  ]);
  const quota = qr.rowCount ? Number(qr.rows[0].quota_bytes) : 0;
  const role = qr.rowCount ? qr.rows[0].role : 'user';
  return { rootId, quota, used: Number(ur.rows[0].s), unlimited: role === 'admin', memberCount: mr.rows[0].c };
}

module.exports = { poolRootId, poolUsage };
