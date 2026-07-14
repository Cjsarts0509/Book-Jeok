#!/usr/bin/env bash
# 북적북적 DB 백업 — pg_dump(gzip) → 로컬 보관 + OCI 오브젝트 스토리지(PAR) 업로드.
# 실행 결과 요약을 앱이 볼 수 있는 위치(_backup-status/db.json)에 기록 → 관리자 '백업' 탭에 표시.
set -euo pipefail

[ -f "$HOME/.bookjeok-backup.env" ] && . "$HOME/.bookjeok-backup.env"

LOCAL_DIR="$HOME/bookjeok-backups"
KEEP_DAYS=14
API_CONTAINER="${API_CONTAINER:-bookjeok-api}"
STAMP="$(date +%F_%H%M)"
NAME="bookjeok-db-${STAMP}.sql.gz"
FILE="${LOCAL_DIR}/${NAME}"
REMOTE=false

mkdir -p "$LOCAL_DIR"

# 1) DB 덤프(gzip)
docker exec "${DB_CONTAINER:-bookjeok-db}" pg_dump -U "${DB_USER:-bookjeok}" --clean --if-exists "${DB_NAME:-bookjeok}" | gzip > "$FILE"
SIZE_BYTES="$(stat -c%s "$FILE" 2>/dev/null || echo 0)"
echo "$(date '+%F %T') 덤프 생성: $NAME ($(du -h "$FILE" | cut -f1))"

# 2) 오브젝트 스토리지 업로드(PAR 설정 시)
if [ -n "${BOOKJEOK_BACKUP_PAR:-}" ]; then
  if curl -fsS --retry 3 --retry-delay 5 -X PUT -T "$FILE" "${BOOKJEOK_BACKUP_PAR}${NAME}"; then
    REMOTE=true; echo "$(date '+%F %T') 업로드 완료 → 오브젝트 스토리지: $NAME"
  else
    echo "$(date '+%F %T') [경고] 업로드 실패 — 로컬 백업은 보존됨" >&2
  fi
fi

# 3) 오래된 로컬 백업 정리
find "$LOCAL_DIR" -name 'bookjeok-db-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
LOCALCOUNT="$(ls -1 "$LOCAL_DIR"/bookjeok-db-*.sql.gz 2>/dev/null | wc -l | tr -d ' ')"

# 4) 상태 기록(앱이 읽는 볼륨 안에 기록 — 컨테이너 통해 씀)
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STATUS=$(printf '{"at":"%s","file":"%s","size":%s,"remote":%s,"localCount":%s}' "$TS" "$NAME" "$SIZE_BYTES" "$REMOTE" "$LOCALCOUNT")
printf '%s' "$STATUS" | docker exec -i "$API_CONTAINER" sh -c 'mkdir -p /data/storage/_backup-status && cat > /data/storage/_backup-status/db.json' 2>/dev/null || true

echo "$(date '+%F %T') 완료. 로컬 보관: ${LOCALCOUNT}개"
