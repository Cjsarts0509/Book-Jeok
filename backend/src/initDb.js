'use strict';

// DB 스키마 초기화 + 마이그레이션 스크립트. `npm run init-db` 또는 컨테이너 시작 시 실행.
// 모든 구문은 idempotent 하여 기존 데이터를 보존한 채 반복 실행할 수 있습니다.
const { pool, query } = require('./db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(64) UNIQUE NOT NULL,
  display_name  VARCHAR(128) NOT NULL DEFAULT '',
  role          VARCHAR(16) NOT NULL DEFAULT 'user',
  password_hash TEXT NOT NULL,
  password_enc  TEXT NOT NULL,
  quota_bytes   BIGINT NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS files (
  id            BIGSERIAL PRIMARY KEY,
  owner_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder        TEXT NOT NULL DEFAULT '/',
  original_name TEXT NOT NULL,
  stored_name   TEXT NOT NULL,
  size_bytes    BIGINT NOT NULL DEFAULT 0,
  mime_type     VARCHAR(255) NOT NULL DEFAULT 'application/octet-stream',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_files_owner ON files(owner_id);
CREATE INDEX IF NOT EXISTS idx_files_owner_folder ON files(owner_id, folder);

-- 명시적 폴더(빈 폴더/트리 지원)
CREATE TABLE IF NOT EXISTS folders (
  id         BIGSERIAL PRIMARY KEY,
  owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, path)
);
CREATE INDEX IF NOT EXISTS idx_folders_owner ON folders(owner_id);

-- 공유 다운로드 링크 (난수 토큰)
CREATE TABLE IF NOT EXISTS share_links (
  id          BIGSERIAL PRIMARY KEY,
  file_id     BIGINT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  token       VARCHAR(64) UNIQUE NOT NULL,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ,
  download_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_share_token ON share_links(token);

CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action      VARCHAR(64) NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  ip          VARCHAR(64) NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);

-- 전역 설정 (허용 확장자 등)
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- 영업점 목록
CREATE TABLE IF NOT EXISTS branches (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT UNIQUE NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 공지사항
CREATE TABLE IF NOT EXISTS notices (
  id         BIGSERIAL PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  start_at   TIMESTAMPTZ,
  end_at     TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

// ── 마이그레이션(기존 배포 대상) ──────────────────────────
const MIGRATIONS = `
-- files: 비고 및 수정시각
ALTER TABLE files ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT '';
ALTER TABLE files ADD COLUMN IF NOT EXISTS note_updated_at TIMESTAMPTZ;
ALTER TABLE files ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- 휴지통(소프트 삭제)
ALTER TABLE files ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE files ADD COLUMN IF NOT EXISTS deleted_with_folder TEXT;   -- 폴더 통째 삭제 시 그 폴더 경로
CREATE INDEX IF NOT EXISTS idx_files_deleted ON files(deleted_at);

-- folders: 비고 및 소프트 삭제
ALTER TABLE folders ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT '';
ALTER TABLE folders ADD COLUMN IF NOT EXISTS note_updated_at TIMESTAMPTZ;
ALTER TABLE folders ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_folders_deleted ON folders(deleted_at);

-- users.role: 'manager'(담당자) 허용하도록 제약 갱신
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user','manager','admin'));
`;

const DEFAULT_EXT = 'csv,xls,xlsx,xlsm,xlsb,jpg,jpeg,png,gif,ppt,pptx,doc,docx,txt';
const BRANCHES = [
  '광화문점', '이화여대점', '강남점', '서울대점', '대구점', '칠곡센터', '잠실점', '영등포점', '목동점', '천안점',
  '안양점', '부산점', '수유점', '창원점', '디큐브시티점', '판교점', '전주점', '동대문점', '울산점', '송도점',
  '해운대점', '일산점', '대전점', '광교월드스퀘어센터', '반월당점', '센텀시티점', '은평점', '워크엔드', '세종점', '청량리점',
  '합정점', '가든파이브점', '평촌점', '경성대부경대센터', '거제디큐브', '분당점', '광주상무센터', '광교점', '천호점', '동탄점',
  '원그로브점', '수원점', '광명팝업스토어', '고척팝업스토어',
];

async function seed() {
  // 허용 확장자 기본값
  await query(
    "INSERT INTO settings (key, value) VALUES ('allowed_extensions', $1) ON CONFLICT (key) DO NOTHING",
    [DEFAULT_EXT]
  );
  // 영업점 목록 (비어있을 때만 시드)
  const cnt = await query('SELECT COUNT(*)::int AS c FROM branches');
  if (cnt.rows[0].c === 0) {
    for (let i = 0; i < BRANCHES.length; i++) {
      await query('INSERT INTO branches (name, sort_order) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING', [BRANCHES[i], i]);
    }
    console.log(`[init-db] 영업점 ${BRANCHES.length}개 시드 완료`);
  }
}

async function main() {
  console.log('[init-db] 스키마/마이그레이션 적용 중...');
  await query(SCHEMA);
  await query(MIGRATIONS);
  await seed();
  console.log('[init-db] 완료.');
  await pool.end();
}

main().catch((err) => {
  console.error('[init-db] 실패:', err);
  process.exit(1);
});
