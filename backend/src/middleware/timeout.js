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
  { re: /\/sa-report\/[^/]+\/photo(\/|$)/, ms: 0 }, // 재고조사 보고서 사진(휴대폰 회선으로 올라옴·내려감)
  { re: /\/bulk\/zip/, ms: HEAVY_MS },             // 압축: 오래 걸리지만 무한은 아니어야 한다
  { re: /\/pdf(\/|$)/, ms: HEAVY_MS },             // 문서 → PDF 변환
  { re: /\/checkups\/[^/]+\/run/, ms: HEAVY_MS },  // 정합성 검사(파일이 많으면 오래)
  { re: /\/health\/indexes/, ms: 60000 },          // 통계 조회
];
// 주소 뒤의 '?…'(쿼리스트링)는 떼고 경로만 본다.
// 예전에는 붙은 채로 검사해서 '/upload?ownerId=3' 이 '/upload(끝)' 규칙에 걸리지 않았다 —
// 담당자·관리자가 다른 계정 공간에 올리는 업로드가 전부 20초에 끊긴 원인.
function limitFor(url) {
  const path = String(url || '').split('?')[0];
  for (const r of RULES) if (r.re.test(path)) return r.ms;
  return DEFAULT_MS;
}
// 파일을 실어 보내는 요청(multipart)은 경로와 상관없이 시간으로 끊지 않는다.
// 업로드 경로는 여러 곳(일반·청크·공개 업로드 링크…)이라 경로 목록만으로는 언젠가 또 빠진다.
// 또, 받는 도중에 끊으면 반쯤 쓰인 파일이 DB 에도 없이 디스크에 남는다.
const isFileTransfer = (req) => /^multipart\/form-data/i.test(String(req.headers['content-type'] || ''));

function requestTimeout(req, res, next) {
  if (isFileTransfer(req)) return next();
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

module.exports = { requestTimeout, limitFor, isFileTransfer, DEFAULT_MS, HEAVY_MS };
