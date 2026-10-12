'use strict';

// 업로드 관측 로그 — "업로드가 느리다"는 말이 나왔을 때 어디가 느린지 한 줄로 보이게 한다.
//   확인:  docker logs bookjeok-api --since 24h 2>&1 | grep '\[upload\]'
//   예)    [upload] 201 bookjeok.cjslabs.kr ICN user=12 3개 24.8MB · 받기 3.1s (8.0MB/s) · 검사 0.4s · 저장 0.1s · 전체 3.6s
//
// - 접속 주소(host): 새 주소(bookjeok.cjslabs.kr)인지, 예전 경로(bookjeok-api…)인지
// - Cloudflare 거점(cf-ray 끝 3글자): ICN 이면 서울, SEA·LAX·NRT 등이면 해외를 돌아온 것
// - 받기: 브라우저→서버로 파일이 다 들어오기까지(회선·경로 속도). 검사: 형식·YARA. 저장: DB 기록.
// 받기가 길면 회선/경로 문제, 검사가 길면 서버 문제로 바로 구분된다.
const UPLOAD_PATH = /^\/api\/(files\/upload(\/chunk|\/complete)?|upload-link\/[^/]+)$/;

const sec = (ms) => (ms / 1000).toFixed(1) + 's';
const mb = (n) => (n / 1048576).toFixed(1) + 'MB';

function middleware(req, res, next) {
  if (req.method !== 'POST' || !UPLOAD_PATH.test(String(req.originalUrl || '').split('?')[0])) return next();
  const t0 = Date.now();
  res.on('finish', () => {
    try {
      const end = Date.now();
      const bytes = Number(req.headers['content-length']) || 0;
      const recv = req._upRecv ? req._upRecv - t0 : null;
      const parts = [];
      if (recv != null) parts.push(`받기 ${sec(recv)}${recv > 0 && bytes ? ` (${mb(bytes / (recv / 1000))}/s)` : ''}`);
      if (req._upRecv && req._upScan) parts.push(`검사 ${sec(req._upScan - req._upRecv)}`);
      if (req._upScan) parts.push(`저장 ${sec(end - req._upScan)}`);
      parts.push(`전체 ${sec(end - t0)}`);
      const ray = String(req.headers['cf-ray'] || '');
      const colo = ray.includes('-') ? ray.split('-').pop() : '-';
      const who = req.user ? `user=${req.user.id}` : (req.originalUrl.includes('/upload-link/') ? 'link' : 'anon');
      const n = (req.files && req.files.length) || (req.file ? 1 : 0);
      const kind = req.originalUrl.includes('/chunk') ? '조각' : req.originalUrl.includes('/complete') ? '조각합치기' : `${n}개`;
      console.log(`[upload] ${res.statusCode} ${req.get('host') || '-'} ${colo} ${who} ${kind} ${mb(bytes)} · ${parts.join(' · ')}`);
    } catch (_) { /* 로그 실패가 응답에 영향 주지 않게 */ }
  });
  next();
}

// 핸들러 맨 앞(=파일을 다 받은 직후)과 보안 검사 직후에 표시
const received = (req) => { req._upRecv = Date.now(); };
const scanned = (req) => { req._upScan = Date.now(); };

module.exports = { middleware, received, scanned };
