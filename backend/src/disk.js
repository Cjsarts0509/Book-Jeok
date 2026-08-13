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

// 저장 볼륨(=pgdata 공용) 여유공간 가드: 임계치 이하로 떨어지면 새 쓰기를 거절해
// 디스크 풀로 Postgres 가 죽는 것을 막는다. statfs 실패 시엔 통과(기존 동작 유지).
// 인증 업로드(files) · 공개 업로드 링크(uploadLink) · 재고조사 전달이 공용으로 쓴다.
const DISK_HEADROOM = 2 * 1024 * 1024 * 1024; // 최소 2GB 여유 확보
async function diskGate(req, res, next) {
  try {
    const { avail, total } = await diskUsage();
    const headroom = Math.max(DISK_HEADROOM, Math.floor(total * 0.03)); // 2GB 또는 3% 중 큰 값
    if (total > 0 && avail < headroom) {
      return res.status(507).json({ error: '서버 저장 공간이 부족합니다. 관리자에게 문의하세요.' });
    }
  } catch (_) { /* 측정 실패 → 통과 */ }
  next();
}

module.exports = { diskTotalBytes, allocatedBytes, validateAllocation, diskUsage, dirSize, diskGate };
