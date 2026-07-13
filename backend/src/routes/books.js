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

module.exports = router;
