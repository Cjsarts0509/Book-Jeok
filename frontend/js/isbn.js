/* 북적북적 — 도서 ISBN 인식 (바코드 → OCR 폴백)
   - 바코드: 네이티브 BarcodeDetector(있으면) → 실패 시 ZXing(vendor, 지연 로드)
   - OCR 폴백: Tesseract.js(CDN, 숫자 전용, ISBN 켤 때만 로드)
   - 모두 정지 이미지/캔버스 대상. 실패해도 조용히 폴백.                          */
window.ISBN = (() => {
  'use strict';

  // ── 체크섬 검증 (EAN-13 / ISBN-10) ──────────
  function isValidEAN13(code) {
    if (!/^\d{13}$/.test(code)) return false;
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += parseInt(code[i], 10) * (i % 2 === 0 ? 1 : 3);
    return parseInt(code[12], 10) === (10 - (sum % 10)) % 10;
  }
  function isValidISBN10(code) {
    if (!/^\d{9}[\dX]$/.test(code)) return false;
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += parseInt(code[i], 10) * (10 - i);
    sum += code[9] === 'X' ? 10 : parseInt(code[9], 10);
    return sum % 11 === 0;
  }
  function isValidEAN8(code) {
    if (!/^\d{8}$/.test(code)) return false;
    let sum = 0;
    for (let i = 0; i < 7; i++) sum += parseInt(code[i], 10) * (i % 2 === 0 ? 3 : 1);
    return parseInt(code[7], 10) === (10 - (sum % 10)) % 10;
  }
  function isValidBarcode(raw) {
    const c = String(raw || '').replace(/[^0-9X]/gi, '').toUpperCase();
    if (c.length === 13) return isValidEAN13(c);
    if (c.length === 10) return isValidISBN10(c);
    return false;
  }
  // 도서 ISBN 만 인정 (EAN-13 은 978/979 접두, 또는 ISBN-10)
  function isBookIsbn(raw) {
    const c = String(raw || '').replace(/[^0-9X]/gi, '').toUpperCase();
    if (c.length === 13) return (c.startsWith('978') || c.startsWith('979')) && isValidEAN13(c);
    if (c.length === 10) return isValidISBN10(c);
    return false;
  }
  // 일반 상품 바코드까지 인정: EAN-13(모든 접두) · UPC-A(12) · EAN-8(8) · ISBN-10(10)
  function isValidProduct(raw) {
    const c = String(raw || '').replace(/[^0-9X]/gi, '').toUpperCase();
    if (c.length === 13) return isValidEAN13(c);
    if (c.length === 12) return isValidEAN13('0' + c);   // UPC-A = 앞 0 붙인 EAN-13
    if (c.length === 8) return isValidEAN8(c);
    if (c.length === 10) return isValidISBN10(c);
    return false;
  }
  const clean = (raw) => String(raw || '').replace(/[^0-9X]/gi, '').toUpperCase();
  const dedupe = (arr) => [...new Set(arr)];

  // OCR 텍스트에서 바코드/ISBN 후보 추출 (8·10·12·13자리 숫자열)
  function extractCandidates(text) {
    const s = String(text || '');
    const out = [];
    const re = /[0-9](?:[\s-]?[0-9Xx]){6,17}/g;
    let m;
    while ((m = re.exec(s))) { const c = clean(m[0]); if (c.length === 8 || c.length === 10 || c.length === 12 || c.length === 13) out.push(c); }
    return dedupe(out);
  }

  // ── 지연 로더 ──────────
  const loaded = {};
  function loadScript(src, globalName) {
    if (globalName && window[globalName]) return Promise.resolve(window[globalName]);
    if (loaded[src]) return loaded[src];
    loaded[src] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = () => resolve(globalName ? window[globalName] : true);
      s.onerror = () => { loaded[src] = null; reject(new Error('스크립트 로드 실패: ' + src)); };
      document.head.appendChild(s);
    });
    return loaded[src];
  }
  const ensureZXing = () => loadScript('vendor/zxing.min.js?v=85', 'ZXing');
  const TESS_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  const ensureTesseract = () => loadScript(TESS_CDN, 'Tesseract');

  // ── 이미지 → 캔버스 (구역 크롭 + 과대 축소) ──────────
  // region: {x,y,w,h} (원본 픽셀 기준) | null(전체). maxSide 로 긴 변 제한.
  function toCanvas(source, region, maxSide) {
    const nw = source.naturalWidth || source.videoWidth || source.width;
    const nh = source.naturalHeight || source.videoHeight || source.height;
    let sx = 0, sy = 0, sw = nw, sh = nh;
    if (region && region.w > 4 && region.h > 4) {
      sx = Math.max(0, Math.min(nw - 1, region.x));
      sy = Math.max(0, Math.min(nh - 1, region.y));
      sw = Math.max(1, Math.min(nw - sx, region.w));
      sh = Math.max(1, Math.min(nh - sy, region.h));
    }
    let dw = sw, dh = sh;
    const longest = Math.max(dw, dh);
    if (maxSide && longest > maxSide) { const k = maxSide / longest; dw = Math.round(dw * k); dh = Math.round(dh * k); }
    const canvas = document.createElement('canvas');
    canvas.width = dw; canvas.height = dh;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, dw, dh);
    return canvas;
  }

  // ── 바코드: 네이티브 BarcodeDetector (한 화면의 모든 바코드 반환) ──────────
  // 여러 개면 위→아래, 왼→오 순으로 정렬해 예측 가능한 순서로 돌려줌
  async function scanNative(canvas) {
    if (!('BarcodeDetector' in window)) return [];
    try {
      const det = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a'] });
      const found = await det.detect(canvas);
      const items = found
        .filter((b) => isValidProduct(b.rawValue))
        .map((b) => ({ code: clean(b.rawValue), y: b.boundingBox ? b.boundingBox.y : 0, x: b.boundingBox ? b.boundingBox.x : 0 }))
        .sort((a, b) => (a.y - b.y) || (a.x - b.x));
      return dedupe(items.map((i) => i.code));
    } catch (_) { return []; } // 미지원 포맷/오류 → 폴백
  }

  // ── 바코드: ZXing (다방향, tryHarder) — 이 번들은 이미지당 1개만 디코드 ──────────
  let zxReader = null;
  async function ensureReader() {
    const Z = await ensureZXing();
    if (!zxReader) {
      const hints = new Map();
      hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A]);
      hints.set(Z.DecodeHintType.TRY_HARDER, true);
      zxReader = new Z.BrowserMultiFormatReader(hints);
    }
    return zxReader;
  }
  async function zxDecode(canvas) {
    try { const r = await (await ensureReader()).decodeFromImageUrl(canvas.toDataURL('image/png')); if (r && isValidProduct(r.getText())) return clean(r.getText()); }
    catch (_) { /* NotFound → null */ }
    return null;
  }
  // 원본 이미지에서 (x,y,w,h) 잘라 긴 변이 targetLong 이 되도록 확대/축소한 캔버스
  function cropCanvas(source, x, y, w, h, targetLong) {
    const long = Math.max(w, h); const k = targetLong ? targetLong / long : 1;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
    const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, x, y, w, h, 0, 0, c.width, c.height);
    return c;
  }
  // 같은 영역을 여러 배율로 시도 — ZXing 은 모듈/픽셀 정렬에 민감해 특정 배율에서만 성공하는 경우가 있음
  async function zxDecodeMulti(source, x, y, w, h, scales) {
    for (const tl of scales) { const code = await zxDecode(cropCanvas(source, x, y, w, h, tl)); if (code) return code; }
    return null;
  }
  // ZXing 견고 스캔: 구역이면 여러 배율로, 전체면 통짜 + 겹치는 타일(여러 배율)로 작은 바코드까지 탐색
  async function scanZXingRobust(source, region) {
    try { await ensureZXing(); } catch (_) { return []; }
    const nw = source.naturalWidth || source.videoWidth || source.width;
    const nh = source.naturalHeight || source.videoHeight || source.height;
    if (region && region.w > 4 && region.h > 4) {
      const code = await zxDecodeMulti(source, region.x, region.y, region.w, region.h, [900, 1300, 1700, 2100]);
      return code ? [code] : [];
    }
    // 1) 통짜(여러 배율)
    let code = await zxDecodeMulti(source, 0, 0, nw, nh, [Math.min(2200, Math.max(nw, nh)), 1600]);
    if (code) return [code];
    // 2) 겹치는 3x3 타일을 각각 여러 배율로 재시도 — 프레임 대비 작은 바코드도 잡음
    const nx = 3, ny = 3, ov = 0.35, tw = nw / nx, th = nh / ny;
    for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
      const x = Math.max(0, tw * ix - tw * ov), y = Math.max(0, th * iy - th * ov);
      const w = Math.min(nw - x, tw * (1 + 2 * ov)), h = Math.min(nh - y, th * (1 + 2 * ov));
      code = await zxDecodeMulti(source, x, y, w, h, [1200, 1600]);
      if (code) return [code];
    }
    return [];
  }

  // ── OCR: Tesseract.js (숫자 전용, 단일 라인) ──────────
  let tessWorker = null;
  async function scanOcr(canvas) {
    let T;
    try { T = await ensureTesseract(); } catch (_) { return []; }
    try {
      if (!tessWorker) {
        tessWorker = await T.createWorker('eng');
        await tessWorker.setParameters({ tessedit_char_whitelist: '0123456789Xx- ', tessedit_pageseg_mode: '6' });
      }
      const { data } = await tessWorker.recognize(canvas);
      return dedupe(extractCandidates(data.text).filter(isValidProduct));
    } catch (_) { return []; } // OCR 실패 → 폴백
  }

  // ── 메인: 이미지에서 ISBN 찾기 (여러 개면 candidates 로 모두 반환) ──────────
  // opts: { region, useOcr }  → { success, isbn, candidates, method, message }
  async function scan(source, opts) {
    opts = opts || {};
    // 바코드는 해상도가 필요 → 크게(축소 상한 2600), OCR 은 라인 인식이라 상한 1800
    const bcCanvas = toCanvas(source, opts.region, 2600);
    let cands = await scanNative(bcCanvas);
    let method = 'BARCODE';
    if (!cands.length) cands = await scanZXingRobust(source, opts.region);
    if (!cands.length && opts.useOcr !== false) {
      const ocrCanvas = toCanvas(source, opts.region, 1800);
      cands = await scanOcr(ocrCanvas);
      if (cands.length) method = 'OCR';
    }
    if (cands.length) {
      return { success: true, isbn: cands[0], candidates: cands, method, message: cands.length > 1 ? `ISBN ${cands.length}개 감지` : '인식 성공' };
    }
    return { success: false, isbn: null, candidates: [], method: 'NONE', message: '유효한 ISBN을 찾지 못했습니다.' };
  }

  // 네이티브 BarcodeDetector 로 한 번에 모든 바코드를 위치와 함께 → [{code, box:{x,y,w,h}}]
  async function detectAllNative(source) {
    if (!('BarcodeDetector' in window)) return [];
    try {
      const det = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a'] });
      const found = await det.detect(source);
      const seen = new Set(); const out = [];
      for (const b of found) {
        if (!isValidProduct(b.rawValue)) continue;
        const code = clean(b.rawValue); if (seen.has(code)) continue; seen.add(code);
        const bb = b.boundingBox || {};
        out.push({ code, box: { x: bb.x || 0, y: bb.y || 0, w: bb.width || 0, h: bb.height || 0 } });
      }
      return out;
    } catch (_) { return []; }
  }
  // ZXing 은 이미지당 1개만 디코드 → 통짜 + 겹치는 타일을 돌며 서로 다른 바코드를 모두 수집(근사 위치)
  async function zxingMultiTiles(source) {
    try { await ensureZXing(); } catch (_) { return []; }
    const nw = source.naturalWidth || source.videoWidth || source.width;
    const nh = source.naturalHeight || source.videoHeight || source.height;
    const found = new Map();
    const record = (code, box) => { const cur = found.get(code); if (!cur) found.set(code, { code, box: box || null }); else if (!cur.box && box) cur.box = box; };
    { const c = await zxDecodeMulti(source, 0, 0, nw, nh, [Math.min(2200, Math.max(nw, nh)), 1600]); if (c) record(c, null); } // 통짜(위치 모름)
    const nx = 3, ny = 3, ov = 0.35, tw = nw / nx, th = nh / ny;
    for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
      const x = Math.max(0, tw * ix - tw * ov), y = Math.max(0, th * iy - th * ov);
      const w = Math.min(nw - x, tw * (1 + 2 * ov)), h = Math.min(nh - y, th * (1 + 2 * ov));
      const c = await zxDecodeMulti(source, x, y, w, h, [1200]); if (c) record(c, { x, y, w, h });
    }
    return [...found.values()];
  }
  const byPos = (a, b) => ((a.box ? a.box.y : 1e9) - (b.box ? b.box.y : 1e9)) || ((a.box ? a.box.x : 0) - (b.box ? b.box.x : 0));
  // 한 이미지의 바코드를 하나도 빠뜨리지 않고 모두 수집 → [{code, box|null}] (위→아래 정렬)
  // 네이티브(정확 위치) 우선, 부족하면 ZXing 타일로 보강. 다중 바코드 선택 UI 용.
  async function scanMulti(source) {
    const native = await detectAllNative(source);
    if (native.length >= 2) return native.slice().sort(byPos);
    const zx = await zxingMultiTiles(source);
    const map = new Map();
    for (const b of zx) map.set(b.code, b);
    for (const b of native) map.set(b.code, b); // 네이티브 위치가 더 정확 → 덮어씀
    return [...map.values()].sort(byPos);
  }

  // ISBN 을 파일명에 안전하게 넣기용 하이픈 표기(978-89-...)는 생략, 숫자 그대로 사용
  return { scan, scanMulti, isValidBarcode, isBookIsbn, isValidProduct, extractCandidates, clean };
})();
