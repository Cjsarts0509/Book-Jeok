'use strict';

// 공개 공유 링크: 인증 없이 토큰으로 파일 정보 조회/다운로드.
// 선택적으로 비밀번호 · 다운로드 횟수 제한을 지원.
const express = require('express');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { query } = require('../db');
const { wrap, rateKey } = require('../util');
const { verifyPassword } = require('../crypto');
const notify = require('../notify');

const router = express.Router();

// 비밀번호 무차별 대입 방어: 실패한 요청(4xx/5xx)만 카운트 → 정상 다운로드는 제한 없음
const attemptLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 15, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false, keyGenerator: rateKey, message: { error: '시도가 너무 많습니다. 잠시 후 다시 시도하세요.' } });

async function resolveShare(token) {
  const r = await query(
    `SELECT s.id AS share_id, s.expires_at, s.password_hash, s.max_downloads, s.download_count,
            s.created_by, s.notify_inapp, s.notify_email,
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
  const common = {
    share_id: row.share_id,
    passwordHash: row.password_hash || null,
    maxDownloads: row.max_downloads,
    downloadCount: row.download_count,
    createdBy: row.created_by,
    notifyInapp: row.notify_inapp,
    notifyEmail: row.notify_email,
  };
  if (row.b_stored) return { ...common, name: row.b_name, size: Number(row.b_size), mime: 'application/zip', diskPath: path.join(config.storageRoot, '_bundles', row.b_stored) };
  if (row.f_stored) return { ...common, name: row.f_name, size: Number(row.f_size), mime: row.f_mime, diskPath: path.join(config.storageRoot, String(row.f_owner), row.f_stored) };
  return null; // 원본이 삭제됨
}

const givenPassword = (req) => String(req.headers['x-share-password'] || req.query.pw || '');

// GET /api/share/:token  → 공유 정보 (미리보기 페이지용)
router.get('/:token', wrap(async (req, res) => {
  const s = await resolveShare(req.params.token);
  if (!s) return res.status(404).json({ error: '유효하지 않은 공유 링크입니다.' });
  if (s.expired) return res.status(410).json({ error: '만료된 공유 링크입니다.' });
  const exhausted = s.maxDownloads != null && s.downloadCount >= s.maxDownloads;
  res.json({
    fileName: s.name,
    size: s.size,
    mime: s.mime,
    needsPassword: !!s.passwordHash,
    limited: s.maxDownloads != null,
    remaining: s.maxDownloads != null ? Math.max(0, s.maxDownloads - s.downloadCount) : null,
    exhausted,
    downloadUrl: `/api/share/${req.params.token}/download`,
  });
}));

// GET /api/share/:token/download  → 실제 파일 다운로드
router.get('/:token/download', attemptLimiter, wrap(async (req, res) => {
  const s = await resolveShare(req.params.token);
  if (!s) return res.status(404).json({ error: '유효하지 않은 공유 링크입니다.' });
  if (s.expired) return res.status(410).json({ error: '만료된 공유 링크입니다.' });
  if (s.passwordHash) {
    const pw = givenPassword(req);
    if (!pw || !(await verifyPassword(pw, s.passwordHash))) return res.status(401).json({ error: '비밀번호가 필요하거나 올바르지 않습니다.', needsPassword: true });
  }
  // 다운로드 횟수 제한: 원자적으로 증가시키며 초과 시 거부
  if (s.maxDownloads != null) {
    const upd = await query('UPDATE share_links SET download_count = download_count + 1 WHERE id=$1 AND download_count < max_downloads RETURNING download_count', [s.share_id]);
    if (upd.rowCount === 0) return res.status(410).json({ error: '다운로드 횟수 제한을 초과했습니다.' });
  } else {
    await query('UPDATE share_links SET download_count = download_count + 1 WHERE id=$1', [s.share_id]);
  }
  if (!fs.existsSync(s.diskPath)) return res.status(410).json({ error: '파일 실체가 존재하지 않습니다.' });
  if (s.notifyInapp && s.createdBy) {
    notify.push({ userId: s.createdBy, type: 'share_download', title: '공유 파일이 다운로드됨', body: `'${s.name}' 공유 링크에서 다운로드가 발생했습니다.` }).catch(() => {});
  }
  res.download(s.diskPath, s.name);
}));

module.exports = router;
