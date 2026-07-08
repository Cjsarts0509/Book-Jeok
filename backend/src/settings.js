'use strict';

// 허용 확장자 등 전역 설정 캐시. 업로드 필터가 동기적으로 참조할 수 있도록 메모리에 유지.
const { query } = require('./db');

const DEFAULT_EXT = 'csv,xls,xlsx,xlsm,xlsb,jpg,jpeg,png,gif,ppt,pptx,doc,docx,txt';
let allowedExt = parseExt(DEFAULT_EXT);

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
    const r = await query("SELECT value FROM settings WHERE key='allowed_extensions'");
    if (r.rowCount > 0) allowedExt = parseExt(r.rows[0].value);
  } catch (err) {
    console.error('[settings] 로드 실패:', err.message);
  }
}

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

module.exports = { loadSettings, setAllowedExtensions, getAllowedExtensions, isAllowed, allowedLabel, DEFAULT_EXT };
