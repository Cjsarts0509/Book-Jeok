'use strict';

// 최초 관리자 계정 생성 스크립트. `npm run seed-admin` 로 실행.
// SUPER_ADMINS 환경변수의 첫 번째 아이디로 관리자 계정을 만듭니다.
const { pool, query } = require('./db');
const { hashPassword, encryptSecret, generatePassword } = require('./crypto');
const config = require('./config');

async function main() {
  const username = config.superAdmins[0] || 'admin';
  const existing = await query('SELECT id FROM users WHERE username = $1', [username]);
  if (existing.rowCount > 0) {
    console.log(`[seed-admin] '${username}' 계정이 이미 존재합니다. 건너뜁니다.`);
    await pool.end();
    return;
  }

  const password = process.env.ADMIN_PASSWORD || generatePassword(14);
  const hash = await hashPassword(password);
  const enc = encryptSecret(password);

  await query(
    `INSERT INTO users (username, display_name, role, password_hash, password_enc)
     VALUES ($1, $2, 'admin', $3, $4)`,
    [username, '관리자', hash, enc]
  );

  console.log('─'.repeat(48));
  console.log(`[seed-admin] 관리자 계정 생성 완료`);
  console.log(`  아이디  : ${username}`);
  console.log(`  비밀번호: ${password}`);
  console.log('  (이 비밀번호를 안전하게 보관하세요. 관리자 페이지에서도 열람 가능합니다.)');
  console.log('─'.repeat(48));
  await pool.end();
}

main().catch((err) => {
  console.error('[seed-admin] 실패:', err);
  process.exit(1);
});
