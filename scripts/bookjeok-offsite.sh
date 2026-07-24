#!/usr/bin/env bash
# 북적북적 '계정 밖' 콜드카피 — OCI 테넌시와 다른 신뢰 경계(다른 클라우드/로컬)로
# DB 덤프 히스토리 + 파일 저장소를 rclone 으로 복사한다. (월 1회 권장)
#
# 왜? 기존 백업(오브젝트스토리지 PAR·볼륨백업)은 모두 같은 OCI 계정 안에 있어,
#     계정 정지/자격증명 유출/컴파트먼트 삭제 한 번에 원본+백업이 동시에 사라진다.
#     이 스크립트가 그 단일 신뢰경계 문제를 메운다.
#
# 준비:
#   1) rclone 설치:  curl https://rclone.org/install.sh | sudo bash
#   2) 원격 설정:    rclone config   → 원하는 원격 하나 만들기(예: Backblaze B2, Google Drive, S3 호환 등)
#   3) ~/.bookjeok-backup.env 에 추가:
#        BOOKJEOK_OFFSITE_REMOTE="myremote:bookjeok"        # rclone 원격:경로
#        BOOKJEOK_OFFSITE_HC_URL="https://hc-ping.com/<id>"  # (선택) 이 작업 전용 모니터링 URL
set -euo pipefail

[ -f "$HOME/.bookjeok-backup.env" ] && . "$HOME/.bookjeok-backup.env"

REMOTE="${BOOKJEOK_OFFSITE_REMOTE:-}"
if [ -z "$REMOTE" ]; then
  echo "[offsite] BOOKJEOK_OFFSITE_REMOTE 미설정 → 건너뜀. (설정법은 이 스크립트 상단 주석 참고)"
  exit 0
fi
command -v rclone >/dev/null 2>&1 || { echo "[offsite] rclone 이 설치돼 있지 않습니다. curl https://rclone.org/install.sh | sudo bash" >&2; exit 1; }

# 모니터링(선택): 전용 URL 없으면 공용 BOOKJEOK_HC_URL 도 사용 안 함(오프사이트는 빈도가 달라 별도 권장)
HC_URL="${BOOKJEOK_OFFSITE_HC_URL:-}"
API_CONTAINER="${API_CONTAINER:-bookjeok-api}"
hc() { [ -n "$HC_URL" ] && curl -fsS -m 15 --retry 2 "${HC_URL}${1:-}" >/dev/null 2>&1 || true; }
# 결과를 앱이 읽는 위치(_backup-status/offsite.json)에 기록 → 주간 리포트/관리자 탭에서 표시
write_status() { # $1=ok(true/false)
  local ts; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"at":"%s","ok":%s}' "$ts" "$1" \
    | docker exec -i "$API_CONTAINER" sh -c 'mkdir -p /data/storage/_backup-status && cat > /data/storage/_backup-status/offsite.json' 2>/dev/null || true
}
trap 'write_status false; hc /fail' ERR
hc /start

DATA_ROOT="${DATA_ROOT:-/mnt/bookjeok-data}"
STORAGE="${STORAGE_DIR:-$DATA_ROOT/storage}"
LOCAL_DB="$HOME/bookjeok-backups"
DB_CONTAINER="${DB_CONTAINER:-bookjeok-db}"

# 1) 최신 상태의 DB 덤프를 하나 만들어 로컬 백업 폴더에 둔다(오프사이트에 '지금' DB가 담기도록)
mkdir -p "$LOCAL_DB"
STAMP="$(date +%F_%H%M)"; DUMP="$LOCAL_DB/bookjeok-db-offsite-$STAMP.sql.gz"
echo "$(date '+%F %T') [offsite] DB 덤프 생성: $(basename "$DUMP")"
docker exec "$DB_CONTAINER" pg_dump -U "${DB_USER:-bookjeok}" --clean --if-exists "${DB_NAME:-bookjeok}" | gzip > "$DUMP"

# 2) DB 덤프들은 '추가 복사'(copy) — 날짜별 히스토리를 원격에 보존(삭제 전파 안 함)
echo "$(date '+%F %T') [offsite] DB 덤프 → $REMOTE/db 복사"
rclone copy "$LOCAL_DB" "$REMOTE/db" --include 'bookjeok-db-*.sql.gz' --transfers 4 --retries 3

# 3) 파일 저장소는 'sync'(증분 미러) — 임시/캐시 폴더는 제외
echo "$(date '+%F %T') [offsite] 파일 저장소 → $REMOTE/storage 동기화"
rclone sync "$STORAGE" "$REMOTE/storage" \
  --exclude '_chunks/**' --exclude '_bundles/**' --exclude '_pdfcache/**' \
  --exclude '_staging/**' --exclude '_backup-status/**' \
  --transfers 8 --checkers 16 --retries 3 --fast-list

# 4) 방금 만든 오프사이트 덤프는 로컬에선 오래 두지 않는다(일간 덤프와 구분·용량 절약)
find "$LOCAL_DB" -name 'bookjeok-db-offsite-*.sql.gz' -mtime +2 -delete

echo "$(date '+%F %T') [offsite] 완료 → $REMOTE"
write_status true
hc            # 성공 핑
