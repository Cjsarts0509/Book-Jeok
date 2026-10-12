/* ─────────────────────────────────────────────────────────────
   북적북적 프런트엔드 설정 — 화면을 어디서 열었느냐에 따라 API 주소를 고른다.

   - Cloudflare Pages 로 연 화면(bookjeok.cjs0509.xyz · *.pages.dev)
       → 터널로 노출한 API 주소를 부른다(주소가 달라 브라우저가 매 요청 CORS 확인을 한다).
   - 그 밖의 주소(서버가 화면까지 함께 보내는 경우, SERVE_FRONTEND=1)
       → 같은 주소의 /api 를 부른다("" = 같은 출처). 예: kr.cjs0509.xyz
         KT 인터넷이 Cloudflare 무료 대역으로 갈 때 해외로 돌아가는 문제를 피하려고
         서울 입구로 고정한 주소다. 같은 출처라 CORS 확인 요청도 없다.

   새 Pages 주소를 쓰게 되면 PAGES_HOSTS 에 추가하세요.
   ───────────────────────────────────────────────────────────── */
(function () {
  var API_ON_TUNNEL = "https://bookjeok-api.cjs0509.xyz";
  var PAGES_HOSTS = ["bookjeok.cjs0509.xyz"];
  var h = (location.hostname || "").toLowerCase();
  var onPages = PAGES_HOSTS.indexOf(h) !== -1 || /\.pages\.dev$/.test(h);
  window.BOOKJEOK_API = onPages ? API_ON_TUNNEL : "";
})();
