'use strict';

// 휴지통 자동 영구삭제: deleted_at 이 1년 지난 파일/폴더를 완전 제거.
const path = require('path');
const fsp = require('fs/promises');
const config = require('./config');
const { query } = require('./db');

const RETENTION_MS = 365 * 24 * 60 * 60 * 1000; // 1년

async function purgeOldTrash() {
  try {
    const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
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
  } catch (err) {
    console.error('[purge] 실패:', err.message);
  }
}

// 서버 기동 시 1회 + 하루마다 실행
function startPurgeScheduler() {
  purgeOldTrash();
  setInterval(purgeOldTrash, 24 * 60 * 60 * 1000).unref();
}

module.exports = { purgeOldTrash, startPurgeScheduler, RETENTION_MS };
