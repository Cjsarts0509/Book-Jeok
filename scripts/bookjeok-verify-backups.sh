#!/usr/bin/env bash
# 북적북적 백업 무결성 검증 (S9)
#
# "백업이 있다"와 "백업이 쓸 수 있다"는 다른 이야기다. 이 스크립트는 로컬 백업 하나하나에 대해
#   1) gzip 이 끝까지 정상으로 풀리는지 (잘림·비트 손상 탐지)
#   2) 풀린 내용이 실제 pg_dump 결과처럼 보이는지 (헤더/종료 표시)
#   3) 처음 봤을 때 기록해 둔 SHA-256 과 지금이 같은지 (조용한 변조·부패 탐지)
# 를 확인하고, 결과를 앱이 읽는 위치(_backup-status/verify.json)에 남긴다.
#
# 해시는 파일마다 <파일>.sha256 로 함께 보관한다. 없으면 이번에 만들어 두고(첫 등록),
# 있으면 대조한다 — 즉 두 번째 실행부터 '변하지 않았음'을 보증한다.
#
# 사용:  ./bookjeok-verify-backups.sh
# 크론:  0 5 * * * /home/ubuntu/Book-Jeok/scripts/bookjeok-verify-backups.sh >> /var/log/bookjeok-verify.log 2>&1
set -uo pipefail

[ -f "$HOME/.bookjeok-backup.env" ] && . "$HOME/.bookjeok-backup.env"

DIR="${BOOKJEOK_BACKUP_DIR:-$HOME/bookjeok-backups}"
API_CONTAINER="${API_CONTAINER:-bookjeok-api}"
CHECK_MAX="${BOOKJEOK_VERIFY_MAX:-8}"     # 최신 N개만 검사(오래된 것까지 매일 읽으면 디스크가 아깝다)

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

echo "$(date '+%F %T') 백업 무결성 검증 시작 — $DIR (최신 ${CHECK_MAX}개)"

mapfile -t FILES < <(ls -1t "$DIR"/bookjeok-db-*.sql.gz 2>/dev/null | head -n "$CHECK_MAX")
if [ "${#FILES[@]}" -eq 0 ]; then
  echo "$(date '+%F %T') [경고] 검사할 백업이 없습니다: $DIR" >&2
  RESULT="{\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"ok\":false,\"checked\":0,\"failed\":0,\"error\":\"백업 파일이 없습니다\",\"files\":[]}"
  printf '%s' "$RESULT" | docker exec -i "$API_CONTAINER" sh -c 'mkdir -p /data/storage/_status/checkups && cat > /data/storage/_status/checkups/backup-verify.json' 2>/dev/null || true
  exit 1
fi

ITEMS=""; FIRST=1; FAILED=0; CHECKED=0; NEWHASH=0

for f in "${FILES[@]}"; do
  NAME="$(basename "$f")"
  SIZE="$(stat -c%s "$f" 2>/dev/null || echo 0)"
  MTIME="$(date -u -d "@$(stat -c%Y "$f")" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '')"
  STATUS="ok"; DETAIL=""
  CHECKED=$((CHECKED + 1))

  # 1) gzip 이 끝까지 풀리는가 — 잘린 백업을 여기서 걸러낸다
  if ! gzip -t "$f" 2>/dev/null; then
    STATUS="corrupt"; DETAIL="gzip 압축이 손상되었거나 파일이 잘렸습니다"
  else
    # 2) pg_dump 결과처럼 보이는가 — 헤더와 종료 표시를 확인
    #    head -c 가 파이프를 닫으면 zcat 이 SIGPIPE(141)로 죽는다. 이 스크립트는 pipefail 이라
    #    grep 이 찾았는데도 파이프라인 전체가 실패로 잡힌다 → 멀쩡한 백업이 전부 '헤더 없음'이 됐다.
    #    그래서 이 두 검사만 pipefail 을 끈 서브셸에서 돌린다.
    HEAD_OK=0; TAIL_OK=0
    ( set +o pipefail; zcat "$f" 2>/dev/null | head -c 4096 | grep -q 'PostgreSQL database dump' ) && HEAD_OK=1
    ( set +o pipefail; zcat "$f" 2>/dev/null | tail -c 4096 | grep -q 'PostgreSQL database dump complete' ) && TAIL_OK=1
    if [ "$HEAD_OK" -ne 1 ]; then
      STATUS="notdump"; DETAIL="pg_dump 헤더를 찾지 못했습니다"
    elif [ "$TAIL_OK" -ne 1 ]; then
      STATUS="truncated"; DETAIL="덤프 종료 표시가 없습니다 — 덤프 도중 중단된 것으로 보입니다"
    fi
  fi

  # 3) 해시 대조 — 처음이면 등록, 있으면 비교
  HASHFILE="${f}.sha256"
  NOW_HASH="$(sha256sum "$f" 2>/dev/null | cut -d' ' -f1)"
  HASH_STATE="new"
  if [ -f "$HASHFILE" ]; then
    OLD_HASH="$(cut -d' ' -f1 < "$HASHFILE")"
    if [ "$OLD_HASH" = "$NOW_HASH" ]; then
      HASH_STATE="match"
    else
      HASH_STATE="changed"
      [ "$STATUS" = "ok" ] && { STATUS="changed"; DETAIL="처음 기록한 해시와 다릅니다 — 백업이 변경·손상되었을 수 있습니다"; }
    fi
  else
    printf '%s  %s\n' "$NOW_HASH" "$NAME" > "$HASHFILE"
    NEWHASH=$((NEWHASH + 1))
  fi

  [ "$STATUS" != "ok" ] && { FAILED=$((FAILED + 1)); echo "$(date '+%F %T') [실패] $NAME — $DETAIL" >&2; }

  [ "$FIRST" -eq 0 ] && ITEMS="$ITEMS,"; FIRST=0
  ITEMS="$ITEMS{\"name\":\"$(json_escape "$NAME")\",\"size\":$SIZE,\"at\":\"$MTIME\",\"status\":\"$STATUS\",\"hash\":\"${NOW_HASH:0:16}\",\"hashState\":\"$HASH_STATE\",\"detail\":\"$(json_escape "$DETAIL")\"}"
done

OK=true; [ "$FAILED" -gt 0 ] && OK=false
RESULT="{\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"ok\":$OK,\"checked\":$CHECKED,\"failed\":$FAILED,\"newHashes\":$NEWHASH,\"dir\":\"$(json_escape "$DIR")\",\"files\":[$ITEMS]}"
printf '%s' "$RESULT" | docker exec -i "$API_CONTAINER" sh -c 'mkdir -p /data/storage/_status/checkups && cat > /data/storage/_status/checkups/backup-verify.json' 2>/dev/null || true

echo "$(date '+%F %T') 검증 완료 — 검사 ${CHECKED}개, 실패 ${FAILED}개, 해시 신규등록 ${NEWHASH}개"
[ "$FAILED" -gt 0 ] && exit 1 || exit 0
