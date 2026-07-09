'use strict';

// 매직바이트(파일 시그니처) 검증 — 데몬/시그니처DB 불필요, 메모리 상주 0.
// 목적:
//  1) 실행 파일 위장 차단: 확장자를 .jpg 등으로 바꾼 실행 바이너리(PE/ELF/Mach-O 등)를
//     선언 확장자와 무관하게 차단한다. (확장자 화이트리스트를 우회하는 핵심 공격 방어)
//  2) 확장자-내용 불일치 탐지: 시그니처가 명확한 형식(이미지/PDF/오피스 등)은
//     선언 확장자와 실제 내용이 어긋나면 거부한다.
// 오탐을 줄이기 위해 (2)는 시그니처가 확실한 형식만 검사하고, 시그니처가 없는
// 형식(txt/csv/md 등)은 통과시킨다.
const fs = require('fs');

// 파일 앞부분만 읽어 판정 (최대 16바이트면 충분)
function readHead(filePath, len = 16) {
  return new Promise((resolve) => {
    fs.open(filePath, 'r', (err, fd) => {
      if (err) return resolve(Buffer.alloc(0));
      const buf = Buffer.alloc(len);
      fs.read(fd, buf, 0, len, 0, (e, n) => {
        fs.close(fd, () => {});
        resolve(e ? Buffer.alloc(0) : buf.subarray(0, n));
      });
    });
  });
}

const at = (buf, bytes, off = 0) => {
  if (buf.length < off + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[off + i] !== bytes[i]) return false;
  return true;
};

// 위험 실행형 시그니처 — 선언 확장자와 무관하게 차단
const EXECUTABLES = [
  { sig: [0x4D, 0x5A], label: 'Windows 실행파일(EXE/DLL)' },       // MZ
  { sig: [0x7F, 0x45, 0x4C, 0x46], label: 'Linux 실행파일(ELF)' }, // \x7fELF
  { sig: [0xFE, 0xED, 0xFA, 0xCE], label: 'macOS 실행파일(Mach-O)' },
  { sig: [0xFE, 0xED, 0xFA, 0xCF], label: 'macOS 실행파일(Mach-O)' },
  { sig: [0xCF, 0xFA, 0xED, 0xFE], label: 'macOS 실행파일(Mach-O)' },
  { sig: [0xCE, 0xFA, 0xED, 0xFE], label: 'macOS 실행파일(Mach-O)' },
  { sig: [0xCA, 0xFE, 0xBA, 0xBE], label: '실행파일(Java class/Mach-O)' },
];

// 확장자별 판정 함수 (head Buffer → boolean). 여기 없는 확장자는 검사 생략(통과).
const OLE2 = [0xD0, 0xCF, 0x11, 0xE0]; // 구형 오피스/한글 복합문서
const PKZIP = (b) => at(b, [0x50, 0x4B, 0x03, 0x04]) || at(b, [0x50, 0x4B, 0x05, 0x06]) || at(b, [0x50, 0x4B, 0x07, 0x08]);
const CHECK = {
  jpg: (b) => at(b, [0xFF, 0xD8, 0xFF]), jpeg: (b) => at(b, [0xFF, 0xD8, 0xFF]),
  png: (b) => at(b, [0x89, 0x50, 0x4E, 0x47]),
  gif: (b) => at(b, [0x47, 0x49, 0x46, 0x38]),
  bmp: (b) => at(b, [0x42, 0x4D]),
  webp: (b) => at(b, [0x52, 0x49, 0x46, 0x46]) && at(b, [0x57, 0x45, 0x42, 0x50], 8),
  pdf: (b) => at(b, [0x25, 0x50, 0x44, 0x46]), // %PDF
  mp4: (b) => at(b, [0x66, 0x74, 0x79, 0x70], 4), // ftyp
  zip: PKZIP, docx: PKZIP, xlsx: PKZIP, pptx: PKZIP, hwpx: PKZIP,
  doc: (b) => at(b, OLE2), xls: (b) => at(b, OLE2), ppt: (b) => at(b, OLE2), hwp: (b) => at(b, OLE2),
  gz: (b) => at(b, [0x1F, 0x8B]),
  rar: (b) => at(b, [0x52, 0x61, 0x72, 0x21]),
  '7z': (b) => at(b, [0x37, 0x7A, 0xBC, 0xAF]),
};

// 내용에서 '명백한 이진 형식'을 식별(위장 탐지용). 텍스트/미확인은 null.
// 짧은(2바이트) 시그니처는 텍스트 오탐 위험이 있어 제외하고, 길고 고유한 것만 사용.
function detectBinary(head) {
  if (at(head, [0x50, 0x4B, 0x03, 0x04]) || at(head, [0x50, 0x4B, 0x05, 0x06]) || at(head, [0x50, 0x4B, 0x07, 0x08])) return '압축/오피스 문서(ZIP)';
  if (at(head, OLE2)) return '구형 오피스/한글 문서(OLE2)';
  if (at(head, [0x25, 0x50, 0x44, 0x46])) return 'PDF';
  if (at(head, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return 'PNG 이미지';
  if (at(head, [0xFF, 0xD8, 0xFF])) return 'JPEG 이미지';
  if (at(head, [0x47, 0x49, 0x46, 0x38])) return 'GIF 이미지';
  if (at(head, [0x52, 0x61, 0x72, 0x21, 0x1A, 0x07])) return 'RAR 압축';
  if (at(head, [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C])) return '7z 압축';
  if (at(head, [0x52, 0x49, 0x46, 0x46]) && at(head, [0x57, 0x45, 0x42, 0x50], 8)) return 'WEBP 이미지';
  return null;
}

// 반환: { ok:true } 또는 { ok:false, reason:'..' }
async function verify(filePath, declaredName) {
  const head = await readHead(filePath);
  if (!head.length) return { ok: true }; // 읽기 실패/빈 파일 → 통과(fail-open)

  // 1) 실행 바이너리 차단 (확장자 무관)
  for (const e of EXECUTABLES) {
    if (at(head, e.sig)) return { ok: false, reason: `실행 파일로 확인됨(${e.label})` };
  }

  const ext = String(declaredName || '').split('.').pop().toLowerCase();
  const check = CHECK[ext];
  if (check) {
    // 2a) 시그니처가 확실한 형식: 선언 확장자와 실제 내용이 맞아야 함
    if (!check(head)) return { ok: false, reason: `내용이 .${ext} 형식과 일치하지 않음` };
  } else {
    // 2b) 시그니처 없는 형식(txt/csv 등): 내용이 명백한 이진 형식이면 위장으로 간주
    const bin = detectBinary(head);
    if (bin) return { ok: false, reason: `실제 내용은 ${bin} 형식입니다(.${ext}로 위장)` };
  }
  return { ok: true };
}

module.exports = { verify };
