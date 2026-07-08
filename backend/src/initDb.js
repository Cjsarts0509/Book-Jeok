'use strict';

// DB 스키마 초기화 스크립트. `npm run init-db` 로 실행.
const { pool, query } = require('./db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(64) UNIQUE NOT NULL,
  display_name  VARCHAR(128) NOT NULL DEFAULT '',
  role          VARCHAR(16) NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  password_hash TEXT NOT NULL,
  password_enc  TEXT NOT NULL,        -- AES-256-GCM 암호화된 비밀번호 (관리자 열람용)
  quota_bytes   BIGINT NOT NULL DEFAULT 0,   -- 0 = 무제한
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS files (
  id            BIGSERIAL PRIMARY KEY,
  owner_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder        TEXT NOT NULL DEFAULT '/',    -- 사용자 스코프 내 논리 경로
  original_name TEXT NOT NULL,
  stored_name   TEXT NOT NULL,                -- 디스크상의 실제 파일명 (uuid)
  size_bytes    BIGINT NOT NULL DEFAULT 0,
  mime_type     VARCHAR(255) NOT NULL DEFAULT 'application/octet-stream',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_files_owner ON files(owner_id);
CREATE INDEX IF NOT EXISTS idx_files_owner_folder ON files(owner_id, folder);

CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action      VARCHAR(64) NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  ip          VARCHAR(64) NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
`;

async function main() {
  console.log('[init-db] 스키마 생성 중...');
  await query(SCHEMA);
  console.log('[init-db] 완료.');
  await pool.end();
}

main().catch((err) => {
  console.error('[init-db] 실패:', err);
  process.exit(1);
});
