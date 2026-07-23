# 🔁 오라클 클라우드 계정 이전 런북 (같은 도메인 · Cloudflare 유지)

북적북적을 **다른 오라클 클라우드(OCI) 계정/테넌시**로 옮기는 절차입니다.
**Cloudflare 계정·도메인은 그대로 두고** 백엔드(오라클 VM)만 새 계정으로 이전합니다.

```
[사용자] ─https://bookjeok.<도메인>─▶ [Cloudflare(그대로)] ─Tunnel─▶ [새 오라클 VM]
                                                                        └ Docker(API+PostgreSQL) ─▶ 새 블록 볼륨(/mnt/bookjeok-data)
```

- 앱은 완전히 컨테이너화돼 있어 이식은 쉽습니다. 실제 공수는 **① 데이터 이전 ② 비밀키 승계 ③ 터널 컷오버**뿐입니다.
- **실 다운타임 목표: 5~15분** (아래 2단계 컷오버). 파일 40GB 전송은 밤새 벌크로 돌려 공수에서 제외합니다.

---

## ⚠️ 절대 규칙 — 비밀키 그대로 승계

새 서버로 **`.env` 파일을 통째로 복사**하세요. 특히:

| 값 | 바뀌면 생기는 일 |
|---|---|
| **`MASTER_KEY`** | 사용자 비밀번호(`password_enc`)·2단계 인증(`totp_secret`) **복호화 불가** → 비번 열람·기존 TOTP 전부 깨짐 |
| **`JWT_SECRET`** | 기존 로그인 토큰 무효화 → 전원 재로그인(치명적이진 않음) |
| **`DB_PASSWORD`** | 아래 dump/restore 방식이면 새로 정해도 됨(단 새 `.env`·새 DB에 동일하게) |

> DB 데이터는 dump/restore로 옮기고, **비밀키는 파일째 복사**가 가장 안전합니다.

---

## 사전 준비물

**새 OCI 계정**
- 테넌시 OCID, 리전(권장: 기존과 동일 `ap-chuncheon-1`)
- VM 접속용 SSH 공개키
- Always Free 한도 확인(A1 Flex 합계 4 OCU / 24GB 무료)

**기존 서버에서 확보**
- `~/Book-Jeok/.env` (MASTER_KEY·JWT_SECRET 포함)
- `crontab -l` 출력(백업 스케줄)
- Cloudflare 터널: 대시보드 Zero Trust → Networks → Tunnels 에서 **기존 터널 이름/토큰**(같은 터널을 새 서버로 옮겨 붙일 예정)

---

## 1단계 · 자기 전 (서비스 켜둔 채로, 무중단)

### 1-1. 새 계정에 VM + 블록 볼륨
- Ubuntu 22.04, `VM.Standard.A1.Flex` (2 vCPU / 12GB 이상) 인스턴스 생성
- **독립 블록 볼륨**(≥100GB) 생성 → 인스턴스에 연결 → `/mnt/bookjeok-data` 로 마운트 + `/etc/fstab` 등록
  - 자세한 절차는 [oracle-cloud-setup.md](./oracle-cloud-setup.md) 1~2단계 그대로
- 보안: 인바운드는 **SSH(22)만**. 80/443 열 필요 없음(모든 트래픽은 Cloudflare Tunnel 아웃바운드).

### 1-2. Docker · 소스 · 환경파일
```bash
# 새 VM에서
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER    # 재로그인 후 적용

git clone <이 저장소 URL> ~/Book-Jeok
cd ~/Book-Jeok
```
```bash
# 기존 서버 → 새 서버로 .env 복사 (기존값 그대로!)
#   기존 서버에서:
scp ~/Book-Jeok/.env  <새서버>:~/Book-Jeok/.env
```

### 1-3. 파일 40GB 벌크 전송 (밤새)
업로드 파일은 사실상 불변이라 **서비스 켜둔 채 복사해도 안전**합니다.
```bash
# 기존 서버에서 실행 (새 서버로 push). 저장소 파일만 먼저 크게 옮겨둠.
rsync -avz --info=progress2 \
  /mnt/bookjeok-data/storage/  <새서버>:/mnt/bookjeok-data/storage/
```
> DB는 지금 옮기지 않습니다(아침 컷오버 시점에 일관성 있게 덤프).

### 1-4. (선택) 새 서버에서 DB만 미리 기동해 스키마 준비
```bash
cd ~/Book-Jeok
docker compose up -d db     # 빈 DB 초기화만. 데이터는 아침에 복원.
```

---

## 2단계 · 아침 컷오버 (여기만 다운타임, 5~15분)

### 2-1. 증분 rsync (밤새 바뀐 것만)
```bash
# 기존 서버에서
rsync -avz --delete --info=progress2 \
  /mnt/bookjeok-data/storage/  <새서버>:/mnt/bookjeok-data/storage/
```

### 2-2. DB 덤프 → 복원 (일관성 위해 이 시점)
```bash
# 기존 서버: 덤프
docker exec bookjeok-db pg_dump -U bookjeok --clean --if-exists bookjeok | gzip > /tmp/bookjeok.sql.gz
scp /tmp/bookjeok.sql.gz  <새서버>:/tmp/

# 새 서버: 복원 (db 컨테이너가 떠 있어야 함)
cd ~/Book-Jeok && docker compose up -d db
gunzip -c /tmp/bookjeok.sql.gz | docker exec -i bookjeok-db psql -U bookjeok -q bookjeok
```

### 2-3. 앱 기동 + 헬스체크
```bash
cd ~/Book-Jeok
docker compose up -d --build
curl -fsS http://127.0.0.1:4000/api/health && echo "  ← OK"
docker compose logs --tail=30 api    # init-db 마이그레이션(0001~0003) 적용 확인
```

### 2-4. Cloudflare 터널을 새 서버로 전환
Cloudflare 계정이 그대로이므로 **DNS는 손대지 않습니다.** 같은 터널을 새 서버에 붙이면 즉시 전환됩니다.
```bash
# 새 서버에 cloudflared 설치 후, 기존 터널 토큰으로 커넥터 실행/등록
#   (대시보드: Zero Trust → Networks → Tunnels → 해당 터널 → Install connector 명령 복사)
sudo cloudflared service install <터널토큰>
```
- 새 커넥터가 붙으면 트래픽이 새 서버로 넘어갑니다.
- **검증 후** 기존 서버의 `cloudflared`를 내리면(`sudo systemctl stop cloudflared`) 완전히 새 서버로 이관됩니다.
- 라우팅(퍼블릭 호스트명 → `http://localhost:4000`)은 터널 설정에 이미 있으니 그대로 유지됩니다.

### 2-5. 컷오버 검증 체크리스트
- [ ] `https://bookjeok.<도메인>` 접속 · 로그인
- [ ] 파일 업로드 / 다운로드 / 미리보기
- [ ] **관리자 → 계정 → 🔑 비밀번호 열람**이 정상(= MASTER_KEY 승계 성공)
- [ ] 2단계 인증(TOTP) 로그인 정상
- [ ] 재고조사 오차체크(영업점) 동작
- [ ] 최근 업로드/수정 파일이 그대로 보임(증분 sync 확인)

---

## 3단계 · 백업 재설정 (새 계정 기준 재발급 — 앱과 무관)

Cloudflare는 그대로지만 **백업은 새 OCI 계정 리소스**라 새로 붙여야 합니다.

### 3-1. DB 오프사이트 백업 (오브젝트 스토리지 PAR)
- 새 계정에 **오브젝트 스토리지 버킷** 생성 → **PAR(Pre-Authenticated Request, 쓰기 허용, 오브젝트 prefix)** 발급
- 새 서버 `~/.bookjeok-backup.env` 에:
  ```bash
  BOOKJEOK_BACKUP_PAR="https://objectstorage.<region>.oraclecloud.com/p/<...>/n/<ns>/b/<bucket>/o/"
  ```
- 스크립트: `scripts/bookjeok-backup.sh` (로컬 `~/bookjeok-backups` + PAR 업로드, 상태를 앱 '백업' 탭에 기록)

### 3-2. 파일 볼륨 증분 백업 (OCI CLI)
- 새 서버에 OCI CLI 설치(`~/bin/oci`) + **새 테넌시 API 키**로 `~/.oci/config` 구성
- 새 블록 볼륨의 **표시 이름을 `bookjeok-data`** 로 맞춰야 스크립트가 찾습니다(스크립트가 `display-name == 'bookjeok-data'` 로 조회)
- 스크립트: `scripts/bookjeok-files-backup.sh` (증분 볼륨 백업 + 35일 이전 정리)

### 3-3. cron 재등록
```bash
crontab -e
# DB 매일 03:00
0 3 * * *  /home/ubuntu/Book-Jeok/scripts/bookjeok-backup.sh >> /home/ubuntu/bookjeok-backup.log 2>&1
# 파일 볼륨 매주 일 04:00
0 4 * * 0  /home/ubuntu/Book-Jeok/scripts/bookjeok-files-backup.sh >> /home/ubuntu/bookjeok-files-backup.log 2>&1
```
- 복원이 필요하면(DB) 터미널에서 `scripts/restore.sh` (백업 목록에서 골라 복원, 복원 전 자동 백업).

---

## 4단계 · 마무리
- 백업 1회 **수동 실행**해 정상 동작·오프사이트 업로드 확인:
  `~/Book-Jeok/scripts/bookjeok-backup.sh`
- 기존 서버는 **며칠 관망 후** 종료/삭제(문제 시 롤백 여지 확보). 기존 `.env`·마지막 DB 덤프는 안전한 곳에 별도 보관.
- 관망 기간 동안 기존 서버가 다시 트래픽을 받지 않도록 `cloudflared`는 반드시 내려둘 것.

---

## 공수 요약 (Cloudflare 유지 · 40GB · 밤새 전송 기준)
| 구간 | 소요 |
|---|---|
| 1단계(VM/볼륨/도커/.env/벌크 rsync 시작) | 1~1.5h 작업 + 밤새 전송 |
| 2단계(증분 sync + DB 복원 + 기동 + 터널 전환 + 검증) | **다운타임 5~15분** 포함 30~60분 |
| 3단계(백업 재발급 + cron) | 30~45분 |
| **합계(관망 제외)** | **반나절 이내** |

## 자주 하는 실수(피하기)
- ❌ 새로 `openssl rand`로 MASTER_KEY 재생성 → 비번/TOTP 깨짐. **기존값 복사만.**
- ❌ pgdata 디렉터리를 raw로 복사(Postgres 버전/권한 이슈). → **pg_dump/restore 권장.**
- ❌ 새 볼륨 이름을 다르게 지정 → 파일 백업 스크립트가 볼륨 못 찾음. **`bookjeok-data`로.**
- ❌ 기존 서버 cloudflared를 안 내림 → 두 서버가 같은 도메인에 붙어 트래픽이 오락가락.
