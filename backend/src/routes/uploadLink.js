'use strict';

// 공개 업로드 요청 링크: 인증 없이 토큰으로 특정 계정의 특정 폴더에만 업로드.
// 보안: 고엔트로피 토큰, 선택적 비밀번호, 개수/용량 상한, 계정 할당량,
//       확장자 화이트리스트, 레이트리밋, 폴더는 요청에 고정(경로 조작 불가).
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { query } = require('../db');
const { wrap } = require('../util');
const { verifyPassword } = require('../crypto');
const { isAllowed, allowedLabel, getAllowedExtensions } = require('../settings');
const filetype = require('../filetype');
const yara = require('../yara');
const notify = require('../notify');

const router = express.Router();
const userDir = (ownerId) => path.join(config.storageRoot, String(ownerId));
const extOf = (name) => (name.split('.').pop() || '').toLowerCase();

async function ensureFolder(ownerId, folder) {
  if (!folder || folder === '/') return;
  const parts = folder.split('/').filter(Boolean); let acc = '';
  for (const p of parts) { acc += '/' + p; await query('INSERT INTO folders (owner_id, path) VALUES ($1,$2) ON CONFLICT (owner_id, path) DO NOTHING', [ownerId, acc]); }
}
async function uniqueFileName(ownerId, folder, name) {
  const dot = name.lastIndexOf('.'); const base = dot > 0 ? name.slice(0, dot) : name; const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = name, n = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) { const r = await query('SELECT 1 FROM files WHERE owner_id=$1 AND folder=$2 AND original_name=$3 AND deleted_at IS NULL', [ownerId, folder, candidate]); if (r.rowCount === 0) return candidate; n++; candidate = `${base} (${n})${ext}`; }
}

async function loadReq(token) {
  const r = await query('SELECT * FROM upload_requests WHERE token=$1', [token]);
  if (r.rowCount === 0) return null;
  const row = r.rows[0];
  const u = await query('SELECT is_active FROM users WHERE id=$1', [row.owner_id]);
  row._ownerActive = u.rowCount > 0 && u.rows[0].is_active;
  return row;
}
function statusOf(row) {
  if (row.disabled || !row._ownerActive) return 'disabled';
  if (row.expires_at && new Date(row.expires_at) < new Date()) return 'expired';
  return 'ok';
}

// 업로드 링크 정보 (외부 노출 최소화: 라벨/상태/제약만)
router.get('/:token', wrap(async (req, res) => {
  const u = await loadReq(req.params.token);
  if (!u) return res.status(404).json({ error: '유효하지 않은 링크입니다.' });
  res.json({
    label: u.label,
    status: statusOf(u),
    needsPassword: !!u.password_hash,
    allowedExtensions: getAllowedExtensions(),
    remainingFiles: u.max_files != null ? Math.max(0, u.max_files - u.uploaded_count) : null,
    remainingBytes: u.max_bytes != null ? Math.max(0, Number(u.max_bytes) - Number(u.uploaded_bytes)) : null,
  });
}));

const uploadLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false, message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' } });
// 비밀번호 무차별 대입 방어: 실패(4xx/5xx)만 카운트
const attemptLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 15, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false, message: { error: '시도가 너무 많습니다. 잠시 후 다시 시도하세요.' } });

// 검증(존재·상태·비밀번호)을 multer 이전에 수행
async function gate(req, res, next) {
  const u = await loadReq(req.params.token);
  if (!u) return res.status(404).json({ error: '유효하지 않은 링크입니다.' });
  const st = statusOf(u);
  if (st === 'expired') return res.status(410).json({ error: '만료된 링크입니다.' });
  if (st === 'disabled') return res.status(410).json({ error: '중지된 링크입니다.' });
  if (u.password_hash) {
    const pw = String(req.headers['x-upload-password'] || '');
    if (!pw || !(await verifyPassword(pw, u.password_hash))) return res.status(401).json({ error: '비밀번호가 필요하거나 올바르지 않습니다.', needsPassword: true });
  }
  req._uploadReq = u; req._ownerId = u.owner_id;
  next();
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { const d = userDir(req._ownerId); fs.mkdirSync(d, { recursive: true }); cb(null, d); },
    filename: (req, file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: { fileSize: parseInt(process.env.MAX_UPLOAD_BYTES || String(2 * 1024 * 1024 * 1024), 10), files: 30 },
  fileFilter: (req, file, cb) => {
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
    if (!isAllowed(extOf(name))) return cb(Object.assign(new Error(`허용되지 않는 파일 형식입니다. 가능: ${allowedLabel()}`), { status: 415 }));
    cb(null, true);
  },
});

router.post('/:token', uploadLimiter, attemptLimiter, wrap(gate), upload.array('file', 30), wrap(async (req, res) => {
  const u = req._uploadReq; const owner = u.owner_id;
  if (!req.files || !req.files.length) return res.status(400).json({ error: '업로드할 파일이 없습니다.' });
  const incoming = req.files.reduce((s, f) => s + f.size, 0);
  const cleanup = () => Promise.all(req.files.map((f) => fsp.unlink(f.path).catch(() => {})));
  if (u.max_files != null && u.uploaded_count + req.files.length > u.max_files) { await cleanup(); return res.status(413).json({ error: '업로드 개수 제한을 초과했습니다.' }); }
  if (u.max_bytes != null && Number(u.uploaded_bytes) + incoming > Number(u.max_bytes)) { await cleanup(); return res.status(413).json({ error: '업로드 용량 제한을 초과했습니다.' }); }
  const ow = await query('SELECT quota_bytes, role FROM users WHERE id=$1', [owner]);
  if (ow.rows[0].role !== 'admin') {
    const quota = Number(ow.rows[0].quota_bytes);
    const used = await query('SELECT COALESCE(SUM(size_bytes),0) AS s FROM files WHERE owner_id=$1 AND deleted_at IS NULL', [owner]);
    if (quota === 0 || Number(used.rows[0].s) + incoming > quota) { await cleanup(); return res.status(413).json({ error: '이 폴더의 저장 공간이 부족합니다.' }); }
  }
  await ensureFolder(owner, u.folder);
  // 요청에 사유가 있으면 업로드된 파일의 비고에 사유를 넣는다(없으면 기본 문구).
  const note = (u.reason && u.reason.trim()) ? u.reason.trim() : '업로드 요청으로 수신';
  let saved = 0; let savedBytes = 0; const rejected = [];
  for (const f of req.files) {
    const originalName = Buffer.from(f.originalname, 'latin1').toString('utf8').replace(/[/\\]/g, '_').replace(/[\u0000-\u001f]/g, '').trim() || 'file';
    const ft = await filetype.verify(f.path, originalName);
    if (!ft.ok) { await fsp.unlink(f.path).catch(() => {}); rejected.push({ name: originalName, reason: ft.reason }); continue; }
    const mal = await yara.scanFile(f.path);
    if (!mal.ok) { await fsp.unlink(f.path).catch(() => {}); rejected.push({ name: originalName, reason: `악성 패턴 감지(${mal.rule})` }); continue; }
    const name = await uniqueFileName(owner, u.folder, originalName);
    await query('INSERT INTO files (owner_id, folder, original_name, stored_name, size_bytes, mime_type, note, note_updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now())', [owner, u.folder, name, path.basename(f.path), f.size, f.mimetype, note]);
    saved++; savedBytes += f.size;
  }
  if (saved) await query('UPDATE upload_requests SET uploaded_count = uploaded_count + $2, uploaded_bytes = uploaded_bytes + $3 WHERE id=$1', [u.id, saved, savedBytes]);
  if (saved && u.notify_inapp && u.created_by) {
    notify.push({ userId: u.created_by, type: 'upload_request', title: `업로드 요청에 파일 ${saved}개 도착`, body: `'${u.label}' (${u.folder}) 에 파일 ${saved}개가 업로드되었습니다.` }).catch(() => {});
  }
  if (saved === 0 && rejected.length) return res.status(422).json({ error: `업로드가 차단되었습니다: ${rejected.map((r) => r.reason).join(', ')}` });
  res.status(201).json({ uploaded: saved, rejected });
}));

module.exports = router;
