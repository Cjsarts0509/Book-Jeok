'use strict';

// 화면 파일의 버전 꼬리표(?v=NNN)에 배포 판(커밋)을 자동으로 붙인다 — 배포마다 주소가 바뀌어 캐시가 꼬이지 않게.
//
// 배경: 정적 파일은 "?v=225 는 영원히 같은 내용"이라고 약속하고 1년 캐시(immutable)를 건다. 그래서 파일을 고치면
//   사람이 v 를 올려야 하는데, 한 번 빠뜨리면 Cloudflare 와 브라우저가 예전 파일을 1년 동안 내주고 사람은 "배포했는데 그대로"를 본다
//   (2026-11 재고조사 보고서 분야별 통계가 그랬다).
// 해결: index.html · js · css 를 내보낼 때 `v=225` 를 `v=225-<커밋>` 으로 바꿔 쓴다(BOOKJEOK_REV 는 배포 스크립트가 넣는 판).
//   배포마다 커밋이 다르니 주소가 저절로 바뀌고, 되돌리면(롤백) 예전 커밋 주소로 돌아가 예전 파일과 짝이 맞는다.
//   js 안의 문자열('js/sa-report.js?v=225' 같은 지연 로드)도 같은 규칙으로 바뀐다. v 가 없는 요청(index.html)은 매번 서버에 묻는다(no-cache).
// 파일은 바뀐 시각(mtime)별로 한 번만 읽어 메모리에 둔다. BOOKJEOK_REV 가 없으면(개발 실행) 아무것도 하지 않는다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TEXT = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const VER_RE = /([?&]v=)(\d+)(?![\w-])/g;

function stamp(text, rev) { return rev ? text.replace(VER_RE, `$1$2-${rev}`) : text; }

function create(frontDir, rev) {
  rev = String(rev || '').trim().replace(/[^0-9a-zA-Z]/g, '').slice(0, 16);
  const cache = new Map();   // 절대 경로 → { mtimeMs, body, etag }
  const root = path.resolve(frontDir);

  function load(file, cb) {
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return cb(null);
      const hit = cache.get(file);
      if (hit && hit.mtimeMs === st.mtimeMs) return cb(hit);
      fs.readFile(file, 'utf8', (e2, txt) => {
        if (e2) return cb(null);
        const body = Buffer.from(stamp(txt, rev));
        const entry = { mtimeMs: st.mtimeMs, body, etag: `"${crypto.createHash('sha1').update(body).digest('hex').slice(0, 20)}"` };
        cache.set(file, entry); cb(entry);
      });
    });
  }

  // 요청 경로의 파일을 판 꼬리표를 붙여 보낸다. 못 보내면(없음 · 글 파일 아님) false 를 돌려 next() 로 넘긴다.
  function send(req, res, urlPath, next) {
    const ext = path.extname(urlPath).toLowerCase();
    if (!TEXT[ext]) return next();
    const file = path.resolve(root, '.' + urlPath);
    if (!file.startsWith(root + path.sep)) return next();
    load(file, (entry) => {
      if (!entry) return next();
      res.setHeader('ETag', entry.etag);
      res.setHeader('Content-Type', TEXT[ext]);
      res.setHeader('Cache-Control', req.query && req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
      if (req.headers['if-none-match'] === entry.etag) return res.status(304).end();
      if (req.method === 'HEAD') return res.status(200).end();
      res.status(200).send(entry.body);
    });
  }

  function middleware(req, res, next) {
    if (!rev || (req.method !== 'GET' && req.method !== 'HEAD')) return next();
    let p;
    try { p = decodeURIComponent(req.path); } catch (_) { return next(); }
    if (p === '/') p = '/index.html';
    send(req, res, p, next);
  }
  // SPA 폴백(어떤 경로든 index.html)
  function sendIndex(req, res, next) {
    if (!rev) return next();
    send(req, res, '/index.html', next);
  }
  return { middleware, sendIndex, stamp: (t) => stamp(t, rev), rev };
}

module.exports = { create, stamp };
