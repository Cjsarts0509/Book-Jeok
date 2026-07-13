'use strict';

// 저장 디스크 총 용량 및 할당 현황 계산
const fs = require('fs/promises');
const path = require('path');
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

// 디스크 실사용/여유 (statfs 기준: OS·DB·캐시 등 파일시스템 전체) — 사용자 파일 합계와 다름
async function diskUsage() {
  try {
    const s = await fs.statfs(config.storageRoot);
    const total = s.blocks * s.bsize, free = s.bfree * s.bsize, avail = s.bavail * s.bsize;
    return { total, free, avail, used: Math.max(0, total - free) };
  } catch {
    return { total: 0, free: 0, avail: 0, used: 0 };
  }
}

// 특정 디렉터리의 총 용량(bytes) — 변환 캐시·압축 임시처럼 시스템이 쓰는 폴더 측정용
async function dirSize(dir) {
  let total = 0, entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try { total += e.isDirectory() ? await dirSize(p) : (await fs.stat(p)).size; } catch { /* skip */ }
  }
  return total;
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

module.exports = { diskTotalBytes, allocatedBytes, validateAllocation, diskUsage, dirSize };
