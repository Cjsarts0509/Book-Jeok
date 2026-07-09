/* 공통 유틸: 토스트, 포맷, 파일 아이콘 */
const UI = (() => {
  function toast(msg, type = '') {
    let wrap = document.getElementById('toast-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'toast-wrap';
      document.body.appendChild(wrap);
    }
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 300);
    }, 2800);
  }

  function bytes(n) {
    n = Number(n) || 0;
    if (n === 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(n) / Math.log(1024));
    return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
  }

  function date(iso) {
    const d = new Date(iso);
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  }

  // 대표 확장자 카탈로그 (관리자 선택 UI · 필터 · 아이콘 공용)
  const EXT_CATALOG = [
    { group: '문서', icon: '📄', exts: ['pdf', 'doc', 'docx', 'hwp', 'hwpx', 'txt', 'md', 'rtf', 'odt', 'pages'] },
    { group: '스프레드시트', icon: '📗', exts: ['xls', 'xlsx', 'xlsm', 'xlsb', 'csv', 'ods', 'numbers'] },
    { group: '프레젠테이션', icon: '📙', exts: ['ppt', 'pptx', 'odp', 'key'] },
    { group: '이미지', icon: '🖼️', exts: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'svg', 'heic', 'ico', 'psd', 'ai'] },
    { group: '동영상', icon: '🎬', exts: ['mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp'] },
    { group: '오디오', icon: '🎵', exts: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus', 'aiff', 'mid'] },
    { group: '압축', icon: '🗜️', exts: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz', 'iso', 'alz'] },
    { group: '코드/웹', icon: '📜', exts: ['html', 'css', 'js', 'ts', 'jsx', 'tsx', 'json', 'xml', 'yml', 'yaml', 'py', 'java', 'c', 'cpp', 'cs', 'go', 'rb', 'php', 'sh', 'sql', 'kt', 'swift', 'rs', 'vue'] },
    { group: '실행/설치', icon: '⚙️', exts: ['exe', 'msi', 'apk', 'dmg', 'deb', 'app', 'bat', 'jar'] },
    { group: '폰트', icon: '🔤', exts: ['ttf', 'otf', 'woff', 'woff2', 'eot'] },
    { group: '기타', icon: '🗂️', exts: ['epub', 'torrent', 'db', 'sqlite', 'log', 'dat', 'bak', 'ini', 'cfg', 'env'] },
  ];
  const ICON_OVERRIDE = { pdf: '📕', doc: '📘', docx: '📘', hwp: '📝', hwpx: '📝', csv: '📊', md: '📄', txt: '📄' };
  const EXT_ICONS = {};
  for (const g of EXT_CATALOG) for (const e of g.exts) EXT_ICONS[e] = ICON_OVERRIDE[e] || g.icon;
  const extIcon = (ext) => EXT_ICONS[String(ext || '').toLowerCase()] || '📄';
  function fileIcon(name) { return extIcon((name.split('.').pop() || '')); }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // 최근성 판단 (기본 7일 이내)
  function isRecent(iso, days = 7) {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return !!t && (Date.now() - t) < days * 86400000;
  }

  // 간단 모달
  function modal(html, { onClose } = {}) {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `<div class="modal"><button class="modal-x" type="button" aria-label="닫기">✕</button>${html}</div>`;
    document.body.appendChild(backdrop);
    // 부드러운 등장 애니메이션
    requestAnimationFrame(() => backdrop.classList.add('open'));
    let closed = false;
    function close() {
      if (closed) return; closed = true;
      backdrop.classList.remove('open');
      document.removeEventListener('keydown', onKey);
      setTimeout(() => backdrop.remove(), 200);
      if (typeof onClose === 'function') onClose();
    }
    // 바깥 클릭으로는 닫히지 않음 (요구사항). X 버튼 / 취소·닫기 버튼 / ESC 로만 닫힘.
    backdrop.querySelector('.modal-x').addEventListener('click', close);
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    const box = backdrop.querySelector('.modal');
    // 내용이 바뀌어 크기가 변할 때 높이를 부드럽게 애니메이션
    function animate(mutate) {
      const start = box.offsetHeight;
      mutate();
      const end = box.offsetHeight;
      if (start === end) return;
      box.style.height = start + 'px';
      box.getBoundingClientRect(); // reflow
      box.style.transition = 'height .28s cubic-bezier(.2,.9,.25,1)';
      box.style.height = end + 'px';
      const clear = () => { box.style.height = ''; box.style.transition = ''; box.removeEventListener('transitionend', clear); };
      box.addEventListener('transitionend', clear);
      setTimeout(clear, 360);
    }
    return { el: backdrop, close, animate, q: (sel) => backdrop.querySelector(sel) };
  }

  // 삭제 등 위험 동작용 확인창 (Promise<boolean>)
  function confirm({ title = '확인', message = '', confirmText = '확인', danger = false }) {
    return new Promise((resolve) => {
      const m = modal(
        `<h3>${escapeHtml(title)}</h3>
         <p style="color:var(--text-muted);line-height:1.6;white-space:pre-line">${escapeHtml(message)}</p>
         <div class="modal-actions">
           <button class="btn btn-ghost" data-c>취소</button>
           <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${escapeHtml(confirmText)}</button>
         </div>`,
        { onClose: () => resolve(false) }
      );
      m.q('[data-c]').addEventListener('click', m.close);
      m.q('[data-ok]').addEventListener('click', () => { resolve(true); m.close(); });
    });
  }

  return { toast, bytes, date, fileIcon, extIcon, EXT_CATALOG, escapeHtml, isRecent, modal, confirm };
})();
