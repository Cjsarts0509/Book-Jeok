'use strict';

// 접속 거점(Cloudflare colo) 감시 — "새 주소가 아직 서울로 들어오나"를 실제 사용자 접속으로 계속 본다.
//
// 배경: bookjeok.cjslabs.kr 은 hosting.kr DNS 에 Cloudflare IP 를 직접 적어(A 104.16.0.1 · 162.159.140.16)
//   KT 회선에서도 서울(ICN) 거점으로 들어오게 했다. Cloudflare 가 자동 배정하는 무료 대역(104.21.x · 172.67.x)은
//   KT 에서 LAX·SEA·NRT 로 돌아 첫 응답이 수백 ms~수 초였다. 그런데 이 IP 는 우리가 «고정»한 것이라,
//   Cloudflare 의 IP 운영이나 KT 의 경로가 바뀌면 소리 없이 다시 해외로 돌 수 있다.
//   서버(오라클)는 KT 회선이 아니어서 스스로 재 볼 수 없다 → 실제 직원들 요청의 cf-ray 끝 3글자(거점)를 센다.
//
// - 센다: EDGE_WATCH_HOSTS(기본 bookjeok.cjslabs.kr)로 온 /api 요청 중 국내(CF-IPCountry=KR, 헤더가 없으면 국내로 친다)
// - 단위: 요청 수가 아니라 «서로 다른 접속 IP 수» — 한 사람이 폴링을 많이 해도 비율을 흔들지 못하게
// - 판단: 최근 60분 국내 접속이 EDGE_MIN_CLIENTS(5) 이상일 때만. 밤처럼 사람이 적으면 판단을 미룬다(경보 상태 유지).
//   ICN 비율 < EDGE_WARN_PCT(70) → 주의, < EDGE_DANGER_PCT(40) → 위험(메일까지). 회복되면 해소 알림.
//   SKT·LGU+ 는 KT 와 경로가 달라 일부만 해외일 수 있다 → 알림에 거점별 인원을 같이 적는다.
// - 대체 IP 찾기: 관리자 화면 서버 상태 → «거점 진단 스크립트»(frontend/tools/cf-ip-probe.ps1)를 KT 회선 PC 에서 돌린다.
const alerts = require('./alerts');
const { clientIp } = require('./util');

const list = (v, d) => String(v == null || v === '' ? d : v).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const WATCH_HOSTS = list(process.env.EDGE_WATCH_HOSTS, 'bookjeok.cjslabs.kr');
const HOME_COLOS = list(process.env.EDGE_HOME_COLOS, 'ICN').map((s) => s.toUpperCase());
const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const WARN_PCT = num(process.env.EDGE_WARN_PCT, 70);
const DANGER_PCT = num(process.env.EDGE_DANGER_PCT, 40);
const MIN_CLIENTS = num(process.env.EDGE_MIN_CLIENTS, 5);
const WINDOW_MIN = 60;
const BUCKET_MIN = 10;                    // 10분 칸 × 144 = 24시간 보관
const KEEP_BUCKETS = (24 * 60) / BUCKET_MIN;
const MAX_IPS = 5000;                     // 한 칸·한 거점에 담는 IP 상한(메모리 고정)

const buckets = [];                       // { slot, colos: Map<colo, { req, ips:Set }> } — 감시 주소·국내만
const slotOf = (t) => Math.floor(t / (BUCKET_MIN * 60000));

function bucketNow(now = Date.now()) {
  const s = slotOf(now);
  let b = buckets[buckets.length - 1];
  if (!b || b.slot !== s) { b = { slot: s, colos: new Map() }; buckets.push(b); }
  while (buckets.length > KEEP_BUCKETS) buckets.shift();
  return b;
}

// 요청 하나를 센다(테스트에서 직접 부르려고 분리)
function record({ host, ray, country, ip }, now = Date.now()) {
  host = String(host || '').toLowerCase().split(':')[0];
  if (!WATCH_HOSTS.includes(host)) return false;
  country = String(country || '').toUpperCase();
  if (country && country !== 'KR' && country !== 'XX') return false;   // 해외발(크롤러 등)은 경로 판단에서 뺀다
  ray = String(ray || '');
  const colo = ray.includes('-') ? ray.split('-').pop().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(colo)) return false;
  const b = bucketNow(now);
  let c = b.colos.get(colo);
  if (!c) { c = { req: 0, ips: new Set() }; b.colos.set(colo, c); }
  c.req++;
  if (ip && c.ips.size < MAX_IPS) c.ips.add(ip);
  return true;
}

function middleware(req, res, next) {
  try {
    record({ host: req.get('host'), ray: req.headers['cf-ray'], country: req.headers['cf-ipcountry'], ip: clientIp(req) });
  } catch (_) { /* 집계 실패가 요청을 막지 않게 */ }
  next();
}

// 최근 windowMin 분 거점별 인원(같은 IP 가 두 거점에 잡히면 각각 센다 — 그 자체가 경로가 흔들린다는 신호)
function stats(windowMin = WINDOW_MIN, now = Date.now()) {
  const from = slotOf(now - windowMin * 60000);
  const agg = new Map();
  for (const b of buckets) {
    if (b.slot < from) continue;
    for (const [colo, c] of b.colos) {
      const a = agg.get(colo) || { req: 0, ips: new Set() };
      a.req += c.req; for (const ip of c.ips) a.ips.add(ip);
      agg.set(colo, a);
    }
  }
  const all = new Set();
  for (const a of agg.values()) for (const ip of a.ips) all.add(ip);
  const home = new Set();
  for (const [colo, a] of agg) if (HOME_COLOS.includes(colo)) for (const ip of a.ips) home.add(ip);
  const clients = all.size;
  const colos = [...agg.entries()]
    .map(([colo, a]) => ({ colo, clients: a.ips.size, requests: a.req, home: HOME_COLOS.includes(colo) }))
    .sort((x, y) => (y.clients - x.clients) || (y.requests - x.requests));
  return {
    windowMinutes: windowMin, clients, homeClients: home.size,
    homePct: clients ? Math.round((home.size / clients) * 100) : null,
    colos,
  };
}

const describe = (s) => s.colos.map((c) => `${c.colo} ${c.clients}명`).join(' · ');

function evaluate(now = Date.now()) {
  const s = stats(WINDOW_MIN, now);
  if (s.clients < MIN_CLIENTS) return s;            // 표본이 적으면 비율이 요동친다 — 지금 상태 유지
  const head = `최근 ${WINDOW_MIN}분 ${WATCH_HOSTS.join(', ')} 국내 접속 ${s.clients}명 중 서울(${HOME_COLOS.join('/')}) ${s.homeClients}명(${s.homePct}%) — ${describe(s)}.`;
  const how = '\nKT 등 통신사 경로나 Cloudflare IP 운영이 바뀌었을 수 있습니다. 관리자 화면 → 서버 상태 → «거점 진단 스크립트»를 KT 회선 PC 에서 실행해 서울로 가는 IP 를 찾은 뒤 hosting.kr 의 A 레코드(bookjeok · projectmanager)를 바꾸세요.';
  if (s.homePct < DANGER_PCT) alerts.raise('edge-colo', 'danger', '접속 대부분이 해외 거점을 돌고 있습니다', head + how);
  else if (s.homePct < WARN_PCT) alerts.raise('edge-colo', 'warn', '서울 거점으로 들어오는 접속이 줄었습니다', head + how);
  else alerts.clear('edge-colo', '', `다시 서울 거점으로 들어옵니다 — ${head}`);
  return s;
}

function snapshot(now = Date.now()) {
  return {
    hosts: WATCH_HOSTS, homeColos: HOME_COLOS,
    thresholds: { warnPct: WARN_PCT, dangerPct: DANGER_PCT, minClients: MIN_CLIENTS },
    hour: stats(60, now), day: stats(24 * 60, now),
  };
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => { try { evaluate(); } catch (_) { /* 판단 실패 무시 */ } }, BUCKET_MIN * 60000);
  timer.unref();
}
function stop() { if (timer) { clearInterval(timer); timer = null; } }
function _reset() { buckets.length = 0; }   // 시험용

module.exports = { middleware, record, stats, evaluate, snapshot, start, stop, _reset };
