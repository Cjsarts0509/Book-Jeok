/* 북적북적 메인 앱 — 파일 웹하드 (v3) */
const App = (() => {
  const state = {
    user: null, folder: '/', ownerId: null, ownerName: null,
    files: [], folders: [], treeFolders: [], usage: null, accounts: [],
    view: localStorage.getItem('bj_view') || 'list',
    branches: [],
    allowedExt: ['csv', 'xls', 'xlsx', 'jpg', 'png', 'gif', 'ppt', 'pptx', 'doc', 'docx', 'txt'],
    selected: new Map(), // key -> {type:'file'|'folder', id, path, name}
  };
  const root = () => document.getElementById('app');
  const isPriv = () => state.user && (state.user.role === 'admin' || state.user.role === 'manager');
  const roleLabel = (r) => ({ admin: '관리자', manager: '담당자', user: '일반' }[r] || r);
  const selKey = (i) => (i.type === 'file' ? `file:${i.id}` : `folder:${i.path}`);

  async function boot() {
    if (API.hasToken()) { try { state.user = (await API.me()).user; return renderApp(); } catch { API.setToken(null); } }
    renderLogin();
  }

  function renderLogin() {
    root().innerHTML = `
      <div class="login-screen">
        <form class="login-card" id="login-form">
          <img src="assets/logo.svg?v=8" class="login-logo" alt="북적북적">
          <div class="login-title">북적북적</div>
          <div class="login-sub">Book-Jeok · 우리끼리 나누는 파일 창고</div>
          <div class="field"><label>아이디</label><input class="input" name="username" autocomplete="username" placeholder="아이디" required></div>
          <div class="field"><label>비밀번호</label><input class="input" name="password" type="password" autocomplete="current-password" placeholder="비밀번호" required></div>
          <button class="btn btn-primary" style="width:100%;margin-top:6px" type="submit">로그인</button>
        </form>
      </div>`;
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault(); const f = e.target, btn = f.querySelector('button');
      btn.disabled = true; btn.textContent = '로그인 중…';
      try {
        const { token, user } = await API.login(f.username.value.trim(), f.password.value);
        API.setToken(token); state.user = user; UI.toast(`${user.displayName}님 환영합니다 🎉`, 'success'); renderApp();
      } catch (err) { UI.toast(err.message, 'error'); btn.disabled = false; btn.textContent = '로그인'; }
    });
  }

  function renderApp() {
    const admin = state.user.role === 'admin';
    root().innerHTML = `
      <div class="layout">
        <header class="appbar">
          <button class="icon-btn appbar-menu" id="menu-toggle" title="폴더">☰</button>
          <div class="brand" id="brand-home" title="홈으로"><img src="assets/logo.svg?v=8"><span class="brand-name">북적북적</span></div>
          ${isPriv() ? `<select class="input account-switcher" id="account-switcher"><option value="">내 파일</option></select>` : ''}
          <div class="topbar-spacer"></div>
          <nav class="appbar-nav">
            <div class="nav-item" data-nav="files"><span class="ico">📁</span><span class="t">내 파일</span></div>
            ${admin ? '<a class="nav-item" href="admin.html"><span class="ico">⚙️</span><span class="t">관리자</span></a>' : ''}
            <div class="nav-item" data-nav="password"><span class="ico">🔑</span><span class="t">비밀번호</span></div>
            <div class="nav-item" data-nav="logout"><span class="ico">🚪</span><span class="t">로그아웃</span></div>
          </nav>
          <div class="user-chip-sm">${UI.escapeHtml(state.user.displayName)} · ${roleLabel(state.user.role)}</div>
        </header>
        <div class="body">
          <aside class="tree-sidebar" id="tree-sidebar"><div class="tree-head">폴더</div><div id="tree"></div></aside>
          <div class="tree-backdrop" id="tree-backdrop"></div>
          <main class="content" id="view"></main>
        </div>
      </div>`;
    root().querySelectorAll('.appbar-nav [data-nav]').forEach((el) => el.addEventListener('click', () => {
      const n = el.dataset.nav;
      if (n === 'logout') doLogout(); else if (n === 'password') changePasswordModal(); else if (n === 'files') resetToOwn();
    }));
    document.getElementById('menu-toggle').addEventListener('click', toggleTree);
    document.getElementById('tree-backdrop').addEventListener('click', toggleTree);
    document.getElementById('brand-home').addEventListener('click', () => { state.folder = '/'; loadFiles(); renderTree(); });
    if (isPriv()) setupAccountSwitcher();
    loadAll();
    loadBranches();
    loadAllowedExt();
    showNotices();
  }

  async function loadBranches() { try { state.branches = (await API.branches()).branches; } catch {} }
  async function loadAllowedExt() { try { const r = await API.allowedExtensions(); if (r.extensions?.length) { state.allowedExt = r.extensions; refreshDropzoneHint(); } } catch {} }
  function refreshDropzoneHint() {
    const hint = document.querySelector('.dropzone .hint'); const input = document.getElementById('file-input');
    if (hint) hint.textContent = '허용: ' + state.allowedExt.join(' · ');
    if (input) input.setAttribute('accept', state.allowedExt.map((e) => '.' + e).join(','));
  }

  // ── 공지사항 팝업 (로그인 후) ──────────
  async function showNotices() {
    try {
      const { notices } = await API.activeNotices();
      for (const n of notices) {
        const key = 'bj_notice_hide_' + n.id;
        const until = parseInt(localStorage.getItem(key) || '0', 10);
        if (until && until > Date.now()) continue; // 일주일간 보지 않기 유효
        noticePopup(n);
        break; // 한 번에 하나씩
      }
    } catch {}
  }
  function noticePopup(n) {
    const period = (n.start_at || n.end_at)
      ? `<p class="muted" style="font-size:12px;margin-bottom:10px">${n.start_at ? new Date(n.start_at).toLocaleDateString('ko-KR') : ''} ~ ${n.end_at ? new Date(n.end_at).toLocaleDateString('ko-KR') : ''}</p>` : '';
    const m = UI.modal(`<h3>📢 ${UI.escapeHtml(n.title)}</h3>${period}
      <div class="notice-body">${n.body || ''}</div>
      <div class="modal-actions" style="align-items:center">
        <label class="autosort" style="margin-right:auto"><input type="checkbox" id="hide7"> 일주일간 보지 않기</label>
        <button class="btn btn-primary" id="close">닫기</button>
      </div>`);
    m.el.querySelector('.modal').classList.add('modal-wide');
    const done = () => { if (m.q('#hide7').checked) localStorage.setItem('bj_notice_hide_' + n.id, String(Date.now() + 7 * 86400000)); m.close(); };
    m.q('#close').addEventListener('click', done);
  }

  function toggleTree() { document.getElementById('tree-sidebar').classList.toggle('open'); document.getElementById('tree-backdrop').classList.toggle('show'); }
  function resetToOwn() { state.ownerId = null; state.ownerName = null; state.folder = '/'; state.selected.clear(); const sw = document.getElementById('account-switcher'); if (sw) sw.value = ''; loadAll(); }

  async function setupAccountSwitcher() {
    try {
      const { accounts } = await API.accounts();
      state.accounts = accounts.filter((a) => a.id !== state.user.id);
      const sw = document.getElementById('account-switcher'); if (!sw) return;
      for (const a of state.accounts) { const o = document.createElement('option'); o.value = a.id; o.textContent = `${a.displayName} (@${a.username}·${roleLabel(a.role)})`; sw.appendChild(o); }
      sw.addEventListener('change', () => {
        if (!sw.value) return resetToOwn();
        const a = state.accounts.find((x) => String(x.id) === sw.value);
        state.ownerId = a.id; state.ownerName = a.displayName; state.folder = '/'; state.selected.clear(); loadAll();
      });
    } catch {}
  }

  async function doLogout() { try { await API.logout(); } catch {} API.setToken(null); state.user = null; renderLogin(); }

  async function loadAll() { await Promise.all([loadTree(), loadFiles()]); }
  async function loadTree() { try { state.treeFolders = (await API.tree(state.ownerId)).folders; renderTree(); } catch {} }
  async function loadFiles() {
    const view = document.getElementById('view');
    view.innerHTML = '<div class="empty"><div class="big">⏳</div>불러오는 중…</div>';
    try {
      const [list, usage] = await Promise.all([API.listFiles(state.folder, state.ownerId), API.usage(state.ownerId)]);
      // 방어적 정규화 (구버전 백엔드가 문자열 배열을 줘도 안전)
      state.folders = (list.folders || [])
        .map((f) => (typeof f === 'string' ? { path: f } : f))
        .filter((f) => f && f.path)
        .map((f) => ({ ...f, name: f.name || f.path.split('/').filter(Boolean).pop() || '(이름없음)' }));
      state.files = list.files || []; state.usage = usage; state.selected.clear(); renderContent();
    } catch (err) { view.innerHTML = `<div class="empty"><div class="big">⚠️</div>${UI.escapeHtml(err.message)}</div>`; }
  }

  function buildTreeNodes(paths) {
    const rootNode = { name: '홈', path: '/', children: {} };
    for (const p of paths) { const parts = p.split('/').filter(Boolean); let node = rootNode, acc = ''; for (const part of parts) { acc += '/' + part; if (!node.children[part]) node.children[part] = { name: part, path: acc, children: {} }; node = node.children[part]; } }
    return rootNode;
  }
  function renderTree() {
    const el = document.getElementById('tree'); const rootNode = buildTreeNodes(state.treeFolders);
    const render = (node, depth) => {
      const kids = Object.values(node.children).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
      const active = node.path === state.folder ? ' active' : '';
      let html = `<div class="tree-item${active}" data-folder="${UI.escapeHtml(node.path)}" style="padding-left:${8 + depth * 16}px"><span class="tico">${depth === 0 ? '🏠' : '📁'}</span><span class="tname">${UI.escapeHtml(node.name)}</span></div>`;
      for (const k of kids) html += render(k, depth + 1); return html;
    };
    el.innerHTML = render(rootNode, 0);
    el.querySelectorAll('[data-folder]').forEach((n) => n.addEventListener('click', () => { state.folder = n.dataset.folder; loadFiles(); renderTree(); if (window.innerWidth <= 768) toggleTree(); }));
  }

  function renderContent() {
    const u = state.usage; const pct = u.quotaBytes > 0 ? Math.min(100, (u.usedBytes / u.quotaBytes) * 100) : 0;
    document.getElementById('view').innerHTML = `
      ${state.ownerId ? `<div class="impersonate-banner">👁️ <b>${UI.escapeHtml(state.ownerName || '')}</b> 계정의 파일을 보는 중<div style="flex:1"></div><button class="btn btn-sm btn-secondary" id="exit-imp">내 파일로</button></div>` : ''}
      <div class="content-head">
        <div class="breadcrumb" id="crumbs"></div>
        <div style="flex:1"></div>
        <div class="viewtoggle">
          <button class="vt ${state.view === 'grid' ? 'on' : ''}" data-view="grid" title="미리보기">▦</button>
          <button class="vt ${state.view === 'list' ? 'on' : ''}" data-view="list" title="리스트">☰</button>
        </div>
        <button class="btn btn-secondary btn-sm" id="new-folder">📂 <span class="label">새 폴더</span></button>
        <button class="btn btn-primary btn-sm" id="upload-btn">⬆️ <span class="label">업로드</span></button>
      </div>
      <div class="usage-line"><span class="num">${UI.bytes(u.usedBytes)}</span><span class="muted">${u.unlimited ? '· 무제한' : (u.quotaBytes > 0 ? '/ ' + UI.bytes(u.quotaBytes) : '· 미할당')} · ${u.fileCount}개 파일</span>${!u.unlimited && u.quotaBytes > 0 ? `<span class="usage-bar" style="flex:1"><span style="width:${pct}%"></span></span>` : ''}</div>
      <label class="dropzone" id="dropzone" for="file-input">
        <div class="big">📥</div><div>여기로 끌어다 놓거나 클릭해서 업로드</div>
        <div class="hint">허용: ${state.allowedExt.join(' · ')}</div>
        <input type="file" id="file-input" multiple hidden accept="${state.allowedExt.map((e) => '.' + e).join(',')}">
      </label>
      <div id="selbar" class="selbar hidden"></div>
      <div id="listing"></div>`;
    renderCrumbs(); renderListing(); wireContent();
  }

  function renderCrumbs() {
    const parts = state.folder.split('/').filter(Boolean); let acc = '', html = `<span data-folder="/">🏠 홈</span>`;
    for (const p of parts) { acc += '/' + p; html += `<span class="sep">/</span><span data-folder="${acc}">${UI.escapeHtml(p)}</span>`; }
    const el = document.getElementById('crumbs'); el.innerHTML = html;
    el.querySelectorAll('[data-folder]').forEach((s) => s.addEventListener('click', () => { state.folder = s.dataset.folder; loadFiles(); renderTree(); }));
  }

  function renderListing() {
    const box = document.getElementById('listing');
    if (state.folders.length === 0 && state.files.length === 0) { box.innerHTML = `<div class="empty"><div class="big">🗂️</div>아직 파일이 없어요. 첫 파일을 올려보세요!</div>`; return; }
    box.innerHTML = state.view === 'grid' ? gridHTML() : listHTML();
    wireListing(); updateSelbar();
  }

  function gridHTML() {
    const folders = state.folders.map((f) => `
      <div class="file-card fade-in" data-folder-card="${UI.escapeHtml(f.path)}" title="더블클릭하여 열기">
        <div class="file-actions">
          <button class="icon-btn" data-fnote="${UI.escapeHtml(f.path)}" title="비고">📝</button>
          <button class="icon-btn" data-frename="${UI.escapeHtml(f.path)}" title="이름변경">✏️</button>
          <button class="icon-btn" data-fdel="${UI.escapeHtml(f.path)}" title="삭제">🗑️</button>
        </div>
        <div class="file-ico">📁</div>
        <div class="file-name">${UI.escapeHtml(f.name)}</div>
        <div class="file-meta num">${UI.bytes(f.size)} · ${f.createdAt ? UI.date(f.createdAt) : '폴더'}</div>
        ${f.note ? `<div class="file-note" title="${UI.escapeHtml(f.note)}">📝 ${UI.escapeHtml(f.note)}</div>` : ''}
      </div>`).join('');
    const files = state.files.map((f) => `
      <div class="file-card fade-in" data-file="${f.id}">
        <div class="file-actions">
          <button class="icon-btn" data-share="${f.id}" title="공유링크">🔗</button>
          <button class="icon-btn" data-note="${f.id}" title="비고">📝</button>
          <button class="icon-btn" data-rename="${f.id}" title="이름변경">✏️</button>
          <button class="icon-btn" data-dl="${f.id}" title="다운로드">⬇️</button>
          <button class="icon-btn" data-del="${f.id}" title="삭제">🗑️</button>
        </div>
        <div class="file-ico">${UI.fileIcon(f.name)}</div>
        <div class="file-name">${UI.escapeHtml(f.name)}</div>
        <div class="file-meta num">${UI.bytes(f.size)} · ${UI.date(f.createdAt)}</div>
        ${f.note ? `<div class="file-note" title="${UI.escapeHtml(f.note)}">📝 ${UI.escapeHtml(f.note)}</div>` : ''}
      </div>`).join('');
    return `<div class="file-grid">${folders}${files}</div>`;
  }

  function listHTML() {
    const isSel = (key) => state.selected.has(key);
    const folders = state.folders.map((f) => {
      const key = `folder:${f.path}`;
      return `<tr data-folder-row="${UI.escapeHtml(f.path)}" class="${isSel(key) ? 'sel' : ''}">
        <td><input type="checkbox" class="rowcheck" data-sel-folder="${UI.escapeHtml(f.path)}" data-name="${UI.escapeHtml(f.name)}" ${isSel(key) ? 'checked' : ''}></td>
        <td class="open-cell" data-open="${UI.escapeHtml(f.path)}" title="더블클릭하여 열기"><span class="ic">📁</span> ${UI.escapeHtml(f.name)}</td>
        <td class="num muted">${UI.bytes(f.size)}</td>
        <td class="num muted">${f.createdAt ? UI.date(f.createdAt) : '—'}</td>
        <td class="num muted">${f.noteUpdatedAt ? UI.date(f.noteUpdatedAt) : '—'}</td>
        <td class="note-cell" data-fnote="${UI.escapeHtml(f.path)}" title="클릭하여 비고 편집">${f.note ? UI.escapeHtml(f.note) : '<span class="muted">+ 비고</span>'}</td>
        <td class="row-actions"><button class="icon-btn" data-frename="${UI.escapeHtml(f.path)}" title="이름변경">✏️</button></td>
      </tr>`;
    }).join('');
    const files = state.files.map((f) => {
      const key = `file:${f.id}`;
      return `<tr data-file="${f.id}" class="${isSel(key) ? 'sel' : ''}">
        <td><input type="checkbox" class="rowcheck" data-sel-file="${f.id}" data-name="${UI.escapeHtml(f.name)}" ${isSel(key) ? 'checked' : ''}></td>
        <td><span class="ic">${UI.fileIcon(f.name)}</span> ${UI.escapeHtml(f.name)}</td>
        <td class="num muted">${UI.bytes(f.size)}</td>
        <td class="num muted">${UI.date(f.createdAt)}</td>
        <td class="num muted">${UI.date(f.updatedAt || f.createdAt)}</td>
        <td class="note-cell" data-note="${f.id}" title="클릭하여 비고 편집">${f.note ? UI.escapeHtml(f.note) : '<span class="muted">+ 비고</span>'}</td>
        <td class="row-actions"><button class="icon-btn" data-share="${f.id}" title="공유">🔗</button><button class="icon-btn" data-dl="${f.id}" title="다운로드">⬇️</button></td>
      </tr>`;
    }).join('');
    return `<div class="table-wrap fade-in"><table class="filetable">
      <thead><tr><th style="width:34px"><input type="checkbox" id="check-all"></th><th>이름</th><th style="width:84px">크기</th><th style="width:96px">등록일</th><th style="width:96px">수정일</th><th>비고</th><th style="width:70px"></th></tr></thead>
      <tbody>${folders}${files}</tbody></table></div>`;
  }

  function wireContent() {
    document.getElementById('exit-imp')?.addEventListener('click', resetToOwn);
    document.querySelectorAll('.viewtoggle .vt').forEach((b) => b.addEventListener('click', () => { state.view = b.dataset.view; localStorage.setItem('bj_view', state.view); state.selected.clear(); renderContent(); }));
    const input = document.getElementById('file-input'), dz = document.getElementById('dropzone');
    document.getElementById('upload-btn').addEventListener('click', () => input.click());
    input.addEventListener('change', () => { if (input.files.length) uploadFiles(input.files); });
    ['dragover', 'dragenter'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', (e) => { if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files); });
    document.getElementById('new-folder').addEventListener('click', newFolderModal);
  }

  function openFolder(path) { state.folder = path; loadFiles(); renderTree(); }

  function wireListing() {
    const box = document.getElementById('listing');
    // 폴더 열기 — 더블클릭으로만 진입
    box.querySelectorAll('[data-folder-card]').forEach((el) => el.addEventListener('dblclick', (e) => { if (e.target.closest('.file-actions')) return; openFolder(el.dataset.folderCard); }));
    box.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('dblclick', () => openFolder(el.dataset.open)));
    // 파일 액션
    box.querySelectorAll('[data-dl]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); downloadFile(el.dataset.dl); }));
    box.querySelectorAll('[data-del]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); deleteFile(el.dataset.del); }));
    box.querySelectorAll('[data-share]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); shareModal(el.dataset.share); }));
    box.querySelectorAll('[data-note]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); noteModal(el.dataset.note); }));
    box.querySelectorAll('[data-rename]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); renameFileModal(el.dataset.rename); }));
    // 폴더 액션
    box.querySelectorAll('[data-fnote]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); folderNoteModal(el.dataset.fnote); }));
    box.querySelectorAll('[data-frename]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); renameFolderModal(el.dataset.frename); }));
    box.querySelectorAll('[data-fdel]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); deleteFolder(el.dataset.fdel); }));
    // 체크박스 선택 (리스트 뷰)
    box.querySelectorAll('.rowcheck').forEach((c) => c.addEventListener('change', () => {
      const item = c.dataset.selFile ? { type: 'file', id: c.dataset.selFile, name: c.dataset.name } : { type: 'folder', path: c.dataset.selFolder, name: c.dataset.name };
      const key = selKey(item);
      if (c.checked) state.selected.set(key, item); else state.selected.delete(key);
      c.closest('tr').classList.toggle('sel', c.checked); updateSelbar();
    }));
    const all = document.getElementById('check-all');
    if (all) all.addEventListener('change', () => {
      state.selected.clear();
      if (all.checked) {
        state.folders.forEach((f) => state.selected.set(`folder:${f.path}`, { type: 'folder', path: f.path, name: f.name }));
        state.files.forEach((f) => state.selected.set(`file:${f.id}`, { type: 'file', id: String(f.id), name: f.name }));
      }
      renderListing();
    });
  }

  function updateSelbar() {
    const bar = document.getElementById('selbar'); if (!bar) return;
    if (state.view !== 'list' || state.selected.size === 0) {
      // 부드럽게 닫힘
      if (!bar.classList.contains('hidden') && !bar.classList.contains('closing')) {
        bar.classList.add('closing');
        setTimeout(() => { bar.classList.add('hidden'); bar.classList.remove('closing'); }, 200);
      }
      return;
    }
    bar.classList.remove('hidden', 'closing');
    bar.innerHTML = `<b>${state.selected.size}개 선택</b><div style="flex:1"></div>
      <button class="btn btn-sm btn-ghost" id="sel-rename" ${state.selected.size !== 1 ? 'disabled' : ''}>✏️ 이름변경</button>
      <button class="btn btn-sm btn-secondary" id="sel-move">📂 폴더이동</button>
      <button class="btn btn-sm btn-danger" id="sel-del">🗑️ 삭제</button>
      <button class="btn btn-sm btn-ghost" id="sel-clear">선택해제</button>`;
    bar.querySelector('#sel-clear').addEventListener('click', () => {
      state.selected.clear();
      document.querySelectorAll('#listing tr.sel').forEach((tr) => tr.classList.remove('sel'));
      document.querySelectorAll('#listing .rowcheck').forEach((c) => { c.checked = false; });
      const all = document.getElementById('check-all'); if (all) all.checked = false;
      updateSelbar();
    });
    bar.querySelector('#sel-del').addEventListener('click', bulkDelete);
    bar.querySelector('#sel-move').addEventListener('click', bulkMoveModal);
    const rn = bar.querySelector('#sel-rename');
    if (!rn.disabled) rn.addEventListener('click', () => {
      const item = [...state.selected.values()][0];
      if (item.type === 'file') renameFileModal(item.id); else renameFolderModal(item.path);
    });
  }

  async function bulkDelete() {
    const items = [...state.selected.values()];
    const folders = items.filter((i) => i.type === 'folder'), files = items.filter((i) => i.type === 'file');
    const ok = await UI.confirm({ title: '선택 항목 삭제', danger: true, confirmText: '휴지통으로',
      message: `선택한 ${items.length}개 항목을 삭제할까요?${folders.length ? `\n(폴더 ${folders.length}개는 하위 파일도 함께 삭제됩니다)` : ''}\n삭제된 항목은 관리자 휴지통에서 복원할 수 있습니다.` });
    if (!ok) return;
    try {
      if (files.length) await API.bulkDelete(files.map((f) => f.id));
      for (const fo of folders) await API.deleteFolder(fo.path, state.ownerId);
      UI.toast(`${items.length}개 삭제됨 (휴지통 이동)`, 'success'); loadAll();
    } catch (err) { UI.toast(err.message, 'error'); }
  }

  function bulkMoveModal() {
    const opts = ['/', ...state.treeFolders].map((p) => `<option value="${UI.escapeHtml(p)}">${p === '/' ? '🏠 홈(루트)' : p}</option>`).join('');
    const m = UI.modal(`<h3>선택 항목 이동</h3>
      <div class="field"><label>이동할 폴더</label><select class="input" id="dest">${opts}</select></div>
      <div class="field"><label>또는 새 폴더 경로 입력 (선택)</label><input class="input" id="newpath" placeholder="예: /2026/보고서"></div>
      <div class="modal-actions"><button class="btn btn-ghost" id="c">취소</button><button class="btn btn-primary" id="ok">이동</button></div>`);
    m.q('#c').addEventListener('click', m.close);
    m.q('#ok').addEventListener('click', async () => {
      const dest = (m.q('#newpath').value.trim() || m.q('#dest').value).replace(/\/+$/, '') || '/';
      const items = [...state.selected.values()];
      const files = items.filter((i) => i.type === 'file'), folders = items.filter((i) => i.type === 'folder');
      try {
        if (files.length) await API.bulkMove(files.map((f) => f.id), dest);
        for (const fo of folders) { const target = (dest === '/' ? '' : dest) + '/' + fo.name; if (target !== fo.path) await API.renameFolder(fo.path, target, state.ownerId); }
        m.close(); UI.toast('이동 완료', 'success'); loadAll();
      } catch (err) { UI.toast(err.message, 'error'); }
    });
  }

  async function uploadFiles(fileList) {
    const fd = new FormData(); fd.append('folder', state.folder);
    [...fileList].forEach((f) => fd.append('file', f));
    UI.toast(`${fileList.length}개 업로드 중…`);
    try { await API.upload(fd, state.ownerId); UI.toast('업로드 완료 ✅', 'success'); loadAll(); }
    catch (err) { UI.toast(err.message, 'error'); }
  }

  function downloadFile(id) {
    fetch(API.downloadUrl(id), { headers: { Authorization: 'Bearer ' + API.getToken() }, credentials: 'include' })
      .then((r) => { if (!r.ok) throw new Error('다운로드 실패'); return r.blob().then((b) => ({ b, r })); })
      .then(({ b, r }) => { const cd = r.headers.get('content-disposition') || ''; const mt = /filename\*?=(?:UTF-8'')?["']?([^"';]+)/i.exec(cd); const name = mt ? decodeURIComponent(mt[1]) : 'download'; const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; a.click(); URL.revokeObjectURL(a.href); })
      .catch((err) => UI.toast(err.message, 'error'));
  }

  async function deleteFile(id) {
    const f = state.files.find((x) => String(x.id) === String(id));
    const ok = await UI.confirm({ title: '파일 삭제', danger: true, confirmText: '휴지통으로', message: `'${f?.name || '이 파일'}'을(를) 삭제할까요?\n관리자 휴지통에서 복원할 수 있습니다.` });
    if (!ok) return;
    try { await API.deleteFile(id); UI.toast('삭제됨 (휴지통 이동)', 'success'); loadFiles(); } catch (err) { UI.toast(err.message, 'error'); }
  }

  async function deleteFolder(path) {
    const name = path.split('/').pop();
    const ok = await UI.confirm({ title: '폴더 삭제', danger: true, confirmText: '휴지통으로', message: `'${name}' 폴더와 그 안의 모든 파일을 삭제할까요?\n관리자 휴지통에서 복원할 수 있습니다.` });
    if (!ok) return;
    try { await API.deleteFolder(path, state.ownerId); UI.toast('폴더 삭제됨 (휴지통 이동)', 'success'); loadAll(); } catch (err) { UI.toast(err.message, 'error'); }
  }

  function newFolderModal() {
    const parent = state.folder === '/' ? '' : state.folder;
    const short = (s) => (s.length > 8 ? s.slice(0, 8) + '…' : s);
    const branchCells = state.branches.map((b) =>
      `<label class="branch-cell" title="${UI.escapeHtml(b.name)}"><input type="checkbox" value="${UI.escapeHtml(b.name)}"><span>${UI.escapeHtml(short(b.name))}</span></label>`
    ).join('');
    const m = UI.modal(`<h3>새 폴더 (현재 위치: ${UI.escapeHtml(state.folder)})</h3>
      <div class="seg" id="seg"><button class="seg-btn on" data-mode="normal">일반 폴더</button><button class="seg-btn" data-mode="branch">영업점 폴더</button></div>
      <div class="pane-wrap">
        <div class="pane" id="pane-normal"><div class="field" style="margin-top:14px"><label>폴더 이름</label><input class="input" id="fn" placeholder="예: 2026-보고서"></div></div>
        <div class="pane hidden" id="pane-branch">
          <div style="display:flex;align-items:center;margin:12px 0 10px">
            <span class="muted" style="font-size:13px">현재 폴더 아래에 선택한 영업점 폴더를 생성합니다.</span>
            <div style="flex:1"></div>
            <label class="autosort"><input type="checkbox" id="branch-all"> 전체 선택</label>
          </div>
          <div class="branch-grid">${branchCells || '<span class="muted">등록된 영업점이 없습니다. 관리자 페이지에서 추가하세요.</span>'}</div>
        </div>
      </div>
      <div class="modal-actions"><button class="btn btn-ghost" id="c">취소</button><button class="btn btn-primary" id="ok">만들기</button></div>`);
    m.el.querySelector('.modal').classList.add('modal-wide');
    let mode = 'normal';
    m.el.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.mode === mode) return;
      mode = b.dataset.mode;
      m.el.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('on', x === b));
      m.animate(() => {
        m.q('#pane-normal').classList.toggle('hidden', mode !== 'normal');
        m.q('#pane-branch').classList.toggle('hidden', mode !== 'branch');
      });
    }));
    m.q('#branch-all')?.addEventListener('change', (e) => {
      m.el.querySelectorAll('#pane-branch input[type=checkbox][value]').forEach((c) => { c.checked = e.target.checked; c.closest('.branch-cell').classList.toggle('on', e.target.checked); });
    });
    m.el.querySelectorAll('.branch-cell input').forEach((c) => c.addEventListener('change', () => c.closest('.branch-cell').classList.toggle('on', c.checked)));
    m.q('#c').addEventListener('click', m.close);
    m.q('#ok').addEventListener('click', async () => {
      try {
        if (mode === 'normal') {
          const name = m.q('#fn').value.trim().replace(/\//g, ''); if (!name) return;
          await API.createFolder(parent + '/' + name, state.ownerId);
        } else {
          const picked = [...m.el.querySelectorAll('#pane-branch input[value]:checked')].map((x) => x.value);
          if (picked.length === 0) return UI.toast('영업점을 하나 이상 선택하세요', 'error');
          for (const name of picked) await API.createFolder(parent + '/' + name, state.ownerId);
        }
        m.close(); UI.toast('폴더 생성됨', 'success'); loadAll();
      } catch (err) { UI.toast(err.message, 'error'); }
    });
    setTimeout(() => m.q('#fn')?.focus(), 50);
  }

  function noteModal(id) {
    const f = state.files.find((x) => String(x.id) === String(id));
    const m = UI.modal(`<h3>비고 — ${UI.escapeHtml(f.name)}</h3><div class="field"><label>메모 (최대 2000자)</label><textarea class="input" id="note" rows="4" placeholder="예: 2분기 매출 원본">${UI.escapeHtml(f.note || '')}</textarea></div>${f.noteUpdatedAt ? `<p class="muted" style="font-size:12px">최근 수정: ${new Date(f.noteUpdatedAt).toLocaleString('ko-KR')}</p>` : ''}<div class="modal-actions"><button class="btn btn-ghost" id="c">취소</button><button class="btn btn-primary" id="ok">저장</button></div>`);
    m.q('#c').addEventListener('click', m.close);
    m.q('#ok').addEventListener('click', async () => { try { await API.setNote(id, m.q('#note').value); m.close(); UI.toast('비고 저장됨', 'success'); loadFiles(); } catch (err) { UI.toast(err.message, 'error'); } });
    setTimeout(() => m.q('#note').focus(), 50);
  }

  function folderNoteModal(path) {
    const f = state.folders.find((x) => x.path === path) || { name: path.split('/').pop(), note: '' };
    const m = UI.modal(`<h3>폴더 비고 — ${UI.escapeHtml(f.name)}</h3><div class="field"><label>메모 (최대 2000자)</label><textarea class="input" id="note" rows="4" placeholder="예: 2026년 지점별 정산자료">${UI.escapeHtml(f.note || '')}</textarea></div><div class="modal-actions"><button class="btn btn-ghost" id="c">취소</button><button class="btn btn-primary" id="ok">저장</button></div>`);
    m.q('#c').addEventListener('click', m.close);
    m.q('#ok').addEventListener('click', async () => { try { await API.setFolderNote(path, m.q('#note').value, state.ownerId); m.close(); UI.toast('폴더 비고 저장됨', 'success'); loadFiles(); } catch (err) { UI.toast(err.message, 'error'); } });
    setTimeout(() => m.q('#note').focus(), 50);
  }

  function renameFileModal(id) {
    const f = state.files.find((x) => String(x.id) === String(id));
    const m = UI.modal(`<h3>파일 이름 변경</h3><div class="field"><label>새 파일 이름 (확장자 포함)</label><input class="input" id="nm" value="${UI.escapeHtml(f.name)}"></div><div class="modal-actions"><button class="btn btn-ghost" id="c">취소</button><button class="btn btn-primary" id="ok">변경</button></div>`);
    m.q('#c').addEventListener('click', m.close);
    m.q('#ok').addEventListener('click', async () => { try { await API.renameFile(id, m.q('#nm').value.trim()); m.close(); UI.toast('이름 변경됨', 'success'); loadFiles(); } catch (err) { UI.toast(err.message, 'error'); } });
    setTimeout(() => { const i = m.q('#nm'); i.focus(); const dot = f.name.lastIndexOf('.'); i.setSelectionRange(0, dot > 0 ? dot : f.name.length); }, 50);
  }

  function renameFolderModal(path) {
    const name = path.split('/').pop(); const parent = path.slice(0, path.lastIndexOf('/'));
    const m = UI.modal(`<h3>폴더 이름 변경</h3><div class="field"><label>새 폴더 이름</label><input class="input" id="nm" value="${UI.escapeHtml(name)}"></div><div class="modal-actions"><button class="btn btn-ghost" id="c">취소</button><button class="btn btn-primary" id="ok">변경</button></div>`);
    m.q('#c').addEventListener('click', m.close);
    m.q('#ok').addEventListener('click', async () => { const nn = m.q('#nm').value.trim().replace(/\//g, ''); if (!nn) return; try { const r = await API.renameFolder(path, (parent || '') + '/' + nn, state.ownerId); m.close(); UI.toast('폴더 이름 변경됨', 'success'); if (state.folder === path || state.folder.startsWith(path + '/')) state.folder = r.path || (parent || '') + '/' + nn; loadAll(); } catch (err) { UI.toast(err.message, 'error'); } });
    setTimeout(() => m.q('#nm').focus(), 50);
  }

  async function shareModal(id) {
    const f = state.files.find((x) => String(x.id) === String(id));
    const m = UI.modal(`<h3>🔗 공유 링크</h3><p class="muted" style="font-size:13px;margin-bottom:8px">${UI.escapeHtml(f.name)}</p><div class="field"><label>만료 기간</label><select class="input" id="exp"><option value="0">무기한</option><option value="1">1일</option><option value="7">7일</option><option value="30">30일</option></select></div><div class="modal-actions"><button class="btn btn-ghost" id="c">닫기</button><button class="btn btn-primary" id="gen">링크 생성</button></div><div id="result"></div>`);
    m.q('#c').addEventListener('click', m.close);
    m.q('#gen').addEventListener('click', async () => {
      try { const r = await API.share(id, parseInt(m.q('#exp').value, 10)); const dl = r.url + '/download';
        m.q('#result').innerHTML = `<div class="field" style="margin-top:14px"><label>다운로드 링크 (누구나 접근 가능)</label><input class="input" id="lnk" readonly value="${dl}"></div><button class="btn btn-secondary btn-sm" id="copy">📋 링크 복사</button>`;
        m.q('#lnk').select();
        m.q('#copy').addEventListener('click', () => { m.q('#lnk').select(); navigator.clipboard?.writeText(dl); UI.toast('링크 복사됨', 'success'); });
      } catch (err) { UI.toast(err.message, 'error'); }
    });
  }

  function changePasswordModal() {
    const m = UI.modal(`<h3>비밀번호 변경</h3>
      <div class="field"><label>현재 비밀번호</label><input class="input" type="password" id="cur"></div>
      <div class="field"><label>새 비밀번호 (8자 이상)</label><input class="input" type="password" id="nw"></div>
      <div class="field"><label>새 비밀번호 확인</label><input class="input" type="password" id="nw2"><span class="pw-match muted" id="match"></span></div>
      <div class="modal-actions"><button class="btn btn-ghost" id="c">취소</button><button class="btn btn-primary" id="ok">변경</button></div>`);
    const check = () => { const a = m.q('#nw').value, b = m.q('#nw2').value; const el = m.q('#match'); if (!b) { el.textContent = ''; return; } if (a === b) { el.textContent = '✓ 일치'; el.className = 'pw-match ok'; } else { el.textContent = '✗ 불일치'; el.className = 'pw-match bad'; } };
    m.q('#nw').addEventListener('input', check); m.q('#nw2').addEventListener('input', check);
    m.q('#c').addEventListener('click', m.close);
    m.q('#ok').addEventListener('click', async () => {
      if (m.q('#nw').value !== m.q('#nw2').value) return UI.toast('새 비밀번호가 일치하지 않습니다', 'error');
      try { await API.changePassword(m.q('#cur').value, m.q('#nw').value); UI.toast('변경됨 🔐', 'success'); m.close(); } catch (err) { UI.toast(err.message, 'error'); }
    });
  }

  function checkImpersonate() { const p = new URLSearchParams(location.search); if (p.get('ownerId')) { state.ownerId = p.get('ownerId'); state.ownerName = p.get('name') || ''; } }

  return { boot, checkImpersonate };
})();

document.addEventListener('DOMContentLoaded', () => { App.checkImpersonate(); App.boot(); });
