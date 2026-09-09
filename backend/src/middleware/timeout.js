'use strict';

// S33 · 요청 타임아웃 일괄 적용
//
// 어딘가에서 응답이 영원히 오지 않으면 브라우저는 무한 로딩에 걸리고, 그 요청이 붙잡은
// DB 커넥션·메모리는 끝까지 돌아오지 않는다. "느리다"보다 "언제 끝날지 모른다"가 더 나쁘다.
// 그래서 모든 API 요청에 상한을 두고, 넘으면 명확한 메시지로 끊는다.
//
// 다만 본질적으로 오래 걸리는 것들이 있다 — 대용량 업로드/다운로드, ZIP 압축, 문서 PDF 변환.
// 이들은 예외로 두거나(스트리밍은 시간이 아니라 진행 여부가 기준) 더 넉넉한 상한을 준다.
const alerts = require('../alerts');

const DEFAULT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || '20000', 10);        // 보통 API
const HEAVY_MS = parseInt(process.env.HEAVY_TIMEOUT_MS || '180000', 10);           // 압축·변환처럼 원래 오래 걸리는 것

// 경로별 상한. 정규식이 먼저 맞는 순서대로 적용된다.
const RULES = [
  { re: /\/upload(\/|$)/, ms: 0 },                 // 업로드: 전송 시간이 곧 파일 크기 — 시간으로 끊지 않는다
  { re: /\/download(\/|$)/, ms: 0 },               // 다운로드: 스트리밍이라 마찬가지
  { re: /\/bulk\/zip/, ms: HEAVY_MS },             // 압축: 오래 걸리지만 무한은 아니어야 한다
  { re: /\/pdf(\/|$)/, ms: HEAVY_MS },             // 문서 → PDF 변환
  { re: /\/checkups\/[^/]+\/run/, ms: HEAVY_MS },  // 정합성 검사(파일이 많으면 오래)
  { re: /\/health\/indexes/, ms: 60000 },          // 통계 조회
];
function limitFor(path) {
  for (const r of RULES) if (r.re.test(path)) return r.ms;
  return DEFAULT_MS;
}

function requestTimeout(req, res, next) {
  const ms = limitFor(req.originalUrl || req.url || '');
  if (!ms) return next();

  const timer = setTimeout(() => {
    if (res.headersSent || res.writableEnded) return;   // 이미 응답이 나가기 시작했으면 건드리지 않는다
    const where = `${req.method} ${(req.originalUrl || '').split('?')[0]}`;
    console.error(`[timeout] ${where} 가 ${ms}ms 안에 끝나지 않아 끊었습니다`);
    // 타임아웃은 '어딘가 막혔다'는 신호다 — 한 번 나면 사람이 봐야 한다
    alerts.raise('request-timeout', 'warn', '응답하지 못한 요청이 있습니다',
      `${where} 가 ${Math.round(ms / 1000)}초 안에 끝나지 않았습니다. DB 잠금이나 외부 프로그램(문서 변환)이 멈춰 있는지 확인해 주세요.`);
    res.status(503).json({ error: '서버가 이 요청을 제시간에 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.' });
  }, ms);
  timer.unref();

  const clear = () => clearTimeout(timer);
  res.on('finish', clear);
  res.on('close', clear);
  next();
}

module.exports = { requestTimeout, limitFor, DEFAULT_MS, HEAVY_MS };
