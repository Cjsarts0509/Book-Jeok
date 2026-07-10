'use strict';

// 이미지 문서 OCR (tesseract, 로컬·오프라인). 정확도 향상을 위해
//  1) 전처리(ImageMagick)
//     - 조명/그림자 균일화(division normalize): 흐린 배경을 추정해 나눠서 얼룩 제거
//     - 그레이스케일·크기정규화·기울기보정·명암정규화
//     - 적응형 이진화(-lat) 변형본도 별도 생성
//  2) 고정밀 언어모델(tessdata_best) 있으면 우선 사용
//  3) 다중 변형(전처리본×PSM)을 돌려 신뢰도(confidence)가 가장 높은 결과 자동 채택
// 실패해도 원본/기본모델로 폴백하며, 업로드/응답을 막지 않도록 백그라운드 큐로 처리.
const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { query } = require('./db');

const DISABLED = process.env.OCR_DISABLED === '1';
const LANG = process.env.OCR_LANG || 'kor+eng';
const OEM = String(process.env.OCR_OEM || '1');            // 1=LSTM
// 여러 PSM 을 시도해 신뢰도가 가장 높은 결과 채택 (3=자동, 6=단일블록, 4=단일컬럼)
const PSMS = String(process.env.OCR_PSMS || '3,6').split(',').map((s) => s.trim()).filter(Boolean);
const TIMEOUT_MS = parseInt(process.env.OCR_TIMEOUT_MS || '90000', 10);
const PREPROCESS = process.env.OCR_PREPROCESS !== '0';     // 기본 켬
const BINARIZE = process.env.OCR_BINARIZE !== '0';         // 적응형 이진화 변형본 사용
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

const tmpPng = (tag) =>
  path.join(os.tmpdir(), `ocr${tag}_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);

function convertTo(args, out) {
  return new Promise((resolve) => {
    execFile('convert', args, { timeout: 40000 }, (err) => resolve(err ? null : out));
  });
}

// 그레이 정규화본: 조명/그림자 얼룩 제거(division) + 명암 정규화 + 기울기 보정
async function preGray(src) {
  if (!PREPROCESS || !imAvailable()) return null;
  const out = tmpPng('g');
  const args = [
    src,
    '-auto-orient',
    '-colorspace', 'Gray',
    '-resize', '3500x3500>',                 // 과대 축소
    '-resize', '1800x1800<',                 // 과소 확대(글자 최소 크기 확보)
    '(', '+clone', '-blur', '0x25', ')',     // 배경 추정(흐린 사본)
    '-compose', 'divide', '-composite',      // 원본 ÷ 배경 = 조명 얼룩 제거
    '-normalize',
    '-deskew', '40%',
    out,
  ];
  return convertTo(args, out);
}

// 이진화본: 그레이 정규화 후 적응형 임계값(-lat)으로 글자만 검게
async function preBin(src) {
  if (!PREPROCESS || !BINARIZE || !imAvailable()) return null;
  const out = tmpPng('b');
  const args = [
    src,
    '-auto-orient',
    '-colorspace', 'Gray',
    '-resize', '3500x3500>',
    '-resize', '1800x1800<',
    '(', '+clone', '-blur', '0x25', ')',
    '-compose', 'divide', '-composite',
    '-normalize',
    '-deskew', '40%',
    '-lat', '30x30+12%',                     // 지역 적응형 이진화(불균일 조명에 강함)
    out,
  ];
  return convertTo(args, out);
}

function cleanText(s) {
  return String(s || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .slice(0, MAX_CHARS);
}

// tesseract TSV 파싱 → { text, conf }. conf 는 단어 신뢰도 평균(0~100)
function parseTsv(tsv) {
  const lines = String(tsv || '').split('\n');
  let confSum = 0, confN = 0;
  const out = [];
  let curLine = -1, curBlock = -1, buf = [];
  const flush = () => { if (buf.length) { out.push(buf.join(' ')); buf = []; } };
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split('\t');
    if (c.length < 12) continue;
    const level = parseInt(c[0], 10);
    if (level !== 5) continue;                 // 5 = word
    const block = parseInt(c[2], 10), line = parseInt(c[4], 10);
    const conf = parseFloat(c[10]);
    const word = (c[11] || '').trim();
    if (!word) continue;
    if (block !== curBlock) { flush(); if (curBlock !== -1) out.push(''); curBlock = block; curLine = line; }
    else if (line !== curLine) { flush(); curLine = line; }
    buf.push(word);
    if (conf >= 0) { confSum += conf; confN += 1; }
  }
  flush();
  return { text: cleanText(out.join('\n')), conf: confN ? confSum / confN : 0, words: confN };
}

function runVariant(imgPath, psm) {
  const args = [imgPath, 'stdout', '-l', LANG, '--oem', OEM, '--psm', String(psm), '--dpi', '300', 'tsv'];
  const bd = bestTessdataDir();
  if (bd) args.push('--tessdata-dir', bd);
  args.push('-c', 'preserve_interword_spaces=1');
  return new Promise((resolve) => {
    execFile('tesseract', args, { timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(parseTsv(stdout));
    });
  });
}

// 신뢰도 우선, 동률(±0.5)이면 더 많은 글자를 인식한 쪽을 채택
function better(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (b.conf > a.conf + 0.5) return b;
  if (Math.abs(b.conf - a.conf) <= 0.5 && b.text.length > a.text.length) return b;
  return a;
}

// 여러 전처리본 × PSM 조합을 돌려 신뢰도 최고 결과 채택
async function extractText(filePath) {
  let gray = null, bin = null;
  try {
    [gray, bin] = await Promise.all([preGray(filePath), preBin(filePath)]);
  } catch { /* 전처리 실패 → 원본 사용 */ }
  const made = [gray, bin].filter(Boolean);

  const images = made.length ? made.slice() : [filePath];
  let best = null;
  for (const img of images) {
    for (const psm of PSMS) {
      best = better(best, await runVariant(img, psm));
    }
  }
  // 전처리본으로 아무것도 못 얻었으면 원본으로 마지막 시도
  if (!best && made.length) {
    for (const psm of PSMS) best = better(best, await runVariant(filePath, psm));
  }

  made.forEach((p) => fsp.unlink(p).catch(() => {}));
  if (!best) return { ok: false };
  return { ok: true, text: best.text, confidence: Math.round(best.conf) };
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
  if (r.ok) await query('UPDATE files SET ocr_text=$1, ocr_status=$2, ocr_confidence=$3 WHERE id=$4', [r.text || '', 'done', r.confidence ?? null, fileId]);
  else await query("UPDATE files SET ocr_status='error' WHERE id=$1", [fileId]);
}
function enqueue(fileId, filePath) {
  if (!enabled()) return;
  q.push(() => processFile(fileId, filePath));
  pump();
}

module.exports = { enabled, canOcr, extractText, enqueue };
