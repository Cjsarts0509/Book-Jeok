'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const config = require('./config');

const app = express();
app.set('trust proxy', 1); // Cloudflare / nginx 프록시 뒤에서 실제 IP 인식

// ── 보안 헤더 ───────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // 정적 프런트는 별도 호스팅(CF Pages) 가정
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors({
  origin(origin, cb) {
    if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
    cb(new Error('CORS 정책에 의해 차단되었습니다.'));
  },
  credentials: true,
  exposedHeaders: ['Content-Disposition'], // 브라우저 JS가 다운로드 파일명을 읽을 수 있도록
}));

app.use(express.json({ limit: '16mb' })); // 공지 리치텍스트(이미지 임베드) 대비
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// 전역 레이트 리밋
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
}));

// ── 라우트 ──────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'book-jeok', time: new Date().toISOString() }));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/files', require('./routes/files'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/share', require('./routes/share'));
app.use('/api/upload-link', require('./routes/uploadLink')); // 공개 업로드 요청 링크
app.use('/api/folder-share', require('./routes/folderShare')); // 공개 폴더 공유(읽기 전용)
app.use('/api/meta', require('./routes/meta')); // 영업점 목록·활성 공지 (로그인 사용자 공용)

// (선택) 프런트엔드를 같은 서버에서 서빙하려면 SERVE_FRONTEND=1
if (process.env.SERVE_FRONTEND === '1') {
  const frontDir = path.join(__dirname, '..', '..', 'frontend');
  app.use(express.static(frontDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(frontDir, 'index.html'));
  });
}

// ── 에러 핸들러 ─────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: '파일 용량이 허용 한도를 초과했습니다.' });
  }
  const status = err.status || 500;
  if (status >= 500) {
    // 내부 오류 상세는 서버 로그에만, 클라이언트엔 일반 메시지 (정보 노출 차단)
    console.error('[error]', err.stack || err.message);
    return res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
  res.status(status).json({ error: err.message || '요청을 처리할 수 없습니다.' });
});

// ── 시작 ────────────────────────────────────────────
fs.mkdirSync(config.storageRoot, { recursive: true });
require('./settings').loadSettings(); // 허용 확장자 캐시 로드
require('./purge').startPurgeScheduler(); // 휴지통 1년 경과분 자동 영구삭제
app.listen(config.port, () => {
  console.log(`북적북적 API 서버 실행 중 → http://localhost:${config.port}  (env: ${config.env})`);
  console.log(`파일 저장 경로: ${config.storageRoot}`);
});
