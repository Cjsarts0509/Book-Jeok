'use strict';

// 공개 폴더 공유: 인증 없이 토큰으로 특정 폴더만 열람·다운로드(전용).
// 보안: 고엔트로피 토큰, 선택적 비밀번호, 만료, 공유 폴더 범위 밖 접근 차단,
//       업로드/이동/삭제 불가(읽기 전용), 실패 시도 레이트리밋.
const express = require('express');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { query } = require('../db');
const { wrap } = require('../util');
const { verifyPassword } = require('../crypto');
const notify = require('../notify');

const router = express.Router();
const attemptLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 30, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false, message: { error: '시도가 너무 많습니다. 잠시 후 다시 시도하세요.' } });

const normFolder = (p) => (!p || p === '/') ? '/' : '/' + String(p).split('/').filter(Boolean).join('/');
const withinScope = (base, target) => base === '/' ? true : (target === base || target.startsWith(base + '/'));

async function loadFS(token) {
  const r = await query('SELECT * FROM folder_shares WHERE token=$1', [token]);
  if (r.rowCount === 0) return null;
  const row = r.rows[0];
  const u = await query('SELECT is_active FROM users WHERE id=$1', [row.owner_id]);
  row._ownerActive = u.rowCount > 0 && u.rows[0].is_active;
  return row;
}
const statusOf = (row) => (row.disabled || !row._ownerActive) ? 'disabled' : (row.expires_at && new Date(row.expires_at) < new Date() ? 'expired' : 'ok');
const givenPw = (req) => String(req.headers['x-folder-password'] || req.query.pw || '');
async function checkPw(row, req) { if (!row.password_hash) return true; const pw = givenPw(req); return !!pw && await verifyPassword(pw, row.password_hash); }

// 공유 정보
router.get('/:token', wrap(async (req, res) => {
  const s = await loadFS(req.params.token);
  if (!s) return res.status(404).json({ error: '유효하지 않은 링크입니다.' });
  res.json({ label: s.label, base: s.folder, status: statusOf(s), needsPassword: !!s.password_hash });
}));

// 폴더 목록(범위 내 하위 경로)
router.get('/:token/list', attemptLimiter, wrap(async (req, res) => {
  const s = await loadFS(req.params.token);
  if (!s) return res.status(404).json({ error: '유효하지 않은 링크입니다.' });
  const st = statusOf(s);
  if (st !== 'ok') return res.status(410).json({ error: st === 'expired' ? '만료된 링크입니다.' : '중지된 링크입니다.' });
  if (!(await checkPw(s, req))) return res.status(401).json({ error: '비밀번호가 필요하거나 올바르지 않습니다.', needsPassword: true });
  let cur = normFolder(req.query.path || s.folder);
  if (!withinScope(s.folder, cur)) cur = s.folder; // 범위 밖 → 루트로 강제
  const prefix = cur === '/' ? '/' : cur + '/';
  const fr = await query('SELECT path FROM folders WHERE owner_id=$1 AND deleted_at IS NULL AND path LIKE $2', [s.owner_id, cur === '/' ? '/%' : prefix + '%']);
  const subs = new Set();
  for (const row of fr.rows) { const p = row.path; if (!p.startsWith(prefix)) continue; const seg = p.slice(prefix.length).split('/')[0]; if (seg) subs.add(prefix + seg); }
  const files = await query('SELECT id, original_name, size_bytes FROM files WHERE owner_id=$1 AND folder=$2 AND deleted_at IS NULL ORDER BY original_name', [s.owner_id, cur]);
  await query('UPDATE folder_shares SET view_count=view_count+1 WHERE id=$1', [s.id]);
  res.json({
    base: s.folder, path: cur,
    folders: [...subs].sort().map((p) => ({ path: p, name: p.split('/').filter(Boolean).pop() })),
    files: files.rows.map((f) => ({ id: f.id, name: f.original_name, size: Number(f.size_bytes) })),
  });
}));

// 파일 다운로드(공유 폴더 범위 검증)
router.get('/:token/download', attemptLimiter, wrap(async (req, res) => {
  const s = await loadFS(req.params.token);
  if (!s) return res.status(404).json({ error: '유효하지 않은 링크입니다.' });
  const st = statusOf(s);
  if (st !== 'ok') return res.status(410).json({ error: st === 'expired' ? '만료된 링크입니다.' : '중지된 링크입니다.' });
  if (!(await checkPw(s, req))) return res.status(401).json({ error: '비밀번호가 필요하거나 올바르지 않습니다.', needsPassword: true });
  const fileId = parseInt(req.query.fileId, 10);
  const fr = await query('SELECT owner_id, folder, original_name, stored_name FROM files WHERE id=$1 AND deleted_at IS NULL', [fileId]);
  if (fr.rowCount === 0) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  const f = fr.rows[0];
  if (f.owner_id !== s.owner_id || !withinScope(s.folder, normFolder(f.folder))) return res.status(403).json({ error: '접근 권한이 없습니다.' });
  const disk = path.join(config.storageRoot, String(f.owner_id), f.stored_name);
  if (!fs.existsSync(disk)) return res.status(410).json({ error: '파일 실체가 없습니다.' });
  if (s.notify_inapp && s.created_by) {
    notify.push({ userId: s.created_by, type: 'folder_share_download', title: '공유 폴더에서 다운로드됨', body: `'${s.label}' 폴더 공유에서 '${f.original_name}' 이(가) 다운로드되었습니다.` }).catch(() => {});
  }
  res.download(disk, f.original_name);
}));

module.exports = router;
