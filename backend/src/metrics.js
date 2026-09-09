'use strict';

// 상시 관측 모듈 — 서버가 조용히 나빠지는 것을 사람이 알아채기 전에 잡는다.
//   S12 이벤트 루프 지연   : 응답이 느려지기 시작하는 순간을 수치로 본다
//   S13 메모리 누수 감시   : 힙이 되돌아오지 않고 우상향하는지 추세로 본다
//   S6  디스크 다단계 경보 : 75/85/92/96% 단계로 올라갈 때만 알린다
//   S30 DB 커넥션 풀       : 대기(waiting)가 쌓이면 풀이 모자란 것
//   S17 에러 집계          : 5분 창의 5xx 비율이 임계를 넘으면 알린다
//   S27 컨테이너 재시작    : 정상 종료 표시 없이 다시 떴으면 '예기치 않은 재시작'
//   S22 인덱스 사용률      : 안 쓰이는 인덱스 · 순차스캔이 잦은 테이블 (요청 시)
//
// 원칙: 측정이 서비스를 방해하지 않는다. 모든 타이머는 unref, 모든 샘플링은 try/catch.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('./config');
const { pool, query } = require('./db');
const disk = require('./disk');
const alerts = require('./alerts');

const STATE_DIR = path.join(config.storageRoot, '_status');
const STATE_FILE = path.join(STATE_DIR, 'runtime.json');

// ── 링버퍼: 최근 N개 샘플만 들고 있는다(메모리 상한 고정) ─────────
function ring(size) {
  const buf = [];
  return {
    push(v) { buf.push(v); if (buf.length > size) buf.shift(); },
    all: () => buf.slice(),
    last: () => (buf.length ? buf[buf.length - 1] : null),
  };
}
const percentile = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
// 최소제곱 기울기 (x = 인덱스). 메모리가 우상향인지 판단하는 데 쓴다.
function slope(ys) {
  const n = ys.length;
  if (n < 3) return 0;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += ys[i]; sxy += i * ys[i]; sxx += i * i; }
  const d = n * sxx - sx * sx;
  return d === 0 ? 0 : (n * sxy - sx * sy) / d;
}

// ── S12 · 이벤트 루프 지연 ─────────────────────────────
// setInterval 이 예정보다 얼마나 늦게 불렸는지 = 루프가 막혀 있던 시간.
const LOOP_TICK_MS = 500;
const LOOP_WARN_MS = parseInt(process.env.LOOP_LAG_WARN_MS || '200', 10);
const LOOP_DANGER_MS = parseInt(process.env.LOOP_LAG_DANGER_MS || '1000', 10);
const loopLag = ring(240);          // 약 2분치
let loopTimer = null, loopExpected = 0;
function startLoopMonitor() {
  loopExpected = Date.now() + LOOP_TICK_MS;
  loopTimer = setInterval(() => {
    const now = Date.now();
    loopLag.push(Math.max(0, now - loopExpected));
    loopExpected = now + LOOP_TICK_MS;
    evaluateLoop();
  }, LOOP_TICK_MS);
  loopTimer.unref();
}
function loopStats() {
  const a = loopLag.all();
  return { samples: a.length, p50: Math.round(percentile(a, 50)), p95: Math.round(percentile(a, 95)), max: Math.round(Math.max(0, ...a)) };
}
function evaluateLoop() {
  const s = loopStats();
  // 루프가 통째로 막히면 타이머도 못 돌아 '샘플 수'가 오히려 줄어든다.
  // → 한 번이라도 위험 수준으로 멈췄다면 표본 수와 무관하게 바로 알린다.
  if (s.max >= LOOP_DANGER_MS) {
    return alerts.raise('loop-lag', 'danger', '서버가 잠시 멈췄습니다',
      `이벤트 루프가 최대 ${s.max}ms 동안 응답하지 못했습니다 — 무거운 작업(대용량 압축·문서 변환)이 루프를 붙잡고 있을 수 있습니다.`);
  }
  if (s.samples < 20) return;                      // 여기부터는 추세 판단 → 표본이 필요
  if (s.p95 >= LOOP_WARN_MS) alerts.raise('loop-lag', 'warn', '서버 응답 지연 조짐', `이벤트 루프 지연 p95 ${s.p95}ms (기준 ${LOOP_WARN_MS}ms)`);
  else alerts.clear('loop-lag');
}

// ── S13 · 메모리 누수 감시 ─────────────────────────────
// 30초마다 힙을 기록하고, 최근 1시간 추세가 계속 우상향이면서 절대량도 크면 경보.
const MEM_TICK_MS = 30 * 1000;
const MEM_WARN_PCT = parseInt(process.env.HEAP_WARN_PCT || '80', 10);   // heapUsed / heapTotal
const memSamples = ring(120);       // 30초 × 120 = 1시간
function sampleMemory() {
  const m = process.memoryUsage();
  memSamples.push({ at: Date.now(), rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external });
  evaluateMemory();
}
function memStats() {
  const a = memSamples.all();
  const last = a[a.length - 1] || { rss: 0, heapUsed: 0, heapTotal: 1, external: 0 };
  return {
    rss: last.rss, heapUsed: last.heapUsed, heapTotal: last.heapTotal, external: last.external,
    heapPct: last.heapTotal > 0 ? Math.round((last.heapUsed / last.heapTotal) * 100) : 0,
    // 샘플당 증가량(bytes) → 시간당 증가량으로 환산
    growthPerHour: Math.round(slope(a.map((x) => x.heapUsed)) * (3600000 / MEM_TICK_MS)),
    samples: a.length, windowMinutes: Math.round((a.length * MEM_TICK_MS) / 60000),
    series: a.map((x) => ({ at: x.at, heapUsed: x.heapUsed, rss: x.rss })),
  };
}
function evaluateMemory() {
  const s = memStats();
  if (s.samples < 40) return;                       // 20분은 봐야 추세라 할 수 있다
  const mb = (b) => (b / 1048576).toFixed(0);
  const leaking = s.growthPerHour > 32 * 1048576 && s.heapPct >= MEM_WARN_PCT;  // 시간당 32MB↑ + 힙 포화
  if (leaking) alerts.raise('heap-leak', 'warn', '메모리가 계속 늘고 있습니다', `최근 ${s.windowMinutes}분 추세로 시간당 약 ${mb(s.growthPerHour)}MB 증가 · 힙 ${s.heapPct}% (${mb(s.heapUsed)}/${mb(s.heapTotal)}MB) — 누수가 의심됩니다.`);
  // 힙 비율만 높은 것은 신호가 아니다 — V8 은 필요할 때 heapTotal 을 늘리므로
  // 갓 뜬 프로세스도 80~90%를 오간다. 절대량이 충분히 클 때만 의미를 둔다.
  else if (s.heapPct >= 95 && s.heapUsed >= 256 * 1048576) alerts.raise('heap-leak', 'warn', '힙 메모리가 거의 찼습니다', `힙 ${s.heapPct}% (${mb(s.heapUsed)}/${mb(s.heapTotal)}MB)`);
  else alerts.clear('heap-leak');
}

// ── S6 · 디스크 다단계 경보 ────────────────────────────
// 올라갈 때만 알린다(같은 단계에 머무는 동안은 조용). 내려오면 해제 알림 한 번.
const DISK_LEVELS = [
  { at: 96, level: 'danger', label: '위험' },
  { at: 92, level: 'danger', label: '심각' },
  { at: 85, level: 'warn', label: '경고' },
  { at: 75, level: 'info', label: '주의' },
];
const DISK_TICK_MS = 60 * 1000;
let diskLast = { total: 0, used: 0, avail: 0, usedPct: 0, level: 'ok', at: null };
let diskStep = -1;                    // 현재 단계 인덱스(작을수록 심각). -1 = 정상
async function sampleDisk() {
  try {
    const d = await disk.diskUsage();
    const usedPct = d.total > 0 ? Math.round((d.used / d.total) * 100) : 0;
    const hitIdx = DISK_LEVELS.findIndex((x) => usedPct >= x.at);
    diskLast = { ...d, usedPct, level: hitIdx >= 0 ? DISK_LEVELS[hitIdx].level : 'ok', at: new Date().toISOString() };
    const gb = (b) => (b / 1073741824).toFixed(1);
    if (hitIdx < 0) {
      if (diskStep >= 0) alerts.clear('disk', '디스크 여유 회복', `사용률 ${usedPct}% · 남은 공간 ${gb(d.avail)}GB`);
      diskStep = -1; return;
    }
    // hitIdx 가 작아질수록 심각 — 더 심각해졌을 때만 새로 알린다
    if (diskStep === -1 || hitIdx < diskStep) {
      const L = DISK_LEVELS[hitIdx];
      alerts.raise('disk', L.level, `디스크 ${L.label} — 사용률 ${usedPct}%`,
        `남은 공간 ${gb(d.avail)}GB / 전체 ${gb(d.total)}GB. 오래된 백업·변환 캐시·휴지통을 정리하거나 볼륨을 늘려 주세요.`);
    }
    diskStep = hitIdx;
  } catch (_) { /* 측정 실패는 조용히 넘긴다 */ }
}

// ── S30 · DB 커넥션 풀 ────────────────────────────────
const POOL_TICK_MS = 10 * 1000;
const poolSamples = ring(180);      // 30분치
let poolWaitStreak = 0;
function samplePool() {
  const s = { at: Date.now(), total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
  poolSamples.push(s);
  if (s.waiting > 0) poolWaitStreak++; else poolWaitStreak = 0;
  // 30초(3틱) 넘게 대기가 있으면 풀이 모자라거나 느린 쿼리가 붙잡고 있는 것
  if (poolWaitStreak >= 3) {
    alerts.raise('db-pool', poolWaitStreak >= 12 ? 'danger' : 'warn', 'DB 커넥션 대기가 쌓이고 있습니다',
      `대기 ${s.waiting}건 · 사용 중 ${s.total - s.idle}/${config.db.max} — 느린 쿼리가 커넥션을 붙잡고 있거나 DB_POOL_MAX 가 모자랍니다.`);
  } else if (poolWaitStreak === 0) alerts.clear('db-pool');
}
function poolStats() {
  const a = poolSamples.all();
  return {
    max: config.db.max, total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount,
    inUse: Math.max(0, pool.totalCount - pool.idleCount),
    peakInUse: a.length ? Math.max(...a.map((x) => x.total - x.idle)) : 0,
    peakWaiting: a.length ? Math.max(...a.map((x) => x.waiting)) : 0,
    series: a.map((x) => ({ at: x.at, inUse: x.total - x.idle, waiting: x.waiting })),
  };
}

// ── S17 · 에러 집계와 임계 알림 ────────────────────────
// 요청 결과를 1분 버킷으로 모아 최근 5분 창의 5xx 비율을 본다.
const ERR_BUCKETS = 10;             // 10분치
const ERR_MIN_REQUESTS = parseInt(process.env.ERROR_ALERT_MIN_REQUESTS || '20', 10);
const ERR_WARN_PCT = parseInt(process.env.ERROR_ALERT_WARN_PCT || '5', 10);
const ERR_DANGER_PCT = parseInt(process.env.ERROR_ALERT_DANGER_PCT || '20', 10);
const buckets = [];                 // { minute, total, e4xx, e5xx, routes: Map }
const errorSamples = [];            // 최근 5xx 상세(최신 우선, 최대 30건)
const minuteOf = (t) => Math.floor(t / 60000);
function bucketNow() {
  const m = minuteOf(Date.now());
  let b = buckets[buckets.length - 1];
  if (!b || b.minute !== m) { b = { minute: m, total: 0, e4xx: 0, e5xx: 0, routes: new Map() }; buckets.push(b); }
  while (buckets.length > ERR_BUCKETS) buckets.shift();
  return b;
}
// express 미들웨어 — 라우트별 결과를 집계한다(경로에서 숫자 id 는 :id 로 묶음).
function requestMetrics(req, res, next) {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    try {
      const b = bucketNow();
      b.total++;
      const s = res.statusCode;
      if (s >= 500) b.e5xx++; else if (s >= 400) b.e4xx++;
      const route = (req.baseUrl || '') + ((req.route && req.route.path) || req.path || '');
      const key = route.replace(/\/\d+/g, '/:id').slice(0, 120) || '/';
      const cur = b.routes.get(key) || { total: 0, e5xx: 0, ms: 0 };
      cur.total++; if (s >= 500) cur.e5xx++;
      cur.ms += Number(process.hrtime.bigint() - started) / 1e6;
      b.routes.set(key, cur);
      if (s >= 500) {
        errorSamples.unshift({ at: new Date().toISOString(), method: req.method, route: key, status: s });
        if (errorSamples.length > 30) errorSamples.length = 30;
      }
    } catch (_) { /* 집계 실패가 응답을 망치지 않게 */ }
  });
  next();
}
function errorStats(windowMinutes = 5) {
  const from = minuteOf(Date.now()) - windowMinutes + 1;
  const win = buckets.filter((b) => b.minute >= from);
  const total = win.reduce((a, b) => a + b.total, 0);
  const e5xx = win.reduce((a, b) => a + b.e5xx, 0);
  const e4xx = win.reduce((a, b) => a + b.e4xx, 0);
  const routes = new Map();
  for (const b of win) {
    for (const [k, v] of b.routes) {
      const cur = routes.get(k) || { total: 0, e5xx: 0, ms: 0 };
      cur.total += v.total; cur.e5xx += v.e5xx; cur.ms += v.ms; routes.set(k, cur);
    }
  }
  return {
    windowMinutes, total, e4xx, e5xx,
    errorPct: total > 0 ? Math.round((e5xx / total) * 1000) / 10 : 0,
    perMinute: buckets.map((b) => ({ minute: b.minute, total: b.total, e4xx: b.e4xx, e5xx: b.e5xx })),
    topRoutes: [...routes.entries()]
      .map(([route, v]) => ({ route, total: v.total, e5xx: v.e5xx, avgMs: Math.round(v.ms / Math.max(1, v.total)) }))
      .sort((a, b) => (b.e5xx - a.e5xx) || (b.total - a.total)).slice(0, 8),
    recent: errorSamples.slice(0, 10),
  };
}
function evaluateErrors() {
  const s = errorStats(5);
  if (s.total < ERR_MIN_REQUESTS) return;           // 표본이 적으면 비율이 요동친다
  const worst = s.topRoutes.find((r) => r.e5xx > 0);
  const detail = `최근 5분 요청 ${s.total}건 중 서버오류 ${s.e5xx}건 (${s.errorPct}%)${worst ? ` · 가장 많은 곳: ${worst.route}` : ''}`;
  if (s.errorPct >= ERR_DANGER_PCT) alerts.raise('error-rate', 'danger', '서버 오류가 급증했습니다', detail);
  else if (s.errorPct >= ERR_WARN_PCT) alerts.raise('error-rate', 'warn', '서버 오류 비율이 높습니다', detail);
  else alerts.clear('error-rate');
}

// ── S27 · 컨테이너 재시작 감지 ─────────────────────────
// 30초마다 '살아있음' 표시를 남기고, 종료 시 정상종료 표시를 찍는다.
// 부팅 때 이전 기록이 '정상종료'가 아니면 예기치 않은 재시작으로 본다.
const HEARTBEAT_MS = 30 * 1000;
const bootAt = Date.now();
let restartInfo = { boots: 0, unexpected: false, previous: null };
async function writeState(patch) {
  try {
    await fsp.mkdir(STATE_DIR, { recursive: true });
    let cur = {};
    try { cur = JSON.parse(await fsp.readFile(STATE_FILE, 'utf8')); } catch (_) { /* 첫 기동 */ }
    await fsp.writeFile(STATE_FILE, JSON.stringify({ ...cur, ...patch }, null, 2));
  } catch (_) { /* 상태파일 실패는 서비스에 영향 없음 */ }
}
async function checkRestart() {
  let prev = null;
  try { prev = JSON.parse(await fsp.readFile(STATE_FILE, 'utf8')); } catch (_) { prev = null; }
  const boots = ((prev && prev.boots) || 0) + 1;
  restartInfo = {
    boots,
    unexpected: !!(prev && prev.cleanShutdown === false),
    previous: prev ? { bootAt: prev.bootAt, lastSeen: prev.lastSeen, cleanShutdown: prev.cleanShutdown } : null,
  };
  await writeState({ boots, bootAt: new Date(bootAt).toISOString(), lastSeen: new Date().toISOString(), cleanShutdown: false, pid: process.pid });
  if (restartInfo.unexpected && prev) {
    const lived = prev.bootAt && prev.lastSeen ? Math.round((new Date(prev.lastSeen) - new Date(prev.bootAt)) / 60000) : null;
    alerts.event('restart', 'warn', '서버가 예기치 않게 재시작되었습니다',
      `정상 종료 절차 없이 다시 시작했습니다(누적 ${boots}회 기동)${lived != null ? ` · 직전 인스턴스는 약 ${lived}분 가동` : ''}. 컨테이너 강제 종료·OOM·크래시 여부를 확인해 주세요.`);
  }
}
// 정상 종료 시 호출 — 다음 부팅에서 '예기치 않음'으로 오인하지 않도록 표시를 남긴다.
function markCleanShutdown() {
  try {
    const cur = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...cur, cleanShutdown: true, lastSeen: new Date().toISOString() }, null, 2));
  } catch (_) { /* 무시 */ }
}

// ── S22 · 인덱스 사용률 점검 ──────────────────────────
// 한 번도 안 쓰인 인덱스(쓰기 비용만 내는 것)와, 순차스캔이 잦은 테이블(인덱스 부족)을 찾는다.
// 통계 조회가 가볍지 않으므로 요청 시에만 수행하고 5분간 캐시한다.
let idxCache = { at: 0, data: null };
async function indexReport(force) {
  if (!force && idxCache.data && Date.now() - idxCache.at < 5 * 60 * 1000) return idxCache.data;
  const [idx, tbl] = await Promise.all([
    query(`
      SELECT s.relname AS table, s.indexrelname AS index, s.idx_scan::bigint AS scans,
             pg_relation_size(s.indexrelid) AS bytes, i.indisunique AS is_unique, i.indisprimary AS is_primary
      FROM pg_stat_user_indexes s JOIN pg_index i ON i.indexrelid = s.indexrelid
      ORDER BY s.idx_scan ASC, pg_relation_size(s.indexrelid) DESC`),
    query(`
      SELECT relname AS table, seq_scan::bigint AS seq_scan, idx_scan::bigint AS idx_scan,
             n_live_tup::bigint AS rows, pg_relation_size(relid) AS bytes
      FROM pg_stat_user_tables ORDER BY seq_scan DESC`),
  ]);
  const indexes = idx.rows.map((r) => ({
    table: r.table, index: r.index, scans: Number(r.scans), bytes: Number(r.bytes),
    unique: r.is_unique, primary: r.is_primary,
  }));
  const tables = tbl.rows.map((r) => {
    const seq = Number(r.seq_scan), ix = Number(r.idx_scan || 0), rows = Number(r.rows);
    return {
      table: r.table, seqScan: seq, idxScan: ix, rows, bytes: Number(r.bytes),
      seqPct: (seq + ix) > 0 ? Math.round((seq / (seq + ix)) * 100) : 0,
      // 행이 많은데 순차스캔이 대부분이면 인덱스가 부족하다는 신호
      needsIndex: rows >= 1000 && seq > 100 && seq / (seq + ix) > 0.5,
    };
  });
  // PK·UNIQUE 는 무결성 목적이라 안 쓰여도 지우면 안 된다 → 후보에서 제외
  const unused = indexes.filter((x) => x.scans === 0 && !x.primary && !x.unique);
  const data = {
    at: new Date().toISOString(),
    indexes, tables, unused,
    unusedBytes: unused.reduce((a, b) => a + b.bytes, 0),
    needIndex: tables.filter((t) => t.needsIndex),
    note: '통계는 마지막 pg_stat_reset 이후 누적치입니다. 서버를 새로 띄운 직후라면 표본이 적어 판단을 미뤄 주세요.',
  };
  idxCache = { at: Date.now(), data };
  return data;
}

// ── 종합 스냅샷 (상태 대시보드 S1) ─────────────────────
function snapshot() {
  return {
    at: new Date().toISOString(),
    process: {
      pid: process.pid, uptime: process.uptime(), node: process.version,
      bootAt: new Date(bootAt).toISOString(), boots: restartInfo.boots,
      unexpectedRestart: restartInfo.unexpected, previous: restartInfo.previous,
    },
    loop: { ...loopStats(), warnMs: LOOP_WARN_MS, dangerMs: LOOP_DANGER_MS },
    memory: memStats(),
    disk: { ...diskLast, steps: DISK_LEVELS },
    dbPool: poolStats(),
    errors: errorStats(5),
    alerts: alerts.snapshot(),
  };
}

let timers = [];
function start() {
  startLoopMonitor();
  const every = (fn, ms) => {
    const t = setInterval(() => { try { const r = fn(); if (r && r.catch) r.catch(() => {}); } catch (_) { /* 샘플링 실패 무시 */ } }, ms);
    t.unref(); timers.push(t); return t;
  };
  sampleMemory(); every(sampleMemory, MEM_TICK_MS);
  sampleDisk(); every(sampleDisk, DISK_TICK_MS);
  samplePool(); every(samplePool, POOL_TICK_MS);
  every(evaluateErrors, 60 * 1000);
  checkRestart().catch(() => {});
  every(() => writeState({ lastSeen: new Date().toISOString() }), HEARTBEAT_MS);
  console.log('[metrics] 관측 시작 — 이벤트루프·메모리·디스크·DB풀·에러율 감시 중');
}
function stop() { timers.forEach(clearInterval); timers = []; if (loopTimer) { clearInterval(loopTimer); loopTimer = null; } }

module.exports = {
  start, stop, snapshot, requestMetrics, indexReport, markCleanShutdown,
  errorStats, memStats, loopStats, poolStats,
  evaluateErrors, evaluateLoop, evaluateMemory, sampleDisk, samplePool,   // 테스트·수동 점검용
};
