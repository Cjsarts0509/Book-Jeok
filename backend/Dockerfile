FROM node:20-bookworm-slim

WORKDIR /app

# YARA(로컬 악성 패턴 검사) + LibreOffice(오피스 문서 → PDF 완전 레이아웃 미리보기) + 한글 폰트
#  - libreoffice-impress: PPT/PPTX, libreoffice-writer: DOC/DOCX, fonts-noto-cjk: 한글 렌더
#  - 오피스 미리보기가 필요 없으면 libreoffice-* / fonts-noto-cjk 줄을 빼도 됩니다(그 경우 텍스트 폴백).
RUN apt-get update && apt-get install -y --no-install-recommends \
      yara \
      libreoffice-impress libreoffice-writer \
      fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# 의존성 먼저 설치 (레이어 캐시).
# package-lock.json 을 함께 복사해 npm ci 로 '잠긴 버전 그대로' 설치한다.
#  → 재빌드마다 의존성이 떠다니지 않고(재현 가능), 보안 패치가 적용된 버전이 그대로 배포된다.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY yara-rules ./yara-rules

# 프런트엔드는 compose 에서 볼륨 마운트하거나 별도 배포
ENV NODE_ENV=production
EXPOSE 4000

# 비-root 실행: LibreOffice/YARA 가 신뢰할 수 없는 문서를 파싱하므로, 만에 하나 뚫려도
# 컨테이너 root 를 내주지 않도록 한다. node 이미지의 기본 사용자(uid/gid 1000)를 사용.
#  ※ 데이터 볼륨(/data/storage) 소유자도 1000:1000 이어야 쓰기가 된다(문서의 chown 안내 참고).
RUN chown -R node:node /app
USER node

# 컨테이너 시작 시 스키마 보장 후 서버 실행
# 마지막 단계는 exec 로 node 가 셸을 대신하게 한다(PID 1). 셸이 남아 있으면 배포 때 docker 가 보내는
# 종료 신호(SIGTERM)가 node 에 닿지 않아 정상 종료 표시를 못 남기고 10초 뒤 강제 종료된다 →
# 다음 기동에서 '예기치 않은 재시작' 경고가 떴다.
CMD ["sh", "-c", "node src/initDb.js && node src/seedAdmin.js && exec node src/server.js"]
