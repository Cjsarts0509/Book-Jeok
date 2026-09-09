'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const { rateKey } = require('./util');

const app = express();
app.set('trust proxy', 1); // Cloudflare / nginx 프록시 뒤에서 실제 IP 인식

// ── 보안 헤더 ───────────────────────────────────────
// CSP: 프런트를 같은 서버에서 서빙(SERVE_FRONTEND=1, compose 기본값)하므로 반드시 필요하다.
//  인라인 스크립트/핸들러를 전부 외부 .js 로 분리했기 때문에 'unsafe-inline' 없이 script-src 'self' 가 가능.
//  → XSS 가 생기더라도 스크립트 실행 자체가 차단되어 세션 탈취로 이어지지 않는다.
//  styleSrc 만 'unsafe-inline' 유지(코드 전반의 style="..." 속성 때문. 스타일은 스크립트 실행이 불가).
// 실제로 쓰는 출처만 열어둔다(하나라도 빠지면 기능이 깨지므로 근거를 함께 남긴다):
//  · API_ORIGIN  : 프런트가 분리 호스팅일 때 호출 대상(frontend/config.js 의 BOOKJEOK_API). CSP_API_ORIGIN 로 지정.
//  · 교보 표지    : app.js 가 표지 이미지를 직접 로드
//  · jsdelivr    : isbn.js 가 OCR(tesseract.js)을 동적 로드
//  · blob:(frame): PDF 미리보기를 <iframe src="blob:"> 로 띄움
const API_ORIGIN = (process.env.CSP_API_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
const TESS_CDN = 'https://cdn.jsdelivr.net';
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    // 기본은 위반 '보고만'(차단 안 함). 배포 후 콘솔에 위반이 없는지 확인하고
    // CSP_ENFORCE=1 로 실제 차단을 켠다 — 잘못된 정책으로 서비스가 멈추는 것을 막기 위함.
    reportOnly: process.env.CSP_ENFORCE !== '1',
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", TESS_CDN],
      styleSrc: ["'self'", "'unsafe-inline'"],   // 코드 전반의 style="..." 속성(스타일은 스크립트 실행 불가)
      imgSrc: ["'self'", 'data:', 'blob:', 'https://contents.kyobobook.co.kr'],
      connectSrc: ["'self'", 'blob:', TESS_CDN, ...API_ORIGIN],
      fontSrc: ["'self'", 'data:'],
      mediaSrc: ["'self'", 'blob:'],
      workerSrc: ["'self'", 'blob:'],
      frameSrc: ["'self'", 'blob:'],             // PDF 미리보기
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],                // 클릭재킹 차단(X-Frame-Options 보다 강함)
      baseUri: ["'self'"],
      formAction: ["'self'"],
      reportUri: ['/api/csp-report'],            // 위반을 서버 로그로 모아 정책을 안전하게 검증
    },
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' },  // 프런트/API 가 분리 호스트일 수 있어 유지
  hsts: { maxAge: 31536000, includeSubDomains: true },
}));

app.use(cors({
  origin(origin, cb) {
    if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
    cb(new Error('CORS 정책에 의해 차단되었습니다.'));
  },
  credentials: true,
  exposedHeaders: ['Content-Disposition'], // 브라우저 JS가 다운로드 파일명을 읽을 수 있도록
}));

// ── CSP 위반 수집 ───────────────────────────────────
// 브라우저가 정책 위반을 여기로 보고한다. Report-Only 로 운영하는 동안 실제 사용 경로에서
// 무엇이 막힐지 로그로 확인한 뒤 CSP_ENFORCE=1 로 켜기 위한 장치.
//   확인:  docker logs bookjeok-api | grep CSP
// 인증 불필요(브라우저가 보냄) → 자체 레이트리밋을 두고 전역 리밋 '앞'에 배치해
// 보고 폭주가 정상 API 호출 예산을 잠식하지 않게 한다. 같은 위반은 합산해 로그를 더럽히지 않는다.
const cspSeen = new Map();
app.post('/api/csp-report',
  rateLimit({ windowMs: 60 * 1000, max: 60, keyGenerator: rateKey, standardHeaders: false, legacyHeaders: false, message: {} }),
  express.json({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '32kb' }),
  (req, res) => {
    res.status(204).end();   // 브라우저는 응답 본문을 쓰지 않는다 — 먼저 끊고 로깅
    try {
      const body = req.body || {};
      // report-uri(구형)는 {"csp-report":{...}}, Reporting API(신형)는 [{type,body},...]
      const items = Array.isArray(body) ? body.map((x) => x && x.body).filter(Boolean)
        : (body['csp-report'] ? [body['csp-report']] : []);
      for (const r of items) {
        const directive = r['effective-directive'] || r.effectiveDirective || r['violated-directive'] || r.violatedDirective || '?';
        const blocked = String(r['blocked-uri'] || r.blockedURL || '?').slice(0, 200);
        const page = String(r['document-uri'] || r.documentURL || '?').slice(0, 200);
        const key = `${directive}|${blocked}`;
        const n = (cspSeen.get(key) || 0) + 1;
        cspSeen.set(key, n);
        // 같은 위반은 1·10·100… 번째만 출력(정책 검증엔 '무엇이' 막히는지가 중요, 횟수는 부차)
        if (n === 1 || n === 10 || n === 100 || n % 1000 === 0) {
          console.warn(`[CSP] 위반 directive=${directive} blocked=${blocked} page=${page} (${n}회)`);
        }
      }
      if (cspSeen.size > 500) cspSeen.clear();   // 메모리 무한 증가 방지
    } catch (_) { /* 보고 파싱 실패는 무시 */ }
  });

app.use(express.json({ limit: '16mb' })); // 공지 리치텍스트(이미지 임베드) 대비
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());

// 전역 레이트 리밋 (실제 클라이언트 IP 기준 — 터널 뒤 전역버킷화 방지)
// 부하 테스트처럼 의도적으로 많이 때려봐야 할 때만 API_RATE_LIMIT_MAX 로 잠시 올린다.
// 운영 기본값은 분당 300건 — 값을 비워두면 항상 이 값이 쓰인다.
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.API_RATE_LIMIT_MAX || '300', 10),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateKey,
}));

// ── 요청 결과 집계(에러율·응답시간) ─────────────────
// 라우트보다 먼저 붙여 모든 응답의 status 를 본다. 집계는 res 'finish' 에서만 하므로 지연이 없다.
const metrics = require('./metrics');
app.use('/api/', metrics.requestMetrics);

// ── 요청 타임아웃 (S33) ─────────────────────────────
// 응답이 영영 안 오는 요청은 브라우저를 무한 로딩에 빠뜨리고 DB 커넥션을 붙잡는다.
// 업로드·다운로드처럼 본래 오래 걸리는 경로는 middleware/timeout.js 에서 예외 처리한다.
app.use('/api/', require('./middleware/timeout').requestTimeout);

// ── 목록 캐시 무효화 (S21) ──────────────────────────
// 쓰기가 성공하면 그 계정의 목록 캐시를 버린다. 개별 라우트마다 무효화를 심으면
// 새 라우트가 생길 때마다 빠뜨리기 쉬우므로, 응답이 끝나는 지점에서 한 번에 처리한다.
const listcache = require('./listcache');
const MUTABLE = /^\/api\/(files|admin|upload-link|share|folder-share)\b/;
app.use('/api/', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    if (!MUTABLE.test(req.originalUrl || '')) return;
    const owners = [];
    if (Array.isArray(req._bumpOwners)) owners.push(...req._bumpOwners);   // 여러 계정이 걸린 일괄 작업
    if (req.targetOwnerId != null) owners.push(req.targetOwnerId);
    if (req.user && req.user.id != null) owners.push(req.user.id);
    if (owners.length) listcache.bumpMany(owners);
    else listcache.clear();     // 대상을 특정 못 하면 안전하게 전부 버린다(드문 경로)
  });
  next();
});

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
require('./scheduler').start(); // 주간 리포트 자동 발송(SMTP 설정 시)
metrics.start(); // 이벤트루프·메모리·디스크·DB풀·에러율 상시 감시 + 예기치 않은 재시작 감지
require('./checkup').startScheduler(); // 정합성 검사(주간) · 좀비 리소스 정리 리포트(일간)
require('./mailQueue').start();        // 메일 재시도 큐(실패분 백오프 재발송)
const server = app.listen(config.port, () => {
  console.log(`북적북적 API 서버 실행 중 → http://localhost:${config.port}  (env: ${config.env})`);
  console.log(`파일 저장 경로: ${config.storageRoot}`);
});

// ── 프로세스 안전망 ──────────────────────────────────
// 미들웨어 체인 밖(스트림 콜백·타이머 등)에서 터진 예외/거부가 서버를 조용히 죽이는 것을 방지.
// 거부는 로깅만(가용성 우선), 미처리 예외는 상태 손상 가능성이 있어 정리 후 종료(컨테이너가 재시작).
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', (reason && (reason.stack || reason.message)) || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', (err && (err.stack || err.message)) || err);
  server.close(() => process.exit(1));
  setTimeout(() => process.exit(1), 5000).unref(); // 정상 종료가 지연되면 강제 종료
});
// 배포/재시작 시 진행 중 요청을 정리하고 DB 풀을 닫은 뒤 종료(무중단성·연결 누수 방지).
const { pool } = require('./db');
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[${sig}] 종료 신호 수신 — 서버 정리 중…`);
    metrics.markCleanShutdown();   // 계획된 종료임을 남긴다(S27 오탐 방지)
    server.close(() => { pool.end().catch(() => {}).finally(() => process.exit(0)); });
    setTimeout(() => process.exit(0), 10000).unref();
  });
}
