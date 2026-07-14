<div align="center">
  <img src="frontend/assets/logo.svg" width="96" alt="북적북적">
  <h1>북적북적 · Book-Jeok</h1>
  <p>우리끼리 나누는 따뜻한 파일 창고 — 계정별 격리 웹하드</p>
</div>

---

## 📊 현재 운영 스펙 (Live)

> 교보문고 영업점(~40개) 파일 수집용. 파일 명명 `지점명_날짜` → `/연도/지점명` 자동분류.

**인프라**
| 항목 | 내용 |
|---|---|
| 접속 | `bookjeok.cjs0509.xyz` (Cloudflare Tunnel, 인바운드 개방 없음) |
| 호스팅 | Oracle Cloud VM · ARM Ampere A1 · 리전 `ap-chuncheon-1` |
| 사양 | 2 vCPU / 12GB RAM · 블록볼륨 99GB(사용 15GB) |
| 구성 | Docker Compose `bookjeok-db`(PostgreSQL 16) + `bookjeok-api`(Node/Express) · 둘 다 `127.0.0.1` 바인딩 |
| 컨테이너 보호 | api `mem_limit 4g`·db `3g` · 로그회전(10m×5) · 헬스체크 · graceful shutdown |
| 배포 | `git pull && docker compose up -d --build` (프론트 ro 마운트) |

**데이터 / 역할**
| 항목 | 내용 |
|---|---|
| DB | 11MB (계정·메타·폴더·태그·공유·알림·감사로그) |
| 파일 | 15GB |
| 역할 | `admin`(전체관리) · `manager`(담당자: 사용자 파일 열람·업로드) · `user`(본인만) |
| 허용 확장자 | csv·xls·xlsx·xlsm·xlsb·jpg·jpeg·png·gif·ppt·pptx·doc·docx·txt |

**백업 (자동화)**
| 대상 | 주기 | 저장 | 검증 |
|---|---|---|---|
| DB (11MB) | 매일 03:00 | OCI 오브젝트 스토리지(원격) + 로컬 · 14일 보관 | ✅ 복구 테스트 통과 |
| 파일 (15GB) | 매주 일 04:00 | OCI 증분 볼륨 백업 · 35일 보관 | ✅ |

**성능 (실측)** — 자세한 공유본은 별도. 2코어/12GB로 40개 영업점 운영에 여유 충분.
| 시나리오 | 동시 | p95 | 실패 |
|---|---|---|---|
| 열람(`/health`) | 300명 | 1.9ms | 0% |
| 로그인+목록(DB) | 60명 | 9.6ms | 0% |
| 업로드 | 15명 | 29ms (CPU 24%) | 0% |

**보안 요약** — bcrypt·JWT(8h)·2FA(TOTP, 관리자 필수)·helmet·레이트리밋(300/분)·AES-256-GCM·시크릿 fail-closed·경로순회 방지·SQL 파라미터화·XSS 이스케이프·감사로그·업로드 매직바이트+YARA 검사. ([상세](docs/security.md))

---

## ✨ 핵심 기능
1. **계정별 격리 웹하드** — 각자 본인 파일만 업로드/다운로드/열람. 관리자·담당자는 타 계정 열람·업로드 가능
2. **철저한 보안** — bcrypt 인증, JWT, 레이트리밋, helmet, 경로순회 방지, 감사 로그 ([상세](docs/security.md))
3. **관리자 페이지** — 계정 발급, 본인/타 계정 비밀번호 변경, **관리자의 비밀번호 열람**
4. **FileBrowser 개념 계승** — 계정 스코프 격리 방식 ([선택 이유](docs/filebrowser.md))
5. **PC·모바일 별도 UI/UX** — PC는 폴더 트리 사이드바, 모바일은 트리 드로어 + 아이콘 상단바
6. **브랜딩** — 사이트명 "북적북적", 머스타드 옐로우 포인트 컬러, 폴더+책 파비콘
7. **오라클 클라우드 독립 디스크 DB** — DB·파일 저장을 독립 블록 볼륨에, 관리자 페이지에서 DB 상태 확인
8. **따뜻한 디자인 시스템** — 지정 팔레트·Pretendard/Inter·둥근 모서리·호버 애니메이션

### 파일 관리 기능
- **폴더 트리** — 좌측 사이드바에 폴더 계층 표시, 상단바로 메뉴 이동
- **두 가지 뷰** — 미리보기(그리드) / 리스트 전환
- **리스트 선택 작업** — 선택 삭제·폴더 이동·이름 변경
- **비고(메모)** — 파일별 설명 + 업로드/비고수정 날짜 저장
- **공유 링크** — 난수 토큰 기반 다운로드 링크 생성(만료 설정 가능, 인증 불필요)
- **업로드 제한** — csv·xls·xlsx·jpg·png·gif·ppt·pptx·doc·docx 만 허용
- **지점파일 자동분류** — `xxx점_yyyymmdd` 파일을 `/yyyy/xxx점` 폴더로 자동 정리(폴더 자동 생성)
- **담당자(manager) 권한** — 관리자와 일반의 중간. 일반 사용자 파일 전체 열람·업로드 가능, 관리 기능만 불가

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
