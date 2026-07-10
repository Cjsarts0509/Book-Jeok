FROM node:20-alpine

WORKDIR /app

# YARA(로컬 악성 패턴 검사) + tesseract OCR(이미지 문서 글자 인식, 한국어/영어) — Alpine community, 외부 통신 없음
RUN apk add --no-cache yara tesseract-ocr tesseract-ocr-data-eng tesseract-ocr-data-kor

# 의존성 먼저 설치 (레이어 캐시)
COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY yara-rules ./yara-rules

# 프런트엔드는 compose 에서 볼륨 마운트하거나 별도 배포
ENV NODE_ENV=production
EXPOSE 4000

# 컨테이너 시작 시 스키마 보장 후 서버 실행
CMD ["sh", "-c", "node src/initDb.js && node src/seedAdmin.js && node src/server.js"]
