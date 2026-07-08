<div align="center">
  <img src="frontend/assets/logo.svg" width="96" alt="북적북적">
  <h1>북적북적 · Book-Jeok</h1>
  <p>우리끼리 나누는 따뜻한 파일 창고 — 계정별 격리 웹하드</p>
</div>

---

## ✨ 핵심 기능
1. **계정별 격리 웹하드** — 각자 본인 파일만 업로드/다운로드/열람. 관리자·특정 계정은 전체 열람·업로드 가능
2. **철저한 보안** — bcrypt 인증, JWT, 레이트리밋, helmet, 경로순회 방지, 감사 로그 ([상세](docs/security.md))
3. **관리자 페이지** — 계정 발급, 본인/타 계정 비밀번호 변경, **관리자의 비밀번호 열람**
4. **FileBrowser 개념 계승** — 계정 스코프 격리 방식 ([선택 이유](docs/filebrowser.md))
5. **PC·모바일 별도 UI/UX** — PC는 사이드바, 모바일은 하단 탭 + 플로팅 업로드 버튼
6. **브랜딩** — 사이트명 "북적북적", 머스타드 옐로우 포인트 컬러
7. **오라클 클라우드 독립 디스크 DB** — DB·파일 저장을 독립 블록 볼륨에, 관리자 페이지에서 DB 상태 확인
8. **따뜻한 디자인 시스템** — 지정 팔레트·Pretendard/Inter·둥근 모서리·호버 애니메이션

## 🏗️ 아키텍처
```
[사용자] ── Cloudflare (TLS·WAF·Tunnel) ──▶ [오라클 클라우드 VM]
                                              ├─ Node/Express API (:4000)
                                              ├─ PostgreSQL  ─┐
                                              └─ 파일 저장소  ─┴─▶ 독립 블록 볼륨
                                                                 (/mnt/bookjeok-data)
프런트엔드: 정적 SPA (API 서버 동시 서빙 또는 Cloudflare Pages 분리 배포)
```

## 📁 구조
```
Book-Jeok/
├─ backend/          Node.js + Express + PostgreSQL API
│  ├─ src/
│  │  ├─ server.js          앱 진입점 / 미들웨어
│  │  ├─ routes/            auth · files · admin
│  │  ├─ middleware/auth.js JWT 인증·권한
│  │  ├─ crypto.js          bcrypt + AES-256-GCM
│  │  ├─ db.js / initDb.js  DB 풀·스키마·상태
│  │  └─ seedAdmin.js       최초 관리자 생성
│  └─ Dockerfile
├─ frontend/         반응형 SPA (PC/모바일 분기)
│  ├─ index.html · admin.html
│  ├─ config.js            백엔드 API 주소 (분리 배포 시 이 파일만 편집)
│  ├─ css/style.css         디자인 시스템
│  └─ js/                   api · app · admin · common
├─ deploy/           cloudflared · nginx 설정
├─ docs/             배포 런북 · 오라클/클라우드플레어/보안/FileBrowser 가이드
└─ docker-compose.yml
```

## 🚀 빠른 시작 (로컬)
```bash
git clone https://github.com/Cjsarts0509/Book-Jeok.git
cd Book-Jeok
cp .env.example .env

# 보안 키 생성해서 .env 의 JWT_SECRET / MASTER_KEY 에 붙여넣기
openssl rand -hex 32
openssl rand -hex 32

# Docker 로 한 번에 (DB + API + 프런트)
docker compose up -d --build

# 최초 관리자 비밀번호 확인
docker compose logs api | grep -A5 seed-admin
# → http://localhost:4000  접속, admin 계정으로 로그인
```

### Docker 없이 백엔드만 개발
```bash
cd backend && npm install
cp .env.example .env   # DB 접속정보·키 채우기 (로컬 PostgreSQL 필요)
npm run init-db && npm run seed-admin
npm run dev            # http://localhost:4000
# 프런트는 frontend/ 를 정적 서버로 열거나 SERVE_FRONTEND=1
```

## ☁️ 배포
- **⭐ 실전 배포 런북 (프런트=Pages · 백엔드=오라클+Tunnel)**: [docs/deployment-runbook.md](docs/deployment-runbook.md)
- 오라클 클라우드 + 독립 디스크 구성: [docs/oracle-cloud-setup.md](docs/oracle-cloud-setup.md)
- Cloudflare (Tunnel / Pages): [docs/cloudflare-setup.md](docs/cloudflare-setup.md)

## 🔑 기본 사용 흐름
1. 관리자 로그인 → **관리자 → 계정 관리**에서 계정 발급 (초기 비밀번호 자동 생성·표시)
2. 발급받은 사용자는 로그인 후 본인 창고에 업로드/다운로드, 비밀번호 변경 가능
3. 관리자는 **📁 열람**으로 특정 계정의 파일을 대신 보고 업로드, **🔑 암호**로 비밀번호 열람/재설정
4. **DB 상태** 탭에서 연결·크기·테이블 행수 확인, **감사 로그**에서 활동 추적

## 🎨 디자인 토큰
| 용도 | 색상 |
|---|---|
| Primary (포인트) | `#FFD166` 머스타드 옐로우 |
| Secondary | `#118AB2` 오션 블루 |
| Accent | `#06D6A0` 민트 그린 |
| 배경 / 텍스트 | `#F8F9FA` / `#343A40` |
| Hover | `#FFF9E6` |

폰트: 한글 **Pretendard**, 숫자/영문 **Inter/Nunito** · 모서리 8–12px · 호버 시 부드러운 상승 애니메이션

## ⚠️ 참고
- `admin`이 비밀번호를 열람할 수 있는 것은 요구사항이며, 보안 절충안(AES 암호화 + 감사 로그)으로
  구현했습니다. 트레이드오프와 대안은 [docs/security.md](docs/security.md) 를 꼭 읽어주세요.
- 프로덕션 전 반드시 `JWT_SECRET`, `MASTER_KEY`, `DB_PASSWORD` 를 강력한 값으로 교체하세요.
