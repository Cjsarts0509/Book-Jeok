'use strict';

// 공개 공유 링크: 인증 없이 토큰으로 파일 정보 조회/다운로드.
const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const { query } = require('../db');
const { wrap } = require('../util');

const router = express.Router();

async function resolveShare(token) {
  const r = await query(
    `SELECT s.id AS share_id, s.expires_at, f.id, f.owner_id, f.original_name, f.stored_name, f.size_bytes, f.mime_type
     FROM share_links s JOIN files f ON f.id = s.file_id WHERE s.token = $1`,
    [token]
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0];
  if (row.expires_at && new Date(row.expires_at) < new Date()) return { expired: true };
  return row;
}

// GET /api/share/:token  → 파일 정보 (미리보기 페이지용)
router.get('/:token', wrap(async (req, res) => {
  const s = await resolveShare(req.params.token);
  if (!s) return res.status(404).json({ error: '유효하지 않은 공유 링크입니다.' });
  if (s.expired) return res.status(410).json({ error: '만료된 공유 링크입니다.' });
  res.json({
    fileName: s.original_name,
    size: Number(s.size_bytes),
    mime: s.mime_type,
    downloadUrl: `/api/share/${req.params.token}/download`,
  });
}));

// GET /api/share/:token/download  → 실제 파일 다운로드
router.get('/:token/download', wrap(async (req, res) => {
  const s = await resolveShare(req.params.token);
  if (!s) return res.status(404).json({ error: '유효하지 않은 공유 링크입니다.' });
  if (s.expired) return res.status(410).json({ error: '만료된 공유 링크입니다.' });
  const diskPath = path.join(config.storageRoot, String(s.owner_id), s.stored_name);
  if (!fs.existsSync(diskPath)) return res.status(410).json({ error: '파일 실체가 존재하지 않습니다.' });
  await query('UPDATE share_links SET download_count = download_count + 1 WHERE id = $1', [s.share_id]);
  res.download(diskPath, s.original_name);
}));

module.exports = router;
