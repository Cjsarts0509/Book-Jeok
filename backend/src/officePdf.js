// 오피스 문서(PPT/PPTX/DOC/DOCX 등) → PDF 변환 (LibreOffice headless).
// 완전한 레이아웃 렌더링을 위해 서버에서 PDF 로 변환하고, 결과를 파일별로 캐시한다.
// LibreOffice 가 없으면 sofficeAvailable()=false → 라우터가 501 로 응답(프런트는 텍스트 미리보기로 폴백).
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const config = require('./config');

const CACHE_DIR = path.join(config.storageRoot, '_pdfcache');
// LibreOffice 로 열 수 있는(=완전 렌더) 형식. 엑셀/CSV 는 표 뷰가 더 나아 프런트에서 별도 처리.
const CONVERTIBLE = new Set(['ppt', 'pptx', 'ppsx', 'pps', 'doc', 'docx', 'odp', 'odt', 'rtf']);

let sofficeOk = null;
function canConvert(ext) { return CONVERTIBLE.has(String(ext || '').toLowerCase()); }
function sofficeAvailable() {
  if (sofficeOk !== null) return sofficeOk;
  try { execFileSync('soffice', ['--version'], { timeout: 10000, stdio: 'ignore' }); sofficeOk = true; }
  catch (_) { sofficeOk = false; console.warn('[officePdf] soffice 없음 — 오피스 PDF 미리보기 비활성(프런트는 텍스트 폴백)'); }
  return sofficeOk;
}

// soffice 는 동시에 여러 개 띄우면 프로필 충돌·메모리 폭증 → 한 번에 하나씩 직렬 처리.
//
// S23 · 백프레셔: 직렬 처리만으로는 부족하다. 여러 사람이 동시에 문서를 열면 요청이
// 끝없이 줄을 서고, 뒤에 선 사람은 몇 분씩 하얀 화면을 본다. 그래서
//   · 줄 길이에 상한을 두고(넘으면 즉시 '지금 붐빕니다'로 거절 — 무한 대기보다 낫다)
//   · 줄에서 기다리는 시간에도 상한을 둔다(내 차례가 와도 이미 늦었으면 의미가 없다).
const QUEUE_MAX = parseInt(process.env.PDF_QUEUE_MAX || '12', 10);
const QUEUE_WAIT_MS = parseInt(process.env.PDF_QUEUE_WAIT_MS || '60000', 10);
const jobs = []; let busy = false;
const convertStats = { queued: 0, running: 0, done: 0, failed: 0, rejected: 0, timedOut: 0, peakQueue: 0, lastMs: 0 };

class BusyError extends Error {
  constructor(msg) { super(msg); this.status = 503; this.code = 'converter_busy'; }
}

function enqueue(fn) {
  if (jobs.length >= QUEUE_MAX) {
    convertStats.rejected++;
    return Promise.reject(new BusyError(`문서 변환이 밀려 있습니다(대기 ${jobs.length}건). 잠시 후 다시 열어 주세요.`));
  }
  return new Promise((resolve, reject) => {
    const job = { fn, resolve, reject, at: Date.now(), timedOut: false };
    // 줄에서 너무 오래 기다렸으면 시작하지 않고 포기한다 — 이미 사용자는 떠났을 것이다
    job.timer = setTimeout(() => {
      job.timedOut = true;
      const i = jobs.indexOf(job);
      if (i >= 0) jobs.splice(i, 1);
      convertStats.timedOut++;
      convertStats.queued = jobs.length;
      reject(new BusyError('문서 변환 대기가 너무 길어 취소했습니다. 잠시 후 다시 시도해 주세요.'));
    }, QUEUE_WAIT_MS);
    job.timer.unref();
    jobs.push(job);
    convertStats.queued = jobs.length;
    convertStats.peakQueue = Math.max(convertStats.peakQueue, jobs.length);
    pump();
  });
}
async function pump() {
  if (busy) return;
  const j = jobs.shift();
  convertStats.queued = jobs.length;
  if (!j) return;
  clearTimeout(j.timer);
  if (j.timedOut) return pump();          // 대기 중 포기된 작업은 건너뛴다
  busy = true; convertStats.running = 1;
  const started = Date.now();
  try { j.resolve(await j.fn()); convertStats.done++; }
  catch (e) { convertStats.failed++; j.reject(e); }
  finally {
    busy = false; convertStats.running = 0;
    convertStats.lastMs = Date.now() - started;
    if (jobs.length) pump();
  }
}
const stats = () => ({ ...convertStats, queueMax: QUEUE_MAX, waitMaxMs: QUEUE_WAIT_MS });

// srcPath: 저장된 실물(확장자 없음) · ext: 원본 확장자 · cacheKey: 파일별 불변 키(stored_name)
// 반환: 캐시된 PDF 경로. 이미 있으면 즉시 반환.
async function convert(srcPath, ext, cacheKey) {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  const outPdf = path.join(CACHE_DIR, `${cacheKey}.pdf`);
  try { await fsp.access(outPdf); return outPdf; } catch (_) { /* 캐시 미스 → 변환 */ }
  return enqueue(() => new Promise((resolve, reject) => {
    (async () => {
      const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'bjpdf-'));
      const cleanExt = String(ext).toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
      const input = path.join(work, `input.${cleanExt}`);      // LibreOffice 는 확장자로 입력 필터를 고름
      await fsp.copyFile(srcPath, input);
      const args = ['--headless', '--norestore', '--nolockcheck',
        `-env:UserInstallation=file://${path.join(work, 'profile')}`,
        '--convert-to', 'pdf', '--outdir', work, input];
      // 환경변수를 통째로 물려주지 않는다. LibreOffice 는 신뢰할 수 없는 문서를 파싱하는 최대 공격면이라,
      // 만에 하나 문서 파싱 취약점으로 장악돼도 MASTER_KEY·JWT_SECRET·DB_PASSWORD 가 새지 않도록
      // 실행에 꼭 필요한 값만 넘긴다.
      const p = spawn('soffice', args, {
        env: { HOME: work, PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', LC_ALL: 'C.UTF-8', TMPDIR: work },
      });
      let errBuf = '';
      p.stderr.on('data', (d) => { errBuf += d.toString(); });
      const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} }, 90000);
      p.on('error', (e) => { clearTimeout(timer); fsp.rm(work, { recursive: true, force: true }).catch(() => {}); reject(e); });
      p.on('close', async () => {
        clearTimeout(timer);
        const produced = path.join(work, 'input.pdf');
        try {
          await fsp.access(produced);
          try { await fsp.rename(produced, outPdf); } catch (_) { await fsp.copyFile(produced, outPdf); }
          resolve(outPdf);
        } catch (_) {
          reject(new Error('변환 실패' + (errBuf ? `: ${errBuf.slice(0, 160)}` : '')));
        } finally {
          fsp.rm(work, { recursive: true, force: true }).catch(() => {});
        }
      });
    })().catch(reject);
  }));
}

// 파일이 완전히 삭제될 때 캐시 정리(선택적으로 호출)
async function dropCache(cacheKey) {
  try { await fsp.unlink(path.join(CACHE_DIR, `${cacheKey}.pdf`)); } catch (_) { /* noop */ }
}

module.exports = {
  canConvert, sofficeAvailable, convert, dropCache, stats, CACHE_DIR,
  enqueue,   // 백프레셔 동작을 직접 검증하기 위해 노출(변환 외 용도로 쓰지 말 것)
};
