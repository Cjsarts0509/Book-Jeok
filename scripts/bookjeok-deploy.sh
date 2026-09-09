#!/usr/bin/env bash
# 북적북적 배포 — 건강검진 실패 시 자동 롤백 (S19)
#
# 배포가 무서운 이유는 "올렸는데 안 뜬다"를 사람이 뒤늦게 아는 것이다.
# 이 스크립트는 올리기 전에 되돌아갈 지점을 기록해 두고, 올린 뒤 실제로 살아났는지
# 확인한다. 살아나지 못하면 사람을 기다리지 않고 이전 상태로 되돌린다.
#
# 순서
#   1) 지금 이미지 ID·커밋을 기록 (되돌아갈 지점)
#   2) 마이그레이션 드라이런 — DB 를 건드리기 전에 SQL 이 통과하는지 먼저 본다
#   3) 배포 직전 DB 백업
#   4) 빌드 → 기동 → 마이그레이션
#   5) 건강검진(/api/health + 로그인 화면) 을 최대 90초 기다린다
#   6) 실패하면 이전 이미지로 되돌리고 다시 기동, 결과를 남긴다
#
# 사용:  ./bookjeok-deploy.sh            (현재 체크아웃된 코드로 배포)
#        ./bookjeok-deploy.sh --pull     (git pull 먼저)
#        ./bookjeok-deploy.sh --no-backup
set -uo pipefail

[ -f "$HOME/.bookjeok-backup.env" ] && . "$HOME/.bookjeok-backup.env"

REPO_DIR="${BOOKJEOK_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
API_CONTAINER="${API_CONTAINER:-bookjeok-api}"
API_SERVICE="${API_SERVICE:-api}"
HEALTH_URL="${BOOKJEOK_HEALTH_URL:-http://127.0.0.1:4000/api/health}"
HEALTH_TIMEOUT="${BOOKJEOK_HEALTH_TIMEOUT:-90}"
DO_PULL=false; DO_BACKUP=true
for a in "$@"; do
  case "$a" in
    --pull) DO_PULL=true ;;
    --no-backup) DO_BACKUP=false ;;
    *) echo "알 수 없는 옵션: $a"; exit 2 ;;
  esac
done

cd "$REPO_DIR" || { echo "저장소를 찾지 못했습니다: $REPO_DIR"; exit 1; }
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
START_TS="$(date +%s)"
STAGE="시작"
report() {  # report <ok> <detail> [rolledBack]
  local elapsed=$(( $(date +%s) - START_TS ))
  local json
  json="{\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"ok\":$1,\"stage\":\"$(json_escape "$STAGE")\",\"detail\":\"$(json_escape "$2")\",\"rolledBack\":${3:-false},\"elapsedSec\":$elapsed,\"fromCommit\":\"${OLD_SHA:-}\",\"toCommit\":\"${NEW_SHA:-}\",\"image\":\"${OLD_IMAGE:-}\"}"
  printf '%s' "$json" | docker exec -i "$API_CONTAINER" sh -c 'mkdir -p /data/storage/_status/checkups && cat > /data/storage/_status/checkups/deploy.json' 2>/dev/null || true
}
say() { echo "$(date '+%F %T') $*"; }

# ── 1) 되돌아갈 지점 기록 ──────────────────────────────
OLD_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
OLD_IMAGE="$(docker inspect --format '{{.Image}}' "$API_CONTAINER" 2>/dev/null || echo '')"
say "배포 시작 — 현재 커밋 $OLD_SHA / 이미지 ${OLD_IMAGE:0:19}"
[ -z "$OLD_IMAGE" ] && say "[주의] 현재 컨테이너 이미지를 찾지 못했습니다 — 자동 롤백을 쓸 수 없습니다."

if [ "$DO_PULL" = true ]; then
  STAGE="코드 받기"
  say "git pull …"
  git pull --ff-only || { say "[실패] git pull"; report false "git pull 실패 — 로컬 변경이 있는지 확인하세요"; exit 1; }
fi
NEW_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

# ── 2) 마이그레이션 드라이런 (DB 를 건드리기 전에) ──────
STAGE="마이그레이션 드라이런"
say "마이그레이션 시험 적용 …"
if ! docker exec -i "$API_CONTAINER" node src/initDb.js --dry-run; then
  say "[중단] 마이그레이션 드라이런 실패 — 배포하지 않습니다. DB 는 그대로입니다."
  report false "마이그레이션 드라이런에서 실패했습니다. 로그를 확인하고 SQL 을 고친 뒤 다시 배포하세요."
  exit 1
fi

# ── 3) 배포 직전 백업 ─────────────────────────────────
if [ "$DO_BACKUP" = true ] && [ -x "$REPO_DIR/scripts/bookjeok-backup.sh" ]; then
  STAGE="배포 전 백업"
  say "배포 전 DB 백업 …"
  "$REPO_DIR/scripts/bookjeok-backup.sh" >/dev/null 2>&1 || say "[주의] 배포 전 백업에 실패했습니다(배포는 계속합니다)"
fi

# ── 4) 빌드 → 기동 → 마이그레이션 ─────────────────────
STAGE="빌드·기동"
say "이미지 빌드 및 재기동 …"
if ! docker compose up -d --build "$API_SERVICE"; then
  say "[실패] 빌드/기동 실패 — 이전 컨테이너가 그대로 떠 있을 수 있습니다."
  report false "docker compose up --build 이 실패했습니다."
  exit 1
fi

STAGE="마이그레이션"
say "마이그레이션 적용 …"
docker exec -i "$API_CONTAINER" node src/initDb.js || say "[주의] 마이그레이션 명령이 0 이 아닌 코드로 끝났습니다 — 아래 건강검진으로 판단합니다"

# ── 5) 건강검진 ───────────────────────────────────────
STAGE="건강검진"
say "건강검진 — 최대 ${HEALTH_TIMEOUT}초 대기 ($HEALTH_URL)"
HEALTHY=false
for i in $(seq 1 "$HEALTH_TIMEOUT"); do
  if curl -fsS -m 3 "$HEALTH_URL" 2>/dev/null | grep -q '"ok":true'; then HEALTHY=true; break; fi
  sleep 1
done

if [ "$HEALTHY" = true ]; then
  # 떠 있다고 끝이 아니다 — 컨테이너가 곧바로 죽는 크래시 루프도 잡는다
  sleep 5
  if ! curl -fsS -m 3 "$HEALTH_URL" 2>/dev/null | grep -q '"ok":true'; then HEALTHY=false; fi
fi

if [ "$HEALTHY" = true ]; then
  ELAPSED=$(( $(date +%s) - START_TS ))
  say "배포 성공 — $OLD_SHA → $NEW_SHA (${ELAPSED}초)"
  STAGE="완료"
  report true "배포 성공 ($OLD_SHA → $NEW_SHA, ${ELAPSED}초). 건강검진 통과."
  exit 0
fi

# ── 6) 자동 롤백 ──────────────────────────────────────
say "[실패] 건강검진 통과 실패 — 되돌립니다."
docker logs --tail 40 "$API_CONTAINER" 2>&1 | sed 's/^/    /' || true

STAGE="롤백"
if [ -z "$OLD_IMAGE" ]; then
  say "[치명] 되돌아갈 이미지를 모릅니다. 수동 조치가 필요합니다: docker compose logs $API_SERVICE"
  report false "건강검진에 실패했지만 되돌아갈 이미지를 찾지 못했습니다. 수동 확인이 필요합니다." false
  exit 1
fi

say "이전 이미지로 되돌리는 중 … (${OLD_IMAGE:0:19})"
docker compose stop "$API_SERVICE" >/dev/null 2>&1 || true
docker compose rm -f "$API_SERVICE" >/dev/null 2>&1 || true
# compose 설정은 그대로 두고 이미지만 이전 것으로 바꿔 띄운다
if docker run -d --name "$API_CONTAINER" $(docker inspect --format '
  {{- range .HostConfig.Binds}}-v {{.}} {{end}}
  {{- range $p, $c := .NetworkSettings.Ports}}{{range $c}}-p {{.HostPort}}:{{$p}} {{end}}{{end}}
  {{- range .Config.Env}}-e {{.}} {{end}}
  {{- range $n, $v := .NetworkSettings.Networks}}--network {{$n}} {{end}}
  --restart unless-stopped' "$API_CONTAINER" 2>/dev/null) "$OLD_IMAGE" >/dev/null 2>&1; then
  say "이전 이미지로 재기동했습니다."
else
  say "[주의] 이전 이미지 재기동 명령이 실패했습니다 — docker compose up -d $API_SERVICE 로 확인하세요."
fi

ROLLED=false
for i in $(seq 1 30); do
  if curl -fsS -m 3 "$HEALTH_URL" 2>/dev/null | grep -q '"ok":true'; then ROLLED=true; break; fi
  sleep 1
done

if [ "$ROLLED" = true ]; then
  say "롤백 완료 — 이전 버전($OLD_SHA)으로 서비스가 돌아왔습니다."
  report false "새 버전이 건강검진에 실패해 이전 버전($OLD_SHA)으로 되돌렸습니다. 서비스는 정상입니다. 로그를 확인하고 원인을 고친 뒤 다시 배포하세요." true
else
  say "[치명] 롤백 후에도 건강검진에 실패했습니다. 즉시 수동 확인이 필요합니다."
  report false "새 버전이 실패해 롤백했으나 그 뒤에도 건강검진을 통과하지 못했습니다. 즉시 확인이 필요합니다." true
fi
exit 1
