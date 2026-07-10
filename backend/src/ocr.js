'use strict';

// 이미지 문서 OCR (tesseract, 로컬·오프라인). 업로드된 이미지의 글자를 추출해
// files.ocr_text 에 저장 → 검색에서 파일 내용까지 찾을 수 있게 한다.
// 업로드 응답을 막지 않도록 백그라운드 큐(동시 1건)로 처리하고, 실패해도 fail-soft.
const { execFile, execFileSync } = require('child_process');
const { query } = require('./db');

const DISABLED = process.env.OCR_DISABLED === '1';
const LANG = process.env.OCR_LANG || 'kor+eng';
const TIMEOUT_MS = parseInt(process.env.OCR_TIMEOUT_MS || '60000', 10);
const MAX_CHARS = 50000;

const IMG_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff']);
const extOf = (name) => (String(name).split('.').pop() || '').toLowerCase();
const canOcr = (name) => IMG_EXT.has(extOf(name));

let available = null;
function binaryAvailable() {
  if (available !== null) return available;
  try { execFileSync('tesseract', ['--version'], { stdio: 'ignore' }); available = true; }
  catch { available = false; }
  return available;
}
const enabled = () => !DISABLED && binaryAvailable();

function extractText(filePath) {
  return new Promise((resolve) => {
    execFile('tesseract', [filePath, 'stdout', '-l', LANG], { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve({ ok: false });
      resolve({ ok: true, text: String(stdout || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS) });
    });
  });
}

// 동시 1건 큐 (작은 VM에서 CPU 폭주 방지)
const q = [];
let running = 0;
const MAX = parseInt(process.env.OCR_CONCURRENCY || '1', 10);
function pump() {
  while (running < MAX && q.length) {
    const task = q.shift();
    running++;
    task().catch(() => {}).finally(() => { running--; pump(); });
  }
}
async function processFile(fileId, filePath) {
  const r = await extractText(filePath);
  if (r.ok) await query('UPDATE files SET ocr_text=$1, ocr_status=$2 WHERE id=$3', [r.text || '', 'done', fileId]);
  else await query("UPDATE files SET ocr_status='error' WHERE id=$1", [fileId]);
}
function enqueue(fileId, filePath) {
  if (!enabled()) return;
  q.push(() => processFile(fileId, filePath));
  pump();
}

module.exports = { enabled, canOcr, extractText, enqueue };
