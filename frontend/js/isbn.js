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
  const ensureZXing = () => loadScript('vendor/zxing.min.js?v=89', 'ZXing');
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

  // ── 흐림 보정: 흑백화 + 대비 스트레치 + 샤픈(3x3) → 새 캔버스 ──────────
  // 흐린 사진의 바코드 모듈 경계를 살려 디코드 성공률을 높인다.
  function enhance(srcCanvas) {
    const w = srcCanvas.width, h = srcCanvas.height;
    if (w < 3 || h < 3) return srcCanvas;
    let img;
    try { img = srcCanvas.getContext('2d').getImageData(0, 0, w, h); }
    catch (_) { return srcCanvas; }
    const d = img.data, N = w * h;
    const gray = new Float32Array(N);
    let mn = 255, mx = 0;
    for (let i = 0; i < N; i++) { const g = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; gray[i] = g; if (g < mn) mn = g; if (g > mx) mx = g; }
    const range = Math.max(1, mx - mn);
    const norm = new Float32Array(N);
    for (let i = 0; i < N; i++) norm[i] = (gray[i] - mn) / range * 255;   // 대비 스트레치
    const out = new Uint8ClampedArray(N * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {             // 샤픈 커널 [0,-1,0,-1,5,-1,0,-1,0]
      const i = y * w + x;
      let v = (x > 0 && x < w - 1 && y > 0 && y < h - 1)
        ? 5 * norm[i] - norm[i - 1] - norm[i + 1] - norm[i - w] - norm[i + w]
        : norm[i];
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      const j = i * 4; out[j] = out[j + 1] = out[j + 2] = v; out[j + 3] = 255;
    }
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').putImageData(new ImageData(out, w, h), 0, 0);
    return c;
  }

  // 캔버스를 90° 시계방향 회전한 새 캔버스 (세로 바코드를 가로로 눕혀 정확히 디코드하기 위함)
  function rotate90(canvas) {
    const w = canvas.width, h = canvas.height;
    const c = document.createElement('canvas'); c.width = h; c.height = w; // 가로/세로 뒤바뀜
    const ctx = c.getContext('2d');
    ctx.translate(h, 0); ctx.rotate(Math.PI / 2);           // 90° CW
    ctx.drawImage(canvas, 0, 0);
    return c;
  }
  // 한 캔버스에서 바코드를 "찾고 → 그 자리를 흰색으로 지우고 → 다시 찾기" 반복해 여러 개를 모두 수집.
  // ZXing 은 이미지당 1개만 반환하므로, 겹쳐 있어도 마스킹으로 두 번째·세 번째를 잡아낸다.
  // toSource(cbox): 캔버스 좌표 박스 → 원본 좌표 박스 매퍼(회전 보정 포함). reliable: 판독축이 가로였는지.
  async function zxDecodeAllOnCanvas(canvas, toSource, maxCodes) {
    const ctx = canvas.getContext('2d');
    const out = [];
    for (let i = 0; i < (maxCodes || 5); i++) {
      let r;
      try { r = await (await ensureReader()).decodeFromImageUrl(canvas.toDataURL('image/png')); }
      catch (_) { break; }                                   // NotFound → 더 없음
      if (!r || !isValidProduct(r.getText())) break;
      const code = clean(r.getText());
      let pts = null; try { pts = r.getResultPoints && r.getResultPoints(); } catch (_) {}
      let cbox = null, mask = null, reliable = false;
      if (pts && pts.length) {
        // resultPoints 는 바코드 '판독 방향'의 양 끝점. 이 캔버스에서 가로로 벌어졌으면(=ZXing 이 내부 회전
        // 없이 바로 읽음) 위치가 신뢰됨. 세로로 벌어졌으면 내부 회전으로 읽은 것 → 위치 부정확(reliable=false).
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const p of pts) { const px = p.getX(), py = p.getY(); if (px < minX) minX = px; if (px > maxX) maxX = px; if (py < minY) minY = py; if (py > maxY) maxY = py; }
        const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;
        const dx = maxX - minX, dy = maxY - minY;
        const horiz = dx >= dy; reliable = horiz && dx > 20;
        const along = Math.max(dx, dy, 8);                   // 판독축 길이(바코드 폭)
        const cross = Math.max(Math.min(dx, dy), along * 0.5); // 수직축(바 높이) 추정
        const bwc = horiz ? along : cross, bhc = horiz ? cross : along;
        cbox = { x: midX - bwc / 2, y: midY - bhc / 2, w: bwc, h: bhc };
        const pad = along * 0.12;                            // 마스킹은 넉넉히 덮어 재검출 방지
        mask = { x: cbox.x - pad, y: cbox.y - pad, w: cbox.w + 2 * pad, h: cbox.h + 2 * pad };
      }
      if (!out.some((o) => o.code === code)) out.push({ code, box: cbox ? toSource(cbox) : null, reliable });
      if (!mask) break;                                      // 위치를 몰라 못 지우면 무한루프 방지 위해 종료
      ctx.fillStyle = '#fff';
      ctx.fillRect(mask.x, mask.y, mask.w, mask.h);
    }
    return out;
  }
  // 한 영역(x,y,w,h)을 배율 tl 로 잘라 0°(+선택적 90°, 샤픈)로 마스킹 디코드. 회전은 직접 걸어 좌표를 정확히 역매핑.
  async function collectFromRegion(source, x, y, w, h, tl, opts, record) {
    const k = tl / Math.max(w, h);
    const ch = cropCanvas(source, x, y, w, h, tl).height;    // 회전 역매핑용 캔버스 높이(배율 고정이라 일정)
    const src0 = (b) => ({ x: x + b.x / k, y: y + b.y / k, w: b.w / k, h: b.h / k });
    // 90° CW 로 눕혀 읽은 좌표를 원래 방향으로 되돌림: crop(cx,cy)=(rotY, ch-rotX)
    const src90 = (b) => ({ x: x + b.y / k, y: y + (ch - (b.x + b.w)) / k, w: b.h / k, h: b.w / k });
    const mk = () => cropCanvas(source, x, y, w, h, tl);     // 매 패스마다 새 캔버스(마스킹으로 변형되므로)
    const max = opts.max || 5;
    (await zxDecodeAllOnCanvas(mk(), src0, max)).forEach(record);
    if (opts.enhance) (await zxDecodeAllOnCanvas(enhance(mk()), src0, max)).forEach(record);
    if (opts.rot90) (await zxDecodeAllOnCanvas(rotate90(mk()), src90, max)).forEach(record); // 세로 바코드용
  }
  // ZXing 은 이미지당 1개만 디코드 → 통짜(0°/90°/샤픈) + 겹치는 타일을 마스킹 반복으로 모두 수집
  async function zxingMultiTiles(source) {
    try { await ensureZXing(); } catch (_) { return []; }
    const nw = source.naturalWidth || source.videoWidth || source.width;
    const nh = source.naturalHeight || source.videoHeight || source.height;
    const found = new Map();
    // 위치는 '신뢰(가로로 바로 읽힘)' 박스를 우선 채택 — 회전 사진의 부정확 박스에 덮이지 않게
    const record = (r) => {
      const cur = found.get(r.code);
      if (!cur) { found.set(r.code, { code: r.code, box: r.box || null, reliable: !!r.reliable }); return; }
      if (r.box && (!cur.box || (r.reliable && !cur.reliable))) { cur.box = r.box; cur.reliable = !!r.reliable; }
    };
    // 1) 통짜: 최고배율은 0°+샤픈+90°, 보조배율은 0°+샤픈(흐림 보강)
    const hi = Math.min(2200, Math.max(nw, nh));
    await collectFromRegion(source, 0, 0, nw, nh, hi, { enhance: true, rot90: true, max: 6 }, record);
    await collectFromRegion(source, 0, 0, nw, nh, 1600, { enhance: true, rot90: false, max: 6 }, record);
    // 2) 겹치는 3x3 타일 — 프레임 대비 작은 바코드까지 확대해 0°로 재시도
    const nx = 3, ny = 3, ov = 0.45, tw = nw / nx, th = nh / ny;
    for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
      const x = Math.max(0, tw * ix - tw * ov), y = Math.max(0, th * iy - th * ov);
      const w = Math.min(nw - x, tw * (1 + 2 * ov)), h = Math.min(nh - y, th * (1 + 2 * ov));
      await collectFromRegion(source, x, y, w, h, 1400, { enhance: false, rot90: false, max: 4 }, record);
    }
    return [...found.values()].map((r) => ({ code: r.code, box: r.box }));
  }
  // 네이티브 BarcodeDetector 를 통짜 + 확대 타일에 적용해 흐린/작은 바코드까지 위치와 함께 수집
  async function detectAllNativeTiled(source) {
    if (!('BarcodeDetector' in window)) return [];
    let det;
    try { det = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a'] }); }
    catch (_) { return []; }
    const nw = source.naturalWidth || source.videoWidth || source.width;
    const nh = source.naturalHeight || source.videoHeight || source.height;
    const found = new Map();
    const addFrom = async (canvas, ox, oy, k) => {
      let res; try { res = await det.detect(canvas); } catch (_) { return; }
      for (const b of res) {
        if (!isValidProduct(b.rawValue)) continue;
        const code = clean(b.rawValue); if (found.has(code)) continue;
        const bb = b.boundingBox || {};
        found.set(code, { code, box: { x: ox + (bb.x || 0) / k, y: oy + (bb.y || 0) / k, w: (bb.width || 0) / k, h: (bb.height || 0) / k } });
      }
    };
    await addFrom(source, 0, 0, 1);
    const nx = 3, ny = 3, ov = 0.45, tw = nw / nx, th = nh / ny;
    for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
      const x = Math.max(0, tw * ix - tw * ov), y = Math.max(0, th * iy - th * ov);
      const w = Math.min(nw - x, tw * (1 + 2 * ov)), h = Math.min(nh - y, th * (1 + 2 * ov));
      const tl = 1400, k = tl / Math.max(w, h);
      await addFrom(cropCanvas(source, x, y, w, h, tl), x, y, k);
    }
    return [...found.values()];
  }
  const byPos = (a, b) => ((a.box ? a.box.y : 1e9) - (b.box ? b.box.y : 1e9)) || ((a.box ? a.box.x : 0) - (b.box ? b.box.x : 0));
  // 한 이미지의 바코드를 하나도 빠뜨리지 않고 모두 수집 → [{code, box|null}] (위→아래 정렬)
  // 네이티브(통짜+타일)로 2개 이상이면 즉시 반환, 아니면 ZXing 타일(마스킹+샤픈)로 보강. 다중 선택 UI 용.
  async function scanMulti(source) {
    const nw = source.naturalWidth || source.videoWidth || source.width;
    const nh = source.naturalHeight || source.videoHeight || source.height;
    // 박스가 이미지 밖으로 크게 벗어나면(회전 추정 오차) 위치를 못 믿는 것 → 박스 제거(칩으로 폴백).
    // 조금 걸친 정도면 화면 안으로 다듬어 탭 가능하게.
    const clamp = (b) => {
      if (!b || !b.box) return b;
      const o = b.box;
      const x = Math.max(0, Math.min(nw - 1, o.x)), y = Math.max(0, Math.min(nh - 1, o.y));
      const w = Math.min(nw - x, o.x + o.w - x), h = Math.min(nh - y, o.y + o.h - y);
      const origArea = Math.max(1, o.w) * Math.max(1, o.h);
      if (w <= 8 || h <= 8 || (w * h) / origArea < 0.5) return { code: b.code, box: null };
      return { code: b.code, box: { x, y, w, h } };
    };
    const native = await detectAllNativeTiled(source);
    if (native.length >= 2) return native.map(clamp).sort(byPos);
    const zx = await zxingMultiTiles(source);
    const map = new Map();
    for (const b of zx) map.set(b.code, b);
    for (const b of native) { const cur = map.get(b.code); if (!cur || !cur.box) map.set(b.code, b); } // 네이티브 위치가 더 정확
    return [...map.values()].map(clamp).sort(byPos);
  }

  // ISBN 을 파일명에 안전하게 넣기용 하이픈 표기(978-89-...)는 생략, 숫자 그대로 사용
  return { scan, scanMulti, isValidBarcode, isBookIsbn, isValidProduct, extractCandidates, clean };
})();
