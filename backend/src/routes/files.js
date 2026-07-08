'use strict';

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const config = require('../config');
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');
const { audit, wrap } = require('../util');

const router = express.Router();

// 사용자별 저장 디렉터리 경로 (오라클 독립 디스크 하위)
function userDir(ownerId) {
  return path.join(config.storageRoot, String(ownerId));
}

// multer: 임시로 디스크에 저장 후 우리가 최종 위치로 이동
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = userDir(req.targetOwnerId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      cb(null, crypto.randomUUID());
    },
  }),
  limits: { fileSize: parseInt(process.env.MAX_UPLOAD_BYTES || String(2 * 1024 * 1024 * 1024), 10) },
});

// 접근 대상 owner 를 결정: 관리자는 ?ownerId 로 타 계정 접근 가능, 일반 사용자는 본인만.
async function resolveOwner(req, res, next) {
  const requested = req.query.ownerId || req.body.ownerId;
  if (requested && Number(requested) !== req.user.id) {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: '다른 계정의 파일에 접근할 수 없습니다.' });
    }
    const exists = await query('SELECT id FROM users WHERE id = $1', [requested]);
    if (exists.rowCount === 0) {
      return res.status(404).json({ error: '대상 계정을 찾을 수 없습니다.' });
    }
    req.targetOwnerId = Number(requested);
  } else {
    req.targetOwnerId = req.user.id;
  }
  next();
}

// 폴더 경로 정규화 (경로 순회 공격 방지)
function normalizeFolder(input) {
  let f = String(input || '/').replace(/\\/g, '/');
  if (!f.startsWith('/')) f = '/' + f;
  const parts = f.split('/').filter((p) => p && p !== '.' && p !== '..');
  return '/' + parts.join('/');
}

// GET /api/files?folder=/&ownerId=  파일 목록
router.get('/', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const folder = normalizeFolder(req.query.folder);
  const result = await query(
    `SELECT id, folder, original_name, size_bytes, mime_type, created_at
     FROM files WHERE owner_id = $1 AND folder = $2
     ORDER BY created_at DESC`,
    [req.targetOwnerId, folder]
  );
  // 하위 폴더 목록도 계산
  const sub = await query(
    `SELECT DISTINCT folder FROM files WHERE owner_id = $1 AND folder LIKE $2`,
    [req.targetOwnerId, folder === '/' ? '/%' : folder + '/%']
  );
  const prefix = folder === '/' ? '/' : folder + '/';
  const folders = new Set();
  for (const row of sub.rows) {
    const rest = row.folder.slice(prefix.length);
    if (rest) folders.add(prefix + rest.split('/')[0]);
  }
  res.json({
    folder,
    ownerId: req.targetOwnerId,
    folders: [...folders].sort(),
    files: result.rows.map((r) => ({
      id: r.id,
      name: r.original_name,
      size: Number(r.size_bytes),
      mime: r.mime_type,
      createdAt: r.created_at,
    })),
  });
}));

// POST /api/files/upload  (multipart, field: file, folder, ownerId)
router.post('/upload', authenticate, wrap(resolveOwner), upload.array('file', 20), wrap(async (req, res) => {
  const folder = normalizeFolder(req.body.folder);
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: '업로드할 파일이 없습니다.' });
  }

  // 할당량 확인
  const owner = await query('SELECT quota_bytes FROM users WHERE id = $1', [req.targetOwnerId]);
  const quota = Number(owner.rows[0].quota_bytes);
  if (quota > 0) {
    const used = await query('SELECT COALESCE(SUM(size_bytes),0) AS s FROM files WHERE owner_id = $1', [req.targetOwnerId]);
    const incoming = req.files.reduce((sum, f) => sum + f.size, 0);
    if (Number(used.rows[0].s) + incoming > quota) {
      // 롤백: 방금 저장된 파일 삭제
      await Promise.all(req.files.map((f) => fsp.unlink(f.path).catch(() => {})));
      return res.status(413).json({ error: '저장 용량 할당량을 초과했습니다.' });
    }
  }

  const saved = [];
  for (const f of req.files) {
    const originalName = Buffer.from(f.originalname, 'latin1').toString('utf8');
    const row = await query(
      `INSERT INTO files (owner_id, folder, original_name, stored_name, size_bytes, mime_type)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [req.targetOwnerId, folder, originalName, path.basename(f.path), f.size, f.mimetype]
    );
    saved.push({ id: row.rows[0].id, name: originalName, size: f.size });
  }
  await audit(req, 'upload', `owner=${req.targetOwnerId} folder=${folder} count=${saved.length}`);
  res.status(201).json({ uploaded: saved });
}));

// GET /api/files/:id/download
router.get('/:id/download', authenticate, wrap(async (req, res) => {
  const result = await query('SELECT * FROM files WHERE id = $1', [req.params.id]);
  const file = result.rows[0];
  if (!file) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  if (file.owner_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: '접근 권한이 없습니다.' });
  }
  const diskPath = path.join(userDir(file.owner_id), file.stored_name);
  if (!fs.existsSync(diskPath)) {
    return res.status(410).json({ error: '파일 실체가 존재하지 않습니다.' });
  }
  await audit(req, 'download', `file=${file.id}`);
  res.download(diskPath, file.original_name);
}));

// DELETE /api/files/:id
router.delete('/:id', authenticate, wrap(async (req, res) => {
  const result = await query('SELECT * FROM files WHERE id = $1', [req.params.id]);
  const file = result.rows[0];
  if (!file) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  if (file.owner_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: '삭제 권한이 없습니다.' });
  }
  await query('DELETE FROM files WHERE id = $1', [file.id]);
  await fsp.unlink(path.join(userDir(file.owner_id), file.stored_name)).catch(() => {});
  await audit(req, 'delete', `file=${file.id} name=${file.original_name}`);
  res.json({ ok: true });
}));

// GET /api/files/usage  본인(또는 관리자가 지정한 계정) 사용량
router.get('/usage/summary', authenticate, wrap(resolveOwner), wrap(async (req, res) => {
  const r = await query(
    'SELECT COUNT(*)::int AS files, COALESCE(SUM(size_bytes),0) AS bytes FROM files WHERE owner_id = $1',
    [req.targetOwnerId]
  );
  const q = await query('SELECT quota_bytes FROM users WHERE id = $1', [req.targetOwnerId]);
  res.json({
    ownerId: req.targetOwnerId,
    fileCount: r.rows[0].files,
    usedBytes: Number(r.rows[0].bytes),
    quotaBytes: Number(q.rows[0].quota_bytes),
  });
}));

module.exports = router;
