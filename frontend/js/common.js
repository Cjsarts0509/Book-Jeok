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

  const ICONS = {
    pdf: '📕', doc: '📘', docx: '📘', xls: '📗', xlsx: '📗', csv: '📊',
    ppt: '📙', pptx: '📙', txt: '📄', md: '📄',
    jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', webp: '🖼️', svg: '🖼️',
    mp4: '🎬', mov: '🎬', avi: '🎬', mkv: '🎬',
    mp3: '🎵', wav: '🎵', flac: '🎵',
    zip: '🗜️', rar: '🗜️', '7z': '🗜️', tar: '🗜️', gz: '🗜️',
    hwp: '📝', hwpx: '📝',
  };
  function fileIcon(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    return ICONS[ext] || '📄';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
    return { el: backdrop, close, q: (sel) => backdrop.querySelector(sel) };
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

  return { toast, bytes, date, fileIcon, escapeHtml, modal, confirm };
})();
