'use strict';

// 아주 큰 xlsx 를 흘려 읽기(스트리밍) — 줄 단위로 넘겨 주고 메모리에 다 올리지 않는다.
//
// 왜: 광화문점 결과확인리스트(도서)는 932,122행 · 63MB 다. 브라우저의 SheetJS 는 10분이 넘어도 못 읽고(메모리 수 GB),
//   서버에서도 통째로 파싱하면 같은 꼴이 난다. xlsx 는 zip 안의 XML 이라, zip 항목을 직접 찾아 inflate 스트림으로 풀면서
//   <row>…</row> 단위로 끊어 읽으면 수십만 줄도 수십 초 · 수백 MB 안에 끝난다.
// 바깥 모듈 없이 zip 을 읽는다(central directory → 항목 → local header → inflateRaw). ZIP64(4GB 초과)는 지원하지 않는다.
// 셀 종류: 공유 문자열(t="s") · 인라인 문자열(t="inlineStr") · 수식 문자열(t="str") · 불리언(t="b") · 숫자(기본) · 오류(t="e")
const fs = require('fs');
const fsp = require('fs/promises');
const zlib = require('zlib');
const { StringDecoder } = require('string_decoder');

const SIG_EOCD = 0x06054b50, SIG_CEN = 0x02014b50, SIG_LOC = 0x04034b50;

// ── zip ──────────────────────────────────────────────
async function readEntries(fd, size) {
  // EOCD 는 파일 끝에서 최대 22+65535 바이트 안에 있다
  const tail = Math.min(size, 22 + 65535);
  const buf = Buffer.alloc(tail);
  await fd.read(buf, 0, tail, size - tail);
  let p = -1;
  for (let i = tail - 22; i >= 0; i--) if (buf.readUInt32LE(i) === SIG_EOCD) { p = i; break; }
  if (p < 0) throw new Error('zip 구조를 찾지 못했습니다(엑셀 파일이 아니거나 손상)');
  const count = buf.readUInt16LE(p + 10), cenSize = buf.readUInt32LE(p + 12), cenOff = buf.readUInt32LE(p + 16);
  if (count === 0xffff || cenSize === 0xffffffff || cenOff === 0xffffffff) throw new Error('4GB 를 넘는 zip(ZIP64)은 읽을 수 없습니다');
  const cen = Buffer.alloc(cenSize);
  await fd.read(cen, 0, cenSize, cenOff);
  const entries = new Map();
  let o = 0;
  for (let k = 0; k < count && o + 46 <= cenSize; k++) {
    if (cen.readUInt32LE(o) !== SIG_CEN) break;
    const method = cen.readUInt16LE(o + 10), compSize = cen.readUInt32LE(o + 20), uncompSize = cen.readUInt32LE(o + 24);
    const n = cen.readUInt16LE(o + 28), m = cen.readUInt16LE(o + 30), c = cen.readUInt16LE(o + 32), off = cen.readUInt32LE(o + 42);
    const name = cen.toString('utf8', o + 46, o + 46 + n);
    entries.set(name, { name, method, compSize, uncompSize, off });
    o += 46 + n + m + c;
  }
  return entries;
}

async function entryStream(fd, path, e) {
  const h = Buffer.alloc(30);
  await fd.read(h, 0, 30, e.off);
  if (h.readUInt32LE(0) !== SIG_LOC) throw new Error('zip 항목 머리글이 깨졌습니다: ' + e.name);
  const start = e.off + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  const raw = fs.createReadStream(path, { start, end: start + e.compSize - 1, highWaterMark: 1 << 20 });
  if (e.method === 0) return raw;
  if (e.method !== 8) throw new Error('지원하지 않는 압축 방식: ' + e.method);
  return raw.pipe(zlib.createInflateRaw({ chunkSize: 1 << 20 }));
}

// 스트림을 글자로 받아, 닫는 표시(closeTag)가 나올 때까지 모았다가 완성된 조각마다 onPiece 를 부른다
async function scanPieces(stream, openRe, closeTag, onPiece) {
  const dec = new StringDecoder('utf8');
  let carry = '';
  for await (const chunk of stream) {
    carry += dec.write(chunk);
    let from = 0;
    for (;;) {
      openRe.lastIndex = from;
      const m = openRe.exec(carry); if (!m) break;
      const s = m.index;
      // 자기 닫힘(<row …/>)
      const gt = carry.indexOf('>', s); if (gt < 0) break;
      if (carry[gt - 1] === '/') { onPiece(carry.slice(s, gt + 1)); from = gt + 1; continue; }
      const e = carry.indexOf(closeTag, gt); if (e < 0) break;
      onPiece(carry.slice(s, e + closeTag.length)); from = e + closeTag.length;
    }
    carry = carry.slice(from);
    if (carry.length > 64 * 1024 * 1024) throw new Error('한 줄이 너무 깁니다(64MB)');
  }
  carry += dec.end();
}

// ── XML 조각 ──────────────────────────────────────────
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unesc(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, k) => {
    if (k[0] === '#') { const code = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10); return Number.isFinite(code) ? String.fromCodePoint(code) : m; }
    return ENT[k] != null ? ENT[k] : m;
  });
}
const textOf = (xml) => { let out = ''; const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g; let m; while ((m = re.exec(xml))) out += m[1]; return unesc(out); };

async function readSharedStrings(fd, path, entries) {
  const e = entries.get('xl/sharedStrings.xml'); if (!e) return [];
  const list = [];
  await scanPieces(await entryStream(fd, path, e), /<si[\s>]/g, '</si>', (si) => { list.push(textOf(si)); });
  return list;
}

const colIndex = (letters) => { let n = 0; for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64); return n - 1; };
const CELL_RE = /<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
function parseRow(xml, sst) {
  const arr = []; let m;
  CELL_RE.lastIndex = 0;
  while ((m = CELL_RE.exec(xml))) {
    const attrs = m[1], body = m[2];
    const r = /\br="([A-Z]+)\d+"/.exec(attrs); if (!r) continue;
    const ci = colIndex(r[1]);
    if (body == null) { arr[ci] = ''; continue; }
    const t = /\bt="(\w+)"/.exec(attrs); const type = t ? t[1] : 'n';
    let v;
    if (type === 'inlineStr') v = textOf(body);
    else { const vm = /<v>([\s\S]*?)<\/v>/.exec(body); v = vm ? unesc(vm[1]) : ''; }
    if (type === 's') { const k = parseInt(v, 10); v = sst[k] != null ? sst[k] : ''; }
    else if (type === 'n' && v !== '') { const n = Number(v); if (Number.isFinite(n)) v = n; }
    else if (type === 'b') v = v === '1';
    arr[ci] = v;
  }
  return arr;
}

// 첫(또는 이름이 맞는) 시트의 zip 경로 — workbook.xml 의 순서와 rels 로 찾고, 못 찾으면 worksheets/sheet*.xml 중 첫 것
async function sheetPaths(fd, path, entries) {
  const read = async (name) => { const e = entries.get(name); if (!e) return ''; const chunks = []; for await (const c of await entryStream(fd, path, e)) chunks.push(c); return Buffer.concat(chunks).toString('utf8'); };
  const out = [];
  try {
    const wb = await read('xl/workbook.xml'), rels = await read('xl/_rels/workbook.xml.rels');
    const relMap = {}; let m; const rre = /<Relationship\s[^>]*?Id="([^"]+)"[^>]*?Target="([^"]+)"|<Relationship\s[^>]*?Target="([^"]+)"[^>]*?Id="([^"]+)"/g;
    while ((m = rre.exec(rels))) { const id = m[1] || m[4], tg = m[2] || m[3]; relMap[id] = tg; }
    const sre = /<sheet\s[^>]*?name="([^"]*)"[^>]*?r:id="([^"]+)"|<sheet\s[^>]*?r:id="([^"]+)"[^>]*?name="([^"]*)"/g;
    while ((m = sre.exec(wb))) {
      const name = unesc(m[1] || m[4] || ''), tg = relMap[m[2] || m[3]] || '';
      let p = tg.startsWith('/') ? tg.slice(1) : 'xl/' + tg.replace(/^\.\//, '');
      if (entries.has(p)) out.push({ name, path: p });
    }
  } catch (_) { /* 아래 fallback */ }
  if (!out.length) for (const n of [...entries.keys()].sort()) if (/^xl\/worksheets\/sheet\d*\.xml$/.test(n)) out.push({ name: n, path: n });
  return out;
}

/**
 * xlsx 를 줄 단위로 읽는다.
 * @param {string} path 파일 경로
 * @param {(row: any[], rowNo: number) => (boolean|void)} onRow 줄마다(0부터 세는 열 배열, 1부터 세는 줄 번호). false 를 돌려주면 그만 읽는다.
 * @param {{ sheet?: number|string }} opts sheet: 몇 번째(0부터) 또는 이름. 기본 0.
 * @returns {Promise<{ rows: number, sheet: string, sheets: string[] }>}
 */
async function readXlsxRows(path, onRow, opts = {}) {
  const st = await fsp.stat(path);
  const fd = await fsp.open(path, 'r');
  try {
    const entries = await readEntries(fd, st.size);
    const sheets = await sheetPaths(fd, path, entries);
    if (!sheets.length) throw new Error('시트를 찾지 못했습니다');
    const want = opts.sheet == null ? 0 : opts.sheet;
    const sh = typeof want === 'number' ? sheets[want] : sheets.find((s) => s.name === want);
    if (!sh) throw new Error('시트가 없습니다: ' + want);
    const sst = await readSharedStrings(fd, path, entries);
    let rows = 0, stop = false;
    const stream = await entryStream(fd, path, entries.get(sh.path));
    await scanPieces(stream, /<row[\s>]/g, '</row>', (xml) => {
      if (stop) return;
      rows++;
      const rn = /^<row\s[^>]*?\br="(\d+)"/.exec(xml);
      if (onRow(parseRow(xml, sst), rn ? parseInt(rn[1], 10) : rows) === false) { stop = true; stream.destroy(); }
    }).catch((e) => { if (!stop) throw e; });
    return { rows, sheet: sh.name, sheets: sheets.map((s) => s.name) };
  } finally { await fd.close(); }
}

module.exports = { readXlsxRows };
