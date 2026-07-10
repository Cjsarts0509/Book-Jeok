FROM node:20-alpine

WORKDIR /app

# YARA(로컬 악성 패턴 검사) + tesseract OCR(이미지 문서 글자 인식, 한국어/영어)
# + ImageMagick(OCR 전처리: 방향/그레이스케일/기울기/명암 보정) — Alpine community, 외부 통신 없음
RUN apk add --no-cache yara tesseract-ocr tesseract-ocr-data-eng tesseract-ocr-data-kor imagemagick

# 고정밀 언어모델(tessdata_best) 내려받기 — 정확도 향상용. 네트워크 없으면 best-effort 로 건너뜀
# (없어도 위 apk 의 fast 모델로 정상 동작, ocr.js 가 자동 폴백)
RUN mkdir -p /usr/share/tessdata-best \
 && ( wget -qO /usr/share/tessdata-best/kor.traineddata https://github.com/tesseract-ocr/tessdata_best/raw/main/kor.traineddata \
   && wget -qO /usr/share/tessdata-best/eng.traineddata https://github.com/tesseract-ocr/tessdata_best/raw/main/eng.traineddata ) \
 || ( echo 'tessdata_best download skipped (offline); falling back to fast models' && rm -f /usr/share/tessdata-best/kor.traineddata /usr/share/tessdata-best/eng.traineddata )

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
