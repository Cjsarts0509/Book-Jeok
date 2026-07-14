'use strict';

// 클래식 YARA(로컬 룰 매칭) 연동 — 업로드 파일의 악성 패턴 검사.
// 완전 오프라인(파일·해시 외부 전송 없음). 룰은 이미지에 정적으로 번들.
// 방침: 바이너리 미설치/룰 오류/타임아웃 등 장애 시 통과(fail-open)로 가용성 우선,
//       명백한 룰 매칭(악성 패턴)일 때만 차단.
const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const RULES = process.env.YARA_RULES || path.join(__dirname, '..', 'yara-rules', 'bookjeok.yar');
const TIMEOUT = parseInt(process.env.YARA_TIMEOUT_MS || '20000', 10);
const DISABLED = process.env.YARA_ENABLED === '0';

const hasRules = () => { try { return fs.existsSync(RULES); } catch (_) { return false; } };

// yara 바이너리 실행 가능 여부를 1회 확인하고 캐시(대시보드 상태를 정확히 표시).
let binaryOk = null;
let binaryMissing = false; // 스캔 중 바이너리가 사라진 경우 경고 1회만 출력하기 위한 플래그
function binaryAvailable() {
  if (binaryOk === null) {
    try { execFileSync('yara', ['--version'], { timeout: 5000, stdio: 'ignore' }); binaryOk = true; }
    catch (_) { binaryOk = false; console.warn('[yara] yara 바이너리를 찾지 못함 — 검사 건너뜀(대시보드: 꺼짐)'); }
  }
  return binaryOk;
}

// 대시보드 표시용: 비활성화 아님 + 룰 존재 + 바이너리 실행 가능일 때만 '켜짐'
const enabled = () => !DISABLED && hasRules() && binaryAvailable();

// 반환: { ok:true }(정상/건너뜀/장애) 또는 { ok:false, rule:'..' }(악성 패턴 매칭)
function scanFile(filePath) {
  return new Promise((resolve) => {
    if (DISABLED || !hasRules() || !binaryAvailable()) return resolve({ ok: true, skipped: true });
    // yara [OPTIONS] RULES FILE → 매칭 시 "<rulename> <path>" 한 줄씩 stdout, 매칭 없으면 빈 출력.
    execFile('yara', ['--no-warnings', '-f', RULES, filePath], { timeout: TIMEOUT, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) {
        if (err.code === 'ENOENT') { if (!binaryMissing) console.warn('[yara] yara 미설치 — 검사 건너뜀'); binaryMissing = true; }
        else console.warn('[yara] 검사 오류 — 통과:', err.message);
        return resolve({ ok: true, error: err.message }); // fail-open
      }
      const line = String(stdout || '').trim();
      if (line) return resolve({ ok: false, rule: line.split(/\s+/)[0] });
      resolve({ ok: true });
    });
  });
}

module.exports = { enabled, scanFile };
