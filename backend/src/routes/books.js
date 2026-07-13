'use strict';

// 교보 키오스크 도서 검색/상세 프록시 (bookpulse python-api 재사용)
// 바코드 경로: ISBN → /books/detail
// OCR 경로:   제목 → /books/search → 후보 리스트에서 선택
const express = require('express');
const { authenticate } = require('../middleware/auth');
const { wrap } = require('../util');
const config = require('../config');

const router = express.Router();
router.use(authenticate);

const BASE = config.bookpulseApi;

async function pass(res, path, extraFallback) {
  if (!BASE) {
    return res.status(503).json({
      error: '도서 조회 서버(BOOKPULSE_API)가 설정되지 않았습니다',
      status: 'error',
      ...extraFallback,
    });
  }
  try {
    const r = await fetch(BASE + path, { signal: AbortSignal.timeout(30000) });
    const data = await r.json();
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    return res.status(502).json({
      error: '도서 조회 서버 연결 실패: ' + e.message,
      status: 'error',
      ...extraFallback,
    });
  }
}

// 제목/키워드 → 도서 후보 리스트 (교보 키오스크 검색)
router.get('/search', wrap(async (req, res) => {
  const keyword = (req.query.keyword || '').toString().trim();
  const limit = Math.min(Math.max(parseInt(req.query.limit || '8', 10) || 8, 1), 20);
  if (!keyword) return res.json({ status: 'empty', keyword: '', count: 0, items: [] });
  const path = `/book-search?keyword=${encodeURIComponent(keyword)}&limit=${limit}`;
  return pass(res, path, { keyword, count: 0, items: [] });
}));

// ISBN → 상세 (바코드 인식 후 제목/출판사 채우기)
router.get('/detail', wrap(async (req, res) => {
  const isbn = (req.query.isbn || '').toString().replace(/[^0-9Xx]/g, '');
  if (!isbn) return res.status(400).json({ error: 'isbn 파라미터가 필요합니다' });
  return pass(res, `/book-detail?isbn=${encodeURIComponent(isbn)}`, { isbn });
}));

// 책등/표지 사진(base64) → 제목 리스트 (python-api /spine-ocr, Gemini 비전)
router.post('/ocr', wrap(async (req, res) => {
  if (!BASE) return res.status(503).json({ status: 'error', message: '도서 조회 서버(BOOKPULSE_API)가 설정되지 않았습니다', books: [] });
  const dataUrl = (req.body && req.body.image) || '';
  const mm = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  const mime = mm ? mm[1] : 'image/jpeg';
  const b64 = mm ? mm[2] : dataUrl;
  if (!b64) return res.status(400).json({ status: 'error', message: '이미지가 필요합니다', books: [] });
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch (_) { return res.status(400).json({ status: 'error', message: '잘못된 이미지', books: [] }); }
  try {
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: mime }), 'spine.jpg');
    const r = await fetch(BASE + '/spine-ocr', { method: 'POST', body: fd, signal: AbortSignal.timeout(70000) });
    const data = await r.json();
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    return res.status(502).json({ status: 'error', message: '인식 서버 연결 실패: ' + e.message, books: [] });
  }
}));

module.exports = router;
