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
  const ensureZXing = () => loadScript('vendor/zxing.min.js?v=160', 'ZXing');
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
  // 캔버스를 90° 시계방향 회전한 새 캔버스 (세로 바코드를 눕혀 ZXing 이 또렷이 읽게)
  function rotate90(canvas) {
    const c = document.createElement('canvas'); c.width = canvas.height; c.height = canvas.width;
    const ctx = c.getContext('2d'); ctx.translate(canvas.height, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(canvas, 0, 0);
    return c;
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

  // 한 캔버스에서 바코드를 마스킹 반복으로 모두 디코드 → 코드 배열(위치 없음). 검출 완전성(놓친 코드) 보강용.
  async function decodeCodesMasked(canvas, maxCodes) {
    const ctx = canvas.getContext('2d');
    const out = [];
    for (let i = 0; i < (maxCodes || 4); i++) {
      let r;
      try { r = await (await ensureReader()).decodeFromImageUrl(canvas.toDataURL('image/png')); }
      catch (_) { break; }
      if (!r || !isValidProduct(r.getText())) break;
      const code = clean(r.getText());
      if (out.includes(code)) break;
      out.push(code);
      let pts = null; try { pts = r.getResultPoints && r.getResultPoints(); } catch (_) {}
      if (!pts || !pts.length) break;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of pts) { const px = p.getX(), py = p.getY(); if (px < minX) minX = px; if (px > maxX) maxX = px; if (py < minY) minY = py; if (py > maxY) maxY = py; }
      const along = Math.max(maxX - minX, maxY - minY, 8), cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, half = along * 0.8;
      ctx.fillStyle = '#fff'; ctx.fillRect(cx - half, cy - half, half * 2, half * 2);
    }
    return out;
  }

  // ── 바코드 '영역' 검출: 구조텐서로 줄무늬 영역을 직접 찾음(디코드와 무관 → 방향·회전에 강함) ──────────
  // 바코드는 한 방향으로 강한 그라디언트(이방성 큰) 영역 → 블록 단위 점수 → 형태학적 닫힘 → 연결요소.
  // 반환: [{x,y,w,h}] (원본 좌표, 바 영역을 타이트하게 감쌈).
  function findBarcodeRegions(source) {
    const NW = source.naturalWidth || source.videoWidth || source.width;
    const NH = source.naturalHeight || source.videoHeight || source.height;
    const scale = Math.min(1, 720 / Math.max(NW, NH));
    const w = Math.max(1, Math.round(NW * scale)), h = Math.max(1, Math.round(NH * scale));
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    let ctx; try { ctx = cv.getContext('2d', { willReadFrequently: true }); } catch (_) { ctx = cv.getContext('2d'); }
    ctx.drawImage(source, 0, 0, w, h);
    let data; try { data = ctx.getImageData(0, 0, w, h).data; } catch (_) { return []; }
    const g = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      gx[i] = (g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1]) - (g[i - w - 1] + 2 * g[i - 1] + g[i + w - 1]);
      gy[i] = (g[i + w - 1] + 2 * g[i + w] + g[i + w + 1]) - (g[i - w - 1] + 2 * g[i - w] + g[i - w + 1]);
    }
    const B = 10, bw = Math.ceil(w / B), bh = Math.ceil(h / B);
    const sxx = new Float32Array(bw * bh), syy = new Float32Array(bw * bh), sxy = new Float32Array(bw * bh);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, bi = ((y / B) | 0) * bw + ((x / B) | 0);
      sxx[bi] += gx[i] * gx[i]; syy[bi] += gy[i] * gy[i]; sxy[bi] += gx[i] * gy[i];
    }
    const score = new Float32Array(bw * bh); let maxS = 0;
    for (let i = 0; i < bw * bh; i++) {
      const tr = sxx[i] + syy[i];
      const coh = Math.sqrt((sxx[i] - syy[i]) * (sxx[i] - syy[i]) + 4 * sxy[i] * sxy[i]);
      const aniso = tr > 1 ? coh / tr : 0, s = tr * aniso * aniso;
      score[i] = s; if (s > maxS) maxS = s;
    }
    if (maxS <= 0) return [];
    const thr = maxS * 0.10; let mask = new Uint8Array(bw * bh);
    for (let i = 0; i < bw * bh; i++) mask[i] = score[i] > thr ? 1 : 0;
    const morph = (m, r, dil) => {
      const o = new Uint8Array(bw * bh);
      for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
        let v = dil ? 0 : 1;
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          const nx = bx + dx, ny = by + dy, s = (nx < 0 || ny < 0 || nx >= bw || ny >= bh) ? 0 : m[ny * bw + nx];
          if (dil) { if (s) v = 1; } else { if (!s) v = 0; }
        }
        o[by * bw + bx] = v;
      }
      return o;
    };
    mask = morph(morph(mask, 2, true), 2, false);             // 닫힘: 바 사이 틈을 메워 하나의 덩어리로
    const lab = new Int32Array(bw * bh), comps = [], st = [];
    for (let i = 0; i < bw * bh; i++) {
      if (!mask[i] || lab[i]) continue;
      const id = comps.length + 1; lab[i] = id;
      let x0 = i % bw, x1 = x0, y0 = (i / bw) | 0, y1 = y0, cnt = 0; st.length = 0; st.push(i);
      while (st.length) {
        const p = st.pop(); cnt++; const px = p % bw, py = (p / bw) | 0;
        if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx, ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
          const np = ny * bw + nx;
          if (mask[np] && !lab[np]) { lab[np] = id; st.push(np); }
        }
      }
      comps.push({ x0, y0, x1, y1, cnt });
    }
    const out = [];
    for (const c of comps) {
      const rbw = c.x1 - c.x0 + 1, rbh = c.y1 - c.y0 + 1, area = rbw * rbh, aspect = rbw / rbh;
      if (c.cnt < 6 || c.cnt / area < 0.45) continue;         // 너무 작거나 성긴 덩어리 제외
      if (aspect > 6 || aspect < 1 / 6) continue;             // 극단적으로 가느다란 띠(바코드 아님) 제외
      out.push({ x: (c.x0 * B) / scale, y: (c.y0 * B) / scale, w: (rbw * B) / scale, h: (rbh * B) / scale, cnt: c.cnt });
    }
    out.sort((a, b) => b.cnt - a.cnt);
    return out.slice(0, 8);
  }
  // 검출된 영역을 잘라 여러 배율로 디코드 → { code: 2표↑ 일치(확실), weak: 최다표 코드(1표 가능) }.
  // 회전은 ZXing 내부 처리. code 는 흐림 오독을 막고, weak 는 나중에 독립 확인된 코드와 교차검증해 박스를 준다.
  async function decodeRegionVotes(source, reg) {
    const NW = source.naturalWidth || source.videoWidth || source.width;
    const NH = source.naturalHeight || source.videoHeight || source.height;
    const ex = reg.w * 0.25, ey = reg.h * 0.25;               // 여백(quiet zone) 포함해 넉넉히
    const x = Math.max(0, reg.x - ex), y = Math.max(0, reg.y - ey);
    const w = Math.min(NW - x, reg.w + 2 * ex), h = Math.min(NH - y, reg.h + 2 * ey);
    // 배율은 영역 크기에 비례 — 작은 영역을 과도하게 확대하면 흐림이 증폭돼 오독됨. 원본~2.4배로 제한.
    const base = Math.max(w, h);
    const cap = (t) => Math.min(1600, Math.max(600, Math.round(t)));
    const scales = [...new Set([cap(base), cap(base * 1.3), cap(base * 1.7), cap(base * 2.2)])];
    const votes = {};
    const tally = (c) => { if (c) votes[c] = (votes[c] || 0) + 1; };
    const pick = () => { let b = null, n = 0; for (const c in votes) if (votes[c] > n) { b = c; n = votes[c]; } return { best: b, n }; };
    // 1) 0° 여러 배율 + 흐림 보정(가로 바코드는 대부분 여기서 확정 → 빠름)
    for (const tl of scales) tally(await zxDecode(cropCanvas(source, x, y, w, h, tl)));
    tally(await zxDecode(enhance(cropCanvas(source, x, y, w, h, cap(base * 1.5)))));
    let p = pick();
    if (p.n >= 2) return { code: p.best, votes: p.n, rotated: false };
    // 2) 확실하지 않으면 세로용 90°(+흐림 보정) 투표를 더한다
    for (const tl of scales) tally(await zxDecode(rotate90(cropCanvas(source, x, y, w, h, tl))));
    tally(await zxDecode(rotate90(enhance(cropCanvas(source, x, y, w, h, cap(base * 1.5))))));
    p = pick();
    return { code: p.n >= 2 ? p.best : null, votes: p.n, rotated: true };
  }
  // 검출 완전성 보강: 통짜+2x2 를 마스킹 디코드해 코드만 수집(영역 검출/디코드가 놓친 것 대비). 폴백 전용.
  async function zxingAllCodes(source) {
    try { await ensureZXing(); } catch (_) { return []; }
    const nw = source.naturalWidth || source.videoWidth || source.width;
    const nh = source.naturalHeight || source.videoHeight || source.height;
    const codes = new Set();
    for (const [cols, rows, ov] of [[1, 1, 0], [2, 2, 0.2], [3, 3, 0.25]]) {
      const tw = nw / cols, th = nh / rows;
      for (let iy = 0; iy < rows; iy++) for (let ix = 0; ix < cols; ix++) {
        const x = Math.max(0, tw * ix - tw * ov), y = Math.max(0, th * iy - th * ov);
        const w = Math.min(nw - x, tw * (1 + 2 * ov)), h = Math.min(nh - y, th * (1 + 2 * ov));
        const tl = Math.min(1600, Math.max(900, Math.round(Math.max(w, h) * 1.4)));
        (await decodeCodesMasked(cropCanvas(source, x, y, w, h, tl), 4)).forEach((c) => codes.add(c));
        (await decodeCodesMasked(enhance(cropCanvas(source, x, y, w, h, tl)), 4)).forEach((c) => codes.add(c));
        // 회전은 영역 디코드(decodeRegionVotes)의 90° 단계가 처리 → 여기서 통짜 90° 는 흐림 오독 위험만 커 제외
      }
    }
    return [...codes];
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
  // 다중 바코드 채택 강도(다이얼). vote↓ 이거나 twoVote=true 일수록 완성도↑
  //  (팬텀 위험은 EAN 체크섬 + 영역 모양 필터 + 박스 겹침 제거로 억제).
  //  A: vote 4→3, voteRot 3→2 / C: twoVote=true(유효 2표면 채택). 보수적으로 되돌리려면 {vote:4,voteRot:3,twoVote:false}.
  const MULTI_ACCEPT = { vote: 3, voteRot: 2, twoVote: true };

  async function scanMulti(source) {
    const nw = source.naturalWidth || source.videoWidth || source.width;
    const nh = source.naturalHeight || source.videoHeight || source.height;
    const clamp = (b) => {                                    // 박스를 이미지 안으로 다듬고, 거의 밖이면 제거(칩 폴백)
      if (!b || !b.box) return b;
      const o = b.box;
      const x = Math.max(0, Math.min(nw - 1, o.x)), y = Math.max(0, Math.min(nh - 1, o.y));
      const w = Math.min(nw - x, o.x + o.w - x), h = Math.min(nh - y, o.y + o.h - y);
      if (w <= 8 || h <= 8 || (w * h) / (Math.max(1, o.w) * Math.max(1, o.h)) < 0.5) return { code: b.code, box: null };
      return { code: b.code, box: { x, y, w, h } };
    };
    const result = new Map(); // code -> {code, box|null}
    // 1) 네이티브 BarcodeDetector(있으면): 정확한 위치 + 코드 (가장 신뢰)
    for (const b of await detectAllNativeTiled(source)) result.set(b.code, { code: b.code, box: b.box });
    // 2) 구조텐서로 바코드 '영역'을 직접 찾고(방향 무관) → 각 영역을 '확실히' 디코드(2표↑)한 것만 채택.
    //    한 영역=한 코드로, 표가 많은(확실한) 순으로 1:1 배정 → 코드가 엉뚱한 영역에 붙는 오배치 방지.
    let regionCount = 0;
    if (result.size < 2 || [...result.values()].some((v) => !v.box)) {
      const regions = findBarcodeRegions(source);
      regionCount = regions.length;
      const hits = [];
      for (const reg of regions) {
        const v = await decodeRegionVotes(source, reg);
        if (v.code) hits.push({ reg, code: v.code, votes: v.votes, rotated: v.rotated });
      }
      // 유령 바코드 방지: 표가 많으면(4↑) 확실히 채택. 애매하면(2~3표) 통짜/격자 디코드로 '독립 확인'된
      //    코드만 채택(유령은 한 영역 크롭에서만 나오고 통짜 디코드엔 안 잡힘). 회전(90°로 읽음)은 통짜 0°로
      //    확인이 안 되므로 3표 이상이면 채택.
      const strong = (h) => h.votes >= MULTI_ACCEPT.vote || (h.rotated && h.votes >= MULTI_ACCEPT.voteRot);
      const needConfirm = !MULTI_ACCEPT.twoVote && hits.some((h) => !strong(h));
      const confirmed = needConfirm ? new Set(await zxingAllCodes(source)) : null;
      const ok = (h) => strong(h) || (MULTI_ACCEPT.twoVote && h.votes >= 2) || (confirmed && confirmed.has(h.code));
      const accepted = hits.filter(ok).sort((a, b) => b.votes - a.votes); // 확실한 것부터 1:1 배정
      // 안전망: 이미 채택된 박스와 크게 겹치면(같은 바코드/팬텀) 스킵 → 3번째 유령 차단
      const overlaps = (a, b) => {
        const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
        const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        return (ix * iy) / (Math.min(a.w * a.h, b.w * b.h) || 1) > 0.5;
      };
      const usedReg = new Set(), boxed = new Set(), takenBoxes = [];
      for (const h of accepted) {
        if (boxed.has(h.code) || usedReg.has(h.reg)) continue;
        if (takenBoxes.some((b) => overlaps(b, h.reg))) continue;
        if (!result.has(h.code) || !result.get(h.code).box) result.set(h.code, { code: h.code, box: { x: h.reg.x, y: h.reg.y, w: h.reg.w, h: h.reg.h } });
        boxed.add(h.code); usedReg.add(h.reg); takenBoxes.push(h.reg);
      }
      // confirmed 는 '유령 걸러내는 대조용'으로만 씀 → 여기서 새 코드를 칩으로 추가하지 않음(대조셋 오독이 3번째로 새는 것 방지)
    }
    // 3) 그래도 2개 미만이고 영역이 여럿이면(놓친 바코드) 통짜·격자 폴백으로 코드만 보강(위치 불명 칩)
    if (result.size < 2 && regionCount >= 2) {
      for (const c of await zxingAllCodes(source)) if (!result.has(c)) result.set(c, { code: c, box: null });
    }
    return [...result.values()].map(clamp).sort(byPos);
  }

  // ISBN 을 파일명에 안전하게 넣기용 하이픈 표기(978-89-...)는 생략, 숫자 그대로 사용
  return { scan, scanMulti, findBarcodeRegions, isValidBarcode, isBookIsbn, isValidProduct, extractCandidates, clean };
})();
