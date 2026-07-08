# 🚀 실전 배포 런북 (프런트=Cloudflare Pages · 백엔드=오라클 클라우드)

당신의 구성에 딱 맞춘 **순서대로 따라 하는** 배포 가이드입니다.

```
[사용자 브라우저]
   │  https://book-jeok.example.com          (프런트, Cloudflare Pages ← GitHub)
   │  https://api.book-jeok.example.com       (API, Cloudflare Tunnel ← 오라클 VM)
   ▼
[Cloudflare]  ──Tunnel──▶  [오라클 VM]  ─▶ Docker(API + PostgreSQL) ─▶ 독립 블록 볼륨
```

준비물: ✅ 오라클 클라우드 계정 ✅ Cloudflare 계정 ✅ 도메인(Cloudflare에 등록) ✅ GitHub 저장소

> 도메인이 아직 없다면: Cloudflare에서 도메인을 등록/이전하거나, 우선
> `*.pages.dev`(프런트)와 `*.trycloudflare.com`(임시 터널)로 테스트할 수 있습니다.
> 정식 운영에는 본인 도메인을 Cloudflare에 연결하는 것을 권장합니다.

---

## 파트 1 · 오라클 클라우드에 백엔드 올리기

### 1-1. VM + 독립 디스크 준비
[oracle-cloud-setup.md](./oracle-cloud-setup.md) 의 **1~2단계**를 먼저 수행하세요.
요약:
- Ubuntu 22.04 인스턴스 생성 (Always Free `VM.Standard.A1.Flex` 권장)
- 100GB 블록 볼륨을 만들어 인스턴스에 연결 → `/mnt/bookjeok-data` 로 마운트 (fstab 등록)

### 1-2. Docker 설치 & 소스 배치
```bash
sudo apt update && sudo apt install -y docker.io docker-compose-plugin
sudo usermod -aG docker $USER && newgrp docker

git clone https://github.com/Cjsarts0509/Book-Jeok.git
cd Book-Jeok
```

### 1-3. 환경변수 & 보안키
```bash
cp .env.example .env

# 보안키 2개 생성 (각 줄의 출력값을 복사)
echo "JWT_SECRET=$(openssl rand -hex 32)"
echo "MASTER_KEY=$(openssl rand -hex 32)"

nano .env
```
`.env` 에서 반드시 채울 값:
```ini
DATA_ROOT=/mnt/bookjeok-data          # 독립 디스크 마운트 지점
DB_PASSWORD=아주_강력한_DB_비밀번호
SERVE_FRONTEND=0                      # ★ 분리 배포이므로 0
JWT_SECRET=위에서_생성한_값
MASTER_KEY=위에서_생성한_값
CORS_ORIGINS=https://book-jeok.example.com   # ★ 프런트(Pages) 도메인
SUPER_ADMINS=admin
ADMIN_PASSWORD=초기_관리자_비밀번호   # 비우면 자동 생성 후 로그에 출력
```

### 1-4. 기동
```bash
docker compose up -d --build

# 최초 관리자 비밀번호 확인 (ADMIN_PASSWORD를 비웠을 경우)
docker compose logs api | grep -A5 seed-admin

# 헬스체크 (로컬)
curl -s localhost:4000/api/health
```
컨테이너가 시작될 때 스키마 생성(init-db)과 관리자 계정(seed-admin)이 자동 수행됩니다.

### 1-5. Cloudflare Tunnel 로 API 노출 (포트 개방 불필요)
```bash
# cloudflared 설치
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb -o cf.deb
sudo dpkg -i cf.deb        # (x86 VM이면 amd64 파일로)

cloudflared tunnel login                       # 브라우저에서 도메인 인증
cloudflared tunnel create book-jeok            # → Tunnel ID + 자격증명 json 생성
cloudflared tunnel route dns book-jeok api.book-jeok.example.com
```
`/etc/cloudflared/config.yml` 작성 (레포의 `deploy/cloudflared-config.yml` 참고):
```yaml
tunnel: <TUNNEL_ID>
credentials-file: /etc/cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: api.book-jeok.example.com
    service: http://127.0.0.1:4000
  - service: http_status:404
```
서비스 등록 & 시작:
```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared   # active(running) 확인
```
확인: 브라우저에서 `https://api.book-jeok.example.com/api/health` → `{"ok":true,...}`

---

## 파트 2 · Cloudflare Pages 에 프런트 올리기 (GitHub 연동)

### 2-1. API 주소 설정 커밋
`frontend/config.js` 를 백엔드 주소로 수정:
```js
window.BOOKJEOK_API = "https://api.book-jeok.example.com";
```
```bash
git add frontend/config.js
git commit -m "chore: 배포용 백엔드 API 주소 설정"
git push
```

### 2-2. Cloudflare Pages 프로젝트 생성 (대시보드)
1. Cloudflare 대시보드 → **Workers & Pages → Create → Pages → Connect to Git**
2. `Cjsarts0509/Book-Jeok` 저장소 선택
3. 빌드 설정:
   - **Framework preset**: `None`
   - **Build command**: (비움)
   - **Build output directory**: `frontend`
   - **Root directory**: (비움, 기본)
4. **Save and Deploy** → 몇 초 뒤 `https://book-jeok.pages.dev` 로 배포 완료
   - 이후 `main` 에 push 할 때마다 **자동 재배포**됩니다.

### 2-3. 커스텀 도메인 연결
Pages 프로젝트 → **Custom domains → Set up a domain** → `book-jeok.example.com` 추가
(Cloudflare가 DNS를 자동 구성)

### 2-4. CORS 최종 확인
`book-jeok.example.com` 로 접속했을 때 로그인이 되면 성공입니다.
만약 콘솔에 CORS 오류가 뜨면, 오라클 `.env` 의 `CORS_ORIGINS` 에 실제 프런트 도메인이
정확히 들어갔는지 확인하고 백엔드를 재시작하세요:
```bash
nano .env    # CORS_ORIGINS 수정
docker compose up -d
```

---

## 파트 3 · 배포 후 보안 마무리 (권장)
- Cloudflare → **SSL/TLS → Full (strict)**, **Always Use HTTPS** 켜기
- **관리자 페이지 보호**: Cloudflare **Zero Trust → Access → Applications** 에서
  `book-jeok.example.com/admin.html` 경로에 이메일 OTP 정책 추가
- **WAF / Bot Fight Mode** 활성화
- 오라클 방화벽: SSH(22) 외 인바운드 전부 차단 (Tunnel은 아웃바운드만 사용)
- 정기 백업:
  ```bash
  # cron 예: 매일 새벽 3시 DB 덤프
  0 3 * * * docker exec bookjeok-db pg_dump -U bookjeok bookjeok | gzip > /mnt/bookjeok-data/backup/db_$(date +\%F).sql.gz
  ```

---

## 자주 겪는 문제
| 증상 | 원인 / 해결 |
|---|---|
| 프런트에서 로그인 시 CORS 오류 | `.env` 의 `CORS_ORIGINS` 를 프런트 도메인과 정확히 일치시키고 `docker compose up -d` |
| `api/health` 접속 안 됨 | `systemctl status cloudflared` 확인, `ingress` hostname/포트 확인 |
| 업로드 100MB 초과 실패 | Tunnel 경유는 무제한. Pages 프록시가 아닌 **API 도메인 직접** 호출인지 확인(config.js) |
| 관리자 비밀번호 분실 | `docker compose exec api node src/seedAdmin.js` 는 이미 있으면 건너뜀 → DB에서 직접 재설정 또는 새 관리자 발급 |
| DB 상태 페이지 오류 | 컨테이너 `db` 헬스체크 및 `.env` DB 접속정보 확인 |

막히는 지점이 있으면 해당 단계 번호와 오류 메시지를 알려주세요. 바로 도와드리겠습니다.
