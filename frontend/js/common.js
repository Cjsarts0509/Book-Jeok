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

  // 공지 리치텍스트 등 HTML을 허용 태그/속성만 남기고 정화 (저장형 XSS 방지)
  const SANITIZE = {
    tags: new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'P', 'BR', 'DIV', 'SPAN', 'FONT', 'UL', 'OL', 'LI', 'A', 'IMG', 'H1', 'H2', 'H3', 'H4', 'BLOCKQUOTE', 'PRE', 'CODE', 'HR']),
    remove: new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'SVG', 'MATH', 'BASE', 'TEMPLATE']),
    attrs: { A: ['href', 'target', 'rel'], IMG: ['src', 'alt', 'width', 'height', 'style'], FONT: ['color', 'size', 'face', 'style'], SPAN: ['style'], DIV: ['style'], P: ['style'], LI: ['style'], H1: ['style'], H2: ['style'], H3: ['style'], H4: ['style'] },
    styleProps: new Set(['color', 'background-color', 'font-size', 'font-weight', 'font-style', 'text-decoration', 'text-align', 'font-family']),
  };
  function safeUrl(u, allowData) {
    u = String(u || '').trim();
    if (/^\s*(https?:|mailto:|tel:)/i.test(u)) return u;
    if (allowData && /^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i.test(u)) return u;
    return '';
  }
  function cleanStyle(v) {
    return String(v || '').split(';').map((d) => {
      const i = d.indexOf(':'); if (i < 0) return '';
      const prop = d.slice(0, i).trim().toLowerCase(), val = d.slice(i + 1).trim();
      if (!SANITIZE.styleProps.has(prop)) return '';
      if (/url\s*\(|expression|javascript:|<|>/i.test(val)) return '';
      return `${prop}:${val}`;
    }).filter(Boolean).join(';');
  }
  function sanitizeHtml(html) {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    const walk = (node) => {
      [...node.childNodes].forEach((el) => {
        if (el.nodeType === 3) return; // 텍스트
        if (el.nodeType !== 1) { el.remove(); return; }
        const tag = el.tagName.toUpperCase(); // SVG/MathML 등 외부요소는 소문자 → 정규화
        if (SANITIZE.remove.has(tag) || el.namespaceURI !== 'http://www.w3.org/1999/xhtml') { el.remove(); return; }
        if (!SANITIZE.tags.has(tag)) { // 허용 안 된 태그는 내용만 남기고 벗김
          const parent = el.parentNode; while (el.firstChild) parent.insertBefore(el.firstChild, el); el.remove(); walk(parent); return;
        }
        const allow = SANITIZE.attrs[tag] || [];
        [...el.attributes].forEach((a) => {
          const n = a.name.toLowerCase();
          if (n.startsWith('on') || !allow.includes(n)) { el.removeAttribute(a.name); return; }
          if (n === 'href') { const s = safeUrl(a.value, false); if (s) el.setAttribute('href', s); else el.removeAttribute('href'); }
          else if (n === 'src') { const s = safeUrl(a.value, true); if (s) el.setAttribute('src', s); else el.remove(); }
          else if (n === 'style') { const s = cleanStyle(a.value); if (s) el.setAttribute('style', s); else el.removeAttribute('style'); }
        });
        if (tag === 'A') { el.setAttribute('rel', 'noopener noreferrer nofollow'); el.setAttribute('target', '_blank'); }
        walk(el);
      });
    };
    walk(doc.body);
    return doc.body.innerHTML;
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
    backdrop.innerHTML = `<div class="modal"><button class="modal-x" type="button" aria-label="닫기">✕</button><div class="modal-scroll">${html}</div></div>`;
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

  // ── 폴더 계층 트리맵(SpaceSniffer식) ──────────────────────────
  // container: 렌더 대상 요소, folders: [{folder, used, files}], opts: {height, rootLabel}
  // 폴더를 한 단계씩 드릴다운(📁 하위 있음 / 📂 없음 / 📄 이 폴더 파일) + 브레드크럼.
  function folderTreemap(container, folders, opts = {}) {
    const H = opts.height || 460;
    const rootLabel = opts.rootLabel || '홈(최상위)';
    let path = '/';
    container.classList.add('tm-wrap');
    container.innerHTML = `<div class="tm-bar"><div class="tm-crumb"></div><div class="muted" style="font-size:12px">타일 크기 = 사용량 · 폴더를 클릭하면 하위로</div></div><div class="treemap"></div><div class="tm-tip" style="display:none"></div>`;
    const box = container.querySelector('.treemap');
    const crumbEl = container.querySelector('.tm-crumb');
    const tip = container.querySelector('.tm-tip');

    function buildTree() {
      const nodes = new Map();
      const parentOf = (p) => { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
      const ensure = (p) => {
        if (nodes.has(p)) return nodes.get(p);
        const name = p === '/' ? rootLabel : p.slice(p.lastIndexOf('/') + 1);
        const node = { path: p, name, selfBytes: 0, selfFiles: 0, children: [] };
        nodes.set(p, node);
        if (p !== '/') ensure(parentOf(p)).children.push(node);
        return node;
      };
      ensure('/');
      for (const r of (folders || [])) { const n = ensure(r.folder || '/'); n.selfBytes += Number(r.used) || 0; n.selfFiles += Number(r.files) || 0; }
      const total = (n) => { let b = n.selfBytes, f = n.selfFiles; for (const c of n.children) { const [cb, cf] = total(c); b += cb; f += cf; } n.totalBytes = b; n.totalFiles = f; return [b, f]; };
      total(nodes.get('/'));
      return nodes;
    }
    function squarify(items, W, Ht) {
      const totalV = items.reduce((s, i) => s + i.value, 0) || 1;
      const scale = (W * Ht) / totalV;
      const data = items.map((i) => ({ ...i, area: Math.max(i.value * scale, 0) })).sort((a, b) => b.area - a.area);
      const out = []; let rect = { x: 0, y: 0, w: W, h: Ht }; let row = [];
      const worst = (r, len) => { const sum = r.reduce((s, x) => s + x.area, 0); const mx = Math.max(...r.map((x) => x.area)); const mn = Math.min(...r.map((x) => x.area)); const l2 = len * len, s2 = sum * sum; return Math.max((l2 * mx) / s2, s2 / (l2 * mn)); };
      const lay = (r, rc, horiz) => { const sum = r.reduce((s, x) => s + x.area, 0); let off = 0; if (horiz) { const rh = sum / rc.w; for (const x of r) { const rw = x.area / rh; out.push({ ...x, x: rc.x + off, y: rc.y, w: rw, h: rh }); off += rw; } return { x: rc.x, y: rc.y + rh, w: rc.w, h: rc.h - rh }; } const rw = sum / rc.h; for (const x of r) { const rh = x.area / rw; out.push({ ...x, x: rc.x, y: rc.y + off, w: rw, h: rh }); off += rh; } return { x: rc.x + rw, y: rc.y, w: rc.w - rw, h: rc.h }; };
      const rem = data.slice();
      while (rem.length) { const horiz = rect.w >= rect.h; const len = horiz ? rect.w : rect.h; if (!row.length) { row.push(rem.shift()); continue; } if (worst(row, len) >= worst([...row, rem[0]], len)) row.push(rem.shift()); else { rect = lay(row, rect, horiz); row = []; } }
      if (row.length) lay(row, rect, rect.w >= rect.h);
      return out;
    }
    const ocean = (t) => { t = Math.max(0.08, Math.min(1, t)); return `hsl(195,75%,${64 - t * 34}%)`; };

    function draw() {
      const tree = buildTree();
      const node = tree.get(path) || tree.get('/');
      const tiles = node.children.filter((c) => c.totalBytes > 0).map((c) => ({ value: c.totalBytes, node: c }));
      if (node.selfBytes > 0) tiles.push({ value: node.selfBytes, files: true, filesCount: node.selfFiles });
      // 브레드크럼
      const segs = path.split('/').filter(Boolean);
      let html = (segs.length ? `<a href="#" class="tm-link" data-path="/">${escapeHtml(rootLabel)}</a>` : `<b>${escapeHtml(rootLabel)}</b>`);
      let accP = '';
      segs.forEach((seg, i) => { accP += '/' + seg; const last = i === segs.length - 1; html += ' <span class="muted">/</span> ' + (last ? `<b>${escapeHtml(seg)}</b>` : `<a href="#" class="tm-link" data-path="${escapeHtml(accP)}">${escapeHtml(seg)}</a>`); });
      crumbEl.innerHTML = html;
      crumbEl.querySelectorAll('[data-path]').forEach((a) => a.onclick = (e) => { e.preventDefault(); path = a.dataset.path; draw(); });

      const W = box.clientWidth || 760;
      box.style.height = H + 'px';
      if (!tiles.length) { box.innerHTML = '<div class="empty" style="height:100%">이 폴더에는 파일이 없습니다.</div>'; return; }
      const rects = squarify(tiles, W, H);
      const maxV = Math.max(...tiles.map((t) => t.value));
      box.innerHTML = rects.map((r) => {
        let name, sub, color, drill = false, pathAttr = '';
        if (r.files) { color = '#8592a0'; name = '📄 이 폴더 파일'; sub = `${bytes(r.value)} · ${r.filesCount}개`; }
        else { const n = r.node; const kids = n.children.length; color = ocean(r.value / maxV); name = (kids ? '📁 ' : '📂 ') + n.name; sub = `${bytes(n.totalBytes)} · ${n.totalFiles}개${kids ? ' · 하위 ' + kids : ''}`; drill = kids > 0; pathAttr = ` data-tpath="${escapeHtml(n.path)}"`; }
        const small = r.w < 60 || r.h < 32;
        return `<div class="tm-tile${drill ? '' : ' nodrill'}" data-drill="${drill ? 1 : 0}"${pathAttr} style="left:${r.x}px;top:${r.y}px;width:${Math.max(0, r.w - 2)}px;height:${Math.max(0, r.h - 2)}px;background:${color}" data-name="${escapeHtml(name)}" data-sub="${escapeHtml(sub)}">${small ? '' : `<div class="tm-name">${escapeHtml(name)}</div><div class="tm-sub">${escapeHtml(sub)}</div>`}</div>`;
      }).join('');
      box.querySelectorAll('.tm-tile').forEach((el) => {
        el.addEventListener('mousemove', (e) => { tip.style.display = 'block'; tip.innerHTML = `<b>${el.dataset.name}</b><br>${el.dataset.sub}`; const cr = container.getBoundingClientRect(); tip.style.left = (e.clientX - cr.left + 12) + 'px'; tip.style.top = (e.clientY - cr.top + 12) + 'px'; });
        el.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
        if (el.dataset.drill === '1') el.addEventListener('click', () => { path = el.dataset.tpath; draw(); });
      });
    }
    draw();
    return { redraw: draw };
  }

  return { toast, bytes, date, fileIcon, extIcon, EXT_CATALOG, escapeHtml, sanitizeHtml, isRecent, modal, confirm, folderTreemap };
})();
