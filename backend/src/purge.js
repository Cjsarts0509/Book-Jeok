'use strict';

// 휴지통 자동 영구삭제: deleted_at 이 보관기간(관리자 설정, 기본 30일) 지난 파일/폴더를 완전 제거.
const path = require('path');
const fsp = require('fs/promises');
const config = require('./config');
const { query } = require('./db');
const { trashRetentionDays } = require('./settings');

async function purgeOldTrash() {
  try {
    const cutoff = new Date(Date.now() - trashRetentionDays() * 86400000).toISOString();
    // 만료된 파일: 디스크 제거 후 행 삭제
    const files = await query('SELECT id, owner_id, stored_name FROM files WHERE deleted_at IS NOT NULL AND deleted_at < $1', [cutoff]);
    for (const f of files.rows) {
      await fsp.unlink(path.join(config.storageRoot, String(f.owner_id), f.stored_name)).catch(() => {});
    }
    if (files.rowCount > 0) await query('DELETE FROM files WHERE id = ANY($1::bigint[])', [files.rows.map((f) => f.id)]);
    // 만료된 폴더 행 삭제
    const folders = await query('DELETE FROM folders WHERE deleted_at IS NOT NULL AND deleted_at < $1 RETURNING id', [cutoff]);
    if (files.rowCount || folders.rowCount) {
      console.log(`[purge] 휴지통 영구삭제: 파일 ${files.rowCount}건, 폴더 ${folders.rowCount}건`);
    }
    await purgeStaleBundles();
    await purgeStaleChunks();
  } catch (err) {
    console.error('[purge] 실패:', err.message);
  }
}

// 미완료(버려진) 청크 업로드 임시폴더 정리: 하루 이상 방치된 조각 디렉터리 삭제.
async function purgeStaleChunks() {
  try {
    const chunkRoot = path.join(config.storageRoot, '_chunks');
    let entries;
    try { entries = await fsp.readdir(chunkRoot, { withFileTypes: true }); } catch { return; }
    const cutoff = Date.now() - 86400000; // 1일
    let removed = 0;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(chunkRoot, e.name);
      try { const st = await fsp.stat(p); if (st.mtimeMs < cutoff) { await fsp.rm(p, { recursive: true, force: true }); removed++; } } catch { /* skip */ }
    }
    if (removed > 0) console.log(`[purge] 미완료 청크 정리: ${removed}건`);
  } catch (err) {
    console.error('[purge] 청크 정리 실패:', err.message);
  }
}

// 오래된 zip 번들 정리: 하루 지났고 유효한 공유가 없는 번들 삭제.
// (기존엔 새 zip 생성 시에만 정리돼, 압축 활동이 없으면 디스크에 계속 쌓였음 → 스케줄러로 이관)
async function purgeStaleBundles() {
  try {
    const bundleDir = path.join(config.storageRoot, '_bundles');
    const r = await query(
      `SELECT id, stored_name FROM zip_bundles b
       WHERE b.created_at < now() - interval '1 day'
         AND NOT EXISTS (SELECT 1 FROM share_links s WHERE s.bundle_id = b.id AND (s.expires_at IS NULL OR s.expires_at > now()))`
    );
    for (const b of r.rows) {
      await fsp.unlink(path.join(bundleDir, b.stored_name)).catch(() => {});
      await query('DELETE FROM zip_bundles WHERE id=$1', [b.id]);
    }
    if (r.rowCount > 0) console.log(`[purge] 만료 번들 정리: ${r.rowCount}건`);
  } catch (err) {
    console.error('[purge] 번들 정리 실패:', err.message);
  }
}

// 서버 기동 시 1회 + 하루마다 실행
function startPurgeScheduler() {
  purgeOldTrash();
  setInterval(purgeOldTrash, 24 * 60 * 60 * 1000).unref();
}

module.exports = { purgeOldTrash, startPurgeScheduler };
