'use strict';

// ClamAV(clamd) INSTREAM 연동 — 업로드 파일 바이러스 검사.
// CLAMAV_HOST 가 설정된 경우에만 동작. 미설정/장애 시에는 통과(fail-open)시켜
// 서비스 가용성을 우선한다(실제 바이러스 탐지(FOUND) 시에만 차단).
const net = require('net');
const fs = require('fs');

const HOST = process.env.CLAMAV_HOST || '';
const PORT = parseInt(process.env.CLAMAV_PORT || '3310', 10);
const TIMEOUT = parseInt(process.env.CLAMAV_TIMEOUT_MS || '30000', 10);

const enabled = () => !!HOST;

// 반환: { ok:true }(정상/건너뜀/장애) 또는 { ok:false, virus:'..' }(탐지)
function scanFile(filePath) {
  return new Promise((resolve) => {
    if (!HOST) return resolve({ ok: true, skipped: true });
    let reply = '';
    let done = false;
    const socket = net.connect(PORT, HOST);
    const finish = (r) => { if (done) return; done = true; try { socket.destroy(); } catch (_) { /* noop */ } resolve(r); };
    socket.setTimeout(TIMEOUT);
    socket.on('timeout', () => { console.warn('[av] clamd timeout — 통과'); finish({ ok: true, error: 'timeout' }); });
    socket.on('error', (e) => { console.warn('[av] clamd 오류 — 통과:', e.message); finish({ ok: true, error: e.message }); });
    socket.on('data', (d) => { reply += d.toString('utf8'); });
    socket.on('end', () => {
      const r = reply.trim();
      if (/\bOK$/.test(r)) return finish({ ok: true });
      const m = /:\s*(.+?)\s+FOUND$/.exec(r);
      if (m) return finish({ ok: false, virus: m[1] });
      console.warn('[av] 예기치 못한 응답 — 통과:', r);
      finish({ ok: true, error: r || 'no-reply' });
    });
    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      const rs = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
      rs.on('data', (chunk) => { const sz = Buffer.alloc(4); sz.writeUInt32BE(chunk.length, 0); socket.write(sz); socket.write(chunk); });
      rs.on('end', () => { const end = Buffer.alloc(4); end.writeUInt32BE(0, 0); socket.write(end); });
      rs.on('error', (e) => { console.warn('[av] 파일 읽기 오류 — 통과:', e.message); finish({ ok: true, error: 'read' }); });
    });
  });
}

module.exports = { enabled, scanFile };
