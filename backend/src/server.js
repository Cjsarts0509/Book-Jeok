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
}));

app.use(express.json({ limit: '1mb' }));
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
  console.error('[error]', err.message);
  res.status(err.status || 500).json({ error: err.message || '서버 오류가 발생했습니다.' });
});

// ── 시작 ────────────────────────────────────────────
fs.mkdirSync(config.storageRoot, { recursive: true });
app.listen(config.port, () => {
  console.log(`북적북적 API 서버 실행 중 → http://localhost:${config.port}  (env: ${config.env})`);
  console.log(`파일 저장 경로: ${config.storageRoot}`);
});
