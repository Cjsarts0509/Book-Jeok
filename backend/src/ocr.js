'use strict';

// 이미지 문서 OCR (tesseract, 로컬·오프라인). 정확도 향상을 위해
//  1) 전처리(ImageMagick): 방향보정·그레이스케일·크기정규화·기울기보정·명암정규화
//  2) 고정밀 언어모델(tessdata_best) 있으면 우선 사용
//  3) 튜닝된 파라미터(--oem 1, psm, --dpi, preserve_interword_spaces)
// 실패해도 원본/기본모델로 폴백하며, 업로드/응답을 막지 않도록 백그라운드 큐로 처리.
const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { query } = require('./db');

const DISABLED = process.env.OCR_DISABLED === '1';
const LANG = process.env.OCR_LANG || 'kor+eng';
const PSM = String(process.env.OCR_PSM || '3');            // 3=자동, 4=단일컬럼, 6=단일블록
const OEM = String(process.env.OCR_OEM || '1');            // 1=LSTM
const TIMEOUT_MS = parseInt(process.env.OCR_TIMEOUT_MS || '90000', 10);
const PREPROCESS = process.env.OCR_PREPROCESS !== '0';     // 기본 켬
const BEST_DIR = process.env.OCR_TESSDATA_DIR || '/usr/share/tessdata-best';
const MAX_CHARS = 100000;

const IMG_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff']);
const extOf = (name) => (String(name).split('.').pop() || '').toLowerCase();
const canOcr = (name) => IMG_EXT.has(extOf(name));

let tessAvail = null;
function binaryAvailable() {
  if (tessAvail !== null) return tessAvail;
  try { execFileSync('tesseract', ['--version'], { stdio: 'ignore' }); tessAvail = true; }
  catch { tessAvail = false; }
  return tessAvail;
}
const enabled = () => !DISABLED && binaryAvailable();

let imAvail = null;
function imAvailable() {
  if (imAvail !== null) return imAvail;
  try { execFileSync('convert', ['-version'], { stdio: 'ignore' }); imAvail = true; }
  catch { imAvail = false; }
  return imAvail;
}

// tessdata_best 에 필요한 언어(kor/eng)가 모두 있으면 그 폴더 사용
let bestDir = null;
function bestTessdataDir() {
  if (bestDir !== null) return bestDir || null;
  try {
    const langs = LANG.split('+').map((s) => s.trim()).filter(Boolean);
    const ok = langs.every((l) => fs.existsSync(path.join(BEST_DIR, l + '.traineddata')));
    bestDir = ok ? BEST_DIR : '';
  } catch { bestDir = ''; }
  return bestDir || null;
}

// ImageMagick 전처리 → 임시 PNG 경로 반환(실패 시 null)
function preprocess(src) {
  if (!PREPROCESS || !imAvailable()) return Promise.resolve(null);
  const out = path.join(os.tmpdir(), `ocrpre_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
  const args = [
    src,
    '-auto-orient',              // EXIF 방향 보정
    '-colorspace', 'Gray',       // 흑백
    '-resize', '3500x3500>',     // 너무 크면 축소
    '-resize', '1800x1800<',     // 너무 작으면 확대(글자 최소 크기 확보)
    '-deskew', '40%',            // 기울기 보정
    '-normalize',                // 명암 정규화
    out,
  ];
  return new Promise((resolve) => {
    execFile('convert', args, { timeout: 40000 }, (err) => resolve(err ? null : out));
  });
}

function cleanText(s) {
  return String(s || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .slice(0, MAX_CHARS);
}

async function extractText(filePath) {
  const pre = await preprocess(filePath);
  const target = pre || filePath;
  const args = [target, 'stdout', '-l', LANG, '--oem', OEM, '--psm', PSM, '--dpi', '300'];
  const bd = bestTessdataDir();
  if (bd) { args.push('--tessdata-dir', bd); }
  args.push('-c', 'preserve_interword_spaces=1');
  return new Promise((resolve) => {
    execFile('tesseract', args, { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (pre) fsp.unlink(pre).catch(() => {});
      if (err) return resolve({ ok: false });
      resolve({ ok: true, text: cleanText(stdout) });
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
