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
    `SELECT s.id AS share_id, s.expires_at,
            f.owner_id AS f_owner, f.original_name AS f_name, f.stored_name AS f_stored, f.size_bytes AS f_size, f.mime_type AS f_mime,
            b.owner_id AS b_owner, b.stored_name AS b_stored, b.display_name AS b_name, b.size_bytes AS b_size
     FROM share_links s
     LEFT JOIN files f ON f.id = s.file_id AND f.deleted_at IS NULL
     LEFT JOIN zip_bundles b ON b.id = s.bundle_id
     WHERE s.token = $1`,
    [token]
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0];
  if (row.expires_at && new Date(row.expires_at) < new Date()) return { expired: true };
  // 파일 또는 압축번들을 공통 형태로 정규화
  if (row.b_stored) {
    return { share_id: row.share_id, name: row.b_name, size: Number(row.b_size), mime: 'application/zip',
      diskPath: path.join(config.storageRoot, '_bundles', row.b_stored) };
  }
  if (row.f_stored) {
    return { share_id: row.share_id, name: row.f_name, size: Number(row.f_size), mime: row.f_mime,
      diskPath: path.join(config.storageRoot, String(row.f_owner), row.f_stored) };
  }
  return null; // 원본이 삭제됨
}

// GET /api/share/:token  → 파일 정보 (미리보기 페이지용)
router.get('/:token', wrap(async (req, res) => {
  const s = await resolveShare(req.params.token);
  if (!s) return res.status(404).json({ error: '유효하지 않은 공유 링크입니다.' });
  if (s.expired) return res.status(410).json({ error: '만료된 공유 링크입니다.' });
  res.json({
    fileName: s.name,
    size: s.size,
    mime: s.mime,
    downloadUrl: `/api/share/${req.params.token}/download`,
  });
}));

// GET /api/share/:token/download  → 실제 파일 다운로드
router.get('/:token/download', wrap(async (req, res) => {
  const s = await resolveShare(req.params.token);
  if (!s) return res.status(404).json({ error: '유효하지 않은 공유 링크입니다.' });
  if (s.expired) return res.status(410).json({ error: '만료된 공유 링크입니다.' });
  if (!fs.existsSync(s.diskPath)) return res.status(410).json({ error: '파일 실체가 존재하지 않습니다.' });
  await query('UPDATE share_links SET download_count = download_count + 1 WHERE id = $1', [s.share_id]);
  res.download(s.diskPath, s.name);
}));

module.exports = router;
