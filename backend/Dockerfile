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

# 컨테이너 시작 시 스키마 보장 후 서버 실행
CMD ["sh", "-c", "node src/initDb.js && node src/seedAdmin.js && node src/server.js"]
