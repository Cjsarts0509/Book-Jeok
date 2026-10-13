'use strict';

// 업로드 관측 — "업로드가 느리다/안 된다"는 말이 나왔을 때 무엇이 어디서 그랬는지 바로 보이게 한다.
//   ① 서버 로그 한 줄:  docker logs bookjeok-api --since 24h 2>&1 | grep '\[upload\]'
//      [upload] 201 bookjeok.cjslabs.kr ICN 홍길동 3개 24.8MB · 받기 3.1s (8.0MB/s) · 검사 0.4s · 저장 0.1s · 전체 3.6s
//      [upload] 끊김 bookjeok.cjslabs.kr ICN 외부업체 3.2MB/24.8MB 받다가 · 41.0s
//   ② 관리자 화면(서버 상태 → 업로드 현황): 지금 올라가는 중인 것 + 최근 결과(완료·실패·끊김)
//      — 배포로 컨테이너가 바뀌면 로그와 함께 비워진다(메모리 보관).
//
// - 접속 주소(host): 새 주소(bookjeok.cjslabs.kr)인지, 예전 경로(bookjeok-api…)인지
// - Cloudflare 거점(cf-ray 끝 3글자): ICN 이면 서울, SEA·LAX·NRT 등이면 해외를 돌아온 것
// - 받기: 브라우저→서버로 파일이 다 들어오기까지(회선·경로 속도). 검사: 형식·YARA. 저장: DB 기록.
//   받기가 길면 회선/경로 문제, 검사가 길면 서버 문제로 구분된다.
// - 끊김: 다 받기 전에 연결이 닫힌 것(사용자가 취소했거나 창을 닫았거나 회선이 끊김). 받은 만큼을 남긴다.
const UPLOAD_PATH = /^\/api\/(files\/upload(\/chunk|\/complete)?|upload-link\/[^/]+)$/;
const KEEP = 300;

const sec = (ms) => (ms / 1000).toFixed(1) + 's';
const mb = (n) => (n / 1048576).toFixed(1) + 'MB';

let seq = 0;
const active = new Map();   // id → 진행 중 업로드
const recent = [];          // 최근 결과(최신이 앞)

function who(req) {
  if (req.user) return { id: req.user.id, name: req.user.display_name || req.user.username || `#${req.user.id}` };
  if (req._uploadReq) return { id: null, name: `외부 링크 '${req._uploadReq.label || ''}'`, ownerId: req._uploadReq.owner_id };
  return { id: null, name: req.originalUrl.includes('/upload-link/') ? '외부 링크' : '(로그인 전)' };
}

function middleware(req, res, next) {
  if (req.method !== 'POST' || !UPLOAD_PATH.test(String(req.originalUrl || '').split('?')[0])) return next();
  const t0 = Date.now();
  const sock = req.socket;
  const read0 = (sock && sock.bytesRead) || 0;
  const ray = String(req.headers['cf-ray'] || '');
  const e = {
    id: ++seq, start: t0,
    host: req.get('host') || '-', colo: ray.includes('-') ? ray.split('-').pop() : '-',
    kind: req.originalUrl.includes('/chunk') ? '조각' : req.originalUrl.includes('/complete') ? '조각합치기' : '파일',
    total: Number(req.headers['content-length']) || 0,
  };
  e.received = () => Math.max(0, ((sock && sock.bytesRead) || 0) - read0);
  active.set(e.id, { e, req });

  // 실패 사유를 기록하려고 이 요청의 JSON 응답에서 error 문구만 엿본다
  const json = res.json.bind(res);
  res.json = (body) => { if (body && body.error) e.error = String(body.error).slice(0, 200); return json(body); };

  let closed = false;
  const finish = (cut) => {
    if (closed) return; closed = true;
    active.delete(e.id);
    try {
      const end = Date.now();
      const u = who(req);
      // 받다가 끊기면 multer 가 반쯤 만든 항목이 남아 이름이 없을 수 있다
      const nameOf = (f) => (f && typeof f.originalname === 'string' ? Buffer.from(f.originalname, 'latin1').toString('utf8') : null);
      const files = [...(Array.isArray(req.files) ? req.files : []), ...(req.file ? [req.file] : [])].map(nameOf).filter(Boolean);
      const rec = {
        at: new Date(t0).toISOString(), result: cut ? 'cut' : res.statusCode < 400 ? 'ok' : 'fail', code: cut ? null : res.statusCode,
        host: e.host, colo: e.colo, user: u.name, userId: u.id, kind: e.kind,
        files: files.slice(0, 5), fileCount: files.length,
        bytes: cut ? Math.min(e.received(), e.total || Infinity) : e.total, total: e.total,
        recvMs: req._upRecv ? req._upRecv - t0 : null,
        scanMs: req._upRecv && req._upScan ? req._upScan - req._upRecv : null,
        saveMs: req._upScan ? end - req._upScan : null,
        totalMs: end - t0, error: cut ? '다 받기 전에 연결이 끊겼습니다(취소·창 닫기·회선 끊김)' : (res.statusCode >= 400 ? e.error || '' : ''),
      };
      recent.unshift(rec); if (recent.length > KEEP) recent.length = KEEP;

      const parts = [];
      if (rec.recvMs != null) parts.push(`받기 ${sec(rec.recvMs)}${rec.recvMs > 0 && rec.total ? ` (${mb(rec.total / (rec.recvMs / 1000))}/s)` : ''}`);
      if (rec.scanMs != null) parts.push(`검사 ${sec(rec.scanMs)}`);
      if (rec.saveMs != null) parts.push(`저장 ${sec(rec.saveMs)}`);
      parts.push(`전체 ${sec(rec.totalMs)}`);
      const what = e.kind === '파일' ? `${rec.fileCount}개` : e.kind;
      if (cut) console.log(`[upload] 끊김 ${rec.host} ${rec.colo} ${rec.user} ${mb(rec.bytes)}/${mb(rec.total)} 받다가 · ${sec(rec.totalMs)}`);
      else console.log(`[upload] ${rec.code} ${rec.host} ${rec.colo} ${rec.user} ${what} ${mb(rec.total)} · ${parts.join(' · ')}${rec.error ? ` · ${rec.error}` : ''}`);
    } catch (err) { console.warn('[upload] 기록 실패:', err.message); }   // 응답에는 영향 없음
  };
  res.on('finish', () => finish(false));
  res.on('close', () => finish(!res.writableFinished));
  next();
}

// 핸들러 맨 앞(=파일을 다 받은 직후)과 보안 검사 직후에 표시
const received = (req) => { req._upRecv = Date.now(); };
const scanned = (req) => { req._upScan = Date.now(); };

// 관리자 화면용: 지금 올라가는 중인 것 + 최근 결과
function snapshot(limit = 50) {
  const now = Date.now();
  return {
    active: [...active.values()].map(({ e, req }) => {
      const u = who(req);
      const got = Math.min(e.received(), e.total || Infinity);
      return { at: new Date(e.start).toISOString(), host: e.host, colo: e.colo, user: u.name, kind: e.kind, bytes: got, total: e.total, elapsedMs: now - e.start, stage: req._upScan ? '저장' : req._upRecv ? '검사' : '받는 중' };
    }).sort((a, b) => a.at.localeCompare(b.at)),
    recent: recent.slice(0, limit),
    since: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  };
}

module.exports = { middleware, received, scanned, snapshot };
