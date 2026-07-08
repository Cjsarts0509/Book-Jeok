/* ─────────────────────────────────────────────────────────────
   북적북적 프런트엔드 설정
   분리 배포(프런트=Cloudflare Pages, 백엔드=오라클) 시 이 값만 바꾸면 됩니다.

   - 백엔드를 Cloudflare Tunnel 로 노출한 주소를 넣으세요.
     예) "https://api.book-jeok.example.com"
   - 프런트+백엔드를 한 서버에서 함께 서빙(SERVE_FRONTEND=1)한다면 "" 로 두세요.
   ───────────────────────────────────────────────────────────── */
window.BOOKJEOK_API = "https://bookjeok-api.cjs0509.xyz";
