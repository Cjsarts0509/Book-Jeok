#!/usr/bin/env bash
# 북적북적 대량 파일 이관 스크립트
# 로컬 디렉터리(예: FTP에서 내려받은 폴더)의 모든 파일을 북적북적 계정으로 업로드합니다.
# 폴더 구조를 그대로 유지하며, 이름 충돌 시 자동으로 번호가 붙습니다.
#
# 사용법:
#   ADMIN_PASS='관리자비번' OWNER_ID=3 SRC=/mnt/bookjeok-data/_import ./scripts/import-files.sh
#
# 대상 계정 id(OWNER_ID)를 모르면, 먼저 계정 목록을 확인:
#   ADMIN_PASS='관리자비번' ./scripts/import-files.sh --list
set -u

API="${API:-http://localhost:4000}"     # 같은 서버면 localhost 직결이 가장 빠름
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-}"

if [ -z "$ADMIN_PASS" ]; then read -rsp "관리자($ADMIN_USER) 비밀번호: " ADMIN_PASS; echo; fi

TOKEN=$(curl -s -X POST "$API/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}" \
  | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("token",""))
except: print("")')
if [ -z "$TOKEN" ]; then echo "❌ 로그인 실패 (비밀번호 확인)"; exit 1; fi

# 계정 목록만 보고 종료
if [ "${1:-}" = "--list" ]; then
  echo "== 계정 목록 (id  아이디  권한) =="
  curl -s "$API/api/admin/users" -H "Authorization: Bearer $TOKEN" \
    | python3 -c 'import sys,json
for u in json.load(sys.stdin)["users"]: print(u["id"], u["username"], u["role"])'
  exit 0
fi

OWNER_ID="${OWNER_ID:-}"
SRC="${SRC:-}"
if [ -z "$OWNER_ID" ] || [ -z "$SRC" ]; then
  echo "OWNER_ID 와 SRC 를 지정하세요. 예:"
  echo "  ADMIN_PASS='...' OWNER_ID=3 SRC=/mnt/bookjeok-data/_import $0"
  echo "대상 계정 id 확인: ADMIN_PASS='...' $0 --list"
  exit 1
fi
[ -d "$SRC" ] || { echo "❌ 원본 폴더가 없습니다: $SRC"; exit 1; }

echo "▶ 업로드 시작: $SRC → 계정 #$OWNER_ID ($API)"
ok=0; fail=0; failed_list=""
cd "$SRC" || exit 1
while IFS= read -r -d '' f; do
  rel="${f#./}"
  dir="/$(dirname "$rel")"; [ "$dir" = "/." ] && dir="/"
  code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/api/files/upload?ownerId=$OWNER_ID" \
    -H "Authorization: Bearer $TOKEN" -F "folder=$dir" -F "file=@${f}")
  if [ "$code" = "201" ]; then
    ok=$((ok+1)); printf "\r  올림: %d개  실패: %d개   " "$ok" "$fail"
  else
    fail=$((fail+1)); failed_list="${failed_list}\n  [$code] $rel"
  fi
done < <(find . -type f -print0)

echo
echo "── 완료: 성공 $ok개, 실패 $fail개 ──"
if [ "$fail" -gt 0 ]; then
  echo "실패 목록 (415=확장자 불허, 413=용량초과):"
  printf "%b\n" "$failed_list"
fi
