'use strict';

// U12 · ISBN 으로 도서정보 자동 채우기
//
// 바코드를 찍으면 ISBN 은 바로 나오지만, 제목·저자·출판사는 어디선가 가져와야 한다.
// 도서 정보 API 는 대부분 발급받은 키가 필요하므로, 어느 곳을 쓸지 환경변수로 고른다.
// 아무것도 설정하지 않으면 키가 필요 없는 OpenLibrary 로 시도한다(국내서는 적중률이 낮다).
//
//   BOOK_API_PROVIDER=aladin  BOOK_API_KEY=<TTB키>          알라딘 (국내서 정확)
//   BOOK_API_PROVIDER=naver   BOOK_API_KEY=<ID>:<SECRET>    네이버 책
//   BOOK_API_PROVIDER=openlibrary                            키 불필요(해외서 위주)
//
// 서버가 대신 불러 준다 — 브라우저에서 직접 부르면 CORS 에 막히고 API 키가 노출된다.
// 결과는 메모리에 캐시한다. 같은 ISBN 을 여러 번 찍는 일이 흔하고, 외부 호출은 느리고 한도가 있다.
const alerts = require('./alerts');

const PROVIDER = (process.env.BOOK_API_PROVIDER || 'openlibrary').toLowerCase();
const KEY = process.env.BOOK_API_KEY || '';
const TIMEOUT_MS = parseInt(process.env.BOOK_API_TIMEOUT_MS || '5000', 10);
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 2000;

const cache = new Map();   // isbn -> { at, data }
const stats = { hit: 0, miss: 0, fail: 0 };

const configured = () => PROVIDER === 'openlibrary' || !!KEY;

function normalizeIsbn(raw) {
  const s = String(raw || '').replace(/[^0-9Xx]/g, '').toUpperCase();
  return (s.length === 10 || s.length === 13) ? s : '';
}

async function fetchJson(url, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    if (!r.ok) throw new Error(`조회 실패 (${r.status})`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// 제공처마다 응답 모양이 다르므로 우리 화면이 쓰는 한 가지 모양으로 맞춘다.
const shape = (o) => ({
  isbn: o.isbn || '', title: o.title || '', author: o.author || '', publisher: o.publisher || '',
  pubDate: o.pubDate || '', cover: o.cover || '', description: (o.description || '').slice(0, 500),
  source: o.source || PROVIDER,
});

async function lookupAladin(isbn) {
  const url = 'https://www.aladin.co.kr/ttb/api/ItemLookUp.aspx'
    + `?ttbkey=${encodeURIComponent(KEY)}&itemIdType=ISBN13&ItemId=${encodeURIComponent(isbn)}`
    + '&output=js&Version=20131101&Cover=Big';
  const d = await fetchJson(url);
  const it = (d.item || [])[0];
  if (!it) return null;
  return shape({
    isbn, title: it.title, author: it.author, publisher: it.publisher,
    pubDate: it.pubDate, cover: it.cover, description: it.description, source: 'aladin',
  });
}

async function lookupNaver(isbn) {
  const [id, secret] = KEY.split(':');
  if (!id || !secret) throw new Error('네이버는 BOOK_API_KEY 를 "클라이언트ID:시크릿" 형식으로 넣어야 합니다.');
  const d = await fetchJson(
    `https://openapi.naver.com/v1/search/book_adv.json?d_isbn=${encodeURIComponent(isbn)}`,
    { 'X-Naver-Client-Id': id, 'X-Naver-Client-Secret': secret });
  const it = (d.items || [])[0];
  if (!it) return null;
  const strip = (x) => String(x || '').replace(/<[^>]*>/g, '');
  return shape({
    isbn, title: strip(it.title), author: strip(it.author), publisher: strip(it.publisher),
    pubDate: it.pubdate, cover: it.image, description: strip(it.description), source: 'naver',
  });
}

async function lookupOpenLibrary(isbn) {
  const d = await fetchJson(`https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(isbn)}&format=json&jscmd=data`);
  const it = d[`ISBN:${isbn}`];
  if (!it) return null;
  return shape({
    isbn, title: it.title,
    author: (it.authors || []).map((a) => a.name).join(', '),
    publisher: (it.publishers || []).map((p) => p.name).join(', '),
    pubDate: it.publish_date, cover: (it.cover && (it.cover.medium || it.cover.small)) || '',
    source: 'openlibrary',
  });
}

const PROVIDERS = { aladin: lookupAladin, naver: lookupNaver, openlibrary: lookupOpenLibrary };

async function lookup(rawIsbn) {
  const isbn = normalizeIsbn(rawIsbn);
  if (!isbn) return { ok: false, error: 'ISBN 형식이 아닙니다(10자리 또는 13자리).' };
  if (!configured()) {
    return {
      ok: false, notConfigured: true,
      error: '도서정보 조회가 설정되지 않았습니다. 서버 .env 에 BOOK_API_PROVIDER 와 BOOK_API_KEY 를 넣어 주세요.',
    };
  }
  const c = cache.get(isbn);
  if (c && Date.now() - c.at < CACHE_TTL_MS) { stats.hit++; return { ok: true, cached: true, book: c.data }; }
  stats.miss++;

  const fn = PROVIDERS[PROVIDER];
  if (!fn) return { ok: false, error: `알 수 없는 제공처입니다: ${PROVIDER}` };
  try {
    const book = await fn(isbn);
    if (!book) return { ok: false, error: '해당 ISBN 의 도서를 찾지 못했습니다.', isbn };
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(isbn, { at: Date.now(), data: book });
    return { ok: true, book };
  } catch (e) {
    stats.fail++;
    // 외부 API 가 죽어 있으면 알려 준다 — 사용자는 "왜 안 채워지지"만 겪게 되므로
    if (stats.fail >= 5) {
      alerts.raise('book-api', 'info', '도서정보 조회가 계속 실패합니다',
        `${PROVIDER} 조회가 ${stats.fail}회 실패했습니다: ${String(e.message).slice(0, 120)} — API 키나 사용 한도를 확인해 주세요.`);
    }
    return { ok: false, error: `도서정보를 가져오지 못했습니다: ${String(e.message).slice(0, 120)}`, isbn };
  }
}

const info = () => ({ provider: PROVIDER, configured: configured(), cached: cache.size, ...stats });

module.exports = { lookup, info, configured, normalizeIsbn };
