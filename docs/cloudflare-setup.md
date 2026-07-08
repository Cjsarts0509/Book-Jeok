# Cloudflare 배포 가이드

두 가지 배포 형태를 지원합니다. 상황에 맞게 선택하세요.

---

## 형태 A — 올인원 (권장, 가장 단순)
프런트+백엔드를 오라클 VM 한 곳에서 서빙하고, Cloudflare Tunnel 로 노출.

1. `.env` 에서 `SERVE_FRONTEND=1` (기본값)
2. cloudflared 설치 & 터널 생성:
   ```bash
   # 설치 (Ubuntu)
   curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cf.deb
   sudo dpkg -i cf.deb

   cloudflared tunnel login
   cloudflared tunnel create book-jeok
   cloudflared tunnel route dns book-jeok book-jeok.example.com
   ```
3. `deploy/cloudflared-config.yml` 를 `/etc/cloudflared/config.yml` 로 복사하고
   `<TUNNEL_ID>` 를 채운 뒤:
   ```bash
   sudo cloudflared service install
   sudo systemctl restart cloudflared
   ```
4. 끝. `https://book-jeok.example.com` 로 접속됩니다.
   포트 개방 없이 Cloudflare 가 TLS·DDoS 방어까지 처리합니다.

---

## 형태 B — 분리 배포 (프런트=CF Pages, 백엔드=오라클 터널)
정적 프런트는 Cloudflare 엣지에서, API 만 오라클에서.

1. `.env` 에서 `SERVE_FRONTEND=0`, `CORS_ORIGINS` 에 Pages 도메인 추가
   (예: `https://book-jeok.pages.dev`)
2. 백엔드는 `api.book-jeok.example.com` 서브도메인으로 터널
   (`cloudflared-config.yml` 의 주석 처리된 hostname 사용)
3. `frontend/config.js` 의 `window.BOOKJEOK_API` 를 백엔드 주소로 설정 후 커밋
   (예: `https://api.book-jeok.example.com`)
4. Cloudflare 대시보드 → **Workers & Pages → Create → Pages → Connect to Git**
   으로 저장소를 연결하고 Build output directory 를 `frontend` 로 지정하면,
   `main` 에 push 할 때마다 자동 배포됩니다.

> 상세 단계는 [deployment-runbook.md](./deployment-runbook.md) 파트 2를 참고하세요.

---

## 보안 권장 (공통)
- Cloudflare 대시보드 → **SSL/TLS → Full (strict)**
- **WAF** 규칙 활성화, Bot Fight Mode 켜기
- 관리자 페이지 경로(`/admin.html`)에 **Cloudflare Access** 로 2차 인증(이메일 OTP 등)을
  걸면 더욱 안전합니다.
- 업로드 대용량 대비: Cloudflare 무료 플랜은 100MB 업로드 제한이 있으므로,
  100MB 초과 파일을 다루려면 **형태 A + Tunnel**(무제한) 을 쓰거나 유료 플랜을 고려하세요.
