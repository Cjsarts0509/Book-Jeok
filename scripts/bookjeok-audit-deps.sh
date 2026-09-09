#!/usr/bin/env bash
# 북적북적 의존성 취약점 점검 (S26)
#
# npm audit 을 정기적으로 돌려, 우리가 쓰는 패키지에 새로 공개된 취약점이 있는지 확인한다.
# 결과는 앱이 읽는 위치(_status/checkups/deps.json)에 남겨 관리자 '점검' 탭에 뜬다.
#
# 운영 의존성만 본다(--omit=dev) — 개발 도구의 취약점은 서비스 표면이 아니다.
# 네트워크가 필요하다(레지스트리 조회). 나가는 연결이 막힌 환경이면 결과에 사유가 남는다.
#
# 사용:  ./bookjeok-audit-deps.sh
# 크론:  0 6 * * 1 /home/ubuntu/Book-Jeok/scripts/bookjeok-audit-deps.sh >> /var/log/bookjeok-deps.log 2>&1
set -uo pipefail

REPO_DIR="${BOOKJEOK_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BACKEND_DIR="$REPO_DIR/backend"
API_CONTAINER="${API_CONTAINER:-bookjeok-api}"

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
push() { printf '%s' "$1" | docker exec -i "$API_CONTAINER" sh -c 'mkdir -p /data/storage/_status/checkups && cat > /data/storage/_status/checkups/deps.json' 2>/dev/null || true; }

echo "$(date '+%F %T') 의존성 취약점 점검 시작 — $BACKEND_DIR"

if ! command -v npm >/dev/null 2>&1; then
  echo "$(date '+%F %T') [건너뜀] npm 이 없습니다" >&2
  push "{\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"ok\":false,\"error\":\"이 서버에 npm 이 설치되어 있지 않습니다.\",\"vulnerabilities\":{}}"
  exit 1
fi
if [ ! -f "$BACKEND_DIR/package-lock.json" ]; then
  echo "$(date '+%F %T') [건너뜀] package-lock.json 이 없습니다" >&2
  push "{\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"ok\":false,\"error\":\"package-lock.json 을 찾지 못했습니다.\",\"vulnerabilities\":{}}"
  exit 1
fi

RAW="$(cd "$BACKEND_DIR" && npm audit --omit=dev --json 2>/dev/null)"
# npm audit 은 취약점이 있으면 종료코드가 0이 아니다 — 출력이 JSON 이면 정상 동작으로 본다
if [ -z "$RAW" ] || ! printf '%s' "$RAW" | head -c 1 | grep -q '{'; then
  echo "$(date '+%F %T') [실패] npm audit 을 실행하지 못했습니다(네트워크 차단일 수 있음)" >&2
  push "{\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"ok\":false,\"error\":\"npm audit 실행에 실패했습니다. 레지스트리로 나가는 네트워크가 막혀 있는지 확인하세요.\",\"vulnerabilities\":{}}"
  exit 1
fi

# npm audit --json 을 화면에 필요한 만큼만 추린다(원본은 수백 KB 가 되기도 한다)
SUMMARY="$(printf '%s' "$RAW" | node -e '
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  let a; try { a = JSON.parse(s); } catch { console.log(JSON.stringify({ at: new Date().toISOString(), ok: false, error: "npm audit 출력을 해석하지 못했습니다", vulnerabilities: {} })); return; }
  const meta = (a.metadata && a.metadata.vulnerabilities) || {};
  const rows = Object.entries(a.vulnerabilities || {}).map(([name, v]) => ({
    name,
    severity: v.severity,
    range: v.range || "",
    direct: !!v.isDirect,
    fixAvailable: v.fixAvailable === true ? "있음" : (v.fixAvailable && v.fixAvailable.name ? `${v.fixAvailable.name}@${v.fixAvailable.version}` : "없음"),
    via: [...new Set((v.via || []).map((x) => (typeof x === "string" ? x : x.title || x.name)).filter(Boolean))].slice(0, 3),
  }));
  const rank = { critical: 0, high: 1, moderate: 2, low: 3, info: 4 };
  rows.sort((x, y) => (rank[x.severity] ?? 9) - (rank[y.severity] ?? 9) || x.name.localeCompare(y.name));
  const total = (meta.critical || 0) + (meta.high || 0) + (meta.moderate || 0) + (meta.low || 0);
  console.log(JSON.stringify({
    at: new Date().toISOString(),
    ok: (meta.critical || 0) + (meta.high || 0) === 0,
    vulnerabilities: meta, total,
    packages: rows.slice(0, 60),
    note: "critical·high 가 있으면 우선 조치 대상입니다. `npm audit fix` 로 고쳐지는지 먼저 확인하세요.",
  }));
});')"

push "$SUMMARY"
printf '%s' "$SUMMARY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);const m=a.vulnerabilities||{};console.log(`  critical ${m.critical||0} · high ${m.high||0} · moderate ${m.moderate||0} · low ${m.low||0}`);});'
echo "$(date '+%F %T') 점검 완료"
