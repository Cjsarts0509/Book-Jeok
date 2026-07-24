#!/usr/bin/env bash
# 북적북적 DB 복원 — 백업 목록에서 골라 확인 후 복원. 복원 전 현재 DB를 자동 백업(되돌리기용).
# 안전을 위해 웹이 아닌 터미널에서만 실행합니다. DB(메타데이터)만 복원 — 파일 15GB는 볼륨 스냅샷에서 별도 복원.
set -euo pipefail

DIR="${BOOKJEOK_BACKUP_DIR:-$HOME/bookjeok-backups}"
DB_CONTAINER="${DB_CONTAINER:-bookjeok-db}"
API_CONTAINER="${API_CONTAINER:-bookjeok-api}"
DB_USER="${DB_USER:-bookjeok}"
DB_NAME="${DB_NAME:-bookjeok}"

echo "=== 북적북적 DB 복원 ==="
# 특정 백업을 바로 지정(관리자 백업탭이 뽑아주는 명령):  BOOKJEOK_RESTORE_FILE=<파일명> ./restore.sh
if [ -n "${BOOKJEOK_RESTORE_FILE:-}" ]; then
  SEL="$DIR/${BOOKJEOK_RESTORE_FILE##*/}"      # basename 만 사용(경로 조작 방지)
  [ -f "$SEL" ] || { echo "지정한 백업이 없습니다: $SEL"; exit 1; }
  echo "지정된 백업: $(basename "$SEL")  ($(du -h "$SEL" | cut -f1))"
else
  mapfile -t files < <(ls -1t "$DIR"/bookjeok-db-*.sql.gz 2>/dev/null || true)
  if [ "${#files[@]}" -eq 0 ]; then echo "백업 파일이 없습니다: $DIR"; exit 1; fi
  echo "복원 가능한 백업(최신순):"
  for i in "${!files[@]}"; do
    printf "  [%d] %s  (%s)\n" "$i" "$(basename "${files[$i]}")" "$(du -h "${files[$i]}" | cut -f1)"
  done
  echo
  read -rp "복원할 백업 번호: " idx
  [[ "$idx" =~ ^[0-9]+$ ]] && [ "$idx" -lt "${#files[@]}" ] || { echo "잘못된 번호입니다."; exit 1; }
  SEL="${files[$idx]}"
fi

echo
echo "⚠️  현재 DB('$DB_NAME')를 아래 백업으로 완전히 덮어씁니다. 이 백업 이후의 변경분은 사라집니다."
echo "    선택: $(basename "$SEL")"
echo
read -rp "정말 진행하려면 대문자로 'RESTORE' 를 입력하세요: " confirm
[ "$confirm" = "RESTORE" ] || { echo "취소되었습니다."; exit 0; }

# 복원 전 현재 상태를 먼저 백업(되돌리기 안전망)
PRE="$DIR/bookjeok-db-pre-restore-$(date +%F_%H%M).sql.gz"
echo "→ 복원 전 현재 DB 백업 생성: $(basename "$PRE")"
docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" --clean --if-exists "$DB_NAME" | gzip > "$PRE"

# API 가 DB 에 연결된 채 --clean 을 부으면 락/부분적용 위험 → 복원 동안 API 정지
API_WAS_UP=false
if docker ps --format '{{.Names}}' | grep -qx "$API_CONTAINER"; then
  API_WAS_UP=true
  echo "→ 복원 동안 API 정지: $API_CONTAINER"
  docker stop "$API_CONTAINER" >/dev/null
fi
# 무슨 일이 있어도(오류·중단) API 를 다시 살린다
restore_api() { if [ "$API_WAS_UP" = true ]; then echo "→ API 재시작: $API_CONTAINER"; docker start "$API_CONTAINER" >/dev/null || true; fi; }
trap restore_api EXIT

echo "→ 복원 실행 중…"
gunzip -c "$SEL" | docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -q "$DB_NAME"

echo "✅ 복원 완료: $(basename "$SEL")"
echo "   문제가 있으면 방금 만든 백업으로 되돌릴 수 있습니다: $(basename "$PRE")"
