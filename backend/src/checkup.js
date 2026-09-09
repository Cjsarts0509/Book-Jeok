'use strict';

// 정기 점검 — "지금 당장은 안 아픈데 나중에 크게 아플 것"을 미리 찾는다.
//   S7  파일 실물↔DB 정합성 : DB엔 있는데 디스크에 없는 파일 · 크기 불일치 · 주인 없는 파일
//   S24 좀비 리소스 리포트   : 회수 가능한 공간이 어디에 얼마나 남아 있는지(지우기 전에 먼저 보여준다)
//
// 결과는 STORAGE_ROOT/_status/checkups/<name>.json 에 남긴다.
// 호스트에서 도는 점검(백업 검증·복원 리허설·의존성 취약점)은 스크립트가 같은 폴더에 써 넣고,
// 관리자 화면은 출처와 상관없이 이 폴더를 한 번에 읽어 보여준다.
const path = require('path');
const fsp = require('fs/promises');
const config = require('./config');
const { query } = require('./db');
const disk = require('./disk');
const officePdf = require('./officePdf');
const { trashRetentionDays } = require('./settings');
const alerts = require('./alerts');

const DIR = path.join(config.storageRoot, '_status', 'checkups');
const userDir = (ownerId) => path.join(config.storageRoot, String(ownerId));

async function save(name, data) {
  try {
    await fsp.mkdir(DIR, { recursive: true });
    await fsp.writeFile(path.join(DIR, `${name}.json`), JSON.stringify({ ...data, name, at: new Date().toISOString() }, null, 2));
  } catch (e) { console.warn(`[checkup] ${name} 결과 저장 실패:`, e.message); }
}
async function load(name) {
  try { return JSON.parse(await fsp.readFile(path.join(DIR, `${name}.json`), 'utf8')); } catch { return null; }
}
async function loadAll() {
  const names = ['integrity', 'cleanup', 'backup-verify', 'restore-drill', 'deps', 'deploy'];
  const out = {};
  for (const n of names) out[n] = await load(n);
  return out;
}

// ── S7 · 파일 실물 ↔ DB 정합성 ─────────────────────────
// 파일이 많을 수 있으므로 한 번에 다 읽지 않고 id 순서로 나눠 훑는다.
// 업로드 직후 경합을 피하려고 최근 10분 내 생성된 행은 건너뛴다.
const INTEGRITY_PAGE = 2000;
const SAMPLE_MAX = 50;               // 화면에 보여줄 예시 개수(전체 목록은 너무 길다)
async function integrityCheck({ deep = false } = {}) {
  const started = Date.now();
  const missing = [], sizeMismatch = [];
  let checked = 0, lastId = 0, missingCount = 0, mismatchCount = 0, missingBytes = 0;

  for (;;) {
    const r = await query(
      `SELECT id, owner_id, stored_name, original_name, folder, size_bytes, deleted_at
       FROM files WHERE id > $1 AND created_at < now() - interval '10 minutes'
       ORDER BY id LIMIT $2`, [lastId, INTEGRITY_PAGE]);
    if (r.rowCount === 0) break;
    for (const f of r.rows) {
      lastId = Number(f.id);
      checked++;
      let st = null;
      try { st = await fsp.stat(path.join(userDir(f.owner_id), f.stored_name)); }
      catch { st = null; }
      if (!st) {
        missingCount++; missingBytes += Number(f.size_bytes) || 0;
        if (missing.length < SAMPLE_MAX) missing.push({ id: Number(f.id), owner: f.owner_id, name: f.original_name, folder: f.folder, size: Number(f.size_bytes), trashed: !!f.deleted_at });
        continue;
      }
      if (deep && st.size !== Number(f.size_bytes)) {
        mismatchCount++;
        if (sizeMismatch.length < SAMPLE_MAX) sizeMismatch.push({ id: Number(f.id), owner: f.owner_id, name: f.original_name, dbSize: Number(f.size_bytes), diskSize: st.size });
      }
    }
    if (r.rowCount < INTEGRITY_PAGE) break;
  }

  // 반대 방향 — 디스크에는 있는데 DB가 모르는 파일(크래시로 남은 조각 등)
  const live = new Set((await query('SELECT stored_name FROM files')).rows.map((x) => x.stored_name));
  const orphans = []; let orphanCount = 0, orphanBytes = 0;
  let dirs = [];
  try { dirs = (await fsp.readdir(config.storageRoot, { withFileTypes: true })).filter((d) => d.isDirectory() && /^\d+$/.test(d.name)); } catch { /* 저장소 없음 */ }
  for (const d of dirs) {
    let entries = [];
    try { entries = await fsp.readdir(path.join(config.storageRoot, d.name), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || live.has(e.name)) continue;
      let st = null;
      try { st = await fsp.stat(path.join(config.storageRoot, d.name, e.name)); } catch { continue; }
      orphanCount++; orphanBytes += st.size;
      if (orphans.length < SAMPLE_MAX) orphans.push({ owner: Number(d.name), stored: e.name, size: st.size, mtime: new Date(st.mtimeMs).toISOString() });
    }
  }

  const result = {
    ok: missingCount === 0 && mismatchCount === 0,
    deep, checked, elapsedMs: Date.now() - started,
    missingCount, missingBytes, missing,
    mismatchCount, sizeMismatch,
    orphanCount, orphanBytes, orphans,
    note: '실물이 없는 파일은 목록엔 보이지만 다운로드가 실패합니다. 볼륨 스냅샷에서 복구하거나, 복구가 불가하면 행을 정리해야 합니다.',
  };
  await save('integrity', result);
  if (missingCount > 0) {
    alerts.raise('integrity', missingCount > 20 ? 'danger' : 'warn', '파일 실물이 사라진 항목이 있습니다',
      `${checked}개 중 ${missingCount}개의 실물 파일을 찾을 수 없습니다(합계 ${(missingBytes / 1048576).toFixed(1)}MB). 관리자 > 점검 탭에서 목록을 확인하세요.`);
  } else if (mismatchCount > 0) {
    alerts.raise('integrity', 'warn', '파일 크기가 기록과 다릅니다', `${mismatchCount}건의 크기 불일치가 발견됐습니다(전송 중 잘렸을 수 있습니다).`);
  } else alerts.clear('integrity');
  return result;
}

// ── S24 · 좀비 리소스 정리 리포트 ──────────────────────
// 지우지 않고 '얼마나 회수할 수 있는지'만 센다. 실제 삭제는 기존 purge 스케줄러가 한다.
async function dirBytes(dir, filter) {
  let bytes = 0, count = 0;
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return { bytes, count }; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) { const sub = await dirBytes(p, filter); bytes += sub.bytes; count += sub.count; continue; }
      const st = await fsp.stat(p);
      if (filter && !filter(e.name, st)) continue;
      bytes += st.size; count++;
    } catch { /* skip */ }
  }
  return { bytes, count };
}
async function cleanupReport() {
  const started = Date.now();
  const root = config.storageRoot;
  const items = [];
  const add = (key, label, count, bytes, hint) => items.push({ key, label, count, bytes, hint });

  // 1) 보관기간이 지난 휴지통 — 다음 purge 에서 영구삭제될 것
  const days = trashRetentionDays();
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const tf = await query('SELECT COUNT(*)::int AS c, COALESCE(SUM(size_bytes),0) AS b FROM files WHERE deleted_at IS NOT NULL AND deleted_at < $1', [cutoff]);
  add('trash-expired', `보관기간(${days}일) 지난 휴지통`, tf.rows[0].c, Number(tf.rows[0].b), '다음 자동 정리에서 영구 삭제됩니다.');

  // 2) 아직 보관기간 안이지만 휴지통에 있는 것 — 사용자가 비우면 즉시 회수되는 공간
  const tf2 = await query('SELECT COUNT(*)::int AS c, COALESCE(SUM(size_bytes),0) AS b FROM files WHERE deleted_at IS NOT NULL AND deleted_at >= $1', [cutoff]);
  add('trash-live', '휴지통(보관기간 내)', tf2.rows[0].c, Number(tf2.rows[0].b), '사용자가 휴지통을 비우면 바로 회수됩니다.');

  // 3) 유효한 공유가 없는 오래된 zip 번들
  const zb = await query(
    `SELECT COUNT(*)::int AS c, COALESCE(SUM(size_bytes),0) AS b FROM zip_bundles b
     WHERE b.created_at < now() - interval '1 day'
       AND NOT EXISTS (SELECT 1 FROM share_links s WHERE s.bundle_id = b.id AND (s.expires_at IS NULL OR s.expires_at > now()))`);
  add('bundles', '만료된 압축 번들', zb.rows[0].c, Number(zb.rows[0].b), '다음 자동 정리에서 삭제됩니다.');

  // 4) 문서 변환 PDF 캐시 — 지워도 다시 만들어지는 순수 캐시
  const pdfc = await dirBytes(officePdf.CACHE_DIR, (n) => n.endsWith('.pdf'));
  add('pdf-cache', '문서 변환 캐시', pdfc.count, pdfc.bytes, '지워도 다시 열 때 자동으로 만들어집니다.');

  // 5) 중단된 청크 업로드 임시폴더
  const chunks = await dirBytes(path.join(root, '_chunks'));
  add('chunks', '중단된 분할 업로드 임시파일', chunks.count, chunks.bytes, '하루 지난 것은 자동 정리됩니다.');

  // 6) 주인 없는 업로드 파일(DB에 없는 실물)
  const live = new Set((await query('SELECT stored_name FROM files')).rows.map((x) => x.stored_name));
  let orphanCount = 0, orphanBytes = 0;
  let dirs = [];
  try { dirs = (await fsp.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory() && /^\d+$/.test(d.name)); } catch { /* 없음 */ }
  for (const d of dirs) {
    let entries = [];
    try { entries = await fsp.readdir(path.join(root, d.name), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || live.has(e.name)) continue;
      try { const st = await fsp.stat(path.join(root, d.name, e.name)); orphanCount++; orphanBytes += st.size; } catch { /* skip */ }
    }
  }
  add('orphan-uploads', '주인 없는 업로드 파일', orphanCount, orphanBytes, '6시간 지난 것은 자동 회수됩니다.');

  // 7) 만료된 공유 링크(공간은 아니지만 정리 대상)
  const sh = await query('SELECT COUNT(*)::int AS c FROM share_links WHERE expires_at IS NOT NULL AND expires_at < now()');
  add('expired-shares', '만료된 공유 링크', sh.rows[0].c, 0, '접근은 이미 차단되어 있습니다. 공유 탭에서 정리할 수 있습니다.');

  const du = await disk.diskUsage();
  const reclaimable = items.filter((x) => x.key !== 'trash-live').reduce((a, b) => a + b.bytes, 0);
  const result = {
    ok: true, elapsedMs: Date.now() - started, items,
    reclaimableBytes: reclaimable,
    trashLiveBytes: items.find((x) => x.key === 'trash-live').bytes,
    disk: { total: du.total, avail: du.avail, usedPct: du.total > 0 ? Math.round((du.used / du.total) * 100) : 0 },
    note: '여기 숫자는 "지우면 이만큼 돌아온다"는 뜻입니다. 실제 삭제는 자동 정리가 맡습니다.',
  };
  await save('cleanup', result);
  return result;
}

// ── 스케줄 ─────────────────────────────────────────────
// 정합성 검사는 디스크를 많이 읽으므로 새벽에, 정리 리포트는 가볍게 하루 한 번.
const DAY = 24 * 60 * 60 * 1000;
function startScheduler() {
  const run = (fn, label) => { fn().catch((e) => console.error(`[checkup] ${label} 실패:`, e.message)); };
  // 기동 직후에는 돌리지 않는다(부팅 부하와 겹치지 않게). 10분 뒤 첫 실행.
  setTimeout(() => {
    run(cleanupReport, '정리 리포트');
    run(() => integrityCheck({ deep: false }), '정합성 검사');
  }, 10 * 60 * 1000).unref();
  setInterval(() => run(cleanupReport, '정리 리포트'), DAY).unref();
  setInterval(() => run(() => integrityCheck({ deep: false }), '정합성 검사'), 7 * DAY).unref();
  console.log('[checkup] 정기 점검 예약됨 — 정리 리포트 매일 · 정합성 검사 매주');
}

module.exports = { integrityCheck, cleanupReport, loadAll, load, save, startScheduler, DIR };
