# 오라클 클라우드 서버 & 독립 디스크 구성 가이드

북적북적의 DB와 파일 저장소를 **오라클 클라우드(OCI) VM의 독립 블록 볼륨**에
구성하는 방법입니다. (요구사항 7)

## 1. 컴퓨트 인스턴스 준비
- OCI 콘솔 → Compute → Instances → **Create Instance**
- 이미지: Ubuntu 22.04 (또는 Oracle Linux 8)
- Shape: Always Free 대상이면 `VM.Standard.A1.Flex` (Ampere, 4 OCPU / 24GB 무료 한도 내)
- SSH 키 등록 후 생성

## 2. 독립 블록 볼륨 생성 및 연결 (DB 전용 디스크)
> "기존 서버 내에서 독립 디스크를 만들어 구성"하는 부분입니다.

1. OCI 콘솔 → Storage → **Block Volumes** → Create Block Volume
   - 크기 예: 100GB, 같은 가용성 도메인(AD)에 생성
2. 생성한 볼륨을 인스턴스에 **Attach** (Attachment type: Paravirtualized 권장)
3. VM 접속 후 디스크 확인·포맷·마운트:

```bash
# 연결된 디스크 확인 (예: /dev/sdb)
lsblk

# 파일시스템 생성 (신규 디스크일 때만!)
sudo mkfs.ext4 /dev/sdb

# 독립 마운트 지점 생성 및 마운트
sudo mkdir -p /mnt/bookjeok-data
sudo mount /dev/sdb /mnt/bookjeok-data

# 부팅 시 자동 마운트 (UUID 사용 권장)
echo "UUID=$(sudo blkid -s UUID -o value /dev/sdb)  /mnt/bookjeok-data  ext4  defaults,_netdev,nofail  0  2" | sudo tee -a /etc/fstab

# DB / 저장소 하위 디렉터리
sudo mkdir -p /mnt/bookjeok-data/pgdata /mnt/bookjeok-data/storage
```

이 `/mnt/bookjeok-data` 가 docker-compose 의 `DATA_ROOT` 이며,
PostgreSQL 데이터(`pgdata`)와 업로드 파일(`storage`)이 모두 이 **독립 디스크**에 저장됩니다.
OS 디스크와 분리되어 백업·확장·이전이 쉽습니다.

## 3. Docker 설치 & 배포
```bash
# Docker + compose 플러그인 설치
sudo apt update && sudo apt install -y docker.io docker-compose-plugin
sudo usermod -aG docker $USER && newgrp docker

# 소스 가져오기
git clone https://github.com/Cjsarts0509/Book-Jeok.git
cd Book-Jeok

# 환경변수 설정
cp .env.example .env
# 아래 두 키는 반드시 생성해서 채우세요:
openssl rand -hex 32   # → JWT_SECRET
openssl rand -hex 32   # → MASTER_KEY
nano .env              # DB_PASSWORD, JWT_SECRET, MASTER_KEY, CORS_ORIGINS 등 입력

# 기동 (스키마 생성 + 관리자 시드가 컨테이너 시작 시 자동 수행)
docker compose up -d --build

# 최초 관리자 비밀번호 확인
docker compose logs api | grep -A5 seed-admin
```

## 4. 방화벽 / 보안
- OCI **Security List / NSG** 에서 인바운드는 최소화합니다.
  Cloudflare Tunnel 을 쓰면 **443/80 을 열 필요조차 없습니다** (아웃바운드만).
- VM 내부 `iptables`(Oracle Linux) 또는 `ufw`:
  ```bash
  sudo ufw allow 22/tcp        # SSH (가능하면 SSH도 제한)
  sudo ufw enable
  ```
- DB 포트(5432)와 API 포트(4000)는 `127.0.0.1` 바인딩이라 외부 노출되지 않습니다.

## 5. 백업 (권장)
```bash
# DB 논리 백업
docker exec bookjeok-db pg_dump -U bookjeok bookjeok > backup_$(date +%F).sql
# 파일 저장소는 블록 볼륨 스냅샷(OCI Console) 또는 rsync
```
다음 단계는 [cloudflare-setup.md](./cloudflare-setup.md) 를 참고하세요.
