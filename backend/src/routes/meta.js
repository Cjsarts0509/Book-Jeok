'use strict';

// 로그인 사용자 공용: 영업점 목록, 활성 공지사항 조회
const express = require('express');
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');
const { wrap } = require('../util');

const router = express.Router();
router.use(authenticate);

// 영업점 목록 (새 폴더 생성용)
router.get('/branches', wrap(async (req, res) => {
  const r = await query('SELECT id, name FROM branches ORDER BY sort_order, name');
  res.json({ branches: r.rows });
}));

// 현재 노출 기간에 해당하는 공지사항
router.get('/notices/active', wrap(async (req, res) => {
  const r = await query(
    `SELECT id, title, body, start_at, end_at, created_at FROM notices
     WHERE (start_at IS NULL OR start_at <= now()) AND (end_at IS NULL OR end_at >= now())
     ORDER BY created_at DESC`
  );
  res.json({ notices: r.rows });
}));

module.exports = router;
