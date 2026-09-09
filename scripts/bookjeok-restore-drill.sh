#!/usr/bin/env bash
# 북적북적 백업 복원 리허설 (S8)
#
# 백업이 실제로 '복원되는지'는 복원해 봐야만 안다. 이 스크립트는 최신 백업을
# 버리는 임시 데이터베이스(bookjeok_drill)에 복원해 보고, 핵심 테이블이 제대로
# 들어왔는지 확인한 뒤 그 임시 DB를 지운다. 운영 DB는 절대 건드리지 않는다.
#
# 확인하는 것
#   · 덤프가 오류 없이 적용되는가
#   · 필수 테이블(users/files/folders/audit_log 등)이 존재하는가
#   · 행 수가 운영 DB와 크게 어긋나지 않는가 (백업 시점 차이만큼의 오차는 허용)
#
# 사용:  ./bookjeok-restore-drill.sh [백업파일명]
# 크론:  30 5 * * 0 /home/ubuntu/Book-Jeok/scripts/bookjeok-restore-drill.sh >> /var/log/bookjeok-drill.log 2>&1
set -uo pipefail

[ -f "$HOME/.bookjeok-backup.env" ] && . "$HOME/.bookjeok-backup.env"

DIR="${BOOKJEOK_BACKUP_DIR:-$HOME/bookjeok-backups}"
DB_CONTAINER="${DB_CONTAINER:-bookjeok-db}"
API_CONTAINER="${API_CONTAINER:-bookjeok-api}"
DB_USER="${DB_USER:-bookjeok}"
DB_NAME="${DB_NAME:-bookjeok}"
DRILL_DB="${BOOKJEOK_DRILL_DB:-bookjeok_drill}"
REQUIRED_TABLES="users files folders audit_log share_links notifications"

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
psql_drill() { docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DRILL_DB" -tA -c "$1" 2>/dev/null; }
psql_live()  { docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME"  -tA -c "$1" 2>/dev/null; }

START_TS="$(date +%s)"
report() {   # report <ok> <detail>
  local ok="$1" detail="$2"
  local elapsed=$(( $(date +%s) - START_TS ))
  local json="{\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"ok\":$ok,\"file\":\"$(json_escape "${NAME:-}")\",\"elapsedSec\":$elapsed,\"detail\":\"$(json_escape "$detail")\",\"tables\":[${TABLE_JSON:-}],\"drillDb\":\"$(json_escape "$DRILL_DB")\"}"
  printf '%s' "$json" | docker exec -i "$API_CONTAINER" sh -c 'mkdir -p /data/storage/_status/checkups && cat > /data/storage/_status/checkups/restore-drill.json' 2>/dev/null || true
}
cleanup() {  # 어떤 경로로 끝나든 임시 DB는 반드시 지운다
  docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS \"$DRILL_DB\";" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ── 대상 백업 고르기 ──────────────────────────────────
if [ "${1:-}" != "" ]; then
  SEL="$DIR/${1##*/}"                       # basename 만 사용(경로 조작 방지)
else
  SEL="$(ls -1t "$DIR"/bookjeok-db-*.sql.gz 2>/dev/null | head -1)"
fi
NAME="$(basename "${SEL:-없음}")"

if [ -z "${SEL:-}" ] || [ ! -f "$SEL" ]; then
  echo "$(date '+%F %T') [실패] 복원할 백업을 찾지 못했습니다: $DIR" >&2
  report false "복원할 백업 파일이 없습니다 ($DIR)"
  exit 1
fi
echo "$(date '+%F %T') 복원 리허설 시작 — $NAME ($(du -h "$SEL" | cut -f1))"

# ── 임시 DB 를 새로 만들고 덤프를 적용 ─────────────────
cleanup
if ! docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d postgres -c "CREATE DATABASE \"$DRILL_DB\";" >/dev/null 2>&1; then
  echo "$(date '+%F %T') [실패] 임시 DB 생성 실패" >&2
  report false "임시 데이터베이스($DRILL_DB)를 만들지 못했습니다"
  exit 1
fi

# ON_ERROR_STOP=1 로 첫 오류에서 멈춘다 — '조용히 절반만 복원'을 성공으로 오인하지 않기 위함
RESTORE_LOG="$(mktemp)"
if ! zcat "$SEL" | docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DRILL_DB" -v ON_ERROR_STOP=1 -q > "$RESTORE_LOG" 2>&1; then
  # psql 출력엔 덤프가 찍는 결과행("(1 row)" 등)이 섞인다 — 실제 오류 줄만 뽑는다
  ERR="$(grep -E '^(psql:)?.*(ERROR|치명적|FATAL)' "$RESTORE_LOG" | head -3 | tr '\n' ' ' | cut -c1-400)"
  [ -z "$ERR" ] && ERR="$(tail -3 "$RESTORE_LOG" | tr '\n' ' ' | cut -c1-400)"
  rm -f "$RESTORE_LOG"
  echo "$(date '+%F %T') [실패] 덤프 적용 중 오류: $ERR" >&2
  report false "덤프를 적용하지 못했습니다: $ERR"
  exit 1
fi
rm -f "$RESTORE_LOG"

# ── 복원 결과 검증 ────────────────────────────────────
MISSING=""; TABLE_JSON=""; FIRST=1; SUSPECT=0
for t in $REQUIRED_TABLES; do
  EXISTS="$(psql_drill "SELECT to_regclass('public.$t') IS NOT NULL;")"
  if [ "$EXISTS" != "t" ]; then MISSING="$MISSING $t"; continue; fi
  N_DRILL="$(psql_drill "SELECT count(*) FROM \"$t\";")"
  N_LIVE="$(psql_live  "SELECT count(*) FROM \"$t\";")"
  N_DRILL="${N_DRILL:-0}"; N_LIVE="${N_LIVE:-0}"
  # 운영 대비 절반도 안 되면(백업 시점 차이로 설명 안 되는 수준) 의심스럽다고 표시
  ODD=false
  if [ "$N_LIVE" -gt 20 ] && [ "$N_DRILL" -lt $((N_LIVE / 2)) ]; then ODD=true; SUSPECT=$((SUSPECT + 1)); fi
  [ "$FIRST" -eq 0 ] && TABLE_JSON="$TABLE_JSON,"; FIRST=0
  TABLE_JSON="$TABLE_JSON{\"table\":\"$t\",\"restored\":$N_DRILL,\"live\":$N_LIVE,\"odd\":$ODD}"
  printf '  %-16s 복원 %8s / 운영 %8s%s\n' "$t" "$N_DRILL" "$N_LIVE" "$([ "$ODD" = true ] && echo '  ← 차이가 큽니다')"
done

if [ -n "$MISSING" ]; then
  echo "$(date '+%F %T') [실패] 복원본에 없는 테이블:$MISSING" >&2
  report false "복원본에 다음 테이블이 없습니다:$MISSING"
  exit 1
fi

# users 가 비어 있으면 로그인 자체가 불가능한 백업 — 성공으로 볼 수 없다
N_USERS="$(psql_drill 'SELECT count(*) FROM users;')"
if [ "${N_USERS:-0}" -eq 0 ]; then
  echo "$(date '+%F %T') [실패] 복원본에 계정이 하나도 없습니다" >&2
  report false "복원본에 계정이 하나도 없습니다 — 이 백업으로는 서비스를 되살릴 수 없습니다"
  exit 1
fi

ELAPSED=$(( $(date +%s) - START_TS ))
if [ "$SUSPECT" -gt 0 ]; then
  echo "$(date '+%F %T') [주의] 복원은 됐지만 행 수 차이가 큰 테이블이 ${SUSPECT}개 있습니다 (${ELAPSED}초)"
  report true "복원 성공. 다만 운영 대비 행 수 차이가 큰 테이블이 ${SUSPECT}개 있습니다 — 백업 시점을 확인해 주세요."
  exit 0
fi

echo "$(date '+%F %T') 복원 리허설 성공 — $NAME (${ELAPSED}초, 계정 ${N_USERS}개)"
report true "복원 성공 (${ELAPSED}초, 계정 ${N_USERS}개). 이 백업으로 서비스를 되살릴 수 있습니다."
exit 0
