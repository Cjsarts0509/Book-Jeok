#!/usr/bin/env node
'use strict';

// 북적북적 부하 테스트 (S29)
//
// "몇 명까지 버티나"를 감이 아니라 숫자로 알기 위한 도구. 외부 라이브러리 없이 Node 만으로 돈다.
// 기본은 읽기 전용 시나리오라 운영에 부담은 주되 데이터를 바꾸지 않는다.
//
//   node scripts/bookjeok-loadtest.js --url http://localhost:4000 --user admin --pass '비번' --totp 123456
//     [--users 20] [--duration 30] [--scenario mixed|list|download|search] [--write] [--yes]
//
//   --users     동시 사용자 수 (기본 10)
//   --duration  지속 시간(초) (기본 30)
//   --scenario  mixed(기본)=목록·검색·미리보기 섞기 / list / download / search
//   --write     업로드·삭제까지 포함(테스트 폴더에만). 지정 안 하면 읽기 전용.
//   --yes       운영 주소로 보이는 곳에도 확인 없이 진행
//
// 출력: 시나리오별 요청 수, 성공률, p50/p90/p95/p99, 최대 지연, 초당 요청 수(RPS).
// 판단 기준: p95 가 평소의 3배 이상으로 벌어지거나 오류율이 1%를 넘으면 그 지점이 한계다.

const http = require('http');
const https = require('https');
const { URL } = require('url');

// ── 인자 ───────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : def;
};
const has = (name) => argv.includes('--' + name);

const BASE = String(arg('url', 'http://localhost:4000')).replace(/\/$/, '');
const USER = arg('user', 'admin');
const PASS = arg('pass', '');
const TOTP = arg('totp', '');
const CONCURRENCY = parseInt(arg('users', '10'), 10);
const DURATION = parseInt(arg('duration', '30'), 10);
const SCENARIO = String(arg('scenario', 'mixed'));
const WRITE = has('write');

if (!PASS) {
  console.error('비밀번호가 필요합니다:  --pass <비밀번호>  (2단계 인증을 켠 계정이면 --totp <6자리>)');
  process.exit(1);
}

// ── HTTP ───────────────────────────────────────────────
const agentHttp = new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY * 2 });
const agentHttps = new https.Agent({ keepAlive: true, maxSockets: CONCURRENCY * 2 });

function request(method, pathOrUrl, { token, body, discard } = {}) {
  return new Promise((resolve) => {
    const u = new URL(pathOrUrl.startsWith('http') ? pathOrUrl : BASE + pathOrUrl);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    const started = process.hrtime.bigint();
    const req = lib.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search, method, headers, agent: isHttps ? agentHttps : agentHttp,
    }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on('data', (c) => { bytes += c.length; if (!discard && bytes < 2_000_000) chunks.push(c); });
      res.on('end', () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        let data = null;
        if (!discard) { try { data = JSON.parse(Buffer.concat(chunks).toString()); } catch (_) { data = null; } }
        resolve({ status: res.statusCode, ms, bytes, data });
      });
    });
    req.on('error', (e) => resolve({ status: 0, ms: Number(process.hrtime.bigint() - started) / 1e6, bytes: 0, error: e.message }));
    req.setTimeout(60000, () => { req.destroy(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// ── 통계 ───────────────────────────────────────────────
const stats = new Map();   // label -> { n, fail, limited, ms: [], bytes }
const statusCount = new Map();      // 상태코드별 집계 — '왜' 실패했는지 바로 보이게
const errorSample = new Map();      // 상태코드 -> 서버가 준 첫 메시지
function record(label, r) {
  let s = stats.get(label);
  if (!s) { s = { n: 0, fail: 0, limited: 0, ms: [], bytes: 0 }; stats.set(label, s); }
  s.n++; s.bytes += r.bytes || 0;
  const code = r.status || 0;
  statusCount.set(code, (statusCount.get(code) || 0) + 1);
  if (code !== 200 && !errorSample.has(code)) errorSample.set(code, (r.data && r.data.error) || r.error || '');
  // 429 는 서버가 '못 버틴' 게 아니라 '일부러 막은' 것 — 실패와 섞으면 판단을 그르친다
  if (r.status === 429) s.limited++;
  else if (!(r.status >= 200 && r.status < 400)) s.fail++;
  s.ms.push(r.ms);
}
const pct = (arr, p) => {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
};
const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 's' : n.toFixed(0) + 'ms');
const bytesFmt = (b) => (b >= 1 << 30 ? (b / (1 << 30)).toFixed(1) + 'GB' : b >= 1 << 20 ? (b / (1 << 20)).toFixed(1) + 'MB' : (b / 1024).toFixed(0) + 'KB');

// ── 시나리오 ───────────────────────────────────────────
async function login() {
  const r = await request('POST', '/api/auth/login', { body: { username: USER, password: PASS, token: TOTP || undefined } });
  if (r.status !== 200 || !r.data || !r.data.token) {
    console.error('로그인 실패:', r.status, (r.data && r.data.error) || r.error || '');
    if (r.data && r.data.need2fa) console.error('→ 2단계 인증이 켜진 계정입니다. --totp 로 6자리 코드를 넘겨 주세요.');
    process.exit(1);
  }
  return r.data.token;
}

async function scenarioStep(token, ctx) {
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  if (SCENARIO === 'list' || (SCENARIO === 'mixed' && Math.random() < 0.45)) {
    const folder = ctx.folders.length ? pick(ctx.folders) : '/';
    record('목록 조회', await request('GET', `/api/files?folder=${encodeURIComponent(folder)}`, { token }));
    return;
  }
  if (SCENARIO === 'search' || (SCENARIO === 'mixed' && Math.random() < 0.5)) {
    const q = pick(['20', '리스트', 'xlsx', '재고', 'a']);
    record('검색', await request('GET', `/api/files/search?q=${encodeURIComponent(q)}`, { token }));
    return;
  }
  if (SCENARIO === 'download' || SCENARIO === 'mixed') {
    if (!ctx.fileIds.length) { record('목록 조회', await request('GET', '/api/files?folder=%2F', { token })); return; }
    const id = pick(ctx.fileIds);
    record('다운로드', await request('GET', `/api/files/${id}/download`, { token, discard: true }));
    return;
  }
  record('사용량', await request('GET', '/api/files/usage/summary', { token }));
}

// ── 실행 ───────────────────────────────────────────────
(async () => {
  const looksProd = /^https:/.test(BASE) && !/localhost|127\.0\.0\.1/.test(BASE);
  if (looksProd && !has('yes')) {
    console.error(`\n⚠️  운영으로 보이는 주소입니다: ${BASE}`);
    console.error('    실제 사용자와 같은 서버에 부하를 겁니다. 한가한 시간에, 짧게 시작하세요.');
    console.error('    계속하려면 --yes 를 붙여 다시 실행하세요.\n');
    process.exit(1);
  }
  if (WRITE) {
    console.error('⚠️  --write 는 아직 지원하지 않습니다(운영 데이터를 건드리지 않기 위해). 읽기 전용으로 진행합니다.\n');
  }

  console.log(`북적북적 부하 테스트 — ${BASE}`);
  console.log(`  동시 사용자 ${CONCURRENCY}명 · ${DURATION}초 · 시나리오 ${SCENARIO} (읽기 전용)\n`);

  const token = await login();

  // 실제 데이터를 대상으로 돌리기 위해 폴더·파일 목록을 미리 확보
  const ctx = { folders: ['/'], fileIds: [] };
  const tree = await request('GET', '/api/files/tree', { token });
  if (tree.data && Array.isArray(tree.data.folders)) ctx.folders = ['/', ...tree.data.folders.slice(0, 30)];
  const root = await request('GET', '/api/files?folder=%2F', { token });
  if (root.data && Array.isArray(root.data.files)) ctx.fileIds = root.data.files.slice(0, 30).map((f) => f.id);
  console.log(`  대상 폴더 ${ctx.folders.length}개 · 파일 ${ctx.fileIds.length}개\n`);

  const endAt = Date.now() + DURATION * 1000;
  let inflight = 0, done = 0;
  const startedAt = Date.now();
  const tick = setInterval(() => {
    const sec = Math.round((Date.now() - startedAt) / 1000);
    process.stdout.write(`\r  진행 ${sec}/${DURATION}초 · 요청 ${done}건 · 동시 ${inflight}   `);
  }, 1000);

  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (Date.now() < endAt) {
      inflight++;
      try { await scenarioStep(token, ctx); } catch (_) { /* 개별 실패는 통계에 이미 잡힌다 */ }
      inflight--; done++;
    }
  }));
  clearInterval(tick);
  const elapsed = (Date.now() - startedAt) / 1000;
  process.stdout.write('\r' + ' '.repeat(60) + '\r');

  // ── 결과 ─────────────────────────────────────────────
  console.log(`\n결과 (${elapsed.toFixed(1)}초, 총 ${done}건, ${(done / elapsed).toFixed(1)} RPS)\n`);
  const cols = ['시나리오', '요청', '실패', '제한(429)', 'p50', 'p90', 'p95', 'p99', '최대', '전송량'];
  const W = [12, 9, 14, 11, 9, 9, 9, 9, 9, 10];
  const row = (vals) => '  ' + vals.map((v, i) => (i === 0 ? String(v).padEnd(W[i]) : String(v).padStart(W[i]))).join(' ');
  const line = '  ' + '─'.repeat(W.reduce((a, b) => a + b, 0) + W.length - 1);
  console.log(row(cols));
  console.log(line);
  let totalFail = 0, totalLimited = 0, allMs = [];
  for (const [label, s] of [...stats.entries()].sort((a, b) => b[1].n - a[1].n)) {
    totalFail += s.fail; totalLimited += s.limited; allMs = allMs.concat(s.ms);
    const failPct = s.n ? (s.fail / s.n * 100).toFixed(1) : '0.0';
    console.log(row([label, s.n, `${s.fail} (${failPct}%)`, s.limited,
      fmt(pct(s.ms, 50)), fmt(pct(s.ms, 90)), fmt(pct(s.ms, 95)), fmt(pct(s.ms, 99)), fmt(Math.max(...s.ms)), bytesFmt(s.bytes)]));
  }
  console.log(line);
  const errPct = done ? (totalFail / done * 100) : 0;
  const limitPct = done ? (totalLimited / done * 100) : 0;
  console.log(row(['전체', done, `${totalFail} (${errPct.toFixed(1)}%)`, totalLimited,
    fmt(pct(allMs, 50)), fmt(pct(allMs, 90)), fmt(pct(allMs, 95)), fmt(pct(allMs, 99)), '', '']));

  // 실패가 있으면 '무엇으로' 실패했는지 먼저 보여준다 — 숫자만으론 원인을 못 찾는다
  if (totalFail > 0 || totalLimited > 0) {
    console.log('\n응답 상태');
    for (const [code, n] of [...statusCount.entries()].sort((a, b) => b[1] - a[1])) {
      const label = code === 0 ? '연결 실패' : String(code);
      const msg = errorSample.get(code);
      console.log(`  ${label.padEnd(10)} ${String(n).padStart(8)}건 ${(n / done * 100).toFixed(1).padStart(6)}%  ${msg ? '— ' + String(msg).slice(0, 70) : ''}`);
    }
    const dominant = [...statusCount.entries()].filter(([c]) => c !== 200).sort((a, b) => b[1] - a[1])[0];
    if (dominant && dominant[1] / done > 0.5) {
      const [c] = dominant;
      if (c === 403) console.log('\n  → 대부분 403 입니다. 관리자 계정은 2단계 인증을 켜야 API 를 쓸 수 있습니다(--totp 필요).');
      else if (c === 401) console.log('\n  → 대부분 401 입니다. 토큰이 만료됐거나 비밀번호가 바뀌었습니다.');
      else if (c === 0) console.log('\n  → 서버에 연결하지 못했습니다. --url 과 방화벽을 확인하세요.');
      console.log('     이 상태에서는 성능 수치가 의미 없습니다 — 원인을 먼저 해결한 뒤 다시 재세요.');
    }
  }

  console.log('\n판단');
  if (limitPct >= 20) {
    console.log(`  ⛔ 요청의 ${limitPct.toFixed(1)}%가 요청 제한(429)에 막혔습니다 — 서버 성능이 아니라 레이트리밋을 측정한 셈입니다.`);
    console.log('     아래 중 하나로 다시 재보세요:');
    console.log('       · --users 를 줄인다 (제한은 IP 기준 분당 300건)');
    console.log('       · 테스트하는 동안만 서버에 API_RATE_LIMIT_MAX=100000 을 주고 재기동한다');
    console.log('     이 상태의 응답시간 수치는 대부분 429 를 돌려준 시간이라 의미가 없습니다.\n');
  }
  if (errPct >= 1) console.log(`  ⚠️  오류율 ${errPct.toFixed(1)}% — 이 부하에서 이미 요청이 떨어지고 있습니다. 동시 사용자 수를 줄여 한계점을 찾아보세요.`);
  else console.log(`  ✅ 오류율 ${errPct.toFixed(1)}% (429 제외) — 이 부하는 문제없이 처리됩니다.`);
  const p95 = pct(allMs, 95);
  if (p95 >= 3000) console.log(`  ⚠️  p95 ${fmt(p95)} — 체감상 "느리다"고 느낄 구간입니다.`);
  else if (p95 >= 1000) console.log(`  ℹ️  p95 ${fmt(p95)} — 여유는 있으나 더 올리면 느려질 수 있습니다.`);
  else console.log(`  ✅ p95 ${fmt(p95)} — 응답이 빠릅니다.`);
  console.log('\n  같은 조건으로 --users 를 늘려가며 반복하면, 오류율이 오르거나 p95 가 꺾이는 지점이 이 서버의 한계입니다.');
  console.log('  관리자 > 상태 탭을 함께 열어 두면 그 순간 무엇이 병목인지(이벤트루프·DB 커넥션) 같이 보입니다.\n');
  process.exit(errPct >= 1 || limitPct >= 20 ? 1 : 0);
})();
