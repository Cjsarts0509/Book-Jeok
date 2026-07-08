'use strict';

// 저장 디스크 총 용량 및 할당 현황 계산
const fs = require('fs/promises');
const config = require('./config');
const { query } = require('./db');

// 저장소가 위치한 디스크의 총 용량(bytes)
async function diskTotalBytes() {
  try {
    const s = await fs.statfs(config.storageRoot);
    return s.blocks * s.bsize;
  } catch {
    return 0;
  }
}

// 관리자를 제외한 계정들에 할당된 quota 합계 (excludeId 계정은 제외)
async function allocatedBytes(excludeId) {
  const r = await query(
    "SELECT COALESCE(SUM(quota_bytes),0) AS s FROM users WHERE role <> 'admin'" + (excludeId ? ' AND id <> $1' : ''),
    excludeId ? [excludeId] : []
  );
  return Number(r.rows[0].s);
}

// 새 할당(newQuota)을 적용했을 때 총 할당이 디스크 총량을 넘는지 검사
async function validateAllocation(newQuota, excludeId) {
  if (!newQuota || newQuota <= 0) return { ok: true };
  const total = await diskTotalBytes();
  if (total <= 0) return { ok: true }; // 총량 조회 실패 시 통과
  const others = await allocatedBytes(excludeId);
  if (others + newQuota > total) {
    return { ok: false, total, others, available: Math.max(0, total - others) };
  }
  return { ok: true };
}

module.exports = { diskTotalBytes, allocatedBytes, validateAllocation };
