'use strict';

// S16 · 계정 단위 요청 제한
//
// 전역 제한은 IP 기준이라, 사무실처럼 여러 사람이 한 IP 를 쓰면 한 사람의 폭주가
// 옆자리 사람까지 막는다. 반대로 한 계정이 여러 IP(휴대폰·PC·태블릿)로 붙으면
// IP 제한을 우회한다. 그래서 '로그인한 사람' 기준으로 한 겹 더 센다.
//
// 슬라이딩 윈도가 아니라 고정 창(1분)이다 — 정확도보다 가벼움이 중요하고,
// 목적은 정밀 과금이 아니라 '한 계정이 서버를 독점하지 못하게' 하는 것이다.
const WINDOW_MS = 60 * 1000;
const DEFAULT_MAX = parseInt(process.env.ACCOUNT_RATE_LIMIT_MAX || '600', 10);   // 계정당 분당 요청
const ADMIN_MAX = parseInt(process.env.ACCOUNT_RATE_LIMIT_ADMIN_MAX || '1200', 10);

const buckets = new Map();   // userId -> { count, resetAt, blocked }

// 창이 지난 항목을 주기적으로 비운다(맵 무한 증가 방지)
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
}, 5 * 60 * 1000).unref();

function limitFor(user) {
  if (!user) return DEFAULT_MAX;
  return user.role === 'admin' ? ADMIN_MAX : DEFAULT_MAX;
}

// authenticate 가 req.user 를 채운 직후에 호출한다. 초과면 429 를 보내고 false 를 반환.
function check(req, res) {
  const user = req.user;
  if (!user) return true;
  const now = Date.now();
  let b = buckets.get(user.id);
  if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + WINDOW_MS, blocked: 0 }; buckets.set(user.id, b); }
  b.count++;
  const max = limitFor(user);
  if (b.count > max) {
    b.blocked++;
    const retry = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
    res.setHeader('Retry-After', String(retry));
    res.setHeader('X-Account-RateLimit-Limit', String(max));
    res.setHeader('X-Account-RateLimit-Remaining', '0');
    // 처음 걸릴 때만 로그 — 폭주 중에 로그까지 폭주하면 안 된다
    if (b.blocked === 1) console.warn(`[ratelimit] 계정 제한 초과: @${user.username} (분당 ${max}건 기준)`);
    res.status(429).json({ error: `요청이 너무 많습니다. ${retry}초 후 다시 시도해 주세요.` });
    return false;
  }
  res.setHeader('X-Account-RateLimit-Limit', String(max));
  res.setHeader('X-Account-RateLimit-Remaining', String(Math.max(0, max - b.count)));
  return true;
}

// 상태 대시보드용 — 지금 한도에 가까운 계정이 있는지
function snapshot() {
  const now = Date.now();
  const rows = [];
  for (const [id, b] of buckets) {
    if (b.resetAt <= now) continue;
    rows.push({ userId: id, count: b.count, blocked: b.blocked });
  }
  rows.sort((a, b) => b.count - a.count);
  return { windowMs: WINDOW_MS, max: DEFAULT_MAX, adminMax: ADMIN_MAX, active: rows.length, top: rows.slice(0, 5) };
}

module.exports = { check, snapshot, WINDOW_MS };
