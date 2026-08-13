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
const { query, withTransaction } = require('../db');
const { wrap, rateKey } = require('../util');
const { verifyPassword } = require('../crypto');
const { diskGate } = require('../disk');
const { poolRootId, poolUsage } = require('../pool');
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

const uploadLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false, keyGenerator: rateKey, message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' } });
// 비밀번호 무차별 대입 방어: 실패(4xx/5xx)만 카운트
const attemptLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 15, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false, keyGenerator: rateKey, message: { error: '시도가 너무 많습니다. 잠시 후 다시 시도하세요.' } });

// 검증(존재·상태·비밀번호)을 multer 이전에 수행.
// 익명 경로이므로 '디스크에 쓰기 전에' 선언된 크기(Content-Length)로 링크 잔여 용량·계정 풀 용량까지
// 미리 막는다. (기록 후 삭제하면 그 사이 볼륨이 차서 Postgres 가 죽을 수 있음)
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
  // 선언 크기 기준 사전 차단 — 링크 잔여 용량과 계정(풀) 잔여 용량 중 작은 쪽을 넘으면 즉시 거절
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > 0) {
    if (u.max_bytes != null) {
      const linkLeft = Math.max(0, Number(u.max_bytes) - Number(u.uploaded_bytes));
      if (declared > linkLeft) return res.status(413).json({ error: '업로드 용량 제한을 초과했습니다.' });
    }
    const pool = await poolUsage(u.owner_id);
    if (!pool.unlimited && pool.used + declared > pool.quota) {
      return res.status(413).json({ error: '이 폴더의 저장 공간이 부족합니다.' });
    }
  }
  req._uploadReq = u; req._ownerId = u.owner_id;
  // 이 링크가 허용하는 1회 최대 바이트 — multer 가 그 이상은 아예 받지 않도록 제한
  req._maxBytes = u.max_bytes != null
    ? Math.max(0, Number(u.max_bytes) - Number(u.uploaded_bytes))
    : MAX_UPLOAD_BYTES;
  next();
}

const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_UPLOAD_BYTES || String(2 * 1024 * 1024 * 1024), 10);

const storage = multer.diskStorage({
  destination: (req, file, cb) => { const d = userDir(req._ownerId); fs.mkdirSync(d, { recursive: true }); cb(null, d); },
  filename: (req, file, cb) => cb(null, crypto.randomUUID()),
});
const fileFilter = (req, file, cb) => {
  const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
  if (!isAllowed(extOf(name))) return cb(Object.assign(new Error(`허용되지 않는 파일 형식입니다. 가능: ${allowedLabel()}`), { status: 415 }));
  cb(null, true);
};
// 링크마다 허용 용량이 다르므로 요청 시점에 multer 를 구성한다(gate 가 계산한 _maxBytes 적용).
// → 링크 잔여 용량을 넘는 파일은 디스크에 다 쓰이기 전에 multer 가 중단한다.
function upload(req, res, next) {
  // 잔여 0 이면 fileSize:0 → 어떤 파일도 받지 않는다(|| 로 쓰면 0이 기본값으로 뒤집히므로 주의)
  const lim = Number.isFinite(req._maxBytes) ? Math.min(req._maxBytes, MAX_UPLOAD_BYTES) : MAX_UPLOAD_BYTES;
  multer({ storage, fileFilter, limits: { fileSize: lim, files: 30 } })
    .array('file', 30)(req, res, next);
}

router.post('/:token', uploadLimiter, attemptLimiter, wrap(gate), wrap(diskGate), upload, wrap(async (req, res) => {
  const u = req._uploadReq; const owner = u.owner_id;
  if (!req.files || !req.files.length) return res.status(400).json({ error: '업로드할 파일이 없습니다.' });
  const incoming = req.files.reduce((s, f) => s + f.size, 0);
  const cleanup = () => Promise.all(req.files.map((f) => fsp.unlink(f.path).catch(() => {})));
  if (u.max_files != null && u.uploaded_count + req.files.length > u.max_files) { await cleanup(); return res.status(413).json({ error: '업로드 개수 제한을 초과했습니다.' }); }
  if (u.max_bytes != null && Number(u.uploaded_bytes) + incoming > Number(u.max_bytes)) { await cleanup(); return res.status(413).json({ error: '업로드 용량 제한을 초과했습니다.' }); }
  // 계정(공유 풀) 용량 재확인 — 동시 업로드 경합(TOCTOU) 방지를 위해 풀 루트 락 안에서 검사
  try {
    await withTransaction(async (client) => {
      const qc = client.query.bind(client);
      const rootId = await poolRootId(owner, qc);
      await client.query('SELECT pg_advisory_xact_lock($1)', [rootId]);
      const pool = await poolUsage(rootId, qc, true);
      if (!pool.unlimited && (pool.quota === 0 || pool.used + incoming > pool.quota)) {
        const e = new Error('이 폴더의 저장 공간이 부족합니다.'); e.status = 413; throw e;
      }
    });
  } catch (err) {
    await cleanup();
    if (err.status === 413) return res.status(413).json({ error: err.message });
    throw err;
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
  if (saved) {
    // 계정 소유자에게 항상 알림(외부 업로드)
    notify.push({ userId: owner, type: 'upload', title: `파일 ${saved}개가 업로드되었습니다`, body: `업로드 요청 '${u.label}' (${u.folder}) 으로 외부에서 파일 ${saved}개가 들어왔습니다.` }).catch(() => {});
    // 링크 생성자가 소유자와 다르면(담당자가 만든 경우) 옵트인 시 추가 알림
    if (u.notify_inapp && u.created_by && Number(u.created_by) !== Number(owner)) {
      notify.push({ userId: u.created_by, type: 'upload_request', title: `업로드 요청에 파일 ${saved}개 도착`, body: `'${u.label}' (${u.folder}) 에 파일 ${saved}개가 업로드되었습니다.` }).catch(() => {});
    }
  }
  if (saved === 0 && rejected.length) return res.status(422).json({ error: `업로드가 차단되었습니다: ${rejected.map((r) => r.reason).join(', ')}` });
  res.status(201).json({ uploaded: saved, rejected });
}));

module.exports = router;
