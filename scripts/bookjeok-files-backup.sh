#!/usr/bin/env bash
# 북적북적 파일 볼륨(bookjeok-data) 자동 증분 백업(OCI) + 오래된 백업 정리.
# 결과 요약을 앱이 볼 수 있는 위치(_backup-status/files.json)에 기록 → 관리자 '백업' 탭에 표시.
set -euo pipefail
export SUPPRESS_LABEL_WARNING=True
[ -f "$HOME/.bookjeok-backup.env" ] && . "$HOME/.bookjeok-backup.env"
OCI="$HOME/bin/oci"
API_CONTAINER="${API_CONTAINER:-bookjeok-api}"
KEEP_DAYS=35

# 백업 모니터링(선택): BOOKJEOK_HC_URL 설정 시 성공/실패 핑(누락 시 모니터링 서비스가 알림)
HC_URL="${BOOKJEOK_HC_URL:-}"
hc() { [ -n "$HC_URL" ] && curl -fsS -m 10 --retry 2 "${HC_URL}${1:-}" >/dev/null 2>&1 || true; }
trap 'hc /fail' ERR
hc /start

write_status() { # $1=ok(true/false) $2=name
  local ts; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"at":"%s","backup":"%s","ok":%s}' "$ts" "$2" "$1" \
    | docker exec -i "$API_CONTAINER" sh -c 'mkdir -p /data/storage/_backup-status && cat > /data/storage/_backup-status/files.json' 2>/dev/null || true
}

COMPARTMENT=$(grep '^tenancy=' "$HOME/.oci/config" | cut -d= -f2)
VOL=$($OCI bv volume list --compartment-id "$COMPARTMENT" --all \
  --query "data[?\"display-name\"=='bookjeok-data' && \"lifecycle-state\"=='AVAILABLE'].id | [0]" --raw-output)
if [ -z "$VOL" ] || [ "$VOL" = "null" ]; then
  echo "$(date '+%F %T') [오류] bookjeok-data 볼륨을 찾지 못함" >&2; write_status false ""; hc /fail; exit 1
fi

STAMP="$(date +%F_%H%M)"; BK="bookjeok-files-$STAMP"
echo "$(date '+%F %T') 백업 시작 (증분)…"
if $OCI bv backup create --volume-id "$VOL" --type INCREMENTAL --display-name "$BK" --wait-for-state AVAILABLE >/dev/null; then
  echo "$(date '+%F %T') 볼륨 백업 완료: $BK"; write_status true "$BK"
else
  echo "$(date '+%F %T') [오류] 볼륨 백업 실패" >&2; write_status false "$BK"; hc /fail; exit 1
fi

# 오래된 백업 정리(우리 prefix만)
CUTOFF=$(date -u -d "$KEEP_DAYS days ago" +%Y-%m-%dT%H:%M:%S.000Z)
OLD=$($OCI bv backup list --compartment-id "$COMPARTMENT" --volume-id "$VOL" --all \
  --query "join(' ', data[?starts_with(\"display-name\",'bookjeok-files-') && \"time-created\" < '$CUTOFF'].id)" \
  --raw-output 2>/dev/null || echo "")
for id in $OLD; do
  $OCI bv backup delete --volume-backup-id "$id" --force >/dev/null 2>&1 && echo "  오래된 백업 삭제: $id"
done
echo "$(date '+%F %T') 정리 완료"
hc            # 성공 핑
