'use strict';

// 휴지통 자동 영구삭제: deleted_at 이 보관기간(관리자 설정, 기본 30일) 지난 파일/폴더를 완전 제거.
const path = require('path');
const fsp = require('fs/promises');
const config = require('./config');
const { query } = require('./db');
const { trashRetentionDays } = require('./settings');
const officePdf = require('./officePdf');

async function purgeOldTrash() {
  try {
    const cutoff = new Date(Date.now() - trashRetentionDays() * 86400000).toISOString();
    // 만료된 파일: 디스크 제거 후 행 삭제
    const files = await query('SELECT id, owner_id, stored_name FROM files WHERE deleted_at IS NOT NULL AND deleted_at < $1', [cutoff]);
    for (const f of files.rows) {
      await fsp.unlink(path.join(config.storageRoot, String(f.owner_id), f.stored_name)).catch(() => {});
      await officePdf.dropCache(f.stored_name);   // 그 파일의 변환 PDF 캐시도 함께 제거
    }
    if (files.rowCount > 0) await query('DELETE FROM files WHERE id = ANY($1::bigint[])', [files.rows.map((f) => f.id)]);
    // 만료된 폴더 행 삭제
    const folders = await query('DELETE FROM folders WHERE deleted_at IS NOT NULL AND deleted_at < $1 RETURNING id', [cutoff]);
    if (files.rowCount || folders.rowCount) {
      console.log(`[purge] 휴지통 영구삭제: 파일 ${files.rowCount}건, 폴더 ${folders.rowCount}건`);
    }
    await purgeStaleBundles();
    await purgeStaleChunks();
    await purgeOrphanPdfCache();
    await purgeOrphanUploads();
    await purgeOldLogs();
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

// 고아 PDF 캐시 정리: files 에 더 이상 없는 stored_name 의 _pdfcache/*.pdf 제거
// (dropCache 를 못 탄 과거 삭제분·크래시 케이스까지 회수 → 무한증가로 볼륨 채우는 것 방지)
async function purgeOrphanPdfCache() {
  try {
    let entries;
    try { entries = await fsp.readdir(officePdf.CACHE_DIR, { withFileTypes: true }); } catch { return; }
    const pdfs = entries.filter((e) => e.isFile() && e.name.endsWith('.pdf'));
    if (!pdfs.length) return;
    const live = new Set((await query('SELECT stored_name FROM files')).rows.map((r) => r.stored_name));
    let removed = 0;
    for (const e of pdfs) {
      const key = e.name.slice(0, -4); // stored_name (확장자 .pdf 제거)
      if (!live.has(key)) { await fsp.unlink(path.join(officePdf.CACHE_DIR, e.name)).catch(() => {}); removed++; }
    }
    if (removed > 0) console.log(`[purge] 고아 PDF 캐시 정리: ${removed}건`);
  } catch (err) {
    console.error('[purge] PDF 캐시 정리 실패:', err.message);
  }
}

// 고아 업로드 파일 회수: 크래시 등으로 DB insert 전에 죽으면 userDir 에 UUID 파일만 남는다.
// files.stored_name 에 없고 6시간 이상 지난(진행 중 업로드와의 경합 방지) 파일을 삭제.
async function purgeOrphanUploads() {
  try {
    const root = config.storageRoot;
    let dirs;
    try { dirs = await fsp.readdir(root, { withFileTypes: true }); } catch { return; }
    const ownerDirs = dirs.filter((d) => d.isDirectory() && /^\d+$/.test(d.name)); // 숫자(=owner id) 디렉터리만
    if (!ownerDirs.length) return;
    const live = new Set((await query('SELECT stored_name FROM files')).rows.map((r) => r.stored_name)); // 활성+휴지통 모두
    const cutoff = Date.now() - 6 * 3600000;
    let removed = 0;
    for (const d of ownerDirs) {
      const dir = path.join(root, d.name);
      let entries; try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isFile() || live.has(e.name)) continue;
        const p = path.join(dir, e.name);
        try { const st = await fsp.stat(p); if (st.mtimeMs < cutoff) { await fsp.unlink(p); removed++; } } catch { /* skip */ }
      }
    }
    if (removed > 0) console.log(`[purge] 고아 업로드 파일 회수: ${removed}건`);
  } catch (err) {
    console.error('[purge] 고아 업로드 정리 실패:', err.message);
  }
}

// 오래된 감사로그/로그인이벤트 정리(무한증가 방지). 보안 추적용이라 넉넉히 보관.
async function purgeOldLogs() {
  try {
    // 사슬 검증(S5)이 '정상적인 정리'를 변조로 오해하지 않도록, 잘라낸 지점을 먼저 확인해 기록한다
    const cut = await query("SELECT MAX(chain_seq) AS s FROM audit_log WHERE created_at < now() - interval '365 days' AND chain_seq IS NOT NULL");
    const a = await query("DELETE FROM audit_log WHERE created_at < now() - interval '365 days'");
    if (cut.rows[0].s) await require('./auditChain').notePrune(Number(cut.rows[0].s));
    const l = await query("DELETE FROM login_events WHERE created_at < now() - interval '180 days'");
    if (a.rowCount || l.rowCount) console.log(`[purge] 오래된 로그 정리: 감사 ${a.rowCount}건, 로그인 ${l.rowCount}건`);
  } catch (err) {
    console.error('[purge] 로그 정리 실패:', err.message);
  }
}

// 서버 기동 시 1회 + 하루마다 실행
function startPurgeScheduler() {
  purgeOldTrash();
  setInterval(purgeOldTrash, 24 * 60 * 60 * 1000).unref();
}

module.exports = { purgeOldTrash, startPurgeScheduler };
