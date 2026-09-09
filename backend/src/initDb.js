'use strict';

// DB 스키마 초기화 + 마이그레이션 스크립트. `npm run init-db` 또는 컨테이너 시작 시 실행.
// 모든 구문은 idempotent 하여 기존 데이터를 보존한 채 반복 실행할 수 있습니다.
const { pool, query, withTransaction } = require('./db');

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
// 아래 BASELINE_SQL 은 지금까지의 모든 스키마 변경을 모은 것(전부 idempotent).
// 앞으로 새 스키마 변경은 MIGRATIONS 배열에 { id, sql } 로 "추가만" 하세요.
// 각 마이그레이션은 한 번만, 트랜잭션 안에서 실행되고 schema_migrations 에 기록됩니다.
const BASELINE_SQL = `
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
ALTER TABLE folders ADD COLUMN IF NOT EXISTS cover_file_id BIGINT;   -- 폴더 대표(커버) 이미지: 해당 폴더 안 이미지 파일 id

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
`;

// 버전 관리 마이그레이션 목록. id 는 절대 바꾸지 말고, 새 변경은 뒤에 추가만 하세요.
const MIGRATIONS = [
  { id: '0001_baseline', sql: BASELINE_SQL },
  // 영업점(branch) 역할 추가 — 담당자는 접근 불가(role='user'만), 관리자만 접근
  { id: '0002_role_branch', sql: `
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user','manager','admin','branch'));
    ALTER TABLE notices ALTER COLUMN target_roles SET DEFAULT ARRAY['admin','manager','user','branch'];
  ` },
  // 재고조사 오차체크 저장(계정별 1행) — 서버 보관 → 같은 계정이면 어느 기기서든 이어보기
  { id: '0003_stock_audit', sql: `
    CREATE TABLE IF NOT EXISTS stock_audits (
      owner_id   INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data       JSONB NOT NULL DEFAULT '[]'::jsonb,
      item_count INTEGER NOT NULL DEFAULT 0,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  ` },
  // 감사로그 action 필터 조회(대시보드·리포트) 가속용 인덱스 — 테이블이 커져도 스캔 방지
  { id: '0004_audit_action_idx', sql: `
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, created_at DESC);
  ` },
  // 계정 공유 용량 풀 — 영업점(branch) 계정을 담당자(manager)에 소속시켜 용량을 함께 쓴다.
  //  manager_id 가 가리키는 계정이 풀 루트(담당자). NULL 이면 자기 혼자 풀(기존과 동일).
  { id: '0005_account_pool', sql: `
    ALTER TABLE users ADD COLUMN IF NOT EXISTS manager_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_users_manager ON users(manager_id);
  ` },
  // 토큰 무효화(세션 폐기) — 발급된 JWT 에 이 값을 담고 매 요청 대조한다.
  // 로그아웃·비밀번호 변경·2FA 변경 시 값을 올려 기존 토큰을 즉시 무효화(기존엔 8시간 살아있었음).
  { id: '0006_token_version', sql: `
    ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
  ` },
  // 감사로그에 '대상 계정'(어느 클라우드에서 벌어진 일인지)을 구조화해 기록.
  //  기존엔 detail 문자열에 owner=N 으로만 섞여 있어 계정별 조회가 불가능했다.
  //  → 관리자 로그의 '대상 계정' 열, 계정별 사이드바 최근활동 패널이 이 컬럼을 쓴다.
  { id: '0007_audit_owner', sql: `
    ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_audit_owner ON audit_log(owner_id, created_at DESC);
  ` },
  // 메일 재시도 큐(S14) — 보내다 실패한 메일을 메모리가 아니라 DB에 남겨,
  // 서버가 재시작되어도 잃어버리지 않고 백오프로 다시 시도한다.
  { id: '0008_mail_queue', sql: `
    CREATE TABLE IF NOT EXISTS mail_queue (
      id              BIGSERIAL PRIMARY KEY,
      recipients      TEXT NOT NULL,
      subject         TEXT NOT NULL,
      html            TEXT NOT NULL DEFAULT '',
      body_text       TEXT NOT NULL DEFAULT '',
      kind            VARCHAR(32) NOT NULL DEFAULT 'general',
      status          VARCHAR(16) NOT NULL DEFAULT 'pending',
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT NOT NULL DEFAULT '',
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      sent_at         TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_mail_queue_due ON mail_queue(status, next_attempt_at);
  ` },
  // 감사로그 변조 탐지(S5) — 각 기록을 앞 기록의 해시와 엮어 사슬로 만든다.
  // 한 줄을 고치거나 지우면 그 뒤 사슬이 전부 어긋나므로 조용한 조작을 알아챌 수 있다.
  { id: '0009_audit_chain', sql: `
    ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS chain_seq  BIGINT;
    ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS prev_hash  TEXT;
    ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS chain_hash TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_chain_seq ON audit_log(chain_seq) WHERE chain_seq IS NOT NULL;

    -- 사슬의 머리. 한 행만 존재하며, 감사 기록을 넣을 때 이 행을 잠가 순서를 보장한다.
    CREATE TABLE IF NOT EXISTS audit_chain (
      id         INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      last_hash  TEXT NOT NULL DEFAULT '',
      seq        BIGINT NOT NULL DEFAULT 0,
      pruned_seq BIGINT NOT NULL DEFAULT 0,   -- 보관기간이 지나 잘라낸 앞부분(검증 시작점)
      started_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    INSERT INTO audit_chain (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  ` },
  // 파일 잠금(U10) · 폴더 템플릿(U9)
  { id: '0010_locks_templates', sql: `
    -- 잠근 파일은 지우기·이름변경·이동·덮어쓰기가 막힌다. 잠근 사람과 관리자만 풀 수 있다.
    ALTER TABLE files ADD COLUMN IF NOT EXISTS locked_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE files ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;
    ALTER TABLE files ADD COLUMN IF NOT EXISTS lock_note TEXT NOT NULL DEFAULT '';

    -- 자주 쓰는 폴더 구조를 저장해 두고 한 번에 만든다. owner_id 가 NULL 이면 모두가 쓰는 공용 템플릿.
    CREATE TABLE IF NOT EXISTS folder_templates (
      id         BIGSERIAL PRIMARY KEY,
      owner_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name       VARCHAR(128) NOT NULL,
      paths      TEXT[] NOT NULL DEFAULT '{}',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_folder_templates_owner ON folder_templates(owner_id);
  ` },
];

// ── S18 · 마이그레이션 드라이런 ────────────────────────
// "적용해 보고, 무엇이 바뀌는지 확인한 뒤, 되돌린다."
// 배포 직전에 이걸 돌려 보면 운영 DB를 건드리지 않고도
//   · SQL 이 실제로 통과하는지 (오타·타입 불일치·제약 위반)
//   · 어떤 테이블/컬럼/인덱스가 생기고 사라지는지
//   · 기존 데이터가 제약에 걸리지는 않는지
// 를 미리 볼 수 있다. 트랜잭션을 반드시 롤백하므로 흔적이 남지 않는다.
async function snapshotSchema(client) {
  const cols = await client.query(`
    SELECT table_name || '.' || column_name || ' ' || data_type ||
           CASE WHEN is_nullable='NO' THEN ' NOT NULL' ELSE '' END AS sig
    FROM information_schema.columns WHERE table_schema='public'`);
  const idx = await client.query("SELECT indexname AS sig FROM pg_indexes WHERE schemaname='public'");
  const con = await client.query(`
    SELECT conrelid::regclass || ':' || conname AS sig FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace`);
  return {
    columns: new Set(cols.rows.map((r) => r.sig)),
    indexes: new Set(idx.rows.map((r) => r.sig)),
    constraints: new Set(con.rows.map((r) => r.sig)),
  };
}
const diffSets = (before, after) => ({
  added: [...after].filter((x) => !before.has(x)).sort(),
  removed: [...before].filter((x) => !after.has(x)).sort(),
});

async function dryRunMigrations() {
  await query('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const done = new Set((await query('SELECT id FROM schema_migrations')).rows.map((r) => r.id));
  const pending = MIGRATIONS.filter((m) => !done.has(m.id));
  const result = { pending: pending.map((m) => m.id), applied: [...done], ok: true, steps: [], diff: null };

  if (!pending.length) {
    console.log('[dry-run] 적용할 마이그레이션이 없습니다. (이미 최신)');
    return result;
  }
  console.log(`[dry-run] 미적용 ${pending.length}건: ${pending.map((m) => m.id).join(', ')}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await snapshotSchema(client);
    for (const m of pending) {
      const t0 = Date.now();
      try {
        await client.query(m.sql);
        const ms = Date.now() - t0;
        result.steps.push({ id: m.id, ok: true, ms });
        console.log(`  ✅ ${m.id} (${ms}ms)`);
      } catch (e) {
        result.ok = false;
        result.steps.push({ id: m.id, ok: false, error: e.message });
        console.error(`  ❌ ${m.id} — ${e.message}`);
        break;                                   // 첫 실패에서 멈춘다(뒤는 어차피 못 믿는다)
      }
    }
    if (result.ok) {
      const after = await snapshotSchema(client);
      result.diff = {
        columns: diffSets(before.columns, after.columns),
        indexes: diffSets(before.indexes, after.indexes),
        constraints: diffSets(before.constraints, after.constraints),
      };
    }
  } finally {
    await client.query('ROLLBACK').catch(() => {});   // 무슨 일이 있어도 되돌린다
    client.release();
  }

  if (result.ok && result.diff) {
    const d = result.diff;
    const show = (label, x) => {
      for (const a of x.added) console.log(`  + ${label} ${a}`);
      for (const r of x.removed) console.log(`  - ${label} ${r}`);
    };
    console.log('\n[dry-run] 예상 변경:');
    show('컬럼', d.columns); show('인덱스', d.indexes); show('제약', d.constraints);
    if (!d.columns.added.length && !d.columns.removed.length && !d.indexes.added.length
      && !d.indexes.removed.length && !d.constraints.added.length && !d.constraints.removed.length) {
      console.log('  (스키마 구조 변화 없음 — 데이터만 바꾸는 마이그레이션일 수 있습니다)');
    }
    console.log('\n[dry-run] 모두 통과. 롤백했으므로 DB는 그대로입니다.');
  } else if (!result.ok) {
    console.error('\n[dry-run] 실패한 마이그레이션이 있습니다. 배포 전에 고쳐 주세요. (DB는 롤백되어 그대로입니다)');
  }
  return result;
}

// 적용 안 된 마이그레이션만 트랜잭션으로 실행하고 schema_migrations 에 기록.
async function runMigrations() {
  await query('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const done = new Set((await query('SELECT id FROM schema_migrations')).rows.map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    await withTransaction(async (client) => {          // DDL도 트랜잭션(Postgres) → 실패 시 전체 롤백
      await client.query(m.sql);
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
    });
    console.log(`[init-db] 마이그레이션 적용: ${m.id}`);
  }
}

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
  // --dry-run: 적용해 보고 무엇이 바뀌는지만 보여준 뒤 되돌린다(S18)
  if (process.argv.includes('--dry-run')) {
    console.log('[dry-run] 마이그레이션 시험 적용 — DB는 바뀌지 않습니다.');
    const r = await dryRunMigrations();
    await pool.end();
    process.exit(r.ok ? 0 : 1);
  }
  console.log('[init-db] 스키마/마이그레이션 적용 중...');
  await query(SCHEMA);        // 기본 테이블(CREATE IF NOT EXISTS, 항상 안전)
  await runMigrations();      // 버전 관리 마이그레이션(미적용분만, 트랜잭션)
  await seed();
  console.log('[init-db] 완료.');
  await pool.end();
}

main().catch((err) => {
  console.error('[init-db] 실패:', err);
  process.exit(1);
});
