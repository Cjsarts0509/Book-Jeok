'use strict';

// 재고조사 오차체크 — ① 결과확인리스트 + ② 서가별스캔데이터를 서버에서 읽어 오차 항목만 돌려준다.
//
// 예전엔 브라우저가 두 엑셀을 통째로 읽었는데, 932,122행 · 63MB 짜리는 10분이 넘어도 끝나지 않았다(휴대폰은 더 못 한다).
// 서버는 xlsxStream 으로 줄 단위로 흘려 읽어 수십만 줄도 몇 초면 된다. CPU 를 꽤 쓰므로 worker 스레드에서 돌려
// 그동안 다른 요청이 멈추지 않게 한다.
//
// 규칙(브라우저에서 하던 것과 같다)
//  ① 머리글은 첫 30줄 안에 'ISBN' 이 있는 줄. 열은 이름으로 찾고 없으면 기본 자리(ISBN0 도서명1 분야2 출판사3 전산재고4 실재고5 누락재고6 예외여부7 스캔재고8 차이9).
//     차이≠0 이면 오차 항목(예외여부 Y 도 남긴다 — 화면 필터로 가른다).
//     ※ 예전엔 '또는 실재고≠스캔재고'도 넣었는데, 이 파일에서 차이 = 실재고 − 전산재고 · 실재고 = 스캔재고 + 누락재고 라서
//        그 조건은 '누락재고가 있는 줄'을 전부 오차로 잡았다(광화문 동양서적 225건이 348건으로). 시스템이 맞춰 둔 누락분은 오차가 아니다.
//  ② 열은 ISBN · 서가번호 · 실사수량(기본 자리 0 · 4 · 5). 오차 항목의 ISBN 만 서가별로 합산.
//  셀 서식이 '일반'이라 앞 0 이 빠진 서가번호(9~10자리)는 11자리로, ISBN-10 은 10자리로 채운다.
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { readXlsxRows } = require('./xlsxStream');

const HEAD1 = ['ISBN', '도서명', '분야', '출판사', '전산재고', '실재고', '누락재고', '예외여부', '스캔재고', '차이'];
const FALL1 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const HEAD2 = ['ISBN', '서가번호', '실사수량'];
const FALL2 = [0, 4, 5];
// 다른 시스템이 내보낸 결과확인리스트(1행 합계 · 2행 머리글 '바코드 · 상품명 · 상품구분 · 매입처 · 장부재고 · X · X · X · 스캔재고 · 차이')도 같은 뜻으로 읽는다
const SYN = { '바코드': 'ISBN', '상품코드': 'ISBN', '상품명': '도서명', '상품구분': '분야', '매입처': '출판사', '장부재고': '전산재고', '수불재고': '전산재고', '실사수량': '실사수량', '서가': '서가번호' };
const HEADER_SCAN_ROWS = 30;

const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/[^\d.-]/g, '')); return Number.isNaN(n) ? 0 : n; };
const normShelf = (v) => { const s = String(v == null ? '' : v).trim(); return /^\d{9,10}$/.test(s) ? s.padStart(11, '0') : s; };
const normIsbn = (v) => { const s = String(v == null ? '' : v).trim(); return /^\d{9}$/.test(s) ? s.padStart(10, '0') : s; };
const cellKey = (v) => { const k = String(v == null ? '' : v).replace(/\s+/g, ''); return (SYN[k] || k).toUpperCase(); };
const hasIsbn = (row) => row.some((c) => cellKey(c) === 'ISBN');

// found: 알아본 머리글 수 · has: 머리글에 실제로 있는 열(없는 열은 기본 자리로 읽되, 규칙에서 '없음'으로 안다)
function mapHeader(row, names, fallback) {
  const head = row.map(cellKey);
  const col = {}, has = {}; let found = 0;
  names.forEach((nm, k) => { const j = head.indexOf(nm.toUpperCase()); if (j >= 0) found++; has[nm] = j >= 0; col[nm] = j >= 0 ? j : fallback[k]; });
  return { col, found, has };
}
const fallbackMap = (names, fallback) => { const col = {}, has = {}; names.forEach((nm, k) => { col[nm] = fallback[k]; has[nm] = true; }); return { col, found: 0, has }; };

// 머리글을 찾을 때까지 앞줄을 모아 두고, 찾으면 그 뒤 줄만 · 끝내 못 찾으면 모아 둔 줄을 기본 자리로 처리한다
function headerGate(names, fallback, onData) {
  let map = null; const pend = [];
  const gate = {
    found: 0, onData,
    row(row) {
      if (map) return onData(row, map.col, map.has);
      if (hasIsbn(row)) { map = mapHeader(row, names, fallback); gate.found = map.found; pend.length = 0; return; }
      pend.push(row);
      if (pend.length > HEADER_SCAN_ROWS) { map = fallbackMap(names, fallback); pend.shift(); for (const r of pend) onData(r, map.col, map.has); pend.length = 0; }
    },
    end() { if (!map && pend.length > 1) { map = fallbackMap(names, fallback); for (const r of pend.slice(1)) onData(r, map.col, map.has); } },
  };
  return gate;
}

async function analyze(p1, p2) {
  const t0 = Date.now();
  const disc = []; const index = new Map();   // isbn → 오차 항목 번호
  const info = { rows1: 0, rows2: 0, sumSys: 0, sumScan: 0, head1: 0, head2: 0, matched: 0, ms: 0 };
  const g1 = headerGate(HEAD1, FALL1, (r, c, has) => {
    const rawIsbn = r[c.ISBN]; if (rawIsbn == null || rawIsbn === '') return;
    if (typeof rawIsbn === 'string' && !/\d/.test(rawIsbn)) return;   // '합계' 같은 글자 줄
    info.rows1++;
    const sys = r[c['전산재고']], real = has['실재고'] ? r[c['실재고']] : undefined, scan = r[c['스캔재고']], diff = r[c['차이']];
    info.sumSys += num(sys); info.sumScan += num(scan);
    if (num(diff) === 0) return;   // 오차 = 차이≠0 (엑셀에서 직접 세는 기준과 같게)
    const isbn = normIsbn(rawIsbn);
    if (!index.has(isbn)) index.set(isbn, disc.length);
    disc.push({ isbn, name: r[c['도서명']], field: r[c['분야']], pub: r[c['출판사']], sys, real, miss: has['누락재고'] ? r[c['누락재고']] : 0, exc: r[c['예외여부']], scan, diff, shelves: [], ssum: 0 });
  });
  // 첫 시트가 요약 시트면(ISBN 머리글 없음 · 줄 거의 없음) 다음 시트를 차례로 본다
  const first = await readXlsxRows(p1, (row) => { g1.row(row); });
  g1.end(); info.head1 = g1.found;
  for (let k = 1; k < first.sheets.length && g1.found === 0 && info.rows1 <= 1; k++) {
    disc.length = 0; index.clear(); info.rows1 = 0; info.sumSys = 0; info.sumScan = 0;
    const g = headerGate(HEAD1, FALL1, g1.onData);
    await readXlsxRows(p1, (row) => { g.row(row); }, { sheet: k });
    g.end(); info.head1 = g.found; info.sheet1 = first.sheets[k];
  }

  const shelfMap = new Map();   // isbn → Map(서가 → 수량)
  const g2 = headerGate(HEAD2, FALL2, (r, c) => {
    const rawIsbn = r[c.ISBN]; if (rawIsbn == null || rawIsbn === '') return;
    info.rows2++;
    const isbn = normIsbn(rawIsbn); if (!index.has(isbn)) return;
    const shelf = normShelf(r[c['서가번호']]); if (!shelf) return;
    const qty = num(r[c['실사수량']]) || 1;
    let mm = shelfMap.get(isbn); if (!mm) { mm = new Map(); shelfMap.set(isbn, mm); }
    mm.set(shelf, (mm.get(shelf) || 0) + qty);
  });
  await readXlsxRows(p2, (row) => { g2.row(row); });
  g2.end(); info.head2 = g2.found;

  for (const d of disc) {
    const mm = shelfMap.get(d.isbn);
    d.shelves = mm ? [...mm.entries()].sort((a, b) => Number(a[0]) - Number(b[0])) : [];
    d.ssum = mm ? [...mm.values()].reduce((a, q) => a + q, 0) : 0;
    if (d.shelves.length) info.matched++;
  }
  info.ms = Date.now() - t0;
  return { disc, info };
}

// ── 전 지점 · 두 해 비교 ─────────────────────────────
// 영업점에 전달한 .bjsa(오차 목록 JSON)를 읽어 지점마다 · 분야마다 숫자를 뽑는다. 예외(Y) 항목은 뺀다.
//  스캔차이는 저장 당시 값이 아니라 지금 규칙(스캔합계 + 누락재고 − 전산재고)으로 다시 계산 — 예전 파일도 같은 잣대로.
const fsp = require('fs/promises');
const toN = (v) => { const n = Number(v); return Number.isFinite(n) ? n : num(v); };
function summarizeDisc(disc) {
  const S = () => ({ items: 0, negN: 0, neg: 0, posN: 0, pos: 0, sd: 0, abs: 0, sys: 0 });
  const all = S(), fields = {};
  for (const d of disc || []) {
    if (!d || String(d.exc || '').trim().toUpperCase() === 'Y') continue;
    const ssum = d.ssum != null && d.ssum !== '' ? toN(d.ssum) : (d.shelves || []).reduce((a, s) => a + toN(s[1]), 0);
    const sd = ssum + toN(d.miss) - toN(d.sys);
    const f = String(d.field == null || d.field === '' ? '(분야 없음)' : d.field);
    const bucket = fields[f] || (fields[f] = S());
    for (const o of [all, bucket]) { o.items++; o.sd += sd; o.abs += Math.abs(sd); o.sys += toN(d.sys); if (sd < 0) { o.negN++; o.neg += sd; } else if (sd > 0) { o.posN++; o.pos += sd; } }
  }
  return { ...all, fields };
}
// files: [{ branchId, branchName, year, path, name, folder, at }] → { rows: [{ branchId, branchName, years: { [year]: { ...summary, file } } }], errors }
async function compare(files) {
  const byBranch = new Map(); const errors = [];
  for (const f of files) {
    let row = byBranch.get(f.branchId); if (!row) { row = { branchId: f.branchId, branchName: f.branchName, years: {} }; byBranch.set(f.branchId, row); }
    try {
      const txt = await fsp.readFile(f.path, 'utf8');
      const j = JSON.parse(txt);
      const disc = Array.isArray(j) ? j : (j && Array.isArray(j.disc) ? j.disc : null);
      if (!disc) throw new Error('오차 목록이 없는 파일');
      row.years[f.year] = { ...summarizeDisc(disc), file: { name: f.name, folder: f.folder, at: f.at, deliveredAt: j.deliveredAt || null } };
    } catch (e) { errors.push({ branchName: f.branchName, year: f.year, name: f.name, error: e.message }); }
  }
  return { rows: [...byBranch.values()], errors };
}
function compareInWorker(files) {
  return new Promise((resolve, reject) => {
    const w = new Worker(__filename, { workerData: { compare: files }, resourceLimits: { maxOldGenerationSizeMb: 2048 } });
    let done = false;
    w.on('message', (m) => { done = true; if (m.ok) resolve(m.result); else reject(new Error(m.error || '비교 실패')); });
    w.on('error', (e) => { if (!done) { done = true; reject(e); } });
    w.on('exit', (code) => { if (!done) { done = true; reject(new Error('비교 작업이 중단되었습니다(코드 ' + code + ')')); } });
  });
}

// worker 스레드에서 돌린다(CPU 작업이 이벤트 루프를 막지 않게). 메모리 상한 2GB.
function analyzeInWorker(p1, p2) {
  return new Promise((resolve, reject) => {
    const w = new Worker(__filename, { workerData: { p1, p2 }, resourceLimits: { maxOldGenerationSizeMb: 2048 } });
    let done = false;
    w.on('message', (m) => { done = true; if (m.ok) resolve(m.result); else reject(new Error(m.error || '분석 실패')); });
    w.on('error', (e) => { if (!done) { done = true; reject(e); } });
    w.on('exit', (code) => { if (!done) { done = true; reject(new Error('분석 작업이 중단되었습니다(코드 ' + code + ')')); } });
  });
}

if (!isMainThread && workerData && (workerData.p1 || workerData.compare)) {
  (workerData.compare ? compare(workerData.compare) : analyze(workerData.p1, workerData.p2))
    .then((result) => parentPort.postMessage({ ok: true, result }))
    .catch((e) => parentPort.postMessage({ ok: false, error: e && e.message ? e.message : String(e) }));
}

module.exports = { analyze, analyzeInWorker, summarizeDisc, compare, compareInWorker, normShelf, normIsbn };
