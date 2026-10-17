'use strict';

// 재고조사 HTML 보고서 → 웹하드 자동 저장(공개 API, 열쇠로만 접근)
//
// 보고서(혼자 열리는 HTML 파일)를 휴대폰에서 열어 사진을 찍거나 '확인완료'를 누르면 바로 여기로 보낸다.
// HTML 파일은 자기 자신을 덮어쓸 수 없어서(브라우저 보안), 저장은 웹하드가 맡는다.
//   · 열쇠: 보고서를 만들 때 발급(기본 60일). 원문은 보고서에만, DB 엔 해시만.
//   · 할 수 있는 것: 그 계정·그 폴더에 사진 올리기/지우기(휴지통), 확인 표시, 지금 상태 읽기, 올린 사진 보기.
//     그 밖의 파일은 보지도 고치지도 못한다.
//   · 사진은 앱과 똑같이 그 폴더에 'ISBN.jpg' 로 — 앱의 '사진 있음' 표시에도 그대로 잡힌다.
//   · 로그인이 없으므로 쿠키를 쓰지 않는다(CORS 는 server.js 에서 이 경로만 '*' 로 연다).
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { query, withTransaction } = require('../db');
const { wrap, rateKey, audit } = require('../util');
const { diskGate } = require('../disk');
const { poolUsage } = require('../pool');
const filetype = require('../filetype');
const yara = require('../yara');
const uploadLog = require('../uploadLog');

const router = express.Router();
const userDir = (ownerId) => path.join(config.storageRoot, String(ownerId));
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const ISBN_RE = /^[0-9]{9,13}X?$/;
const CID_RE = /^[A-Za-z0-9_-]{4,40}$/;
const PHOTO_MAX = 15 * 1024 * 1024;

const limiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false, keyGenerator: rateKey, message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' } });
router.use(limiter);

async function ensureFolder(ownerId, folder) {
  if (!folder || folder === '/') return;
  const parts = folder.split('/').filter(Boolean); let acc = '';
  for (const p of parts) { acc += '/' + p; await query('INSERT INTO folders (owner_id, path) VALUES ($1,$2) ON CONFLICT (owner_id, path) DO NOTHING', [ownerId, acc]); }
}
async function uniqueFileName(qc, ownerId, folder, name) {
  const dot = name.lastIndexOf('.'); const base = dot > 0 ? name.slice(0, dot) : name; const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = name, n = 1;
  for (;;) {
    const r = await qc('SELECT 1 FROM files WHERE owner_id=$1 AND folder=$2 AND original_name=$3 AND deleted_at IS NULL', [ownerId, folder, candidate]);
    if (r.rowCount === 0) return candidate;
    n++; candidate = `${base} (${n})${ext}`;
  }
}

// 열쇠 확인 → req.saKey · req.targetOwnerId(목록 캐시 무효화용)
async function gate(req, res, next) {
  const r = await query(
    `SELECT k.*, u.is_active, u.display_name AS owner_name FROM sa_report_keys k JOIN users u ON u.id = k.owner_id WHERE k.token_hash=$1`,
    [hashToken(req.params.token)]
  );
  if (!r.rowCount) return res.status(404).json({ error: '유효하지 않은 보고서 열쇠입니다.', code: 'bad_key' });
  const k = r.rows[0];
  if (k.revoked_at) return res.status(410).json({ error: '관리자가 끊은 보고서 열쇠입니다. 새 보고서를 받아 주세요.', code: 'revoked' });
  if (new Date(k.expires_at) < new Date()) return res.status(410).json({ error: '기간이 지난 보고서 열쇠입니다. 새 보고서를 받아 주세요.', code: 'expired' });
  if (!k.is_active) return res.status(410).json({ error: '사용이 중지된 계정입니다.', code: 'inactive' });
  req.saKey = k; req.targetOwnerId = k.owner_id;
  query('UPDATE sa_report_keys SET last_used_at=now() WHERE id=$1', [k.id]).catch(() => {});
  next();
}
async function loadState(qc, k, lock) {
  await qc('INSERT INTO sa_report_state (owner_id, folder) VALUES ($1,$2) ON CONFLICT DO NOTHING', [k.owner_id, k.folder]);
  const r = await qc(`SELECT checked, photos, updated_at FROM sa_report_state WHERE owner_id=$1 AND folder=$2${lock ? ' FOR UPDATE' : ''}`, [k.owner_id, k.folder]);
  return r.rows[0];
}
const view = (k, st) => ({
  label: k.label, owner: k.owner_name, folder: k.folder, expiresAt: k.expires_at,
  checked: st.checked || {}, photos: st.photos || [], updatedAt: st.updated_at,
});

// 지금 상태(확인 표시 + 올라간 사진 목록)
router.get('/:token', wrap(gate), wrap(async (req, res) => {
  res.json(view(req.saKey, await loadState(query, req.saKey, false)));
}));

// 올린 사진 보기 — 이 폴더 상태에 등록된 파일만
router.get('/:token/photo/:fileId(\\d+)', wrap(gate), wrap(async (req, res) => {
  const k = req.saKey; const id = Number(req.params.fileId);
  const st = await loadState(query, k, false);
  const known = (st.photos || []).some((p) => (p.files || []).some((f) => Number(f.id) === id));
  if (!known) return res.status(404).json({ error: '사진을 찾을 수 없습니다.' });
  const f = await query('SELECT stored_name FROM files WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL', [id, k.owner_id]);
  if (!f.rowCount) return res.status(404).json({ error: '사진을 찾을 수 없습니다.' });
  res.set('Cache-Control', 'private, max-age=86400');
  res.type('image/jpeg');
  res.sendFile(path.join(userDir(k.owner_id), f.rows[0].stored_name));
}));

// 사진 올리기: 사진 한 장 → 대상 ISBN 마다 'ISBN.jpg'(앱과 같은 이름 규칙). cid 로 중복 전송을 막는다.
const storage = multer.diskStorage({
  destination: (req, file, cb) => { const d = userDir(req.saKey.owner_id); fs.mkdirSync(d, { recursive: true }); cb(null, d); },
  filename: (req, file, cb) => cb(null, crypto.randomUUID()),
});
const photoUpload = multer({ storage, limits: { fileSize: PHOTO_MAX, files: 1 } }).single('file');

router.post('/:token/photo', wrap(gate), wrap(diskGate), photoUpload, wrap(async (req, res) => {
  uploadLog.received(req);
  const k = req.saKey; const f = req.file;
  const drop = () => (f ? fsp.unlink(f.path).catch(() => {}) : Promise.resolve());
  const cid = String(req.body.cid || '');
  let isbns = [];
  try { isbns = JSON.parse(req.body.isbns || '[]'); } catch (_) { isbns = []; }
  isbns = [...new Set((Array.isArray(isbns) ? isbns : []).map((x) => String(x).trim().toUpperCase()))].filter((x) => ISBN_RE.test(x)).slice(0, 20);
  const note = String(req.body.note || '').replace(/[\x00-\x1f]/g, ' ').slice(0, 200).trim();
  const at = Number(req.body.at) > 0 ? Number(req.body.at) : Date.now();
  if (!f) return res.status(400).json({ error: '사진이 없습니다.' });
  if (!CID_RE.test(cid) || !isbns.length) { await drop(); return res.status(400).json({ error: '잘못된 요청입니다.' }); }

  // 이미 받은 사진(다시 보낸 것)이면 그대로 돌려준다
  const before = await loadState(query, k, false);
  const dup = (before.photos || []).find((p) => p.cid === cid);
  if (dup) { await drop(); return res.json({ photo: dup, duplicate: true }); }

  const ft = await filetype.verify(f.path, 'photo.jpg');
  if (!ft.ok) { await drop(); return res.status(422).json({ error: `사진이 아닙니다: ${ft.reason}` }); }
  const mal = await yara.scanFile(f.path);
  if (!mal.ok) { await drop(); return res.status(422).json({ error: `악성 패턴 감지(${mal.rule})` }); }
  uploadLog.scanned(req);
  const pool = await poolUsage(k.owner_id);
  if (!pool.unlimited && pool.used + f.size * isbns.length > pool.quota) { await drop(); return res.status(413).json({ error: '이 계정의 저장 공간이 부족합니다.' }); }

  await ensureFolder(k.owner_id, k.folder);
  // 두 번째 ISBN 부터는 같은 사진을 복사해 각자 파일로(앱도 대상마다 따로 저장한다)
  const stored = [path.basename(f.path)];
  for (let i = 1; i < isbns.length; i++) {
    const n = crypto.randomUUID(); await fsp.copyFile(f.path, path.join(userDir(k.owner_id), n)); stored.push(n);
  }
  const fileNote = note || '재고조사 보고서에서 촬영';
  let photo;
  try {
    photo = await withTransaction(async (client) => {
      const qc = client.query.bind(client);
      const st = await loadState(qc, k, true);
      const again = (st.photos || []).find((p) => p.cid === cid);
      if (again) return { ...again, _dup: true };
      const files = [];
      for (let i = 0; i < isbns.length; i++) {
        const name = await uniqueFileName(qc, k.owner_id, k.folder, `${isbns[i]}.jpg`);
        const row = await qc(
          `INSERT INTO files (owner_id, folder, original_name, stored_name, size_bytes, mime_type, note, note_updated_at, upload_via)
           VALUES ($1,$2,$3,$4,$5,'image/jpeg',$6,now(),$7) RETURNING id`,
          [k.owner_id, k.folder, name, stored[i], f.size, fileNote, '재고조사 보고서']
        );
        files.push({ isbn: isbns[i], id: Number(row.rows[0].id), name });
      }
      const p = { cid, isbns, note, at, files, by: 'report' };
      await qc(`UPDATE sa_report_state SET photos = photos || $3::jsonb, updated_at=now() WHERE owner_id=$1 AND folder=$2`, [k.owner_id, k.folder, JSON.stringify([p])]);
      return p;
    });
  } catch (err) {
    await Promise.all(stored.map((n) => fsp.unlink(path.join(userDir(k.owner_id), n)).catch(() => {})));
    throw err;
  }
  if (photo._dup) {   // 동시에 같은 cid 가 두 번 들어온 경우
    await Promise.all(stored.map((n) => fsp.unlink(path.join(userDir(k.owner_id), n)).catch(() => {})));
    delete photo._dup; return res.json({ photo, duplicate: true });
  }
  await audit(req, 'upload', `${k.folder} · 재고조사 보고서 사진 ${photo.files.length}개 · ${photo.files.map((x) => `file=${x.id}`).join(' ')}`, k.owner_id);
  res.status(201).json({ photo });
}));

// 사진 지우기: 그 사진으로 만든 파일을 휴지통으로(보관기간 동안 복원 가능)
router.delete('/:token/photo/:cid', wrap(gate), wrap(async (req, res) => {
  const k = req.saKey; const cid = String(req.params.cid || '');
  if (!CID_RE.test(cid)) return res.status(400).json({ error: '잘못된 요청입니다.' });
  const gone = await withTransaction(async (client) => {
    const qc = client.query.bind(client);
    const st = await loadState(qc, k, true);
    const p = (st.photos || []).find((x) => x.cid === cid);
    if (!p) return null;
    const ids = (p.files || []).map((x) => Number(x.id));
    if (ids.length) await qc('UPDATE files SET deleted_at=now() WHERE owner_id=$1 AND id = ANY($2::bigint[]) AND deleted_at IS NULL', [k.owner_id, ids]);
    const rest = (st.photos || []).filter((x) => x.cid !== cid);
    await qc('UPDATE sa_report_state SET photos=$3::jsonb, updated_at=now() WHERE owner_id=$1 AND folder=$2', [k.owner_id, k.folder, JSON.stringify(rest)]);
    return ids;
  });
  if (gone && gone.length) await audit(req, 'trash_file', `${k.folder} · 재고조사 보고서 사진 삭제 · ${gone.map((id) => `file=${id}`).join(' ')}`, k.owner_id);
  res.json({ ok: true });
}));

// 확인 표시 켜기/끄기
router.put('/:token/check', express.json({ limit: '4kb' }), wrap(gate), wrap(async (req, res) => {
  const k = req.saKey;
  const isbn = String((req.body && req.body.isbn) || '').trim().toUpperCase();
  if (!ISBN_RE.test(isbn)) return res.status(400).json({ error: '잘못된 ISBN 입니다.' });
  const on = !!(req.body && req.body.checked);
  const at = Number(req.body && req.body.at) > 0 ? Number(req.body.at) : Date.now();
  await loadState(query, k, false);
  if (on) await query(`UPDATE sa_report_state SET checked = checked || jsonb_build_object($3::text, $4::bigint), updated_at=now() WHERE owner_id=$1 AND folder=$2`, [k.owner_id, k.folder, isbn, at]);
  else await query(`UPDATE sa_report_state SET checked = checked - $3::text, updated_at=now() WHERE owner_id=$1 AND folder=$2`, [k.owner_id, k.folder, isbn]);
  res.json({ ok: true });
}));

module.exports = { router, hashToken };
