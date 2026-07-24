# 🟠 오라클 클라우드(OCI) 서버 세팅 — 처음부터 끝까지

북적북적 백엔드(API + PostgreSQL)를 **오라클 클라우드 VM**에 올리는 전 과정입니다.
콘솔 클릭 순서 + 서버 명령을 **그대로 따라 하면 되는** 수준으로 정리했습니다.
계정 이전(다른 OCI 계정으로 옮기기)이라면 [oci-migration.md](./oci-migration.md)를 함께 보세요.

**최종 그림**
```
[사용자] ─https─▶ [Cloudflare(터널)] ─▶ [오라클 VM] ─▶ Docker(API+PostgreSQL) ─▶ 독립 블록 볼륨 /mnt/bookjeok-data
```
- 포트를 하나도 안 열어도 됩니다(모든 트래픽은 Cloudflare Tunnel 아웃바운드). VM 인바운드는 **SSH만**.
- DB·업로드 파일은 부팅 디스크와 분리된 **독립 블록 볼륨**에 저장 → 백업·확장·이전이 쉬움.

---

## 0. 준비물 · 개념
- OCI 계정(무료 Always Free 가능), Cloudflare 계정 + 도메인(Cloudflare에 등록)
- 로컬에 SSH 클라이언트(맥/리눅스 기본, 윈도우는 PowerShell/PuTTY)
- 용어: **테넌시**(계정 전체) · **컴파트먼트**(리소스 묶음, 없으면 `root` 사용) · **가용성 도메인(AD)** · **VCN**(가상 네트워크)

권장 리전: **`ap-chuncheon-1`(춘천)** 또는 `ap-seoul-1`(서울) — 지연·데이터 위치.

---

## 1. SSH 키 만들기 (먼저)
인스턴스 생성 시 **공개키**를 등록해야 하니 미리 만듭니다.
```bash
# 로컬 PC에서
ssh-keygen -t ed25519 -f ~/.ssh/bookjeok_oci -C "bookjeok"
# → ~/.ssh/bookjeok_oci (개인키, 절대 유출 금지) / bookjeok_oci.pub (공개키, 콘솔에 등록)
cat ~/.ssh/bookjeok_oci.pub   # 이 내용을 복사해 둠
```

---

## 2. 네트워크(VCN) 준비
대개 인스턴스 생성 마법사가 VCN을 자동으로 만들어 주지만, 확실히 하려면:

1. 콘솔 → **Networking → Virtual Cloud Networks** → **Start VCN Wizard** → *VCN with Internet Connectivity* → 생성
   - 퍼블릭 서브넷이 있는 VCN이 만들어집니다.
2. **보안 목록(Security List) 인바운드 규칙** — 인터넷용 포트는 안 엽니다. SSH만:
   - VCN → 퍼블릭 서브넷 → Security Lists → 기본 목록 → **Ingress Rules**
   - 확인: `0.0.0.0/0`, TCP, **포트 22** 허용 규칙이 있는지(없으면 추가)
   - 80/443은 **추가하지 않습니다**(Cloudflare Tunnel은 아웃바운드라 인바운드 개방 불필요)
   - 아웃바운드(Egress)는 기본 `0.0.0.0/0` 전체 허용이면 됩니다(터널·패키지·백업 업로드용)

> 보안 강화: 가능하면 SSH 규칙의 소스를 `0.0.0.0/0` 대신 **본인 고정 IP/대역**으로 좁히세요.

---

## 3. 컴퓨트 인스턴스 생성
콘솔 → **Compute → Instances → Create Instance**

1. **이름**: `bookjeok`
2. **Placement**: 가용성 도메인(AD) 선택(용량 상황에 따라 AD-1/2/3 바꿔 시도)
3. **Image and shape**
   - Image: **Ubuntu 22.04** (Canonical Ubuntu)
   - Shape: **Ampere `VM.Standard.A1.Flex`** → **OCPU 2 / Memory 12GB**(Always Free 합계 4 OCPU·24GB 내)
     - 참고: Always Free x86(`E2.1.Micro`)는 1 OCPU/1GB라 이 서비스엔 부족. **ARM A1 권장.**
4. **Networking**: 위에서 만든 VCN·퍼블릭 서브넷, **Assign public IPv4 = Yes**
5. **Add SSH keys**: *Paste public keys* → 1단계 `bookjeok_oci.pub` 내용 붙여넣기
6. **Boot volume**: 기본(약 47GB)로 충분(데이터는 별도 볼륨에 둠). 필요 시 50~100GB로.
7. **Create** → `Running` 되면 **Public IP** 확인

> ⚠️ **"Out of host capacity"** 오류(무료 ARM 인기 리전)면: AD를 바꾸거나, 몇 시간 뒤 재시도, 또는 잠깐 유료 A1(무료 한도 내면 과금 0)로도 동일하게 생성됩니다. 자동 재시도 스크립트를 돌리는 사람도 많습니다.

### 3-1. 첫 접속
```bash
ssh -i ~/.ssh/bookjeok_oci ubuntu@<PUBLIC_IP>
# (Ubuntu 이미지 기본 사용자: ubuntu)
```
접속되면 기본 세팅:
```bash
sudo timedatectl set-timezone Asia/Seoul
sudo apt update && sudo apt -y upgrade
```

### 3-2. OCI Ubuntu 방화벽 주의 (중요)
OCI의 Ubuntu 이미지는 **iptables INPUT 기본 규칙**이 들어 있어 SSH 외 포트를 막습니다.
우리는 인바운드가 SSH뿐이라 **그대로 둬도 됩니다.** 나중에 혹시 포트를 열게 되면
**보안목록(2단계)과 VM iptables 둘 다** 열어야 한다는 점만 기억하세요.
(DB 5432·API 4000은 아래 compose에서 `127.0.0.1`에만 바인딩되어 외부 노출 자체가 없습니다.)

---

## 4. 독립 블록 볼륨 생성·연결·마운트 (DB+파일 저장소)

### 4-1. 볼륨 생성 & 연결
1. 콘솔 → **Storage → Block Volumes → Create Block Volume**
   - 이름: **`bookjeok-data`** ← (파일 백업 스크립트가 이 이름으로 볼륨을 찾으니 **정확히** 이 이름)
   - 크기: **100GB**(현재 사용량 40GB면 여유). 인스턴스와 **같은 AD**에 생성.
2. 만든 볼륨 → **Attached Instances → Attach to Instance**
   - Instance: `bookjeok`, **Attachment type: Paravirtualized**(iSCSI 명령 불필요, 간단)

### 4-2. VM에서 포맷·마운트
```bash
# 새로 붙은 디스크 확인 (부팅디스크 외 두 번째 디스크. 보통 /dev/sdb, 크기로 구분)
lsblk
# 예) sdb  100G  ← 이게 새 볼륨

# ⚠️ 신규(빈) 디스크일 때만 포맷! 기존 데이터 있는 디스크면 절대 mkfs 하지 말 것.
sudo mkfs.ext4 /dev/sdb

# 마운트 지점 생성 & 마운트
sudo mkdir -p /mnt/bookjeok-data
sudo mount /dev/sdb /mnt/bookjeok-data

# 부팅 시 자동 마운트 (UUID 사용 · nofail 로 디스크 문제 시 부팅 안 막힘)
UUID=$(sudo blkid -s UUID -o value /dev/sdb)
echo "UUID=$UUID  /mnt/bookjeok-data  ext4  defaults,_netdev,nofail  0  2" | sudo tee -a /etc/fstab
sudo mount -a && df -h /mnt/bookjeok-data   # 정상 마운트 확인

# 하위 디렉터리(선택 — compose가 없으면 자동 생성하지만 미리 만들어도 됨)
sudo mkdir -p /mnt/bookjeok-data/pgdata /mnt/bookjeok-data/storage
```
이 `/mnt/bookjeok-data`가 곧 `.env`의 **`DATA_ROOT`**입니다.

---

## 5. Docker 설치
```bash
# 공식 스크립트(권장) — Ubuntu에 docker + compose 플러그인 설치
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker            # 또는 로그아웃 후 재접속
docker --version && docker compose version
```

---

## 6. 소스 배치 & 환경변수(.env)
```bash
git clone https://github.com/Cjsarts0509/Book-Jeok.git ~/Book-Jeok
cd ~/Book-Jeok
cp .env.example .env

# 보안키 2개 생성(각각 복사해서 .env에 붙여넣기)
openssl rand -hex 32   # → JWT_SECRET 값
openssl rand -hex 32   # → MASTER_KEY 값

nano .env
```
`.env` 최소 필수값:
```ini
DATA_ROOT=/mnt/bookjeok-data
DB_USER=bookjeok
DB_PASSWORD=<강력한_임의_비밀번호>
DB_NAME=bookjeok
SERVE_FRONTEND=1
JWT_SECRET=<openssl 결과 1>
MASTER_KEY=<openssl 결과 2>
CORS_ORIGINS=https://bookjeok.<도메인>,http://localhost:4000
SUPER_ADMINS=admin
ADMIN_PASSWORD=            # 비우면 최초 기동 로그에 자동 생성된 비밀번호가 찍힘
```
> 🔑 **MASTER_KEY / JWT_SECRET는 분실 금지.** MASTER_KEY는 사용자 비밀번호·2단계 인증 시크릿을 암호화하는 키라, 잃어버리면 복호화가 불가합니다. `.env`를 안전한 곳에 백업해 두세요.

---

## 7. 기동 & 확인
```bash
cd ~/Book-Jeok
docker compose up -d --build      # 이미지 빌드 + DB/API 기동

# 스키마·마이그레이션(0001~0003)·관리자 시드가 시작 시 자동 수행
docker compose ps
docker compose logs api | grep -iE 'seed|admin|listen|마이그레이션'   # 최초 관리자 비번 확인
curl -fsS http://127.0.0.1:4000/api/health && echo "  ← API OK"
```
- DB(5432)·API(4000)는 `127.0.0.1`에만 바인딩 → 외부에서 직접 접근 불가(정상).
- 다음 단계(Cloudflare 터널)를 붙이면 도메인으로 접속됩니다.

---

## 8. Cloudflare Tunnel로 외부 공개
자세한 건 [cloudflare-setup.md](./cloudflare-setup.md). 요약(올인원, 포트 개방 없음):
```bash
# cloudflared 설치 (ARM64 VM)
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb -o cf.deb
sudo dpkg -i cf.deb

cloudflared tunnel login                       # 브라우저로 Cloudflare 로그인·도메인 인가
cloudflared tunnel create bookjeok             # 터널 생성(자격증명 json 발급)
cloudflared tunnel route dns bookjeok bookjeok.<도메인>   # DNS(CNAME) 자동 생성
```
`/etc/cloudflared/config.yml` 예시:
```yaml
tunnel: <TUNNEL_ID>
credentials-file: /root/.cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: bookjeok.<도메인>
    service: http://localhost:4000
  - service: http_status:404
```
서비스 등록:
```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared --no-pager
```
→ `https://bookjeok.<도메인>` 접속되면 성공(TLS·DDoS 방어는 Cloudflare가 처리).

> `.env`의 `CORS_ORIGINS`에 실제 도메인(`https://bookjeok.<도메인>`)이 들어있는지 확인하고, 바꿨다면 `docker compose up -d` 재적용.

---

## 9. 백업 설정 (권장, 오프사이트)
스크립트는 `~/Book-Jeok/scripts/`에 있습니다.

### 9-1. DB 매일 백업 → 오브젝트 스토리지(PAR)
1. 콘솔 → **Storage → Object Storage → Buckets → Create Bucket** (예: `bookjeok-backup`)
2. 그 버킷 → **Pre-Authenticated Requests → Create PAR**
   - 대상: *Objects with prefix* + **Permit object writes**(오브젝트 쓰기)
   - 발급된 URL 복사(끝에 오브젝트 prefix 슬래시까지 포함)
3. VM에 설정:
```bash
echo 'BOOKJEOK_BACKUP_PAR="https://objectstorage.<region>.oraclecloud.com/p/<...>/n/<ns>/b/bookjeok-backup/o/"' > ~/.bookjeok-backup.env
chmod +x ~/Book-Jeok/scripts/bookjeok-backup.sh
~/Book-Jeok/scripts/bookjeok-backup.sh    # 수동 1회 테스트 → 로컬 + 업로드 확인
```
(로컬은 `~/bookjeok-backups`에 14일 보관, 상태는 관리자 '백업' 탭에 표시)

### 9-2. 파일 볼륨 백업 → OCI CLI  ⚠️ 선택(무료 한도 주의)
> **주의**: OCI 볼륨 백업은 오브젝트 스토리지를 차지합니다. **Always Free는 20GB 한도**라, 저장소가 커지면 넘어가 과금될 수 있습니다.
> 파일은 아래 **9-6 계정 밖(구글 드라이브) 매일 백업**이 이미 커버하므로, **볼륨 백업은 안 써도 됩니다**(권장: 미사용 또는 저장소가 작을 때만).
```bash
# OCI CLI 설치 (~/bin/oci 로)
bash -c "$(curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)"
oci setup config    # 새 API 키 생성 → 콘솔의 프로필 → API Keys 에 공개키 등록
# → ~/.oci/config 완성 (tenancy/user/fingerprint/region/key_file)
```
- 스크립트는 볼륨을 **display-name == `bookjeok-data`**로 찾으니 4-1의 이름이 정확해야 합니다.
```bash
chmod +x ~/Book-Jeok/scripts/bookjeok-files-backup.sh
~/Book-Jeok/scripts/bookjeok-files-backup.sh   # 수동 1회 테스트(증분 볼륨 백업 생성)
```

### 9-3. cron 등록
```bash
crontab -e
```
```cron
# DB 매일 03:00 (로컬 + 선택적 오브젝트스토리지)
0 3 * * *  /home/ubuntu/Book-Jeok/scripts/bookjeok-backup.sh   >> /home/ubuntu/bookjeok-backup.log 2>&1
# 계정 밖(구글 드라이브) 매일 05:00 — DB + 파일 전체 (권장 주 백업)
0 5 * * *  /home/ubuntu/Book-Jeok/scripts/bookjeok-offsite.sh  >> /home/ubuntu/bookjeok-offsite.log 2>&1
# (선택) 파일 볼륨 백업 — Always Free 20GB 한도 주의. 안 쓰면 이 줄은 넣지 않는다.
# 0 4 * * 0  /home/ubuntu/Book-Jeok/scripts/bookjeok-files-backup.sh >> /home/ubuntu/bookjeok-files-backup.log 2>&1
```
- **복원**은 터미널에서 `~/Book-Jeok/scripts/restore.sh` (백업 목록에서 선택, 복원 전 자동 백업 + **복원 동안 API 자동 정지/재시작**). 특정 백업을 바로: `BOOKJEOK_RESTORE_FILE=<파일명> ./scripts/restore.sh`
- 파일 복원(구글 드라이브에서): `rclone copy gdrive:bookjeok-backup/storage /mnt/bookjeok-data/storage`

### 9-4. 백업 실패 알림 (강력 권장)
백업이 조용히 실패하면 정작 복원할 때 발견합니다. **dead-man's-switch** 방식으로 감시하세요.
1. 무료 모니터링(예: [healthchecks.io](https://healthchecks.io))에서 체크를 2개 만듭니다(DB 일간 / 파일 주간). 각 체크의 **ping URL**을 복사.
2. `~/.bookjeok-backup.env` 에 추가(두 스크립트가 함께 읽습니다):
   ```bash
   BOOKJEOK_HC_URL="https://hc-ping.com/<your-uuid>"
   ```
   (스크립트가 시작 시 `/start`, 성공 시 그대로, 실패 시 `/fail` 을 핑합니다. **성공 핑이 예정 시각에 안 오면 서비스가 이메일/푸시로 알림**.)
   - 두 스크립트에 서로 다른 URL을 쓰려면 각 스크립트 실행 앞에 `BOOKJEOK_HC_URL=... ` 를 붙여 cron에 넣으면 됩니다.
   - 미설정 시 아무 동작 안 함(기존과 동일). Slack/Discord 웹훅 등 다른 URL도 사용 가능.
> 특히 **PAR(오프사이트 업로드) 실패**는 로컬 백업만 성공해도 `/fail` 로 알립니다(반쪽 백업 방지). PAR은 만료되니 만료 전 갱신도 잊지 마세요.

### 9-5. 백업 자격증명 최소권한 (권장)
VM이 털리면 백업까지 지워지는 걸 막으려면, 백업용 OCI 키/PAR의 권한을 **딱 필요한 만큼만** 주세요.
- **파일 볼륨 백업 키(`~/.oci/config`)**: 테넌시 관리 키가 아니라 **전용 IAM 사용자 + 최소 정책**으로.
  ```
  # 예: 백업 전용 그룹 정책 (해당 컴파트먼트에서 볼륨 백업 생성/조회만)
  Allow group bookjeok-backup to manage volume-backups in compartment <comp>
  Allow group bookjeok-backup to read volumes in compartment <comp>
  ```
  - 삭제(`bv backup delete`)까지 이 키로 하지 말고, **보존은 OCI 볼륨백업 정책(lifecycle)** 에 맡기면 VM이 털려도 백업을 지울 수 없습니다.
- **DB 백업 PAR**: *쓰기만* 허용(읽기·삭제 없음). 버킷에 **버전관리(Object Versioning)** 또는 **Retention Rule** 을 켜면 덮어쓰기·삭제로 과거 백업이 사라지지 않습니다.
- 이렇게 하면 아래 "계정 밖 사본"과 별개로, **한 서버 침해가 곧 백업 전멸**로 이어지는 경로를 끊습니다.

### 9-6. 계정 밖 콜드카피 (월 1회, 강력 권장)
9-1·9-2 백업은 전부 **같은 OCI 계정 안**에 있어, 계정 정지/자격증명 유출/컴파트먼트 삭제 한 번에 원본+백업이 동시에 사라집니다. **다른 신뢰 경계**(다른 클라우드/로컬)로 사본 하나를 두면 이 구멍이 메워집니다.
1. rclone 설치·원격 설정:
   ```bash
   curl https://rclone.org/install.sh | sudo bash
   rclone config      # 원하는 원격 하나 생성 (예: Backblaze B2·Google Drive·S3 호환 등)
   ```
2. `~/.bookjeok-backup.env` 에 추가:
   ```bash
   BOOKJEOK_OFFSITE_REMOTE="myremote:bookjeok"          # rclone 원격:경로
   BOOKJEOK_OFFSITE_HC_URL="https://hc-ping.com/<id>"   # (선택) 이 작업 전용 모니터링
   ```
3. 수동 1회 테스트 → cron(매월 1일 05:00):
   ```bash
   ~/Book-Jeok/scripts/bookjeok-offsite.sh
   crontab -e
   # 0 5 1 * *  /home/ubuntu/Book-Jeok/scripts/bookjeok-offsite.sh >> /home/ubuntu/bookjeok-offsite.log 2>&1
   ```
   - DB 덤프는 **날짜별 히스토리 보존**(rclone copy), 파일은 **증분 미러**(rclone sync, 임시/캐시 폴더 제외).
   - 미설정 시 아무 동작 안 함. 40GB 첫 전송만 오래 걸리고, 이후엔 바뀐 것만 올라갑니다.

---

## 10. 운영 · 업데이트 · 점검
```bash
# 코드 업데이트 반영
cd ~/Book-Jeok && git pull
docker compose up -d --build      # 백엔드 변경 시 재빌드
#   프런트만 바뀐 경우: git pull 만으로 반영(프런트는 read-only 바인드 마운트)

# 상태·로그
docker compose ps
docker compose logs -f api
df -h /mnt/bookjeok-data           # 저장소 여유 확인
```
- 로그 회전(json-file 10m×5)·메모리 상한(api 4g/db 3g)은 `docker-compose.yml`에 이미 설정됨.
- 서버 상태(CPU/메모리/디스크/프로세스)는 앱 상단 **🖥️ 서버 상태** 메뉴에서도 확인.

---

## 자주 막히는 부분
- **ARM 용량 부족(Out of capacity)** → AD 변경·시간차 재시도.
- **SSH 접속 안 됨** → 보안목록에 22 인바운드 있는지 / 개인키 경로·권한(`chmod 600`) / 사용자 `ubuntu`.
- **디스크가 안 보임(`lsblk`에 없음)** → 볼륨이 인스턴스에 Attach 됐는지, Paravirtualized인지 확인.
- **부팅 후 마운트 실패** → `/etc/fstab`에 `nofail,_netdev` 넣었는지, UUID 정확한지.
- **도메인 접속 안 됨** → `systemctl status cloudflared`, config.yml의 hostname·`service: http://localhost:4000`, DNS(CNAME) 생성 여부.
- **로그인은 되는데 비번 열람/2FA 깨짐** → MASTER_KEY가 최초 기동 때와 달라짐. 원래 값으로.

이후 도메인·터널 세부는 [cloudflare-setup.md](./cloudflare-setup.md), 계정 이전은 [oci-migration.md](./oci-migration.md).
