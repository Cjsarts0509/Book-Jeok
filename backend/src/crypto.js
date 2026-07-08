'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('./config');

const KEY = Buffer.from(config.masterKey, 'hex');
if (KEY.length !== 32) {
  throw new Error('MASTER_KEY 는 64자리 hex(32바이트)여야 합니다. `openssl rand -hex 32` 로 생성하세요.');
}

// ── 인증용 단방향 해시 ────────────────────────────────
async function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

// ── 관리자 열람용 가역 암호화 (AES-256-GCM) ────────────
// 주의: 이 기능은 "관리자가 암호를 열람 가능"이라는 요구사항 때문에 존재합니다.
// 보안상 권장되는 방식은 아니며, 마스터 키는 DB와 분리된 곳(서버 env/KMS)에 보관해야 합니다.
function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // iv(12) + tag(16) + ciphertext 를 base64 로 직렬화
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptSecret(payload) {
  const raw = Buffer.from(payload, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// 안전한 랜덤 임시 비밀번호 생성 (계정 발급 시)
function generatePassword(len = 12) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

module.exports = {
  hashPassword,
  verifyPassword,
  encryptSecret,
  decryptSecret,
  generatePassword,
};
