'use strict';

// 허용 확장자 등 전역 설정 캐시. 업로드 필터가 동기적으로 참조할 수 있도록 메모리에 유지.
const { query } = require('./db');

const DEFAULT_EXT = 'csv,xls,xlsx,xlsm,xlsb,jpg,jpeg,png,gif,ppt,pptx,doc,docx,txt';
let allowedExt = parseExt(DEFAULT_EXT);

// 일반 key/value 설정 캐시 (휴지통 보관일수, 공유 QR 등)
const cache = new Map();
const DEFAULTS = { trash_retention_days: '30', share_qr_enabled: '1' };

function parseExt(str) {
  return new Set(
    String(str || '')
      .split(/[\s,]+/)
      .map((s) => s.trim().replace(/^\./, '').toLowerCase())
      .filter(Boolean)
  );
}

async function loadSettings() {
  try {
    const r = await query('SELECT key, value FROM settings');
    for (const row of r.rows) {
      if (row.key === 'allowed_extensions') allowedExt = parseExt(row.value);
      else cache.set(row.key, row.value);
    }
  } catch (err) {
    console.error('[settings] 로드 실패:', err.message);
  }
}

function getSetting(key, def) {
  return cache.has(key) ? cache.get(key) : (def !== undefined ? def : DEFAULTS[key]);
}
async function setSetting(key, value) {
  const v = String(value);
  await query(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
    [key, v]
  );
  cache.set(key, v);
  return v;
}

// 휴지통 보관일수 (1~3650일, 잘못된 값이면 기본 30)
function trashRetentionDays() {
  const n = parseInt(getSetting('trash_retention_days'), 10);
  return Number.isFinite(n) && n >= 1 && n <= 3650 ? n : 30;
}
const shareQrEnabled = () => getSetting('share_qr_enabled') !== '0';

async function setAllowedExtensions(str) {
  const normalized = [...parseExt(str)].join(',');
  await query(
    "INSERT INTO settings (key, value) VALUES ('allowed_extensions', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
    [normalized]
  );
  allowedExt = parseExt(normalized);
  return normalized;
}

const getAllowedExtensions = () => [...allowedExt].sort();
const isAllowed = (ext) => allowedExt.has(String(ext || '').toLowerCase());
const allowedLabel = () => getAllowedExtensions().join(', ');

module.exports = {
  loadSettings, setAllowedExtensions, getAllowedExtensions, isAllowed, allowedLabel, DEFAULT_EXT,
  getSetting, setSetting, trashRetentionDays, shareQrEnabled,
};
