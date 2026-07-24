# 🆘 긴급 복구(Failover) 런북 — OCI가 죽었을 때 다른 곳에서 되살리기

오라클(OCI) 리전/계정이 **장기 장애**라 자동복구로 안 살아날 때, **구글 드라이브 오프사이트 백업**으로
**아무 서버(다른 클라우드 소형 VM·Docker 깔린 노트북)** 에서 30~60분 안에 같은 도메인으로 부활시키는 절차입니다.

> VM 재부팅·컨테이너 크래시·네트워크 잠깐 끊김은 이미 자동복구(Docker restart + 헬스체크)됩니다.
> 이 문서는 **그걸로도 안 되는 리전급 장애**일 때만 씁니다.

## 전제(미리 확보해 둘 것)
- **구글 드라이브 백업**이 돌고 있을 것: `gdrive:bookjeok-backup/db`(DB 덤프), `gdrive:bookjeok-backup/storage`(파일). → `scripts/bookjeok-offsite.sh`
- **`.env` 사본**(특히 `MASTER_KEY`·`JWT_SECRET`)을 안전한 곳에 별도 보관. ← **이게 없으면 비번·2FA 복호화 불가**
- Cloudflare 계정 접근(터널을 새 서버로 붙일 것 — 도메인은 그대로).

---

## 1. 새 서버 준비 (아무 곳이나)
- 다른 클라우드 소형 VM(2 vCPU/4GB+), 또는 Docker 설치된 리눅스/노트북. OS 상관없음.
- Docker + rclone 설치:
  ```bash
  curl -fsSL https://get.docker.com | sh
  curl https://rclone.org/install.sh | sudo bash
  ```
- **rclone에 `gdrive` 원격 연결**(백업 만들 때와 동일한 인증). rclone 설정 파일(`~/.config/rclone/rclone.conf`)을 그대로 복사하거나 `rclone config`로 재인증.

## 2. 소스 + 환경파일
```bash
git clone https://github.com/Cjsarts0509/Book-Jeok.git ~/Book-Jeok
cd ~/Book-Jeok
# 보관해둔 .env 를 그대로 복사(MASTER_KEY/JWT_SECRET 원본!). DATA_ROOT 는 이 서버 경로에 맞게.
cp /안전한곳/.env ~/Book-Jeok/.env
mkdir -p /mnt/bookjeok-data/storage      # DATA_ROOT (없으면 생성)
```

## 3. 데이터 복원 (구글 드라이브 → 새 서버)
```bash
# 3-1) 파일 저장소 복원
rclone copy gdrive:bookjeok-backup/storage /mnt/bookjeok-data/storage --transfers 8 --fast-list

# 3-2) DB: 가장 최신 덤프 하나 받기
mkdir -p /tmp/dbrestore
LATEST=$(rclone lsf gdrive:bookjeok-backup/db --include 'bookjeok-db-*.sql.gz' | sort | tail -1)
rclone copy "gdrive:bookjeok-backup/db/$LATEST" /tmp/dbrestore
echo "복원할 덤프: $LATEST"
```

## 4. 기동 + DB 주입
```bash
cd ~/Book-Jeok
docker compose up -d db                  # 빈 DB 먼저
sleep 20                                 # initdb 대기
gunzip -c /tmp/dbrestore/$LATEST | docker exec -i bookjeok-db psql -U bookjeok -q bookjeok
docker compose up -d --build             # API까지 기동(마이그레이션 자동)
curl -fsS http://127.0.0.1:4000/api/health && echo "  ← OK"
```

## 5. Cloudflare 터널을 새 서버로 (도메인 그대로)
- Cloudflare 계정이 살아있으니 **DNS는 안 건드립니다.** 같은 터널을 새 서버에 붙이면 됩니다.
  ```bash
  # cloudflared 설치(ARM/AMD 맞게) 후, 기존 터널 토큰으로 커넥터 실행
  #  (Cloudflare 대시보드 → Zero Trust → Networks → Tunnels → 해당 터널 → Install connector 명령 복사)
  sudo cloudflared service install <터널토큰>
  ```
- 새 커넥터가 붙으면 `https://bookjeok.<도메인>` 트래픽이 새 서버로 넘어옵니다.
- 라우팅(퍼블릭 호스트명 → `http://localhost:4000`)은 터널 설정에 이미 있어 그대로 유지.

## 6. 검증
- [ ] 도메인 접속·로그인
- [ ] **관리자 비밀번호 열람 정상**(= MASTER_KEY 승계 확인) · 2FA 로그인
- [ ] 파일 목록·다운로드·미리보기
- [ ] 최근 파일이 보이는지(백업 시점 이후 변경분은 손실될 수 있음 — 마지막 오프사이트 시각 기준)

---

## 7. OCI 복구 후 원복
1. OCI VM이 정상화되면, **그동안 새 서버에 쌓인 변경분을 원 서버로 되돌려야** 합니다.
   - 간단히: 새 서버에서 다시 오프사이트 백업을 돌리고, 원 서버가 그걸 복원 → 또는 새 서버를 그대로 정식 서버로 승격(그럼 원복 불필요).
2. Cloudflare 터널을 원하는 서버 하나에만 붙여둘 것(두 서버가 동시에 같은 도메인에 붙으면 트래픽이 오락가락).

## 알아둘 것 (한계)
- **RPO(데이터 손실 폭)** = 마지막 오프사이트 백업 이후 변경분. 오프사이트가 월 1회면 최악의 경우 한 달치. 장애 대비를 더 촘촘히 하려면 오프사이트 주기를 **주 1회/일 1회**로 올리세요(드라이브 여유 3TB면 부담 없음).
- **RTO(복구 시간)** ≈ 30~60분(대부분 40GB 파일 다운로드 시간). 파일을 미리 받아둔 웜 스탠바이를 상시 두면 더 짧아집니다.
- 상시 무중단(액티브-액티브)은 서버 이중화+DB복제+로드밸런서가 필요해 40명 내부용엔 과투자 — 이 수동 failover가 현실적 최적점입니다.
