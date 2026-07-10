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

-- folders: 아이콘(모양) 및 색상 커스터마이즈
ALTER TABLE folders ADD COLUMN IF NOT EXISTS icon TEXT NOT NULL DEFAULT '';
ALTER TABLE folders ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT '';

-- users.role: 'manager'(담당자) 허용하도록 제약 갱신
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user','manager','admin'));

-- 사용자 설정: 알림 이메일 / 이메일 수신 여부 / 동일 이름 업로드 처리
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_email BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS upload_conflict VARCHAR(16) NOT NULL DEFAULT 'rename'; -- rename | overwrite

-- 2단계 인증(TOTP): 암호화된 시크릿 + 활성화 여부 + 등록중(pending) 시크릿
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending TEXT NOT NULL DEFAULT '';

-- notices: 노출 대상 권한 (기본: 전체)
ALTER TABLE notices ADD COLUMN IF NOT EXISTS target_roles TEXT[] NOT NULL DEFAULT ARRAY['admin','manager','user'];

-- 압축(ZIP) 번들: 선택 항목을 묶어 임시 생성한 파일. 다운로드/공유 대상.
CREATE TABLE IF NOT EXISTS zip_bundles (
  id           BIGSERIAL PRIMARY KEY,
  owner_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stored_name  TEXT NOT NULL,
  display_name TEXT NOT NULL,
  size_bytes   BIGINT NOT NULL DEFAULT 0,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- share_links: 파일 또는 압축번들을 가리킬 수 있도록
ALTER TABLE share_links ALTER COLUMN file_id DROP NOT NULL;
ALTER TABLE share_links ADD COLUMN IF NOT EXISTS bundle_id BIGINT REFERENCES zip_bundles(id) ON DELETE CASCADE;
-- share_links: 비밀번호(선택)·다운로드 횟수 제한(선택)
ALTER TABLE share_links ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE share_links ADD COLUMN IF NOT EXISTS max_downloads INTEGER;

-- 업로드 요청 링크(외부인이 특정 폴더로 업로드)
CREATE TABLE IF NOT EXISTS upload_requests (
  id             BIGSERIAL PRIMARY KEY,
  owner_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder         TEXT NOT NULL,
  token          VARCHAR(64) UNIQUE NOT NULL,
  label          TEXT NOT NULL DEFAULT '',
  password_hash  TEXT,
  max_files      INTEGER,
  max_bytes      BIGINT,
  uploaded_count INTEGER NOT NULL DEFAULT 0,
  uploaded_bytes BIGINT NOT NULL DEFAULT 0,
  disabled       BOOLEAN NOT NULL DEFAULT false,
  expires_at     TIMESTAMPTZ,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_upload_req_token ON upload_requests(token);

-- 폴더 단위 공유(외부인이 그 폴더만 열람·다운로드, 이동/업로드 불가)
CREATE TABLE IF NOT EXISTS folder_shares (
  id            BIGSERIAL PRIMARY KEY,
  owner_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder        TEXT NOT NULL,
  token         VARCHAR(64) UNIQUE NOT NULL,
  label         TEXT NOT NULL DEFAULT '',
  password_hash TEXT,
  disabled      BOOLEAN NOT NULL DEFAULT false,
  expires_at    TIMESTAMPTZ,
  view_count    INTEGER NOT NULL DEFAULT 0,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_folder_share_token ON folder_shares(token);

-- 인앱 알림
CREATE TABLE IF NOT EXISTS notifications (
  id         BIGSERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       VARCHAR(32) NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  is_read    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read, created_at DESC);

-- 공유 생성 사유(선택 메모)
ALTER TABLE share_links     ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT '';
ALTER TABLE folder_shares   ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT '';
ALTER TABLE upload_requests ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT '';

-- 공유별 알림 옵트인 (인앱 / 이메일)
ALTER TABLE share_links     ADD COLUMN IF NOT EXISTS notify_inapp BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE share_links     ADD COLUMN IF NOT EXISTS notify_email BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE folder_shares   ADD COLUMN IF NOT EXISTS notify_inapp BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE folder_shares   ADD COLUMN IF NOT EXISTS notify_email BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE upload_requests ADD COLUMN IF NOT EXISTS notify_inapp BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE upload_requests ADD COLUMN IF NOT EXISTS notify_email BOOLEAN NOT NULL DEFAULT FALSE;

-- 로그인 이벤트(이상 로그인 감지): (사용자, IP) 최초 접속 여부 판별용
CREATE TABLE IF NOT EXISTS login_events (
  id         BIGSERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip         VARCHAR(64) NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_events_user ON login_events(user_id, ip);

-- 즐겨찾기(별표): 뷰어(user_id) 개인 북마크. 파일 또는 (소유자,폴더경로)
CREATE TABLE IF NOT EXISTS favorites (
  id           BIGSERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id      BIGINT REFERENCES files(id) ON DELETE CASCADE,
  folder_owner INTEGER REFERENCES users(id) ON DELETE CASCADE,
  folder_path  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fav_file ON favorites(user_id, file_id) WHERE file_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_fav_folder ON favorites(user_id, folder_owner, folder_path) WHERE folder_path IS NOT NULL;

-- 태그(라벨): 계정(owner)별 정의 + 파일 연결
CREATE TABLE IF NOT EXISTS tags (
  id         BIGSERIAL PRIMARY KEY,
  owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#118AB2',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);
CREATE TABLE IF NOT EXISTS file_tags (
  file_id BIGINT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  tag_id  BIGINT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (file_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(tag_id);

-- 전역 설정 기본값(휴지통 보관일수, 공유 QR 사용여부)
INSERT INTO settings (key, value) VALUES ('trash_retention_days', '30') ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('share_qr_enabled', '1') ON CONFLICT (key) DO NOTHING;

-- 이미지 OCR(문서 속 글자) 텍스트 + 처리 상태
ALTER TABLE files ADD COLUMN IF NOT EXISTS ocr_text   TEXT NOT NULL DEFAULT '';
ALTER TABLE files ADD COLUMN IF NOT EXISTS ocr_status VARCHAR(16) NOT NULL DEFAULT '';  -- '' | pending | done | error
ALTER TABLE files ADD COLUMN IF NOT EXISTS ocr_confidence SMALLINT;                       -- 0~100 (단어 신뢰도 평균, NULL=미측정)
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
