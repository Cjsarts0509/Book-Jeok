'use strict';

// S21 · 목록 캐시 계층
//
// 폴더 목록 한 번에 쿼리가 5~6개 나간다(파일·하위폴더·백필·메타·집계·즐겨찾기).
// 같은 폴더를 여러 사람이 반복해서 열거나, 한 사람이 뒤로/앞으로를 오갈 때
// 매번 같은 답을 다시 만드는 것은 낭비다.
//
// 무효화 원칙: 시간(TTL)에 기대지 않는다. 계정에 뭔가 바뀌면 그 계정의 캐시를
// 통째로 버린다(bump). TTL 은 프로세스 밖에서 데이터가 바뀌었을 때를 위한 안전망일 뿐이다.
//
// 캐시 키에 '보는 사람'을 넣는다 — 즐겨찾기·태그는 사람마다 다르게 붙기 때문이다.
const TTL_MS = parseInt(process.env.LIST_CACHE_TTL_MS || '30000', 10);
const MAX_ENTRIES = parseInt(process.env.LIST_CACHE_MAX || '500', 10);
const ENABLED = process.env.LIST_CACHE !== '0';

const versions = new Map();   // ownerId -> 정수. 그 계정에 변화가 생기면 올라간다.
const entries = new Map();    // key -> { at, version, owner, payload }
const stats = { hit: 0, miss: 0, stale: 0, evict: 0, invalidate: 0 };

const versionOf = (owner) => versions.get(Number(owner)) || 0;

// 그 계정의 캐시를 모두 무효화한다. 실제로 지우지 않고 버전만 올려 O(1) 로 끝낸다.
function bump(owner) {
  if (owner == null) return;
  const id = Number(owner);
  versions.set(id, versionOf(id) + 1);
  stats.invalidate++;
}
// 여러 계정이 걸린 작업(일괄 이동·복사)용
function bumpMany(owners) { for (const o of new Set((owners || []).filter((x) => x != null))) bump(o); }

function key(kind, owner, viewer, extra = '') { return `${kind}|${owner}|${viewer}|${extra}`; }

function get(k, owner) {
  if (!ENABLED) return null;
  const e = entries.get(k);
  if (!e) { stats.miss++; return null; }
  if (e.version !== versionOf(owner)) { entries.delete(k); stats.invalidate++; stats.miss++; return null; }
  if (Date.now() - e.at > TTL_MS) { entries.delete(k); stats.stale++; stats.miss++; return null; }
  stats.hit++;
  return e.payload;
}

function set(k, owner, payload) {
  if (!ENABLED) return payload;
  // 가장 오래된 것부터 버린다(Map 은 삽입 순서를 지킨다)
  if (entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) { entries.delete(oldest); stats.evict++; }
  }
  entries.set(k, { at: Date.now(), version: versionOf(owner), owner: Number(owner), payload });
  return payload;
}

// 캐시된 값을 그대로 돌려주면 호출자가 응답 객체를 고쳤을 때 캐시까지 오염된다.
// 목록 응답은 그대로 직렬화되어 나가므로 깊은 복사 대신 JSON 사본을 준다(안전하고 충분히 빠르다).
const clone = (v) => JSON.parse(JSON.stringify(v));

// 조회 → 없으면 만들고 저장. 예외는 캐시하지 않는다.
async function wrap(k, owner, producer) {
  const hit = get(k, owner);
  if (hit) return clone(hit);
  const fresh = await producer();
  set(k, owner, fresh);
  return fresh;
}

function snapshot() {
  const total = stats.hit + stats.miss;
  return {
    enabled: ENABLED, entries: entries.size, maxEntries: MAX_ENTRIES, ttlMs: TTL_MS,
    ...stats, hitRate: total ? Math.round((stats.hit / total) * 1000) / 10 : 0,
  };
}
function clear() { entries.clear(); versions.clear(); }

module.exports = { key, get, set, wrap, bump, bumpMany, snapshot, clear, ENABLED };
