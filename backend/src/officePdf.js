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

// soffice 는 동시에 여러 개 띄우면 프로필 충돌·메모리 폭증 → 한 번에 하나씩 직렬 처리
const jobs = []; let busy = false;
function enqueue(fn) { return new Promise((resolve, reject) => { jobs.push({ fn, resolve, reject }); pump(); }); }
async function pump() {
  if (busy) return; const j = jobs.shift(); if (!j) return;
  busy = true;
  try { j.resolve(await j.fn()); } catch (e) { j.reject(e); }
  finally { busy = false; if (jobs.length) pump(); }
}

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

module.exports = { canConvert, sofficeAvailable, convert, dropCache, CACHE_DIR };
