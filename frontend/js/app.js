/* 북적북적 메인 앱 — 파일 웹하드 (v3) */
const App = (() => {
  const state = {
    user: null, folder: '/', ownerId: null, ownerName: null,
    files: [], folders: [], treeFolders: [], usage: null, accounts: [],
    view: localStorage.getItem('bj_view') || 'list',
    branches: [],
    allowedExt: ['csv', 'xls', 'xlsx', 'jpg', 'png', 'gif', 'ppt', 'pptx', 'doc', 'docx', 'txt'],
    selected: new Map(), // key -> {type:'file'|'folder', id, path, name}
    treeStyles: {},      // path -> {icon, color}
    expanded: new Set(['/']), // 펼쳐진 폴더 경로 (기본: 루트만 = 최상위만 보임)
    sort: { key: 'name', dir: 'asc' }, // 리스트 정렬 기준
    nav: { stack: ['/'], idx: 0 }, // 폴더 이동 히스토리(뒤로/앞으로)
    search: { on: false, q: '' }, // 이름 검색 모드
    anchor: null, drag: null, // 선택 앵커 / 드래그 중 항목
    extFilter: new Set(), // 확장자 필터(비어있으면 전체)
    foldersOnly: false,   // 폴더만 보기
    seenAt: 0,            // 현재 폴더를 '직전에' 열람한 시각(이 이후 생긴 항목만 NEW/수정)
    seenFolder: null,     // seenAt이 캡처된 폴더 키(리프레시 시 재캡처 방지)
  };
  const root = () => document.getElementById('app');
  const isPriv = () => state.user && (state.user.role === 'admin' || state.user.role === 'manager');
  const roleLabel = (r) => ({ admin: '관리자', manager: '담당자', user: '일반' }[r] || r);
  const selKey = (i) => (i.type === 'file' ? `file:${i.id}` : `folder:${i.path}`);
  // 폴더 아이콘(모양)·색상 프리셋
  const FOLDER_ICONS = ['📁', '📂', '🗂️', '🗃️', '📦', '📚', '⭐', '🏷️', '🎁', '🔖', '💼', '🎨'];
  const FOLDER_COLORS = ['', '#EA4B54', '#F39C12', '#F0BC3C', '#37B34A', '#118AB2', '#8B5CF6', '#868E96'];
  const folderStyle = (path) => state.treeStyles[path] || {};

  async function boot() {
    setupGlobal();
    if (API.hasToken()) {
      try {
        state.user = (await API.me()).user;
        if (state.user.role === 'admin' && !state.user.totpEnabled) return force2faSetup();
        return renderApp();
      } catch { API.setToken(null); }
    }
    renderLogin();
  }
  // 관리자 2FA 필수: 설정 완료 전까지 앱 진입 차단
  function force2faSetup() {
    root().innerHTML = `<div class="login-screen"><div class="login-card" style="max-width:460px">
      <img src="assets/logo.svg?v=49" class="login-logo" alt="북적북적">
      <div class="login-title">2단계 인증 설정</div>
      <p class="muted" style="text-align:center;font-size:13px;margin:6px 0 12px">관리자 계정은 보안을 위해 <b>2단계 인증이 필수</b>입니다.<br>설정을 완료해야 계속할 수 있습니다.</p>
      <div id="tf-host"></div>
      <button class="btn btn-ghost" id="tf-logout" style="width:100%;margin-top:10px">로그아웃</button>
    </div></div>`;
    document.getElementById('tf-logout').addEventListener('click', doLogout);
    twoFactorEnroll(document.getElementById('tf-host'), () => { UI.toast('2단계 인증이 설정되었습니다 🔐', 'success'); boot(); });
  }

  function renderLogin() {
    root().innerHTML = `
      <div class="login-screen">
        <form class="login-card" id="login-form">
          <img src="assets/logo.svg?v=49" class="login-logo" alt="북적북적">
          <div class="login-title">북적북적</div>
          <div class="login-sub">Book-Jeok · 우리끼리 나누는 파일 창고</div>
          <div class="field"><label>아이디</label><input class="input" name="username" autocomplete="username" placeholder="아이디" required></div>
          <div class="field"><label>비밀번호</label><input class="input" name="password" type="password" autocomplete="current-password" placeholder="비밀번호" required></div>
          <div class="field hidden" id="tfa-field"><label>2단계 인증 코드</label><input class="input num" name="token" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="인증 앱의 6자리"></div>
          <button class="btn btn-primary" style="width:100%;margin-top:6px" type="submit">로그인</button>
        </form>
      </div>`;
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault(); const f = e.target, btn = f.querySelector('button');
      btn.disabled = true; btn.textContent = '로그인 중…';
      try {
        const r = await API.login(f.username.value.trim(), f.password.value, f.token.value.trim());
        API.setToken(r.token); state.user = r.user;
        if (r.mustSetup2fa) return force2faSetup();
        UI.toast(`${r.user.displayName}님 환영합니다 🎉`, 'success'); renderApp();
      } catch (err) {
        if (err.data && err.data.need2fa) {
          f.querySelector('#tfa-field').classList.remove('hidden'); f.token.focus();
          UI.toast(err.message, err.data.need2fa && f.token.value ? 'error' : 'info');
        } else UI.toast(err.message, 'error');
        btn.disabled = false; btn.textContent = '로그인';
      }
    });
  }

  function renderApp() {
    const admin = state.user.role === 'admin';
    root().innerHTML = `
      <div class="layout">
        <header class="appbar">
          <button class="icon-btn appbar-menu" id="menu-toggle" title="폴더">☰</button>
          <div class="brand" id="brand-home" title="홈으로"><img src="assets/logo.svg?v=49"><span class="brand-name">북적북적</span></div>
          ${isPriv() ? `<select class="input account-switcher" id="account-switcher"><option value="">내 파일</option></select>` : ''}
          <div class="topbar-spacer"></div>
          <nav class="appbar-nav">
            <div class="nav-item" data-nav="files"><span class="ico">📁</span><span class="t">내 파일</span></div>
            <div class="nav-item" data-nav="shares"><span class="ico">🔗</span><span class="t">공유</span></div>
            <div class="nav-item" data-nav="trash"><span class="ico">🗑️</span><span class="t">휴지통</span></div>
            <div class="nav-item nav-bell" data-nav="notif"><span class="ico">🔔</span><span class="t">알림</span><span class="notif-badge hidden" id="notif-badge">0</span></div>
            ${admin ? '<a class="nav-item" href="admin.html"><span class="ico">⚙️</span><span class="t">관리자</span></a>' : ''}
            <div class="nav-item" data-nav="help"><span class="ico">❓</span><span class="t">도움말</span></div>
            <div class="nav-item" data-nav="settings"><span class="ico">⚙️</span><span class="t">설정</span></div>
            <div class="nav-item" data-nav="logout"><span class="ico">🚪</span><span class="t">로그아웃</span></div>
          </nav>
          <div class="user-chip-sm">${UI.escapeHtml(state.user.displayName)} · ${roleLabel(state.user.role)}</div>
        </header>
        <div class="body">
          <aside class="tree-sidebar" id="tree-sidebar">
            <div class="tree-head"><span>폴더</span><div class="tree-head-btns"><button class="tree-hbtn" id="expand-all" title="전체 펴기">⊞</button><button class="tree-hbtn" id="collapse-all" title="전체 닫기">⊟</button></div></div>
            <div id="tree"></div>
          </aside>
          <div class="tree-backdrop" id="tree-backdrop"></div>
          <main class="content" id="view"></main>
        </div>
      </div>
      <div class="drop-overlay hidden" id="drop-overlay"><div class="drop-inner"><div class="drop-ic">📥</div>여기에 놓아 업로드<div class="drop-sub">현재 폴더로 올라갑니다</div></div></div>`;
    root().querySelectorAll('.appbar-nav [data-nav]').forEach((el) => el.addEventListener('click', () => {
      const n = el.dataset.nav;
      if (n === 'logout') doLogout(); else if (n === 'settings') settingsModal(); else if (n === 'files') resetToOwn(); else if (n === 'help') helpModal(); else if (n === 'trash') trashModal(); else if (n === 'shares') shareManageModal(); else if (n === 'notif') notifModal();
    }));
    document.getElementById('menu-toggle').addEventListener('click', toggleTree);
    refreshNotifBadge(); startNotifPolling();
    document.getElementById('tree-backdrop').addEventListener('click', toggleTree);
    document.getElementById('brand-home').addEventListener('click', () => goTo('/'));
    document.getElementById('expand-all').addEventListener('click', expandAll);
    document.getElementById('collapse-all').addEventListener('click', collapseAll);
    if (isPriv()) setupAccountSwitcher();
    loadAll();
    loadBranches();
    loadAllowedExt();
    showNotices();
  }

  async function loadBranches() { try { state.branches = (await API.branches()).branches; } catch {} }
  async function loadAllowedExt() { try { const r = await API.allowedExtensions(); if (r.extensions?.length) { state.allowedExt = r.extensions; refreshDropzoneHint(); } } catch {} }
  function refreshDropzoneHint() {
    const input = document.getElementById('file-input'); const btn = document.getElementById('upload-btn');
    if (input) input.setAttribute('accept', state.allowedExt.map((e) => '.' + e).join(','));
    if (btn) btn.title = '허용: ' + state.allowedExt.join(' · ');
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
      <div class="notice-body">${UI.sanitizeHtml(n.body || '')}</div>
      <div class="modal-actions" style="align-items:center">
        <label class="autosort" style="margin-right:auto"><input type="checkbox" id="hide7"> 일주일간 보지 않기</label>
        <button class="btn btn-primary" id="close">닫기</button>
      </div>`);
    m.el.querySelector('.modal').classList.add('modal-wide');
    const done = () => { if (m.q('#hide7').checked) localStorage.setItem('bj_notice_hide_' + n.id, String(Date.now() + 7 * 86400000)); m.close(); };
    m.q('#close').addEventListener('click', done);
  }

  function toggleTree() { document.getElementById('tree-sidebar').classList.toggle('open'); document.getElementById('tree-backdrop').classList.toggle('show'); }
  function resetToOwn() { state.ownerId = null; state.ownerName = null; state.folder = '/'; state.selected.clear(); resetNav(); const sw = document.getElementById('account-switcher'); if (sw) sw.value = ''; loadAll(); }

  async function setupAccountSwitcher() {
    try {
      const { accounts } = await API.accounts();
      state.accounts = accounts.filter((a) => a.id !== state.user.id);
      const sw = document.getElementById('account-switcher'); if (!sw) return;
      for (const a of state.accounts) { const o = document.createElement('option'); o.value = a.id; o.textContent = `${a.displayName} (@${a.username}·${roleLabel(a.role)})`; sw.appendChild(o); }
      sw.addEventListener('change', () => {
        if (!sw.value) return resetToOwn();
        const a = state.accounts.find((x) => String(x.id) === sw.value);
        state.ownerId = a.id; state.ownerName = a.displayName; state.folder = '/'; state.selected.clear(); resetNav(); loadAll();
      });
    } catch {}
  }

  async function doLogout() { try { await API.logout(); } catch {} API.setToken(null); state.user = null; renderLogin(); }

  async function loadAll() { await Promise.all([loadTree(), loadFiles()]); }
  async function loadTree() { try { const t = await API.tree(state.ownerId); state.treeFolders = t.folders; state.treeStyles = t.styles || {}; renderTree(); } catch {} }
  async function loadFiles(silent) {
    if (!silent) { state.search.on = false; const view = document.getElementById('view'); view.innerHTML = '<div class="empty"><div class="big">⏳</div>불러오는 중…</div>'; }
    const view = document.getElementById('view');
    try {
      const [list, usage] = await Promise.all([API.listFiles(state.folder, state.ownerId), API.usage(state.ownerId)]);
      // 방어적 정규화 (구버전 백엔드가 문자열 배열을 줘도 안전)
      state.folders = (list.folders || [])
        .map((f) => (typeof f === 'string' ? { path: f } : f))
        .filter((f) => f && f.path)
        .map((f) => ({ ...f, name: f.name || f.path.split('/').filter(Boolean).pop() || '(이름없음)' }));
      state.files = list.files || []; state.usage = usage; state.selected.clear(); captureSeen(); renderContent();
    } catch (err) { view.innerHTML = `<div class="empty"><div class="big">⚠️</div>${UI.escapeHtml(err.message)}</div>`; }
  }

  function buildTreeNodes(paths) {
    const rootNode = { name: '홈', path: '/', children: {} };
    for (const p of paths) { const parts = p.split('/').filter(Boolean); let node = rootNode, acc = ''; for (const part of parts) { acc += '/' + part; if (!node.children[part]) node.children[part] = { name: part, path: acc, children: {} }; node = node.children[part]; } }
    return rootNode;
  }
  function allTreePaths() { const s = new Set(['/']); for (const p of state.treeFolders) { const parts = p.split('/').filter(Boolean); let acc = ''; for (const part of parts) { acc += '/' + part; s.add(acc); } } return s; }
  function renderTree() {
    const el = document.getElementById('tree'); const rootNode = buildTreeNodes(state.treeFolders);
    const render = (node, depth) => {
      const kids = Object.values(node.children).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
      const hasKids = kids.length > 0;
      const isOpen = state.expanded.has(node.path);
      const active = node.path === state.folder ? ' active' : '';
      const st = folderStyle(node.path);
      const icon = depth === 0 ? '🏠' : (st.icon || '📁');
      const icoStyle = (depth > 0 && st.color) ? folderIcoStyle(st.color) : '';
      const caret = hasKids ? `<span class="tcaret ${isOpen ? 'open' : ''}" data-toggle="${UI.escapeHtml(node.path)}">▸</span>` : '<span class="tcaret-empty"></span>';
      let html = `<div class="tree-item${active}" data-folder="${UI.escapeHtml(node.path)}" style="padding-left:${6 + depth * 14}px;">${caret}<span class="tico${icoStyle ? ' tint' : ''}" style="${icoStyle}">${icon}</span><span class="tname">${UI.escapeHtml(node.name)}</span></div>`;
      if (hasKids && isOpen) for (const k of kids) html += render(k, depth + 1);
      return html;
    };
    el.innerHTML = render(rootNode, 0);
    const toggleExpand = (p) => { if (p === '/') return; if (state.expanded.has(p)) state.expanded.delete(p); else state.expanded.add(p); renderTree(); };
    // 캐럿 버튼: 한 번 클릭으로 하위트리 열고 닫기
    el.querySelectorAll('[data-toggle]').forEach((c) => c.addEventListener('click', (e) => { e.stopPropagation(); toggleExpand(c.dataset.toggle); }));
    // 트리 폴더 클릭: 해당 폴더로 이동(경로에 맞춰 트리 자동 펼침). 열고닫기는 ▸ 캐럿으로.
    // 드래그해서 트리 폴더에 놓으면 그 폴더로 이동.
    el.querySelectorAll('.tree-item[data-folder]').forEach((n) => {
      n.addEventListener('click', () => goTo(n.dataset.folder));
      n.addEventListener('dragover', (e) => { if (state.drag) { e.preventDefault(); n.classList.add('drop-target'); } });
      n.addEventListener('dragleave', () => n.classList.remove('drop-target'));
      n.addEventListener('drop', (e) => { if (!state.drag) return; e.preventDefault(); n.classList.remove('drop-target'); moveDraggedTo(n.dataset.folder); });
    });
  }
  function expandAll() { state.expanded = allTreePaths(); renderTree(); }
  function collapseAll() { state.expanded = new Set(['/']); renderTree(); }

  function renderContent() {
    const u = state.usage; const pct = u.quotaBytes > 0 ? Math.min(100, (u.usedBytes / u.quotaBytes) * 100) : 0;
    document.getElementById('view').innerHTML = `
      ${state.ownerId ? `<div class="impersonate-banner">👁️ <b>${UI.escapeHtml(state.ownerName || '')}</b> 계정의 파일을 보는 중<div style="flex:1"></div><button class="btn btn-sm btn-secondary" id="exit-imp">내 파일로</button></div>` : ''}
      <div class="content-head">
        <div class="tools-left">
          <div class="navcon">
            <button class="icon-btn nav-btn" id="nav-back" title="뒤로 (Backspace)" ${state.nav.idx > 0 ? '' : 'disabled'}>◀</button>
            <button class="icon-btn nav-btn" id="nav-fwd" title="앞으로" ${state.nav.idx < state.nav.stack.length - 1 ? '' : 'disabled'}>▶</button>
            <button class="icon-btn nav-btn" id="nav-up" title="상위 폴더로" ${state.folder !== '/' ? '' : 'disabled'}>▲</button>
          </div>
          <div class="viewtoggle">
            <button class="vt ${state.view === 'grid' ? 'on' : ''}" data-view="grid" title="미리보기">▦</button>
            <button class="vt ${state.view === 'list' ? 'on' : ''}" data-view="list" title="리스트">☰</button>
          </div>
          <button class="btn btn-primary btn-sm" id="upload-btn" title="허용: ${state.allowedExt.join(' · ')}">⬆️ <span class="label">업로드</span></button>
          <button class="btn btn-secondary btn-sm" id="new-folder">📂 <span class="label">새 폴더</span></button>
          <input type="file" id="file-input" multiple hidden accept="${state.allowedExt.map((e) => '.' + e).join(',')}">
          <form class="searchbox" id="searchform">
            <input class="input" id="search-input" type="search" placeholder="이름 검색…" autocomplete="off">
            <button class="btn btn-secondary btn-sm" type="submit" title="검색">🔎 <span class="label">조회</span></button>
          </form>
          <div class="extfilter" id="extfilter">
            <button type="button" class="btn btn-secondary btn-sm${(state.extFilter.size || state.foldersOnly) ? ' on' : ''}" id="extfilter-btn" title="보기 필터(확장자·폴더만)">🧩 <span class="label">필터</span><span id="extfilter-count">${state.foldersOnly ? ' (폴더)' : (state.extFilter.size ? ` (${state.extFilter.size})` : '')}</span></button>
            <div class="extfilter-panel hidden" id="extfilter-panel"></div>
          </div>
        </div>
        <div class="head-right">
          <div class="breadcrumb" id="crumbs"></div>
          <div class="usage-line"><span class="num">${UI.bytes(u.usedBytes)}</span><span class="muted">${u.unlimited ? '· 무제한' : (u.quotaBytes > 0 ? '/ ' + UI.bytes(u.quotaBytes) : '· 미할당')} · ${u.fileCount}개 파일</span>${!u.unlimited && u.quotaBytes > 0 ? `<span class="usage-bar"><span style="width:${pct}%"></span></span>` : ''}<button class="btn btn-ghost btn-sm" id="usage-report" title="용량 리포트">📊</button></div>
        </div>
      </div>
      ${state.search.on ? `<div class="search-banner">🔎 <b>${UI.escapeHtml(state.search.q)}</b> 검색 결과 · ${state.folders.length + state.files.length}건<div style="flex:1"></div><button class="btn btn-sm btn-ghost" id="search-exit">✕ 검색 나가기</button></div>` : ''}
      <div id="selbar" class="selbar empty"></div>
      <div id="listing"></div>`;
    renderCrumbs(); renderListing(); wireContent();
  }

  function renderCrumbs() {
    const parts = state.folder.split('/').filter(Boolean); let acc = '', html = `<span data-folder="/">🏠 홈</span>`;
    for (const p of parts) { acc += '/' + p; html += `<span class="sep">/</span><span data-folder="${UI.escapeHtml(acc)}">${UI.escapeHtml(p)}</span>`; }
    const el = document.getElementById('crumbs'); el.innerHTML = html;
    el.querySelectorAll('[data-folder]').forEach((s) => s.addEventListener('click', () => goTo(s.dataset.folder)));
  }

  // ── 정렬 ──────────────────────────────
  const SORT_KEYS = { name: '이름', size: '크기', createdAt: '등록일', updatedAt: '수정일', note: '비고' };
  function sortVal(f, key, isFolder) {
    switch (key) {
      case 'size': return Number(f.size) || 0;
      case 'createdAt': return f.createdAt ? new Date(f.createdAt).getTime() : 0;
      case 'updatedAt': return new Date((isFolder ? f.noteUpdatedAt : f.updatedAt) || f.createdAt || 0).getTime();
      case 'note': return (f.note || '').toLowerCase();
      default: return (f.name || '').toLowerCase();
    }
  }
  function sortItems(arr, isFolder) {
    const { key, dir } = state.sort;
    const s = [...arr].sort((a, b) => {
      const va = sortVal(a, key, isFolder), vb = sortVal(b, key, isFolder);
      const c = (typeof va === 'string') ? va.localeCompare(vb, 'ko') : (va - vb);
      return dir === 'desc' ? -c : c;
    });
    return s;
  }
  function toggleSort(key) {
    if (state.sort.key === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
    else state.sort = { key, dir: 'asc' };
    renderListing();
  }
  const sortArrow = (key) => state.sort.key === key ? (state.sort.dir === 'asc' ? ' ▲' : ' ▼') : '';

  // ── 폴더 열람('봤음') 상태 ──────
  // NEW/수정 태그는 해당 폴더를 한 번 열람하면(다운로드 여부와 무관) 사라진다.
  // 뷰어(로그인 사용자)·대상 계정별로 폴더의 마지막 열람 시각을 브라우저에 저장한다.
  const SEEN_KEY = 'bj_seen';
  function seenMap() { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}'); } catch { return {}; } }
  const seenId = (folder) => `${state.ownerId || 'me'}|${folder}`;
  const getSeen = (folder) => seenMap()[seenId(folder)] || 0;
  function markSeen(folder) { const m = seenMap(); m[seenId(folder)] = Date.now(); try { localStorage.setItem(SEEN_KEY, JSON.stringify(m)); } catch {} }
  // 폴더 진입 시 1회: 직전 열람 시각을 seenAt에 담고(태그 판정용), 지금을 '봤음'으로 기록.
  function captureSeen() {
    const key = seenId(state.folder);
    if (state.seenFolder === key) return; // 같은 폴더 리프레시면 유지(방문 중 태그 안정)
    state.seenAt = getSeen(state.folder);
    markSeen(state.folder);
    state.seenFolder = key;
  }

  // ── 업데이트 태그 (최근 추가/수정) ──────
  // 최근(7일 이내)이면서, 이 폴더를 마지막으로 열람한 시각 이후에 생긴 항목만 표시.
  function updateBadge(f, isFolder) {
    const created = f.createdAt ? new Date(f.createdAt).getTime() : 0;
    const upd = new Date((isFolder ? f.noteUpdatedAt : f.updatedAt) || 0).getTime();
    const seen = state.seenAt || 0;
    if (upd && upd - created > 60000 && UI.isRecent(upd) && upd > seen) return '<span class="badge-upd" title="최근 수정됨">수정</span>';
    if (created && UI.isRecent(created) && created > seen) return '<span class="badge-new" title="최근 추가됨">NEW</span>';
    return '';
  }

  // 폴더 색상 → 아이콘에 입히기 (테두리 대신)
  function folderIcoStyle(color) {
    return color ? `background:${color}22;box-shadow:inset 0 0 0 1.6px ${color};` : '';
  }

  function renderListing() {
    const box = document.getElementById('listing');
    if (state.folders.length === 0 && state.files.length === 0) { box.innerHTML = `<div class="empty"><div class="big">🗂️</div>아직 파일이 없어요. 첫 파일을 올려보세요!</div>`; return; }
    box.innerHTML = state.view === 'grid' ? gridHTML() : listHTML();
    wireListing(); updateSelbar(); if (state.view === 'grid') loadThumbs();
  }

  function gridHTML() {
    const folders = sortItems(state.folders, true).map((f) => `
      <div class="file-card fade-in${state.selected.has(`folder:${f.path}`) ? ' sel' : ''}" data-folder-card="${UI.escapeHtml(f.path)}" data-row-key="folder:${UI.escapeHtml(f.path)}" data-drop-folder="${UI.escapeHtml(f.path)}" draggable="true" title="더블클릭하여 열기">
        <div class="file-actions">
          <button class="icon-btn" data-fshare="${UI.escapeHtml(f.path)}" title="폴더 공유(읽기전용)">🔗</button>
          <button class="icon-btn" data-freq="${UI.escapeHtml(f.path)}" title="업로드 요청 링크">📥</button>
          <button class="icon-btn" data-fedit="${UI.escapeHtml(f.path)}" title="폴더 설정">⚙️</button>
          <button class="icon-btn" data-fnote="${UI.escapeHtml(f.path)}" title="비고">📝</button>
          <button class="icon-btn" data-fdel="${UI.escapeHtml(f.path)}" title="삭제">🗑️</button>
        </div>
        <div class="file-ico${f.color ? ' tint' : ''}" style="${folderIcoStyle(f.color)}">${f.icon || '📁'}</div>
        <div class="file-name">${UI.escapeHtml(f.name)}${updateBadge(f, true)}</div>
        <div class="file-meta num">${UI.bytes(f.size)} · ${f.createdAt ? UI.date(f.createdAt) : '폴더'}</div>
        ${f.note ? `<div class="file-note" title="${UI.escapeHtml(f.note)}">📝 ${UI.escapeHtml(f.note)}</div>` : ''}
      </div>`).join('');
    const files = sortItems(filteredFiles(), false).map((f) => `
      <div class="file-card fade-in${state.selected.has(`file:${f.id}`) ? ' sel' : ''}" data-file="${f.id}" data-row-key="file:${f.id}" draggable="true">
        <div class="file-actions">
          ${canPreview(f.name) ? `<button class="icon-btn" data-preview="${f.id}" title="미리보기">👁️</button>` : ''}
          <button class="icon-btn" data-share="${f.id}" title="공유링크">🔗</button>
          <button class="icon-btn" data-note="${f.id}" title="비고">📝</button>
          <button class="icon-btn" data-rename="${f.id}" title="이름변경">✏️</button>
          <button class="icon-btn" data-dl="${f.id}" title="다운로드">⬇️</button>
          <button class="icon-btn" data-del="${f.id}" title="삭제">🗑️</button>
        </div>
        <div class="file-ico${isImage(f.name) ? ' thumb' : ''}"${isImage(f.name) ? ` data-thumb="${f.id}"` : ''}>${isImage(f.name) ? '🖼️' : UI.fileIcon(f.name)}</div>
        <div class="file-name">${UI.escapeHtml(f.name)}${updateBadge(f, false)}</div>
        <div class="file-meta num">${UI.bytes(f.size)} · ${UI.date(f.createdAt)}</div>
        ${f.note ? `<div class="file-note" title="${UI.escapeHtml(f.note)}">📝 ${UI.escapeHtml(f.note)}</div>` : ''}
      </div>`).join('');
    return `<div class="file-grid">${folders}${files}</div>`;
  }

  function listHTML() {
    const isSel = (key) => state.selected.has(key);
    const folders = sortItems(state.folders, true).map((f) => {
      const key = `folder:${f.path}`;
      return `<tr data-folder-row="${UI.escapeHtml(f.path)}" data-row-key="${UI.escapeHtml(key)}" data-drop-folder="${UI.escapeHtml(f.path)}" draggable="true" class="${isSel(key) ? 'sel' : ''}">
        <td><input type="checkbox" class="rowcheck" data-sel-folder="${UI.escapeHtml(f.path)}" data-name="${UI.escapeHtml(f.name)}" ${isSel(key) ? 'checked' : ''}></td>
        <td class="open-cell name-cell" data-open="${UI.escapeHtml(f.path)}" title="더블클릭하여 열기"><span class="ic${f.color ? ' tint' : ''}" style="${folderIcoStyle(f.color)}">${f.icon || '📁'}</span> ${UI.escapeHtml(f.name)}${updateBadge(f, true)}</td>
        <td class="num muted" data-label="크기">${UI.bytes(f.size)}</td>
        <td class="num muted" data-label="등록">${f.createdAt ? UI.date(f.createdAt) : '—'}</td>
        <td class="num muted" data-label="수정">${f.noteUpdatedAt ? UI.date(f.noteUpdatedAt) : '—'}</td>
        <td class="note-cell" data-fnote="${UI.escapeHtml(f.path)}" title="클릭하여 비고 편집">${f.note ? UI.escapeHtml(f.note) : '<span class="muted">+ 비고</span>'}</td>
        <td class="row-actions"><button class="icon-btn" data-fshare="${UI.escapeHtml(f.path)}" title="폴더 공유(읽기전용)">🔗</button><button class="icon-btn" data-freq="${UI.escapeHtml(f.path)}" title="업로드 요청 링크">📥</button><button class="icon-btn" data-fedit="${UI.escapeHtml(f.path)}" title="폴더 설정">⚙️</button></td>
      </tr>`;
    }).join('');
    const files = sortItems(filteredFiles(), false).map((f) => {
      const key = `file:${f.id}`;
      return `<tr data-file="${f.id}" data-row-key="${UI.escapeHtml(key)}" draggable="true" class="${isSel(key) ? 'sel' : ''}">
        <td><input type="checkbox" class="rowcheck" data-sel-file="${f.id}" data-name="${UI.escapeHtml(f.name)}" ${isSel(key) ? 'checked' : ''}></td>
        <td class="name-cell"><span class="ic">${UI.fileIcon(f.name)}</span> ${UI.escapeHtml(f.name)}${updateBadge(f, false)}</td>
        <td class="num muted" data-label="크기">${UI.bytes(f.size)}</td>
        <td class="num muted" data-label="등록">${UI.date(f.createdAt)}</td>
        <td class="num muted" data-label="수정">${UI.date(f.updatedAt || f.createdAt)}</td>
        <td class="note-cell" data-note="${f.id}" title="클릭하여 비고 편집">${f.note ? UI.escapeHtml(f.note) : '<span class="muted">+ 비고</span>'}</td>
        <td class="row-actions">${canPreview(f.name) ? `<button class="icon-btn" data-preview="${f.id}" title="미리보기">👁️</button>` : ''}<button class="icon-btn" data-share="${f.id}" title="공유">🔗</button><button class="icon-btn" data-dl="${f.id}" title="다운로드">⬇️</button></td>
      </tr>`;
    }).join('');
    const th = (key, label, style = '') => `<th class="sortable${state.sort.key === key ? ' sorted' : ''}" data-sort="${key}"${style ? ` style="${style}"` : ''}>${label}${sortArrow(key)}</th>`;
    const vf = filteredFiles();
    const total = state.folders.length + vf.length;
    const allSel = total > 0 && state.folders.every((f) => isSel(`folder:${f.path}`)) && vf.every((f) => isSel(`file:${f.id}`));
    return `<div class="table-wrap fade-in"><table class="filetable">
      <thead><tr><th style="width:34px"><input type="checkbox" id="check-all" title="전체선택/해제" ${allSel ? 'checked' : ''}></th>${th('name', '이름')}${th('size', '크기', 'width:84px')}${th('createdAt', '등록일', 'width:96px')}${th('updatedAt', '수정일', 'width:96px')}${th('note', '비고')}<th style="width:70px"></th></tr></thead>
      <tbody>${folders}${files}</tbody></table></div>`;
  }

  function wireContent() {
    document.getElementById('exit-imp')?.addEventListener('click', resetToOwn);
    document.querySelectorAll('.viewtoggle .vt').forEach((b) => b.addEventListener('click', () => { state.view = b.dataset.view; localStorage.setItem('bj_view', state.view); state.selected.clear(); renderContent(); }));
    const input = document.getElementById('file-input');
    document.getElementById('upload-btn').addEventListener('click', () => input.click());
    input.addEventListener('change', () => { if (input.files.length) uploadFiles(input.files); input.value = ''; });
    document.getElementById('new-folder').addEventListener('click', newFolderModal);
    document.getElementById('nav-back').addEventListener('click', navBack);
    document.getElementById('nav-fwd').addEventListener('click', navForward);
    document.getElementById('nav-up').addEventListener('click', navUp);
    document.getElementById('usage-report').addEventListener('click', usageReportModal);
    const sf = document.getElementById('searchform'), si = document.getElementById('search-input');
    si.value = state.search.q;
    sf.addEventListener('submit', (e) => { e.preventDefault(); doSearch(si.value); });
    document.getElementById('search-exit')?.addEventListener('click', clearSearch);
    // 확장자 필터
    const efb = document.getElementById('extfilter-btn'), panel = document.getElementById('extfilter-panel');
    efb.addEventListener('click', (e) => { e.stopPropagation(); if (panel.classList.contains('hidden')) buildExtFilterPanel(); panel.classList.toggle('hidden'); });
    document.addEventListener('click', (e) => { if (!e.target.closest('#extfilter')) panel.classList.add('hidden'); });
  }

  // ── 확장자 필터 ──────────────────────────
  const extOf = (name) => (name.split('.').pop() || '').toLowerCase();
  function filteredFiles() { if (state.foldersOnly) return []; return state.extFilter.size ? state.files.filter((f) => state.extFilter.has(extOf(f.name))) : state.files; }
  const filterActive = () => state.extFilter.size > 0 || state.foldersOnly;
  function updateExtCount() {
    const c = document.getElementById('extfilter-count'), b = document.getElementById('extfilter-btn');
    if (c) c.textContent = state.foldersOnly ? ' (폴더)' : (state.extFilter.size ? ` (${state.extFilter.size})` : '');
    if (b) b.classList.toggle('on', filterActive());
  }
  function buildExtFilterPanel() {
    const panel = document.getElementById('extfilter-panel'); if (!panel) return;
    const chips = state.allowedExt.map((e) => `<label class="ext-chip${state.extFilter.has(e) ? ' on' : ''}"><input type="checkbox" value="${e}" ${state.extFilter.has(e) ? 'checked' : ''}><span class="ei">${UI.extIcon(e)}</span> .${UI.escapeHtml(e)}</label>`).join('');
    panel.innerHTML = `<div class="ext-panel-head"><b>보기 필터</b><button class="btn btn-sm btn-ghost" id="ext-clear">전체 해제</button></div>
      <label class="ext-chip only-folders${state.foldersOnly ? ' on' : ''}" style="margin-bottom:8px"><input type="checkbox" id="only-folders" ${state.foldersOnly ? 'checked' : ''}><span class="ei">📁</span> 폴더만 보기</label>
      <div class="ext-chip-grid"${state.foldersOnly ? ' style="opacity:.4;pointer-events:none"' : ''}>${chips || '<span class="muted">허용 확장자가 없습니다.</span>'}</div>`;
    panel.querySelector('#only-folders').addEventListener('change', (e) => { state.foldersOnly = e.target.checked; state.selected.clear(); state.anchor = null; buildExtFilterPanel(); updateExtCount(); renderListing(); });
    panel.querySelectorAll('.ext-chip-grid input[type=checkbox]').forEach((c) => c.addEventListener('change', () => {
      if (c.checked) state.extFilter.add(c.value); else state.extFilter.delete(c.value);
      c.closest('.ext-chip').classList.toggle('on', c.checked);
      state.selected.clear(); state.anchor = null; updateExtCount(); renderListing();
    }));
    panel.querySelector('#ext-clear')?.addEventListener('click', () => { state.extFilter.clear(); state.foldersOnly = false; buildExtFilterPanel(); updateExtCount(); state.selected.clear(); renderListing(); });
  }

  // ── 이름 검색 ──────────────────────────
  function doSearch(q) {
    q = (q || '').trim();
    if (!q) { if (state.search.on) clearSearch(); return; }
    API.search(q, state.ownerId).then((r) => {
      state.search = { on: true, q };
      state.folders = r.folders || []; state.files = r.files || [];
      state.selected.clear(); state.anchor = null; renderContent();
    }).catch((e) => UI.toast(e.message, 'error'));
  }
  function clearSearch() { state.search = { on: false, q: '' }; loadFiles(); }

  // ── 폴더 이동(히스토리 · 트리 동기화) ──────────────
  function normFolder(p) { if (!p || p === '/') return '/'; return '/' + String(p).split('/').filter(Boolean).join('/'); }
  function pathChain(folder) { const s = new Set(['/']); let acc = ''; for (const p of folder.split('/').filter(Boolean)) { acc += '/' + p; s.add(acc); } return s; }
  function syncTreeToFolder() { state.expanded = pathChain(state.folder); } // 현재 위치의 경로만 펼침
  function goTo(path, record = true) {
    path = normFolder(path);
    if (record) { const n = state.nav; if (n.stack[n.idx] !== path) { n.stack = n.stack.slice(0, n.idx + 1); n.stack.push(path); n.idx = n.stack.length - 1; } }
    if (state.folder === path) { syncTreeToFolder(); renderTree(); return; }
    state.folder = path; syncTreeToFolder(); loadFiles(); renderTree();
    if (window.innerWidth <= 768 && document.getElementById('tree-sidebar')?.classList.contains('open')) toggleTree();
  }
  function navBack() { const n = state.nav; if (n.idx > 0) { n.idx--; goTo(n.stack[n.idx], false); } }
  function navForward() { const n = state.nav; if (n.idx < n.stack.length - 1) { n.idx++; goTo(n.stack[n.idx], false); } }
  function navUp() { if (state.folder === '/') return; goTo(state.folder.slice(0, state.folder.lastIndexOf('/')) || '/'); }
  function resetNav() { state.nav = { stack: [state.folder || '/'], idx: 0 }; }
  function openFolder(path) { goTo(path); }

  // ── 전역: 화면 어디든 드롭 업로드 · 백스페이스=폴더 뒤로 ──
  let globalsBound = false;
  function setupGlobal() {
    if (globalsBound) return; globalsBound = true;
    let dragDepth = 0;
    const overlay = () => document.getElementById('drop-overlay');
    const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
    window.addEventListener('dragenter', (e) => { if (!state.user || !hasFiles(e)) return; e.preventDefault(); dragDepth++; overlay()?.classList.remove('hidden'); });
    window.addEventListener('dragover', (e) => { if (state.user && hasFiles(e)) e.preventDefault(); });
    window.addEventListener('dragleave', (e) => { if (!state.user || !hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (dragDepth === 0) overlay()?.classList.add('hidden'); });
    window.addEventListener('drop', (e) => { if (!state.user || !hasFiles(e)) return; e.preventDefault(); dragDepth = 0; overlay()?.classList.add('hidden'); if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files); });
    document.addEventListener('keydown', (e) => {
      if (!state.user) return;
      const t = e.target;
      const inField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      const modalOpen = !!document.querySelector('.modal-backdrop');
      if (e.key === 'Backspace') { if (inField || modalOpen) return; e.preventDefault(); navBack(); return; } // 브라우저 뒤로가기 차단→폴더 뒤로
      if (inField || modalOpen || !document.getElementById('listing')) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); selectAllItems(); return; }
      if (e.key === 'Escape') { if (state.selected.size) { state.selected.clear(); applySelectionClasses(); } return; }
      if (e.key === 'Delete') { if (state.selected.size) { e.preventDefault(); bulkDelete(); } return; }
      if (e.key === 'F2') { if (state.selected.size === 1) { e.preventDefault(); const it = [...state.selected.values()][0]; if (it.type === 'file') renameFileModal(it.id); else folderSettingsModal(it.path); } return; }
      if (e.key === 'Enter') { if (state.selected.size === 1) { const it = [...state.selected.values()][0]; if (it.type === 'folder') openFolder(it.path); else downloadFile(it.id); } return; }
    });
  }

  // ── 선택 모델(클릭/Ctrl/Shift) · 드래그 이동 ──────────
  function orderedItems() {
    const fol = sortItems(state.folders, true).map((f) => ({ key: `folder:${f.path}`, item: { type: 'folder', path: f.path, name: f.name } }));
    const fil = sortItems(filteredFiles(), false).map((f) => ({ key: `file:${f.id}`, item: { type: 'file', id: String(f.id), name: f.name } }));
    return [...fol, ...fil];
  }
  function applySelectionClasses() {
    document.querySelectorAll('#listing [data-row-key]').forEach((el) => {
      const on = state.selected.has(el.dataset.rowKey);
      el.classList.toggle('sel', on);
      const cb = el.querySelector('.rowcheck'); if (cb) cb.checked = on;
    });
    const all = document.getElementById('check-all');
    if (all) { const o = orderedItems(); all.checked = o.length > 0 && o.every((x) => state.selected.has(x.key)); }
    updateSelbar();
  }
  function selectAllItems() { state.selected.clear(); orderedItems().forEach((o) => state.selected.set(o.key, o.item)); applySelectionClasses(); }
  function selectClick(e, key, item) {
    const order = orderedItems();
    if (e.shiftKey && state.anchor) {
      const ia = order.findIndex((o) => o.key === state.anchor), ib = order.findIndex((o) => o.key === key);
      if (ia >= 0 && ib >= 0) { state.selected.clear(); const [lo, hi] = ia < ib ? [ia, ib] : [ib, ia]; for (let i = lo; i <= hi; i++) state.selected.set(order[i].key, order[i].item); }
    } else if (e.ctrlKey || e.metaKey) {
      if (state.selected.has(key)) state.selected.delete(key); else state.selected.set(key, item);
      state.anchor = key;
    } else { state.selected.clear(); state.selected.set(key, item); state.anchor = key; }
    applySelectionClasses();
  }
  function moveDraggedTo(targetPath) {
    const items = state.drag || []; state.drag = null;
    if (!items.length) return;
    const files = items.filter((i) => i.type === 'file'), folders = items.filter((i) => i.type === 'folder');
    if (folders.some((fo) => targetPath === fo.path || targetPath.startsWith(fo.path + '/'))) return UI.toast('폴더를 자기 자신/하위로 옮길 수 없습니다', 'error');
    (async () => {
      try {
        if (files.length) await API.bulkMove(files.map((f) => f.id), targetPath);
        for (const fo of folders) { const target = (targetPath === '/' ? '' : targetPath) + '/' + fo.name; if (target !== fo.path) await API.renameFolder(fo.path, target, state.ownerId); }
        UI.toast('이동 완료', 'success'); loadAll();
      } catch (err) { UI.toast(err.message, 'error'); }
    })();
  }

  function wireListing() {
    const box = document.getElementById('listing');
    const actionSel = '.file-actions, .row-actions, .rowcheck, button, a, input';
    // 항목: 클릭=선택, 더블클릭=열기/다운로드, 드래그=이동
    box.querySelectorAll('[data-row-key]').forEach((el) => {
      const key = el.dataset.rowKey; const isFolder = key.startsWith('folder:');
      const found = isFolder ? state.folders.find((f) => `folder:${f.path}` === key) : state.files.find((f) => `file:${f.id}` === key);
      const item = isFolder ? { type: 'folder', path: key.slice(7), name: found ? found.name : '' } : { type: 'file', id: key.slice(5), name: found ? found.name : '' };
      el.addEventListener('click', (e) => { if (e.target.closest(actionSel)) return; selectClick(e, key, item); });
      el.addEventListener('dblclick', (e) => { if (e.target.closest(actionSel)) return; if (isFolder) openFolder(item.path); else downloadFile(item.id); });
      el.addEventListener('dragstart', (e) => {
        if (!state.selected.has(key)) { state.selected.clear(); state.selected.set(key, item); state.anchor = key; applySelectionClasses(); }
        state.drag = [...state.selected.values()]; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('application/bookjeok', '1');
      });
      el.addEventListener('dragend', () => { state.drag = null; document.querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target')); });
    });
    // 폴더 드롭 대상 (리스트 행/그리드 카드)
    box.querySelectorAll('[data-drop-folder]').forEach((el) => {
      el.addEventListener('dragover', (e) => { if (state.drag) { e.preventDefault(); el.classList.add('drop-target'); } });
      el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
      el.addEventListener('drop', (e) => { if (!state.drag) return; e.preventDefault(); el.classList.remove('drop-target'); moveDraggedTo(el.dataset.dropFolder); });
    });
    // 파일 액션
    box.querySelectorAll('[data-preview]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); previewModal(el.dataset.preview); }));
    box.querySelectorAll('[data-dl]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); downloadFile(el.dataset.dl); }));
    box.querySelectorAll('[data-del]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); deleteFile(el.dataset.del); }));
    box.querySelectorAll('[data-share]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); shareModal(el.dataset.share); }));
    box.querySelectorAll('[data-note]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); noteModal(el.dataset.note); }));
    box.querySelectorAll('[data-rename]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); renameFileModal(el.dataset.rename); }));
    // 폴더 액션
    box.querySelectorAll('[data-fnote]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); folderNoteModal(el.dataset.fnote); }));
    box.querySelectorAll('[data-fedit]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); folderSettingsModal(el.dataset.fedit); }));
    box.querySelectorAll('[data-freq]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); uploadRequestModal(el.dataset.freq); }));
    box.querySelectorAll('[data-fshare]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); folderShareModal(el.dataset.fshare); }));
    box.querySelectorAll('[data-fdel]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); deleteFolder(el.dataset.fdel); }));
    // 체크박스
    box.querySelectorAll('.rowcheck').forEach((c) => {
      c.addEventListener('click', (e) => e.stopPropagation());
      c.addEventListener('change', () => {
        const item = c.dataset.selFile ? { type: 'file', id: c.dataset.selFile, name: c.dataset.name } : { type: 'folder', path: c.dataset.selFolder, name: c.dataset.name };
        const key = selKey(item);
        if (c.checked) state.selected.set(key, item); else state.selected.delete(key);
        state.anchor = key; applySelectionClasses();
      });
    });
    // 칼럼 정렬 (헤더 클릭)
    box.querySelectorAll('th.sortable').forEach((th) => th.addEventListener('click', () => toggleSort(th.dataset.sort)));
    const all = document.getElementById('check-all');
    if (all) all.addEventListener('change', () => { if (all.checked) selectAllItems(); else { state.selected.clear(); applySelectionClasses(); } });
  }

  // 선택바: 항상 표시, 선택이 없으면 비활성
  function updateSelbar() {
    const bar = document.getElementById('selbar'); if (!bar) return;
    const n = state.selected.size, dis = n === 0;
    bar.classList.remove('hidden', 'closing');
    bar.classList.toggle('empty', dis);
    bar.innerHTML = `<b>${n > 0 ? `${n}개 선택` : '항목을 선택하세요'}</b><div style="flex:1"></div>
      <button class="btn btn-sm btn-ghost" id="sel-rename" ${n !== 1 ? 'disabled' : ''}>✏️ 이름변경</button>
      <button class="btn btn-sm btn-primary" id="sel-dl" ${dis ? 'disabled' : ''}>⬇️ 다운로드(ZIP)</button>
      <button class="btn btn-sm btn-secondary" id="sel-move" ${dis ? 'disabled' : ''}>📂 폴더이동</button>
      <button class="btn btn-sm btn-danger" id="sel-del" ${dis ? 'disabled' : ''}>🗑️ 삭제</button>
      <button class="btn btn-sm btn-ghost" id="sel-clear" ${dis ? 'disabled' : ''}>선택해제</button>`;
    bar.querySelector('#sel-clear').addEventListener('click', () => { state.selected.clear(); applySelectionClasses(); });
    bar.querySelector('#sel-del').addEventListener('click', bulkDelete);
    bar.querySelector('#sel-dl').addEventListener('click', bulkDownload);
    bar.querySelector('#sel-move').addEventListener('click', bulkMoveModal);
    const rn = bar.querySelector('#sel-rename');
    if (!rn.disabled) rn.addEventListener('click', () => {
      const item = [...state.selected.values()][0];
      if (item.type === 'file') renameFileModal(item.id); else folderSettingsModal(item.path);
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

  const lastSeg = (p) => (p && p !== '/') ? p.split('/').filter(Boolean).pop() : '';
  async function bulkDownload() {
    const items = [...state.selected.values()];
    const ids = items.filter((i) => i.type === 'file').map((i) => i.id);
    const folders = items.filter((i) => i.type === 'folder').map((i) => i.path);
    if (!ids.length && !folders.length) return;
    // 압축 파일명 기준: 폴더 하나만 선택했으면 그 폴더명, 그 외엔 현재 보고 있는 폴더명
    const zipBase = (folders.length === 1 && ids.length === 0)
      ? lastSeg(folders[0])
      : (lastSeg(state.folder) || '북적북적');

    const btn = document.getElementById('sel-dl');
    if (btn) { btn.disabled = true; btn.textContent = '압축 중…'; }
    let bundle;
    try {
      bundle = await API.bulkZip(ids, folders, state.folder, zipBase, state.ownerId);
    } catch (err) { UI.toast(err.message || '압축 실패', 'error'); return; }
    finally { if (btn) { btn.disabled = false; btn.innerHTML = '⬇️ 다운로드(ZIP)'; } }
    zipActionModal(bundle);
  }

  // 압축 완료 후: 내 기기로 다운로드 / 공유링크 만들기 선택
  function zipActionModal(bundle) {
    const m = UI.modal(`<h3>🗜️ 압축 완료</h3>
      <p class="muted" style="font-size:13px;margin-bottom:4px">${UI.escapeHtml(bundle.name)}</p>
      <p class="muted" style="font-size:12px;margin-bottom:14px">크기: ${UI.bytes(bundle.size)}</p>
      <div class="zip-actions">
        <button class="btn btn-primary" id="zdl">⬇️ 내 기기로 다운로드</button>
        <button class="btn btn-secondary" id="zshare">🔗 공유링크 만들기</button>
      </div>
      <div id="zresult"></div>
      <div class="modal-actions"><button class="btn btn-ghost" id="zclose">닫기</button></div>`);
    m.q('#zclose').addEventListener('click', m.close);
    m.q('#zdl').addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = API.bundleDownloadUrl(bundle.bundleId); a.download = bundle.name;
      // 인증이 필요하므로 fetch로 blob 받아 저장
      fetch(a.href, { headers: { Authorization: 'Bearer ' + API.getToken() }, credentials: 'include' })
        .then((r) => { if (!r.ok) throw new Error('다운로드 실패'); return r.blob(); })
        .then((b) => { const u = URL.createObjectURL(b); const el = document.createElement('a'); el.href = u; el.download = bundle.name; el.click(); URL.revokeObjectURL(u); UI.toast('다운로드 시작 ✅', 'success'); })
        .catch((err) => UI.toast(err.message, 'error'));
    });
    m.q('#zshare').addEventListener('click', () => {
      m.animate(() => {
        m.q('#zresult').innerHTML = `${shareOptionFields()}<button class="btn btn-primary btn-sm" id="zgen">링크 생성</button><div id="result"></div>`;
      });
      m.q('#zgen').addEventListener('click', async () => {
        try { const r = await API.bundleShare(bundle.bundleId, shareOptionValues(m)); shareResult(m, r.url); }
        catch (err) { UI.toast(err.message, 'error'); }
      });
    });
  }

  function bulkMoveModal() {
    const items = [...state.selected.values()];
    const movingFolders = items.filter((i) => i.type === 'folder').map((i) => i.path);
    // 폴더 자신·하위로는 이동 불가
    const blocked = new Set();
    for (const mf of movingFolders) { blocked.add(mf); for (const p of state.treeFolders) if (p === mf || p.startsWith(mf + '/')) blocked.add(p); }
    let dest = state.folder;
    const picked = () => (dest === '/' ? '🏠 홈(최상위)' : dest);
    const m = UI.modal(`<h3>선택 항목 이동</h3>
      <p class="muted" style="font-size:13px;margin-bottom:8px">아래에서 이동할 폴더를 선택하세요.</p>
      <div class="folder-picker" id="picker"></div>
      <div class="picked-bar">이동 위치: <b id="picked">${UI.escapeHtml(picked())}</b></div>
      <div class="modal-actions"><button class="btn btn-ghost" id="c">취소</button><button class="btn btn-primary" id="ok">여기로 이동</button></div>`);
    m.el.querySelector('.modal').classList.add('modal-wide');
    // 펼침 상태(피커 전용) — 기본은 현재 경로까지 펼침
    const openSet = pathChain(state.folder);
    function drawPicker() {
      const rootNode = buildTreeNodes(state.treeFolders);
      const render = (node, depth) => {
        const kids = Object.values(node.children).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
        const hasKids = kids.length > 0;
        const isOpen = openSet.has(node.path);
        const isBlocked = blocked.has(node.path);
        const sel = node.path === dest ? ' sel' : '';
        const caret = hasKids ? `<span class="pk-caret ${isOpen ? 'open' : ''}" data-tog="${UI.escapeHtml(node.path)}">▸</span>` : '<span class="pk-caret-empty"></span>';
        let html = `<div class="pick-row${sel}${isBlocked ? ' disabled' : ''}" data-path="${UI.escapeHtml(node.path)}" style="padding-left:${4 + depth * 16}px">${caret}<span class="pk-ic">${depth === 0 ? '🏠' : '📁'}</span><span class="pk-name">${UI.escapeHtml(node.name)}</span></div>`;
        if (hasKids && isOpen) for (const k of kids) html += render(k, depth + 1);
        return html;
      };
      const box = m.q('#picker'); box.innerHTML = render(rootNode, 0);
      box.querySelectorAll('.pk-caret[data-tog]').forEach((c) => c.addEventListener('click', (e) => { e.stopPropagation(); const p = c.dataset.tog; if (openSet.has(p)) openSet.delete(p); else openSet.add(p); drawPicker(); }));
      box.querySelectorAll('.pick-row:not(.disabled)').forEach((r) => r.addEventListener('click', () => { dest = r.dataset.path; m.q('#picked').textContent = picked(); drawPicker(); }));
    }
    drawPicker();
    m.q('#c').addEventListener('click', m.close);
    m.q('#ok').addEventListener('click', async () => {
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
    try {
      const r = await API.upload(fd, state.ownerId);
      if (r && r.rejected && r.rejected.length) UI.toast(`⚠️ ${r.rejected.length}개 차단됨 (${r.rejected.map((x) => x.reason || '보안 정책').join(' · ')})`, 'error');
      if (!r || !r.rejected || r.rejected.length < fileList.length) UI.toast('업로드 완료 ✅', 'success');
      loadAll();
    } catch (err) { UI.toast(err.message, 'error'); }
  }

  // Content-Disposition에서 파일명 추출 (filename*=UTF-8'' 우선, 없으면 filename=)
  function filenameFromCD(cd, fallback) {
    cd = cd || '';
    let m = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd);
    if (m) { try { return decodeURIComponent(m[1].trim().replace(/^["']|["']$/g, '')); } catch { return m[1].trim(); } }
    m = /filename="?([^";]+)"?/i.exec(cd);
    return m ? m[1].trim() : fallback;
  }

  // ── 이미지 썸네일 (그리드 뷰, 지연 로딩) ──────────
  const thumbCache = new Map(); // fileId -> objectURL
  const isImage = (name) => ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico'].includes((name.split('.').pop() || '').toLowerCase());
  function loadThumbs() {
    const els = document.querySelectorAll('#listing [data-thumb]'); if (!els.length || !('IntersectionObserver' in window)) return;
    const setImg = (el, url) => { el.innerHTML = `<img class="thumb-img" alt="" src="${url}">`; };
    const io = new IntersectionObserver((ents) => {
      ents.forEach((en) => {
        if (!en.isIntersecting) return; const el = en.target; io.unobserve(el); const id = el.dataset.thumb;
        if (thumbCache.has(id)) return setImg(el, thumbCache.get(id));
        fetch(API.downloadUrl(id), { headers: { Authorization: 'Bearer ' + API.getToken() }, credentials: 'include' })
          .then((r) => r.ok ? r.blob() : Promise.reject()).then((b) => { const u = URL.createObjectURL(b); thumbCache.set(id, u); setImg(el, u); }).catch(() => {});
      });
    }, { rootMargin: '150px' });
    els.forEach((el) => io.observe(el));
  }

  // ── 파일 미리보기 ──────────────────────────
  const PV_IMG = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico']);
  const PV_TXT = new Set(['txt', 'md', 'csv', 'log', 'json', 'xml', 'yml', 'yaml', 'html', 'css', 'js', 'ts', 'sql', 'ini', 'cfg', 'env']);
  const canPreview = (name) => { const e = (name.split('.').pop() || '').toLowerCase(); return PV_IMG.has(e) || PV_TXT.has(e) || e === 'pdf'; };
  function previewModal(id) {
    const f = state.files.find((x) => String(x.id) === String(id));
    const name = f ? f.name : '파일'; const ext = (name.split('.').pop() || '').toLowerCase();
    let objUrl = null;
    const m = UI.modal(`<h3 class="pv-title">👁️ ${UI.escapeHtml(name)}</h3><div class="preview-body" id="pv"><p class="muted" style="text-align:center;padding:36px">불러오는 중…</p></div><div class="modal-actions"><button class="btn btn-secondary" id="pv-dl">⬇️ 다운로드</button><button class="btn btn-primary" id="pv-close">닫기</button></div>`, { onClose: () => { if (objUrl) URL.revokeObjectURL(objUrl); } });
    m.el.querySelector('.modal').classList.add('modal-wide', 'modal-preview');
    m.q('#pv-close').addEventListener('click', m.close);
    m.q('#pv-dl').addEventListener('click', () => downloadFile(id));
    fetch(API.downloadUrl(id), { headers: { Authorization: 'Bearer ' + API.getToken() }, credentials: 'include' })
      .then((r) => { if (!r.ok) throw new Error('불러오기 실패'); return r.blob(); })
      .then(async (blob) => {
        const pv = m.q('#pv'); if (!pv) return;
        if (PV_IMG.has(ext)) { objUrl = URL.createObjectURL(blob); pv.innerHTML = `<img class="pv-img" alt="" src="${objUrl}">`; }
        else if (ext === 'pdf') { objUrl = URL.createObjectURL(blob); pv.innerHTML = `<iframe class="pv-frame" src="${objUrl}"></iframe>`; }
        else { let text = await blob.text(); if (text.length > 200000) text = text.slice(0, 200000) + '\n…(생략됨)'; const pre = document.createElement('pre'); pre.className = 'pv-text'; pre.textContent = text; pv.innerHTML = ''; pv.appendChild(pre); }
      })
      .catch((e) => { const pv = m.q('#pv'); if (pv) pv.innerHTML = `<p class="muted" style="text-align:center;color:var(--danger);padding:36px">${UI.escapeHtml(e.message)}</p>`; });
  }

  function downloadFile(id) {
    // 이미 목록에 아는 파일명이 있으면 그것을 기본값으로 (헤더를 못 읽어도 이름 보존)
    const known = state.files.find((x) => String(x.id) === String(id));
    fetch(API.downloadUrl(id), { headers: { Authorization: 'Bearer ' + API.getToken() }, credentials: 'include' })
      .then((r) => { if (!r.ok) throw new Error('다운로드 실패'); return r.blob().then((b) => ({ b, r })); })
      .then(({ b, r }) => { const name = filenameFromCD(r.headers.get('content-disposition'), known ? known.name : 'download'); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; a.click(); URL.revokeObjectURL(a.href); })
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
        <div class="pane" id="pane-normal"><div class="field" style="margin-top:14px"><label>폴더 이름</label><input class="input" id="fn" placeholder="예: 2026-보고서"></div>${stylePickerHTML('📁', '')}</div>
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
    const picker = wireStylePicker(m);
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
          await API.createFolder(parent + '/' + name, state.ownerId, picker.icon, picker.color);
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

  // 아이콘/색상 선택 UI HTML 생성
  function stylePickerHTML(curIcon, curColor) {
    const icons = FOLDER_ICONS.map((ic) => `<button type="button" class="ipick ${ic === (curIcon || '📁') ? 'on' : ''}" data-icon="${ic}">${ic}</button>`).join('');
    const colors = FOLDER_COLORS.map((c) => `<button type="button" class="cpick ${c === (curColor || '') ? 'on' : ''}" data-color="${c}" style="${c ? `background:${c}` : ''}" title="${c || '기본'}">${c ? '' : '✕'}</button>`).join('');
    return `<div class="field"><label>폴더 모양</label><div class="icon-picker">${icons}</div></div>
      <div class="field"><label>폴더 색상</label><div class="color-picker">${colors}</div></div>`;
  }
  function wireStylePicker(m) {
    let icon = m.el.querySelector('.ipick.on')?.dataset.icon || '📁';
    let color = m.el.querySelector('.cpick.on')?.dataset.color || '';
    m.el.querySelectorAll('.ipick').forEach((b) => b.addEventListener('click', () => { icon = b.dataset.icon; m.el.querySelectorAll('.ipick').forEach((x) => x.classList.toggle('on', x === b)); }));
    m.el.querySelectorAll('.cpick').forEach((b) => b.addEventListener('click', () => { color = b.dataset.color; m.el.querySelectorAll('.cpick').forEach((x) => x.classList.toggle('on', x === b)); }));
    return { get icon() { return icon; }, get color() { return color; } };
  }

  function folderSettingsModal(path) {
    const name = path.split('/').pop(); const parent = path.slice(0, path.lastIndexOf('/'));
    const f = state.folders.find((x) => x.path === path) || {};
    const st = f.icon || f.color ? f : folderStyle(path);
    const m = UI.modal(`<h3>폴더 설정</h3>
      <div class="field"><label>폴더 이름</label><input class="input" id="nm" value="${UI.escapeHtml(name)}"></div>
      ${stylePickerHTML(st.icon, st.color)}
      <div class="modal-actions"><button class="btn btn-ghost" id="c">취소</button><button class="btn btn-primary" id="ok">저장</button></div>`);
    const picker = wireStylePicker(m);
    m.q('#c').addEventListener('click', m.close);
    m.q('#ok').addEventListener('click', async () => {
      const nn = m.q('#nm').value.trim().replace(/\//g, ''); if (!nn) return;
      try {
        let target = path;
        if (nn !== name) { const r = await API.renameFolder(path, (parent || '') + '/' + nn, state.ownerId); target = r.path || (parent || '') + '/' + nn; if (state.folder === path || state.folder.startsWith(path + '/')) state.folder = target; }
        await API.setFolderStyle(target, picker.icon, picker.color, state.ownerId);
        m.close(); UI.toast('폴더 설정 저장됨', 'success'); loadAll();
      } catch (err) { UI.toast(err.message, 'error'); }
    });
    setTimeout(() => m.q('#nm').focus(), 50);
  }

  // 업로드 요청 링크: 생성 + 목록 + 취소
  function uploadRequestModal(folder) {
    const fname = folder === '/' ? '홈(최상위)' : folder.split('/').filter(Boolean).pop();
    const m = UI.modal(`<h3>📥 업로드 요청 링크</h3>
      <p class="muted" style="font-size:13px;margin-bottom:10px"><b>${UI.escapeHtml(fname)}</b> 폴더로 외부인이 로그인 없이 업로드할 수 있는 링크를 만듭니다.</p>
      <div class="field"><label>링크 이름(외부에 표시)</label><input class="input" id="ur-label" value="${UI.escapeHtml(fname)}"></div>
      <div style="display:flex;gap:10px">
        <div class="field" style="flex:1"><label>만료</label><select class="input" id="ur-exp"><option value="0">무기한</option><option value="1">1일</option><option value="7" selected>7일</option><option value="30">30일</option></select></div>
        <div class="field" style="flex:1"><label>최대 개수</label><input class="input num" id="ur-mf" type="number" min="1" placeholder="무제한"></div>
        <div class="field" style="flex:1"><label>최대 용량(GB)</label><input class="input num" id="ur-mg" type="number" min="0.1" step="0.1" placeholder="무제한"></div>
      </div>
      <div class="field"><label>비밀번호 (선택, 권장)</label><input class="input" id="ur-pw" type="text" placeholder="비우면 없음"></div>
      ${reasonField()}
      ${notifyFields('수신')}
      <div style="text-align:right"><button class="btn btn-primary btn-sm" id="ur-gen">＋ 링크 생성</button></div>
      <div id="ur-result"></div>
      <hr class="manual-hr" style="margin:16px 0 12px">
      <div class="muted" style="font-size:12px;margin-bottom:6px">이 폴더의 기존 링크</div>
      <div id="ur-list"><p class="muted" style="font-size:13px">불러오는 중…</p></div>
      <div class="modal-actions"><button class="btn btn-ghost" id="ur-close">닫기</button></div>`);
    m.el.querySelector('.modal').classList.add('modal-wide');
    m.q('#ur-close').addEventListener('click', m.close);
    async function refresh() {
      try {
        const { requests } = await API.uploadRequests(state.ownerId);
        const mine = requests.filter((r) => r.folder === folder);
        if (!mine.length) { m.q('#ur-list').innerHTML = '<p class="muted" style="font-size:13px">아직 없습니다.</p>'; return; }
        m.q('#ur-list').innerHTML = mine.map((r) => {
          const cap = [r.maxFiles ? `${r.uploadedCount}/${r.maxFiles}개` : `${r.uploadedCount}개`, r.maxBytes ? `${UI.bytes(r.uploadedBytes)}/${UI.bytes(r.maxBytes)}` : UI.bytes(r.uploadedBytes)].join(' · ');
          const badges = [r.hasPassword ? '🔒' : '', r.disabled ? '중지' : '', r.expiresAt ? UI.date(r.expiresAt) + '까지' : '무기한'].filter(Boolean).join(' · ');
          return `<div class="ur-row"><div style="flex:1;min-width:0"><b>${UI.escapeHtml(r.label)}</b> <span class="muted" style="font-size:12px">${badges}</span><br><span class="muted" style="font-size:11px">받음 ${cap}</span></div>
            <button class="btn btn-sm btn-ghost" data-copy="${UI.escapeHtml(location.origin + '/upload.html?t=' + r.token)}">📋 복사</button>
            <button class="btn btn-sm btn-danger" data-del="${r.id}">취소</button></div>`;
        }).join('');
        m.el.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => { navigator.clipboard?.writeText(b.dataset.copy); UI.toast('링크 복사됨', 'success'); }));
        m.el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => { try { await API.deleteUploadRequest(b.dataset.del, state.ownerId); UI.toast('취소됨', 'success'); refresh(); } catch (e) { UI.toast(e.message, 'error'); } }));
      } catch (e) { m.q('#ur-list').innerHTML = `<p class="muted" style="color:var(--danger)">${UI.escapeHtml(e.message)}</p>`; }
    }
    m.q('#ur-gen').addEventListener('click', async () => {
      try {
        const r = await API.createUploadRequest({
          folder, ownerId: state.ownerId, label: m.q('#ur-label').value.trim(),
          expiresInDays: parseInt(m.q('#ur-exp').value, 10) || 0, password: m.q('#ur-pw').value.trim(),
          maxFiles: parseInt(m.q('#ur-mf').value, 10) || 0, maxGb: parseFloat(m.q('#ur-mg').value) || 0,
          reason: reasonVal(m), ...notifyValues(m),
        });
        m.animate(() => { m.q('#ur-result').innerHTML = `<div class="field" style="margin-top:10px"><label>업로드 링크</label><input class="input" id="ur-lnk" readonly value="${UI.escapeHtml(r.url)}"></div><button class="btn btn-secondary btn-sm" id="ur-copy">📋 복사</button>`; });
        m.q('#ur-lnk').select();
        m.q('#ur-copy').addEventListener('click', () => { m.q('#ur-lnk').select(); navigator.clipboard?.writeText(r.url); UI.toast('링크 복사됨', 'success'); });
        refresh();
      } catch (e) { UI.toast(e.message, 'error'); }
    });
    refresh();
  }

  // 폴더 단위 공유(읽기 전용) 링크: 생성 + 목록 + 취소
  function folderShareModal(folder) {
    const fname = folder === '/' ? '홈(최상위)' : folder.split('/').filter(Boolean).pop();
    const m = UI.modal(`<h3>🔗 폴더 공유 (읽기 전용)</h3>
      <p class="muted" style="font-size:13px;margin-bottom:10px"><b>${UI.escapeHtml(fname)}</b> 폴더와 그 하위를 외부인이 <b>다운로드만</b> 할 수 있는 링크입니다. (업로드·이동·다른 폴더 접근 불가)</p>
      <div class="field"><label>링크 이름(외부에 표시)</label><input class="input" id="fs-label" value="${UI.escapeHtml(fname)}"></div>
      <div style="display:flex;gap:10px">
        <div class="field" style="flex:1"><label>만료</label><select class="input" id="fs-exp"><option value="0">무기한</option><option value="1">1일</option><option value="7" selected>7일</option><option value="30">30일</option></select></div>
        <div class="field" style="flex:1"><label>비밀번호 (선택)</label><input class="input" id="fs-pw" type="text" placeholder="비우면 없음"></div>
      </div>
      ${reasonField()}
      ${notifyFields('다운로드')}
      <div style="text-align:right"><button class="btn btn-primary btn-sm" id="fs-gen">＋ 링크 생성</button></div>
      <div id="fs-result"></div>
      <hr class="manual-hr" style="margin:16px 0 12px">
      <div class="muted" style="font-size:12px;margin-bottom:6px">이 폴더의 기존 공유</div>
      <div id="fs-list"><p class="muted" style="font-size:13px">불러오는 중…</p></div>
      <div class="modal-actions"><button class="btn btn-ghost" id="fs-close">닫기</button></div>`);
    m.el.querySelector('.modal').classList.add('modal-wide');
    m.q('#fs-close').addEventListener('click', m.close);
    async function refresh() {
      try {
        const { shares } = await API.folderShares(state.ownerId);
        const mine = shares.filter((r) => r.folder === folder);
        m.q('#fs-list').innerHTML = mine.length ? mine.map((r) => `<div class="ur-row"><div style="flex:1;min-width:0"><b>${UI.escapeHtml(r.label)}</b> <span class="muted" style="font-size:12px">${[r.hasPassword ? '🔒' : '', r.expiresAt ? UI.date(r.expiresAt) + '까지' : '무기한', '조회 ' + r.viewCount].join(' · ')}</span></div>
          <button class="btn btn-sm btn-ghost" data-copy="${UI.escapeHtml(location.origin + '/folder.html?t=' + r.token)}">📋</button><button class="btn btn-sm btn-danger" data-del="${r.id}">취소</button></div>`).join('') : '<p class="muted" style="font-size:13px">아직 없습니다.</p>';
        m.el.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => { navigator.clipboard?.writeText(b.dataset.copy); UI.toast('링크 복사됨', 'success'); }));
        m.el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => { try { await API.deleteFolderShare(b.dataset.del, state.ownerId); UI.toast('취소됨', 'success'); refresh(); } catch (e) { UI.toast(e.message, 'error'); } }));
      } catch (e) { m.q('#fs-list').innerHTML = `<p class="muted" style="color:var(--danger)">${UI.escapeHtml(e.message)}</p>`; }
    }
    m.q('#fs-gen').addEventListener('click', async () => {
      try {
        const r = await API.createFolderShare({ folder, ownerId: state.ownerId, label: m.q('#fs-label').value.trim(), expiresInDays: parseInt(m.q('#fs-exp').value, 10) || 0, password: m.q('#fs-pw').value.trim(), reason: reasonVal(m), ...notifyValues(m) });
        m.animate(() => { m.q('#fs-result').innerHTML = `<div class="field" style="margin-top:10px"><label>공유 링크</label><input class="input" id="fs-lnk" readonly value="${UI.escapeHtml(r.url)}"></div><button class="btn btn-secondary btn-sm" id="fs-copy">📋 복사</button>`; });
        m.q('#fs-lnk').select();
        m.q('#fs-copy').addEventListener('click', () => { m.q('#fs-lnk').select(); navigator.clipboard?.writeText(r.url); UI.toast('링크 복사됨', 'success'); });
        refresh();
      } catch (e) { UI.toast(e.message, 'error'); }
    });
    refresh();
  }

  // 공유 링크 관리 (내가 만든 파일/압축/폴더 공유)
  function shareManageModal() {
    const m = UI.modal(`<h3>🔗 공유 관리</h3><div id="sm-body"><p class="muted">불러오는 중…</p></div><div class="modal-actions"><button class="btn btn-primary" id="sm-close">닫기</button></div>`);
    m.el.querySelector('.modal').classList.add('modal-wide');
    m.q('#sm-close').addEventListener('click', m.close);
    async function load() {
      try {
        const [a, b, c] = await Promise.all([API.myShares(), API.folderShares(state.ownerId), API.uploadRequests(state.ownerId)]);
        const kindIco = { file: '📄', zip: '🗜️' };
        const fileRows = a.shares.map((s) => {
          const meta = [s.hasPassword ? '🔒' : '', s.maxDownloads != null ? `${s.downloadCount}/${s.maxDownloads}회` : `${s.downloadCount}회`, s.expiresAt ? UI.date(s.expiresAt) + '까지' : '무기한'].filter(Boolean).join(' · ');
          return `<div class="ur-row"><div style="flex:1;min-width:0">${kindIco[s.kind] || '📄'} <b>${UI.escapeHtml(s.name)}</b><br><span class="muted" style="font-size:11px">${meta}</span>${s.reason ? `<br><span class="muted" style="font-size:11px">💬 ${UI.escapeHtml(s.reason)}</span>` : ''}</div>
            <button class="btn btn-sm btn-ghost" data-copy="${UI.escapeHtml(location.origin + '/share.html?t=' + s.token)}">📋</button><button class="btn btn-sm btn-danger" data-dels="${s.id}">폐기</button></div>`;
        }).join('') || '<p class="muted" style="font-size:13px">파일/압축 공유가 없습니다.</p>';
        const folderRows = b.shares.map((s) => {
          const meta = [s.hasPassword ? '🔒' : '', s.expiresAt ? UI.date(s.expiresAt) + '까지' : '무기한', '조회 ' + s.viewCount].filter(Boolean).join(' · ');
          return `<div class="ur-row"><div style="flex:1;min-width:0">📁 <b>${UI.escapeHtml(s.label)}</b> <span class="muted" style="font-size:11px">${UI.escapeHtml(s.folder)}</span><br><span class="muted" style="font-size:11px">${meta}</span>${s.reason ? `<br><span class="muted" style="font-size:11px">💬 ${UI.escapeHtml(s.reason)}</span>` : ''}</div>
            <button class="btn btn-sm btn-ghost" data-copy="${UI.escapeHtml(location.origin + '/folder.html?t=' + s.token)}">📋</button><button class="btn btn-sm btn-danger" data-delf="${s.id}">폐기</button></div>`;
        }).join('') || '<p class="muted" style="font-size:13px">폴더 공유가 없습니다.</p>';
        const reqRows = c.requests.map((r) => {
          const cap = [r.maxFiles ? `${r.uploadedCount}/${r.maxFiles}개` : `${r.uploadedCount}개`, r.maxBytes ? `${UI.bytes(r.uploadedBytes)}/${UI.bytes(r.maxBytes)}` : UI.bytes(r.uploadedBytes)].join(' · ');
          const meta = [r.hasPassword ? '🔒' : '', r.disabled ? '중지' : '', r.expiresAt ? UI.date(r.expiresAt) + '까지' : '무기한', '받음 ' + cap].filter(Boolean).join(' · ');
          return `<div class="ur-row"><div style="flex:1;min-width:0">📥 <b>${UI.escapeHtml(r.label)}</b> <span class="muted" style="font-size:11px">${UI.escapeHtml(r.folder)}</span><br><span class="muted" style="font-size:11px">${meta}</span>${r.reason ? `<br><span class="muted" style="font-size:11px">💬 ${UI.escapeHtml(r.reason)}</span>` : ''}</div>
            <button class="btn btn-sm btn-ghost" data-copy="${UI.escapeHtml(location.origin + '/upload.html?t=' + r.token)}">📋</button><button class="btn btn-sm btn-danger" data-delu="${r.id}">폐기</button></div>`;
        }).join('') || '<p class="muted" style="font-size:13px">업로드 요청 링크가 없습니다.</p>';
        m.q('#sm-body').innerHTML = `<div class="muted" style="font-size:12px;margin-bottom:4px">파일 · 압축 공유</div>${fileRows}
          <hr class="manual-hr" style="margin:14px 0 10px"><div class="muted" style="font-size:12px;margin-bottom:4px">폴더 공유(읽기 전용)</div>${folderRows}
          <hr class="manual-hr" style="margin:14px 0 10px"><div class="muted" style="font-size:12px;margin-bottom:4px">업로드 요청(외부 업로드)</div>${reqRows}`;
        m.el.querySelectorAll('[data-copy]').forEach((x) => x.addEventListener('click', () => { navigator.clipboard?.writeText(x.dataset.copy); UI.toast('링크 복사됨', 'success'); }));
        m.el.querySelectorAll('[data-dels]').forEach((x) => x.addEventListener('click', async () => { try { await API.deleteShare(x.dataset.dels); UI.toast('폐기됨', 'success'); load(); } catch (e) { UI.toast(e.message, 'error'); } }));
        m.el.querySelectorAll('[data-delf]').forEach((x) => x.addEventListener('click', async () => { try { await API.deleteFolderShare(x.dataset.delf, state.ownerId); UI.toast('폐기됨', 'success'); load(); } catch (e) { UI.toast(e.message, 'error'); } }));
        m.el.querySelectorAll('[data-delu]').forEach((x) => x.addEventListener('click', async () => { try { await API.deleteUploadRequest(x.dataset.delu, state.ownerId); UI.toast('폐기됨', 'success'); load(); } catch (e) { UI.toast(e.message, 'error'); } }));
      } catch (e) { m.q('#sm-body').innerHTML = `<p class="muted" style="color:var(--danger)">${UI.escapeHtml(e.message)}</p>`; }
    }
    load();
  }

  // 공유 옵션(만료·비밀번호·횟수) 공통 필드/값/결과
  // 공유별 알림 옵트인 (인앱) — 활동 발생 시 만든 사람에게 알림(상단 🔔)
  function notifyFields(kindLabel) {
    return `<div class="field"><label class="set-check"><input type="checkbox" id="nt-inapp"> 🔔 ${kindLabel || '활동'} 시 인앱 알림 받기</label></div>`;
  }
  const notifyValues = (m) => ({ notifyInapp: !!(m.q('#nt-inapp') && m.q('#nt-inapp').checked) });
  // 공유 생성 사유(선택 메모) — 공유 관리에서 표시
  function reasonField() { return `<div class="field"><label>생성 사유 (선택)</label><input class="input" id="sh-reason" maxlength="300" placeholder="예: 2분기 정산 자료 전달용"></div>`; }
  const reasonVal = (m) => (m.q('#sh-reason') ? m.q('#sh-reason').value.trim() : '');
  function shareOptionFields() {
    return `<div class="field"><label>만료 기간</label><select class="input" id="exp"><option value="0">무기한</option><option value="1">1일</option><option value="7">7일</option><option value="30">30일</option></select></div>
      <div class="field"><label>비밀번호 (선택)</label><input class="input" id="spw" type="text" placeholder="비우면 없음"></div>
      <div class="field"><label>다운로드 횟수 제한 (선택)</label><input class="input num" id="smax" type="number" min="1" placeholder="비우면 무제한"></div>
      ${reasonField()}
      ${notifyFields('다운로드')}`;
  }
  const shareOptionValues = (m) => ({ expiresInDays: parseInt(m.q('#exp').value, 10) || 0, password: m.q('#spw').value.trim(), maxDownloads: parseInt(m.q('#smax').value, 10) || 0, reason: reasonVal(m), ...notifyValues(m) });
  function shareResult(m, url) {
    m.animate(() => { m.q('#result').innerHTML = `<div class="field" style="margin-top:14px"><label>공유 링크 (누구나 접근 가능)</label><input class="input" id="lnk" readonly value="${UI.escapeHtml(url)}"></div><button class="btn btn-secondary btn-sm" id="copy">📋 링크 복사</button>`; });
    m.q('#lnk').select();
    m.q('#copy').addEventListener('click', () => { m.q('#lnk').select(); navigator.clipboard?.writeText(url); UI.toast('링크 복사됨', 'success'); });
  }
  async function shareModal(id) {
    const f = state.files.find((x) => String(x.id) === String(id));
    const m = UI.modal(`<h3>🔗 공유 링크</h3><p class="muted" style="font-size:13px;margin-bottom:8px">${UI.escapeHtml(f ? f.name : '')}</p>${shareOptionFields()}<div class="modal-actions"><button class="btn btn-ghost" id="c">닫기</button><button class="btn btn-primary" id="gen">링크 생성</button></div><div id="result"></div>`);
    m.q('#c').addEventListener('click', m.close);
    m.q('#gen').addEventListener('click', async () => {
      try { const r = await API.share(id, shareOptionValues(m)); shareResult(m, r.url); }
      catch (err) { UI.toast(err.message, 'error'); }
    });
  }

  function trashModal() {
    const m = UI.modal(`<h3>🗑️ 내 휴지통 <span class="muted" style="font-size:13px;font-weight:400">· 최근 30일 이내 복원 가능</span></h3><div id="trash-body"><p class="muted">불러오는 중…</p></div><div class="modal-actions"><button class="btn btn-ghost" id="tc">닫기</button></div>`);
    m.el.querySelector('.modal').classList.add('modal-wide');
    m.q('#tc').addEventListener('click', m.close);
    const daysLeft = (iso) => Math.max(0, 30 - Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
    async function load() {
      try {
        const { folders, files } = await API.selfTrash();
        if (!folders.length && !files.length) { m.q('#trash-body').innerHTML = '<p class="muted" style="text-align:center;padding:24px">휴지통이 비어 있습니다.</p>'; return; }
        const frows = folders.map((f) => `<tr><td>📁 <b>${UI.escapeHtml(f.name)}</b> <span class="muted" style="font-size:12px">(${f.fileCount}개)</span><br><span class="muted" style="font-size:11px">${UI.escapeHtml(f.path)}</span></td><td class="num muted">${daysLeft(f.deletedAt)}일 남음</td><td style="text-align:right"><button class="btn btn-sm btn-secondary" data-rf="${f.id}">복원</button></td></tr>`).join('');
        const rows = files.map((f) => `<tr><td>📄 ${UI.escapeHtml(f.name)}<br><span class="muted" style="font-size:11px">${UI.escapeHtml(f.folder)} · ${UI.bytes(f.size)}</span></td><td class="num muted">${daysLeft(f.deletedAt)}일 남음</td><td style="text-align:right"><button class="btn btn-sm btn-secondary" data-rfile="${f.id}">복원</button></td></tr>`).join('');
        m.q('#trash-body').innerHTML = `<div class="table-wrap"><table><tbody>${frows}${rows}</tbody></table></div>`;
        m.el.querySelectorAll('[data-rf]').forEach((b) => b.addEventListener('click', async () => { try { await API.restoreSelfFolder(b.dataset.rf); UI.toast('폴더 복원됨', 'success'); load(); loadAll(); } catch (e) { UI.toast(e.message, 'error'); } }));
        m.el.querySelectorAll('[data-rfile]').forEach((b) => b.addEventListener('click', async () => { try { await API.restoreSelfFile(b.dataset.rfile); UI.toast('파일 복원됨', 'success'); load(); loadAll(); } catch (e) { UI.toast(e.message, 'error'); } }));
      } catch (e) { m.q('#trash-body').innerHTML = `<p class="muted" style="color:var(--danger)">${UI.escapeHtml(e.message)}</p>`; }
    }
    load();
  }

  function usageReportModal() {
    const m = UI.modal(`<h3>📊 용량 리포트</h3><div id="rep-body"><p class="muted">불러오는 중…</p></div><div class="modal-actions"><button class="btn btn-primary" id="rc">닫기</button></div>`);
    m.el.querySelector('.modal').classList.add('modal-wide');
    m.q('#rc').addEventListener('click', m.close);
    API.usageReport(state.ownerId).then((r) => {
      const pct = r.quotaBytes > 0 ? Math.min(100, r.usedBytes / r.quotaBytes * 100) : 0;
      m.q('#rep-body').innerHTML = `
        <div class="rep-summary"><b class="num">${UI.bytes(r.usedBytes)}</b> <span class="muted">${r.unlimited ? '· 무제한' : (r.quotaBytes > 0 ? '/ ' + UI.bytes(r.quotaBytes) + ` (${pct.toFixed(0)}%)` : '· 미할당')} · 총 ${r.fileCount}개 파일</span></div>
        ${!r.unlimited && r.quotaBytes > 0 ? `<div class="usage-bar" style="max-width:none;margin:6px 0 14px"><span style="width:${pct}%"></span></div>` : '<div style="height:8px"></div>'}
        <div id="rep-map"></div>`;
      if (r.tree && r.tree.length) UI.folderTreemap(m.q('#rep-map'), r.tree, { height: 380, rootLabel: '내 폴더' });
      else m.q('#rep-map').innerHTML = '<p class="muted">파일이 없습니다.</p>';
    }).catch((e) => { m.q('#rep-body').innerHTML = `<p class="muted" style="color:var(--danger)">${UI.escapeHtml(e.message)}</p>`; });
  }

  function helpModal() {
    const m = UI.modal(`${Manual.userHTML()}<div class="modal-actions"><button class="btn btn-primary" id="mclose">닫기</button></div>`);
    m.el.querySelector('.modal').classList.add('modal-wide');
    m.q('#mclose').addEventListener('click', m.close);
  }

  // ── 인앱 알림 ──────────
  let notifTimer = null, refreshTimer = null, lastUnread = -1, visHooked = false;
  async function refreshNotifBadge() {
    try {
      const d = await API.notifications(1);
      const badge = document.getElementById('notif-badge'); if (!badge) return;
      if (d.unread > 0) { badge.textContent = d.unread > 99 ? '99+' : d.unread; badge.classList.remove('hidden'); }
      else badge.classList.add('hidden');
      // 새 알림이 늘었으면 토스트 + 현재 목록 자동 새로고침(최초 로드 때는 제외)
      if (lastUnread >= 0 && d.unread > lastUnread) { UI.toast(`🔔 새 알림 ${d.unread - lastUnread}건`, 'info'); maybeAutoRefresh(); }
      lastUnread = d.unread;
    } catch {}
  }
  // 안전할 때만 조용히 현재 폴더를 다시 불러온다(선택/검색/모달/숨김 탭이면 건너뜀).
  function maybeAutoRefresh() {
    if (document.visibilityState !== 'visible') return;
    if (!state.user || state.search.on) return;
    if (state.selected.size > 0) return;
    if (document.querySelector('.modal-backdrop')) return;
    loadTree(); loadFiles(true);
  }
  function startNotifPolling() {
    if (notifTimer) clearInterval(notifTimer);
    if (refreshTimer) clearInterval(refreshTimer);
    notifTimer = setInterval(refreshNotifBadge, 30000);      // 알림 30초 폴링
    refreshTimer = setInterval(maybeAutoRefresh, 45000);     // 목록 45초 자동 새로고침
    if (!visHooked) { visHooked = true; document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { refreshNotifBadge(); maybeAutoRefresh(); } }); }
  }
  function notifModal() {
    const m = UI.modal(`<h3>🔔 알림</h3><div id="nf-body"><p class="muted">불러오는 중…</p></div><div class="modal-actions"><button class="btn btn-ghost" id="nf-read">모두 읽음</button><button class="btn btn-primary" id="nf-close">닫기</button></div>`);
    m.el.querySelector('.modal').classList.add('modal-wide');
    m.q('#nf-close').addEventListener('click', m.close);
    const when = (iso) => { const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000); if (s < 60) return '방금'; if (s < 3600) return Math.floor(s / 60) + '분 전'; if (s < 86400) return Math.floor(s / 3600) + '시간 전'; return UI.date(iso); };
    const ico = { upload: '📤', upload_request: '📥', share_download: '⬇️', folder_share_download: '📁' };
    async function load() {
      try {
        const d = await API.notifications(30);
        m.q('#nf-body').innerHTML = d.items.length ? d.items.map((n) => `<div class="nf-item${n.isRead ? '' : ' unread'}">
          <span class="nf-ic">${ico[n.type] || '🔔'}</span>
          <div style="flex:1;min-width:0"><div class="nf-title">${UI.escapeHtml(n.title)}</div><div class="nf-body">${UI.escapeHtml(n.body)}</div><div class="nf-time muted">${when(n.createdAt)}</div></div></div>`).join('') : '<div class="empty" style="padding:24px">알림이 없습니다.</div>';
        // 열람 시 자동으로 모두 읽음 처리
        if (d.unread > 0) { await API.markNotificationsRead(); refreshNotifBadge(); }
      } catch (e) { m.q('#nf-body').innerHTML = `<p class="muted" style="color:var(--danger)">${UI.escapeHtml(e.message)}</p>`; }
    }
    m.q('#nf-read').addEventListener('click', async () => { try { await API.markNotificationsRead(); UI.toast('모두 읽음 처리됨', 'success'); refreshNotifBadge(); load(); } catch (e) { UI.toast(e.message, 'error'); } });
    load();
  }

  // 2FA 등록 UI를 host 요소에 렌더(QR + 시크릿 + 코드 확인). 완료 시 onDone().
  async function twoFactorEnroll(host, onDone) {
    host.innerHTML = '<p class="muted" style="text-align:center">준비 중…</p>';
    let data;
    try { data = await API.setup2fa(); } catch (e) { host.innerHTML = `<p class="muted" style="color:var(--danger)">${UI.escapeHtml(e.message)}</p>`; return; }
    host.innerHTML = `
      <p class="muted" style="font-size:13px;margin-bottom:8px">① 인증 앱(Google Authenticator, Authy 등)으로 아래 QR을 스캔하거나 키를 입력하세요.</p>
      <div style="text-align:center"><img src="${data.qr}" alt="QR" style="width:180px;height:180px;border:1px solid var(--border);border-radius:8px"></div>
      <div class="field" style="margin-top:8px"><label>설정 키(수동 입력용)</label><input class="input" readonly value="${UI.escapeHtml(data.secret)}" style="font-family:monospace;letter-spacing:1px"></div>
      <p class="muted" style="font-size:13px;margin:10px 0 6px">② 앱에 표시된 6자리 코드를 입력하세요.</p>
      <div class="field"><input class="input num" id="tf-code" inputmode="numeric" maxlength="6" placeholder="6자리 코드"></div>
      <button class="btn btn-primary" id="tf-confirm" style="width:100%">확인하고 켜기</button>
      <p id="tf-msg" class="muted" style="text-align:center;font-size:13px;margin-top:8px"></p>`;
    const confirm = async () => {
      const msg = host.querySelector('#tf-msg'); const btn = host.querySelector('#tf-confirm');
      btn.disabled = true; msg.style.color = ''; msg.textContent = '확인 중…';
      try { await API.enable2fa(host.querySelector('#tf-code').value.trim()); onDone(); }
      catch (e) { msg.style.color = 'var(--danger)'; msg.textContent = e.message; btn.disabled = false; }
    };
    host.querySelector('#tf-confirm').addEventListener('click', confirm);
    host.querySelector('#tf-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') confirm(); });
  }

  async function settingsModal() {
    const m = UI.modal(`<h3>⚙️ 내 설정</h3><div id="set-body"><p class="muted">불러오는 중…</p></div><div class="modal-actions"><button class="btn btn-primary" id="set-close">닫기</button></div>`);
    m.el.querySelector('.modal').classList.add('modal-wide');
    m.q('#set-close').addEventListener('click', m.close);
    let u;
    try { u = (await API.me()).user; } catch (e) { m.q('#set-body').innerHTML = `<p class="muted" style="color:var(--danger)">${UI.escapeHtml(e.message)}</p>`; return; }
    m.q('#set-body').innerHTML = `
      <div class="set-sec">
        <div class="dash-h">⬆️ 업로드</div>
        <label class="muted" style="font-size:13px">같은 이름 파일을 올릴 때</label>
        <label class="set-radio"><input type="radio" name="s-conf" value="rename" ${u.uploadConflict !== 'overwrite' ? 'checked' : ''}> 번호 붙여 보관 <span class="muted">— 기존 파일 그대로 두고 (2), (3)…</span></label>
        <label class="set-radio"><input type="radio" name="s-conf" value="overwrite" ${u.uploadConflict === 'overwrite' ? 'checked' : ''}> 덮어쓰기 <span class="muted">— 이전 파일은 휴지통으로(30일 복원 가능)</span></label>
        <div style="text-align:right;margin-top:8px"><button class="btn btn-primary btn-sm" id="s-save">저장</button></div>
      </div>
      <hr class="manual-hr" style="margin:16px 0">
      <div class="set-sec">
        <div class="dash-h">🔐 2단계 인증 (TOTP)</div>
        <div id="tf-section"></div>
      </div>
      <hr class="manual-hr" style="margin:16px 0">
      <div class="set-sec">
        <div class="dash-h">🔑 비밀번호 변경</div>
        <div class="field"><label>현재 비밀번호</label><input class="input" type="password" id="cur"></div>
        <div class="field"><label>새 비밀번호 (8자 이상)</label><input class="input" type="password" id="nw"></div>
        <div class="field"><label>새 비밀번호 확인</label><input class="input" type="password" id="nw2"><span class="pw-match muted" id="match"></span></div>
        <div style="text-align:right"><button class="btn btn-secondary btn-sm" id="pw-save">비밀번호 변경</button></div>
      </div>`;
    const tf = m.q('#tf-section');
    function renderTf(enabled) {
      if (enabled) {
        tf.innerHTML = `<p style="font-size:14px"><span class="badge on">사용 중</span> 로그인 시 인증 앱의 6자리 코드를 요구합니다.</p>${u.role === 'admin' ? '<p class="muted" style="font-size:12px">관리자 계정은 필수라 해제할 수 없습니다.</p>' : '<div style="text-align:right"><button class="btn btn-sm btn-danger" id="tf-disable">해제</button></div>'}`;
        const db = tf.querySelector('#tf-disable');
        if (db) db.addEventListener('click', () => {
          tf.innerHTML = `<div class="field"><label>해제하려면 비밀번호 확인</label><input class="input" type="password" id="tf-pw" placeholder="현재 비밀번호"></div><div style="text-align:right"><button class="btn btn-sm btn-ghost" id="tf-cancel">취소</button> <button class="btn btn-sm btn-danger" id="tf-do">해제</button></div>`;
          tf.querySelector('#tf-cancel').addEventListener('click', () => renderTf(true));
          tf.querySelector('#tf-do').addEventListener('click', async () => {
            try { await API.disable2fa(tf.querySelector('#tf-pw').value); UI.toast('2단계 인증이 해제되었습니다', 'success'); renderTf(false); } catch (e) { UI.toast(e.message, 'error'); }
          });
        });
      } else {
        tf.innerHTML = `<p class="muted" style="font-size:13px">로그인 보안을 위해 인증 앱 기반 2단계 인증을 켤 수 있습니다.</p><div style="text-align:right"><button class="btn btn-sm btn-primary" id="tf-start">＋ 설정</button></div>`;
        tf.querySelector('#tf-start').addEventListener('click', () => twoFactorEnroll(tf, () => { UI.toast('2단계 인증이 켜졌습니다 🔐', 'success'); renderTf(true); }));
      }
    }
    renderTf(!!u.totpEnabled);
    m.q('#s-save').addEventListener('click', async () => {
      try {
        await API.updateSettings({ uploadConflict: m.el.querySelector('input[name=s-conf]:checked').value });
        UI.toast('설정이 저장되었습니다 ✅', 'success');
      } catch (err) { UI.toast(err.message, 'error'); }
    });
    const check = () => { const a = m.q('#nw').value, b = m.q('#nw2').value; const el = m.q('#match'); if (!b) { el.textContent = ''; return; } if (a === b) { el.textContent = '✓ 일치'; el.className = 'pw-match ok'; } else { el.textContent = '✗ 불일치'; el.className = 'pw-match bad'; } };
    m.q('#nw').addEventListener('input', check); m.q('#nw2').addEventListener('input', check);
    m.q('#pw-save').addEventListener('click', async () => {
      if (m.q('#nw').value !== m.q('#nw2').value) return UI.toast('새 비밀번호가 일치하지 않습니다', 'error');
      try { await API.changePassword(m.q('#cur').value, m.q('#nw').value); UI.toast('비밀번호가 변경되었습니다 🔐', 'success'); m.q('#cur').value = m.q('#nw').value = m.q('#nw2').value = ''; } catch (err) { UI.toast(err.message, 'error'); }
    });
  }

  function checkImpersonate() { const p = new URLSearchParams(location.search); if (p.get('ownerId')) { state.ownerId = p.get('ownerId'); state.ownerName = p.get('name') || ''; } }

  return { boot, checkImpersonate };
})();

document.addEventListener('DOMContentLoaded', () => { App.checkImpersonate(); App.boot(); });
