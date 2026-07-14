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
    favOnly: false,       // 즐겨찾기만 보기
    tagFilter: null,      // 태그로 필터(태그 id)
    tags: [],             // 현재 계정(owner)의 태그 목록
    qrEnabled: true,      // 공유 QR 사용 여부(관리자 설정)
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
        state.qrEnabled = state.user.qrEnabled !== false;
        if (state.user.role === 'admin' && !state.user.totpEnabled) return force2faSetup();
        return renderApp();
      } catch { API.setToken(null); }
    }
    renderLogin();
  }
  // 관리자 2FA 필수: 설정 완료 전까지 앱 진입 차단
  function force2faSetup() {
    root().innerHTML = `<div class="login-screen"><div class="login-card" style="max-width:460px">
      <img src="assets/logo.svg?v=64" class="login-logo" alt="북적북적">
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
          <img src="assets/logo.svg?v=64" class="login-logo" alt="북적북적">
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
      try {
        await UI.busy(btn, async () => {
          const r = await API.login(f.username.value.trim(), f.password.value, f.token.value.trim());
          API.setToken(r.token); state.user = r.user; state.qrEnabled = r.user.qrEnabled !== false;
          if (r.mustSetup2fa) return force2faSetup();
          UI.toast(`${r.user.displayName}님 환영합니다 🎉`, 'success'); renderApp();
        });
      } catch (err) {
        if (err.data && err.data.need2fa) {
          f.querySelector('#tfa-field').classList.remove('hidden'); f.token.focus();
          UI.toast(err.message, err.data.need2fa && f.token.value ? 'error' : 'info');
        } else UI.toast(err.message, 'error');
      }
    });
  }

  function renderApp() {
    const admin = state.user.role === 'admin';
    root().innerHTML = `
      <div class="layout">
        <header class="appbar">
          <button class="icon-btn appbar-menu" id="menu-toggle" title="폴더">☰</button>
          <div class="brand" id="brand-home" title="홈으로"><img src="assets/logo.svg?v=64"><span class="brand-name">북적북적</span></div>
          ${isPriv() ? `<select class="input account-switcher" id="account-switcher"><option value="">내 파일</option></select>` : ''}
          <div class="topbar-spacer"></div>
          <button class="icon-btn appbar-navmenu" id="nav-menu-toggle" title="메뉴" aria-label="메뉴">☰<span class="notif-badge hidden" id="notif-badge-menu">0</span></button>
          <nav class="appbar-nav" id="appbar-nav">
            <div class="nav-user">${UI.escapeHtml(state.user.displayName)} · ${roleLabel(state.user.role)}</div>
            <div class="nav-item" data-nav="files"><span class="ico">📁</span><span class="t">내 파일</span></div>
            <div class="nav-item" data-nav="shares"><span class="ico">🔗</span><span class="t">공유</span></div>
            <div class="nav-item" data-nav="trash"><span class="ico">🗑️</span><span class="t">휴지통</span></div>
            <div class="nav-item nav-bell" data-nav="notif"><span class="ico">🔔</span><span class="t">알림</span><span class="notif-badge hidden" id="notif-badge">0</span></div>
            ${admin ? '<a class="nav-item" href="admin.html"><span class="ico">🛡️</span><span class="t">관리자</span></a>' : ''}
            <div class="nav-item" data-nav="serverstatus"><span class="ico">🖥️</span><span class="t">서버 상태</span></div>
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
          <aside class="preview-panel hidden" id="preview-panel" aria-hidden="true">
            <div class="pp-head">
              <span class="pp-name" id="pp-name" title=""></span>
              <button class="icon-btn" id="pp-dl" title="다운로드">⬇️</button>
              <button class="icon-btn" id="pp-close" title="닫기">✕</button>
            </div>
            <div class="pp-body" id="pp-body"></div>
          </aside>
          <div class="preview-backdrop" id="preview-backdrop"></div>
        </div>
      </div>
      <nav class="mobile-tabbar" id="mobile-tabbar">
        <button class="mtab" data-mtab="files"><span class="mt-ic">📁</span><span class="mt-l">파일</span></button>
        <button class="mtab" data-mtab="search"><span class="mt-ic">🔎</span><span class="mt-l">검색</span></button>
        <button class="mtab mtab-fab" data-mtab="upload" aria-label="업로드"><span class="mt-ic">⬆️</span></button>
        <button class="mtab" data-mtab="notif"><span class="mt-ic">🔔</span><span class="notif-badge hidden" id="notif-badge-tab">0</span><span class="mt-l">알림</span></button>
        <button class="mtab" data-mtab="menu"><span class="mt-ic">☰</span><span class="mt-l">메뉴</span></button>
      </nav>
      <div class="drop-overlay hidden" id="drop-overlay"><div class="drop-inner"><div class="drop-ic">📥</div>여기에 놓아 업로드<div class="drop-sub">현재 폴더로 올라갑니다</div></div></div>`;
    root().querySelectorAll('#mobile-tabbar [data-mtab]').forEach((el) => el.addEventListener('click', (e) => {
      e.stopPropagation(); // 상단 nav 드롭다운을 닫는 document 클릭 핸들러와 충돌 방지(메뉴 즉시 닫힘 버그)
      const t = el.dataset.mtab;
      if (t === 'menu') { document.getElementById('appbar-nav')?.classList.toggle('open'); return; }
      closeNavMenu(); // 다른 탭 이동 시 열려있던 메뉴는 닫기
      if (t === 'files') goTo('/');
      else if (t === 'search') { const si = document.getElementById('search-input'); if (si) { window.scrollTo({ top: 0, behavior: 'smooth' }); si.focus(); } }
      else if (t === 'upload') uploadSheet();
      else if (t === 'notif') notifModal();
    }));
    root().querySelectorAll('.appbar-nav [data-nav]').forEach((el) => el.addEventListener('click', () => {
      const n = el.dataset.nav;
      closeNavMenu();
      if (n === 'logout') doLogout(); else if (n === 'settings') settingsModal(); else if (n === 'files') resetToOwn(); else if (n === 'help') helpModal(); else if (n === 'trash') trashModal(); else if (n === 'shares') shareManageModal(); else if (n === 'notif') notifModal(); else if (n === 'serverstatus') serverStatusModal();
    }));
    // 모바일: 상단바 메뉴(햄버거) → 텍스트 리스트 드롭다운
    const navMenuBtn = document.getElementById('nav-menu-toggle');
    navMenuBtn.addEventListener('click', (e) => { e.stopPropagation(); document.getElementById('appbar-nav').classList.toggle('open'); });
    document.addEventListener('click', (e) => { if (!e.target.closest('#appbar-nav, #nav-menu-toggle')) closeNavMenu(); });
    document.getElementById('menu-toggle').addEventListener('click', toggleTree);
    refreshNotifBadge(); startNotifPolling(); setupBackTrap();
    document.getElementById('tree-backdrop').addEventListener('click', toggleTree);
    // 우측 미리보기 패널: 닫기·다운로드·배경탭·ESC
    document.getElementById('pp-close')?.addEventListener('click', closePreview);
    document.getElementById('preview-backdrop')?.addEventListener('click', closePreview);
    document.getElementById('pp-dl')?.addEventListener('click', () => { if (pvCurrentId) downloadFile(pvCurrentId); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('pv-open')) closePreview(); });
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
  function closeNavMenu() { document.getElementById('appbar-nav')?.classList.remove('open'); }
  const isMobile = () => window.matchMedia('(max-width: 640px)').matches;
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

  async function loadAll() { await Promise.all([loadTree(), loadFiles(), loadTags()]); }
  async function loadTags() { try { state.tags = (await API.tags(state.ownerId)).tags || []; } catch { state.tags = []; } }
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
          <button class="btn btn-secondary btn-sm" id="smart-btn" title="파일명(지점·날짜)으로 폴더를 추천해 업로드">🧭 <span class="label">추천</span></button>
          <button class="btn btn-secondary btn-sm" id="new-folder">📂 <span class="label">새 폴더</span></button>
          <button class="btn btn-ghost btn-sm" id="refresh-btn" title="목록 새로고침">🔄 <span class="label">새로고침</span></button>
          <input type="file" id="file-input" multiple hidden accept="${state.allowedExt.map((e) => '.' + e).join(',')}">
          <input type="file" id="cam-input" accept="image/*" capture="environment" multiple hidden>
          <div class="tools-break"></div>
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
      if (!!a.fav !== !!b.fav) return a.fav ? -1 : 1; // 즐겨찾기는 항상 상단 고정
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

  // 즐겨찾기 별 버튼 / 태그 칩
  const favBtn = (isFolder, ref, on) => `<button class="fav-btn${on ? ' on' : ''}" data-fav-${isFolder ? 'folder' : 'file'}="${UI.escapeHtml(String(ref))}" title="${on ? '즐겨찾기 해제' : '즐겨찾기'}" aria-label="즐겨찾기">${on ? '⭐' : '☆'}</button>`;
  const tagChips = (tags) => (tags && tags.length)
    ? `<span class="tag-chips">${tags.map((t) => `<span class="tag-chip" style="--tc:${UI.escapeHtml(t.color || '#118AB2')}">${UI.escapeHtml(t.name)}</span>`).join('')}</span>` : '';
  function renderListing() {
    const box = document.getElementById('listing');
    if (state.folders.length === 0 && state.files.length === 0) { box.innerHTML = `<div class="empty"><div class="big">🗂️</div>아직 파일이 없어요. 첫 파일을 올려보세요!</div>`; return; }
    if (filteredFolders().length === 0 && filteredFiles().length === 0) { box.innerHTML = `<div class="empty"><div class="big">🔍</div>필터에 해당하는 항목이 없습니다.</div>`; updateSelbar(); return; }
    // 모바일 리스트 뷰: 항목을 눌러 펼치는 아코디언 카드 + 텍스트 버튼
    if (isMobile() && state.view === 'list') box.innerHTML = mobileListHTML();
    else box.innerHTML = state.view === 'grid' ? gridHTML() : listHTML();
    wireListing(); updateSelbar(); loadThumbs(); // 그리드 파일 썸네일 + 모든 뷰의 폴더 커버
  }

  // 모바일 전용: 기본정보(이름·크기·등록일)만 보이고, 탭하면 상세+기능이 펼쳐지는 카드
  function mobileListHTML() {
    const esc = UI.escapeHtml, isSel = (key) => state.selected.has(key);
    const folders = sortItems(filteredFolders(), true).map((f) => {
      const key = `folder:${f.path}`;
      return `<div class="mcard fade-in${isSel(key) ? ' sel' : ''}" data-folder-row="${esc(f.path)}" data-row-key="${esc(key)}" data-drop-folder="${esc(f.path)}">
        <div class="mcard-head">
          <input type="checkbox" class="rowcheck" data-sel-folder="${esc(f.path)}" data-name="${esc(f.name)}" ${isSel(key) ? 'checked' : ''}>
          <div class="mcard-main">
            <div class="mcard-name"><span class="ic${f.color ? ' tint' : ''}${f.cover ? ' has-cover' : ''}"${f.cover ? ` data-thumb="${f.cover}"` : ''} style="${folderIcoStyle(f.color)}">${f.icon || '📁'}</span> ${esc(f.name)}${updateBadge(f, true)}</div>
            <div class="mcard-sub">${UI.bytes(f.size)} · ${f.createdAt ? UI.date(f.createdAt) : '폴더'}</div>
          </div>
          ${favBtn(true, f.path, f.fav)}
          <span class="mcard-caret">▾</span>
        </div>
        <div class="mcard-body">
          ${f.noteUpdatedAt ? `<div class="mcard-info"><span class="k">수정</span> ${UI.date(f.noteUpdatedAt)}</div>` : ''}
          ${f.note ? `<div class="mcard-info"><span class="k">비고</span> ${esc(f.note)}</div>` : ''}
          <div class="mcard-acts">
            <button class="mbtn mbtn-primary" data-open="${esc(f.path)}">📂 열기</button>
            <button class="mbtn" data-fshare="${esc(f.path)}">🔗 폴더공유</button>
            <button class="mbtn" data-freq="${esc(f.path)}">📥 업로드요청</button>
            <button class="mbtn" data-fnote="${esc(f.path)}">📝 비고</button>
            <button class="mbtn" data-fedit="${esc(f.path)}">⚙️ 설정</button>
            <button class="mbtn mbtn-danger" data-fdel="${esc(f.path)}">🗑️ 삭제</button>
          </div>
        </div>
      </div>`;
    }).join('');
    const files = sortItems(filteredFiles(), false).map((f) => {
      const key = `file:${f.id}`;
      return `<div class="mcard fade-in${isSel(key) ? ' sel' : ''}" data-file="${f.id}" data-row-key="${esc(key)}">
        <div class="mcard-head">
          <input type="checkbox" class="rowcheck" data-sel-file="${f.id}" data-name="${esc(f.name)}" ${isSel(key) ? 'checked' : ''}>
          <div class="mcard-main">
            <div class="mcard-name"><span class="ic">${UI.fileIcon(f.name)}</span> ${esc(f.name)}${updateBadge(f, false)}</div>
            <div class="mcard-sub">${UI.bytes(f.size)} · ${UI.date(f.createdAt)}</div>
            ${state.search.on ? `<div class="mcard-sub mcard-path" data-goto="${esc(f.folder || '/')}">📁 ${esc(prettyPath(f.folder))}</div>` : ''}
            ${tagChips(f.tags)}
          </div>
          ${favBtn(false, f.id, f.fav)}
          <span class="mcard-caret">▾</span>
        </div>
        <div class="mcard-body">
          <div class="mcard-info"><span class="k">수정</span> ${UI.date(f.updatedAt || f.createdAt)}</div>
          ${f.note ? `<div class="mcard-info"><span class="k">비고</span> ${esc(f.note)}</div>` : ''}
          <div class="mcard-acts">
            <button class="mbtn mbtn-primary" data-dl="${f.id}">⬇️ 다운로드</button>
            ${canPreview(f.name) ? `<button class="mbtn" data-preview="${f.id}">👁️ 미리보기</button>` : ''}
            <button class="mbtn" data-share="${f.id}">🔗 공유</button>
            <button class="mbtn" data-tags="${f.id}">🏷️ 태그</button>
            <button class="mbtn" data-note="${f.id}">📝 비고</button>
            <button class="mbtn" data-rename="${f.id}">✏️ 이름변경</button>
            <button class="mbtn mbtn-danger" data-del="${f.id}">🗑️ 삭제</button>
          </div>
        </div>
      </div>`;
    }).join('');
    return `<div class="mlist fade-in">${folders}${files}</div>`;
  }

  function gridHTML() {
    const folders = sortItems(filteredFolders(), true).map((f) => `
      <div class="file-card fade-in${state.selected.has(`folder:${f.path}`) ? ' sel' : ''}" data-folder-card="${UI.escapeHtml(f.path)}" data-row-key="folder:${UI.escapeHtml(f.path)}" data-drop-folder="${UI.escapeHtml(f.path)}" draggable="true" title="더블클릭하여 열기">
        <div class="file-actions">
          <button class="icon-btn" data-fshare="${UI.escapeHtml(f.path)}" title="폴더 공유(읽기전용)">🔗</button>
          <button class="icon-btn" data-freq="${UI.escapeHtml(f.path)}" title="업로드 요청 링크">📥</button>
          <button class="icon-btn" data-fedit="${UI.escapeHtml(f.path)}" title="폴더 설정">⚙️</button>
          <button class="icon-btn" data-fnote="${UI.escapeHtml(f.path)}" title="비고">📝</button>
          <button class="icon-btn" data-fdel="${UI.escapeHtml(f.path)}" title="삭제">🗑️</button>
        </div>
        ${favBtn(true, f.path, f.fav)}
        ${f.cover
          ? `<div class="file-ico folder-cover" data-thumb="${f.cover}">${f.icon || '📁'}</div>`
          : `<div class="file-ico${f.color ? ' tint' : ''}" style="${folderIcoStyle(f.color)}">${f.icon || '📁'}</div>`}
        <div class="file-name">${UI.escapeHtml(f.name)}${updateBadge(f, true)}</div>
        <div class="file-meta num">${UI.bytes(f.size)} · ${f.createdAt ? UI.date(f.createdAt) : '폴더'}</div>
        ${f.note ? `<div class="file-note" title="${UI.escapeHtml(f.note)}">📝 ${UI.escapeHtml(f.note)}</div>` : ''}
      </div>`).join('');
    const files = sortItems(filteredFiles(), false).map((f) => `
      <div class="file-card fade-in${state.selected.has(`file:${f.id}`) ? ' sel' : ''}" data-file="${f.id}" data-row-key="file:${f.id}" draggable="true">
        <div class="file-actions">
          ${canPreview(f.name) ? `<button class="icon-btn" data-preview="${f.id}" title="미리보기">👁️</button>` : ''}
          <button class="icon-btn" data-share="${f.id}" title="공유링크">🔗</button>
          <button class="icon-btn" data-tags="${f.id}" title="태그">🏷️</button>
          <button class="icon-btn" data-note="${f.id}" title="비고">📝</button>
          <button class="icon-btn" data-rename="${f.id}" title="이름변경">✏️</button>
          <button class="icon-btn" data-dl="${f.id}" title="다운로드">⬇️</button>
          <button class="icon-btn" data-del="${f.id}" title="삭제">🗑️</button>
        </div>
        ${favBtn(false, f.id, f.fav)}
        <div class="file-ico${isImage(f.name) ? ' thumb' : ''}"${isImage(f.name) ? ` data-thumb="${f.id}"` : ''}>${isImage(f.name) ? '🖼️' : UI.fileIcon(f.name)}</div>
        <div class="file-name">${UI.escapeHtml(f.name)}${updateBadge(f, false)}</div>
        <div class="file-meta num">${UI.bytes(f.size)} · ${UI.date(f.createdAt)}</div>
        ${tagChips(f.tags)}
        ${f.note ? `<div class="file-note" title="${UI.escapeHtml(f.note)}">📝 ${UI.escapeHtml(f.note)}</div>` : ''}
      </div>`).join('');
    return `<div class="file-grid">${folders}${files}</div>`;
  }

  // 파일 폴더 경로를 보기 좋게 (홈 / 세그먼트 › ...)
  const prettyPath = (folder) => (!folder || folder === '/') ? '🏠 홈' : folder.split('/').filter(Boolean).join(' › ');
  // 목록용 짧은 날짜: 2026.07.09 → 26.07.09
  const sdate = (iso) => { const s = UI.date(iso); return s ? s.replace(/^20/, '') : s; };

  // 파일명 기반 폴더 추천: 파일명 속 지점명(영업점) + 날짜(YYYYMMDD/YYYY-MM 등)와 매칭되는 폴더를 경로째 추천
  function recommendFolders(fileItems) {
    const folders = (state.treeFolders || []).filter((p) => p && p !== '/');
    const core = (s) => String(s || '').replace(/\s+/g, '').replace(/점$/, ''); // 공백·끝 '점' 제거
    const branchCores = (state.branches || []).map((b) => core(b.name)).filter((c) => c.length >= 2);
    const score = new Map();
    for (const it of fileItems) {
      const name = String(it.name || '');
      const nameC = core(name);
      // 장소 토큰: 등록 지점(코어 매칭) + 파일명 선두 토큰(날짜·구분자 앞) — '~점' 유무/미등록 대응
      const places = new Set(branchCores.filter((bc) => nameC.includes(bc)));
      const leadC = core((name.split(/[_\-\s]|20\d{2}/)[0] || ''));
      if (leadC.length >= 2) places.add(leadC);
      const dm = name.match(/(20\d{2})[-_. ]?(0[1-9]|1[0-2])[-_. ]?(0[1-9]|[12]\d|3[01])/);
      const ymd = dm ? dm[1] + dm[2] + dm[3] : null;   // 20251021
      const ym = dm ? dm[1] + dm[2] : null;            // 202510
      const yr = dm ? dm[1] : null;                    // 2025
      if (!places.size && !ymd) continue;
      for (const p of folders) {
        const pc = core(p);
        const placeHit = [...places].some((pl) => pc.includes(pl));
        const pdates = p.match(/20\d{6}/g) || [];        // 폴더 속 8자리 날짜들
        const dateHit = ymd && pdates.includes(ymd);
        const monthHit = ym && pdates.some((d) => d.slice(0, 6) === ym);
        let s = 0;
        if (placeHit) {                                  // 지점 맞으면 후보. 날짜/월/연도로 우선순위(동점 방지)
          s = 6;
          if (dateHit) s += 5;
          else if (monthHit) s += 3;
          else if (yr && p.includes(yr)) s += 2;         // 같은 연도 폴더 우선 → 다른 연도(2021~) 폴더에 안 밀림
        } else if (dateHit) { s = 6; }                   // 지점 못 맞춰도 '날짜 완전일치'면 후보
        // 지점도 없고 날짜 완전일치도 아니면(월만 일치 등) 추천 안 함 → 노이즈 차단
        if (s > 0) score.set(p, (score.get(p) || 0) + s);
      }
    }
    return [...score.entries()].filter(([, s]) => s >= 6).sort((a, b) => b[1] - a[1]).slice(0, 6).map((e) => e[0]);
  }

  // 추천 업로드: 파일 선택 → 파일명으로 폴더 추천 → 파일별 대상 확인/수정 후 업로드
  function pickForSmartUpload() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.multiple = true; inp.accept = (state.allowedExt || []).map((e) => '.' + e).join(','); inp.style.display = 'none';
    document.body.appendChild(inp);
    inp.addEventListener('change', () => { const files = [...inp.files]; inp.remove(); if (files.length) smartUpload(files); });
    inp.click();
  }
  function smartUpload(files) {
    const esc = UI.escapeHtml;
    const recs = recommendFolders(files.map((f) => ({ name: f.name })));
    let dest = recs[0] || state.folder;
    const picked = () => (dest === '/' ? '🏠 홈(최상위)' : dest);
    const label = files.length === 1 ? esc(files[0].name) : `${files.length}개 파일`;
    const m = UI.modal(`<h3>🧭 추천 업로드</h3>
      <p class="muted" style="font-size:13px;margin-bottom:8px">${label} → 올릴 폴더를 선택하세요. (파일명으로 추천)</p>
      <div class="rec-box" id="rec-box"></div>
      <div class="folder-picker" id="picker"></div>
      <div class="picked-bar">업로드 위치: <b id="picked">${esc(picked())}</b></div>
      <div class="modal-actions"><button class="btn btn-ghost" id="c">취소</button><button class="btn btn-primary" id="ok">여기로 업로드</button></div>`);
    m.el.querySelector('.modal').classList.add('modal-wide');
    const openSet = pathChain(dest);
    function drawPicker() {
      const rootNode = buildTreeNodes(state.treeFolders);
      const render = (node, depth) => {
        const kids = Object.values(node.children).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
        const hasKids = kids.length > 0;
        const isOpen = openSet.has(node.path);
        const sel = node.path === dest ? ' sel' : '';
        const caret = hasKids ? `<span class="pk-caret ${isOpen ? 'open' : ''}" data-tog="${esc(node.path)}">▸</span>` : '<span class="pk-caret-empty"></span>';
        let html = `<div class="pick-row${sel}" data-path="${esc(node.path)}" style="padding-left:${4 + depth * 16}px">${caret}<span class="pk-ic">${depth === 0 ? '🏠' : '📁'}</span><span class="pk-name">${esc(node.name)}</span></div>`;
        if (hasKids && isOpen) for (const k of kids) html += render(k, depth + 1);
        return html;
      };
      const box = m.q('#picker'); box.innerHTML = render(rootNode, 0);
      box.querySelectorAll('.pk-caret[data-tog]').forEach((c) => c.addEventListener('click', (e) => { e.stopPropagation(); const p = c.dataset.tog; if (openSet.has(p)) openSet.delete(p); else openSet.add(p); drawPicker(); }));
      box.querySelectorAll('.pick-row').forEach((r) => r.addEventListener('click', () => { dest = r.dataset.path; m.q('#picked').textContent = picked(); drawPicker(); }));
    }
    drawPicker();
    if (recs.length) {
      m.q('#rec-box').innerHTML = `<div class="rec-title">📂 파일명 기반 추천 위치 <span class="muted">(눌러서 선택)</span></div>`
        + recs.map((p) => `<button type="button" class="rec-row" data-rec="${esc(p)}"><span class="pk-ic">📁</span><span class="rec-path">${esc(prettyPath(p))}</span></button>`).join('');
      m.q('#rec-box').querySelectorAll('[data-rec]').forEach((b) => b.addEventListener('click', () => {
        dest = b.dataset.rec; m.q('#picked').textContent = picked();
        for (const seg of pathChain(dest)) openSet.add(seg);
        drawPicker();
      }));
    }
    m.q('#c').addEventListener('click', m.close);
    m.q('#ok').addEventListener('click', async () => {
      m.close();
      const fd = new FormData(); fd.append('folder', dest);
      for (const f of files) fd.append('file', f);
      UI.toast(`${files.length}개 업로드 중… (백그라운드)`, 'info');
      try { const r = await API.upload(fd, state.ownerId); const rj = (r && r.rejected && r.rejected.length) || 0; UI.toast(`업로드 완료 ✅ ${files.length - rj}개${rj ? ` · ${rj}개 차단` : ''}`, rj ? 'error' : 'success'); }
      catch (err) { UI.toast('업로드 실패: ' + err.message, 'error'); }
      loadAll();
    });
  }

  function listHTML() {
    const isSel = (key) => state.selected.has(key);
    const folders = sortItems(filteredFolders(), true).map((f) => {
      const key = `folder:${f.path}`;
      const par = f.path.replace(/\/[^/]*$/, '') || '/';
      return `<tr data-folder-row="${UI.escapeHtml(f.path)}" data-row-key="${UI.escapeHtml(key)}" data-drop-folder="${UI.escapeHtml(f.path)}" draggable="true" class="${isSel(key) ? 'sel' : ''}">
        <td><input type="checkbox" class="rowcheck" data-sel-folder="${UI.escapeHtml(f.path)}" data-name="${UI.escapeHtml(f.name)}" ${isSel(key) ? 'checked' : ''}></td>
        <td class="open-cell name-cell" data-open="${UI.escapeHtml(f.path)}" title="더블클릭하여 열기">${favBtn(true, f.path, f.fav)}<span class="ic${f.color ? ' tint' : ''}" style="${folderIcoStyle(f.color)}">${f.icon || '📁'}</span> ${UI.escapeHtml(f.name)}${updateBadge(f, true)}</td>
        <td class="path-cell" data-goto="${UI.escapeHtml(par)}" title="${UI.escapeHtml(par)}">${UI.escapeHtml(prettyPath(par))}</td>
        <td class="num muted" data-label="크기">${UI.bytes(f.size)}</td>
        <td class="num muted" data-label="등록">${f.createdAt ? sdate(f.createdAt) : '—'}</td>
        <td class="num muted" data-label="수정">${f.noteUpdatedAt ? sdate(f.noteUpdatedAt) : '—'}</td>
        <td class="note-cell" data-fnote="${UI.escapeHtml(f.path)}" title="클릭하여 비고 편집">${f.note ? UI.escapeHtml(f.note) : '<span class="muted">+ 비고</span>'}</td>
        <td class="row-actions"><button class="icon-btn" data-fshare="${UI.escapeHtml(f.path)}" title="폴더 공유(읽기전용)">🔗</button><button class="icon-btn" data-freq="${UI.escapeHtml(f.path)}" title="업로드 요청 링크">📥</button><button class="icon-btn" data-fedit="${UI.escapeHtml(f.path)}" title="폴더 설정">⚙️</button></td>
      </tr>`;
    }).join('');
    const files = sortItems(filteredFiles(), false).map((f) => {
      const key = `file:${f.id}`;
      return `<tr data-file="${f.id}" data-row-key="${UI.escapeHtml(key)}" draggable="true" class="${isSel(key) ? 'sel' : ''}">
        <td><input type="checkbox" class="rowcheck" data-sel-file="${f.id}" data-name="${UI.escapeHtml(f.name)}" ${isSel(key) ? 'checked' : ''}></td>
        <td class="name-cell">${favBtn(false, f.id, f.fav)}<span class="ic">${UI.fileIcon(f.name)}</span> ${UI.escapeHtml(f.name)}${updateBadge(f, false)}${tagChips(f.tags)}</td>
        <td class="path-cell" data-goto="${UI.escapeHtml(f.folder || '/')}" title="${UI.escapeHtml(f.folder || '/')}">${UI.escapeHtml(prettyPath(f.folder))}</td>
        <td class="num muted" data-label="크기">${UI.bytes(f.size)}</td>
        <td class="num muted" data-label="등록">${sdate(f.createdAt)}</td>
        <td class="num muted" data-label="수정">${sdate(f.updatedAt || f.createdAt)}</td>
        <td class="note-cell" data-note="${f.id}" title="클릭하여 비고 편집">${f.note ? UI.escapeHtml(f.note) : '<span class="muted">+ 비고</span>'}</td>
        <td class="row-actions">${canPreview(f.name) ? `<button class="icon-btn" data-preview="${f.id}" title="미리보기">👁️</button>` : ''}<button class="icon-btn" data-share="${f.id}" title="공유">🔗</button><button class="icon-btn" data-tags="${f.id}" title="태그">🏷️</button><button class="icon-btn" data-dl="${f.id}" title="다운로드">⬇️</button></td>
      </tr>`;
    }).join('');
    const th = (key, label, style = '') => `<th class="sortable${state.sort.key === key ? ' sorted' : ''}" data-sort="${key}"${style ? ` style="${style}"` : ''}>${label}${sortArrow(key)}</th>`;
    const vf = filteredFiles(); const vfo = filteredFolders();
    const total = vfo.length + vf.length;
    const allSel = total > 0 && vfo.every((f) => isSel(`folder:${f.path}`)) && vf.every((f) => isSel(`file:${f.id}`));
    return `<div class="table-wrap fade-in"><table class="filetable">
      <thead><tr><th style="width:3%"><input type="checkbox" id="check-all" title="전체선택/해제" ${allSel ? 'checked' : ''}></th>${th('name', '이름', 'width:31%')}<th class="path-col">경로</th>${th('size', '크기', 'width:6%')}${th('createdAt', '등록일', 'width:6%')}${th('updatedAt', '수정일', 'width:6%')}${th('note', '비고', 'width:10%')}<th style="width:12%"></th></tr></thead>
      <tbody>${folders}${files}</tbody></table></div>`;
  }

  function wireContent() {
    document.getElementById('exit-imp')?.addEventListener('click', resetToOwn);
    document.querySelectorAll('.viewtoggle .vt').forEach((b) => b.addEventListener('click', () => { state.view = b.dataset.view; localStorage.setItem('bj_view', state.view); state.selected.clear(); renderContent(); }));
    const input = document.getElementById('file-input');
    document.getElementById('upload-btn').addEventListener('click', () => input.click());
    input.addEventListener('change', () => { if (input.files.length) uploadFiles(input.files); input.value = ''; });
    // 촬영은 모바일 하단 ⬆️ 시트에서만(PC에선 미사용). cam-input 자체는 시트가 재사용하므로 유지.
    const cam = document.getElementById('cam-input');
    cam.addEventListener('change', () => { if (cam.files.length) cameraReviewModal([...cam.files]); cam.value = ''; });
    document.getElementById('smart-btn')?.addEventListener('click', pickForSmartUpload);
    document.getElementById('new-folder').addEventListener('click', newFolderModal);
    document.getElementById('refresh-btn')?.addEventListener('click', async (e) => {
      const b = e.currentTarget; b.disabled = true; b.classList.add('spinning');
      try { await loadAll(); UI.toast('목록을 새로고침했습니다', 'success'); }
      catch { UI.toast('새로고침 실패', 'error'); }
      finally { b.disabled = false; b.classList.remove('spinning'); }
    });
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

  // ── 확장자·즐겨찾기·태그 필터 ──────────────────────────
  const extOf = (name) => (name.split('.').pop() || '').toLowerCase();
  function filteredFiles() {
    if (state.foldersOnly) return [];
    let out = state.files;
    if (state.extFilter.size) out = out.filter((f) => state.extFilter.has(extOf(f.name)));
    if (state.favOnly) out = out.filter((f) => f.fav);
    if (state.tagFilter) out = out.filter((f) => (f.tags || []).some((t) => String(t.id) === String(state.tagFilter)));
    return out;
  }
  // 폴더도 즐겨찾기 필터 반영(태그는 파일 전용)
  function filteredFolders() {
    let out = state.folders;
    if (state.favOnly) out = out.filter((f) => f.fav);
    if (state.tagFilter) out = []; // 태그로 필터 시 폴더는 숨김
    return out;
  }
  const filterActive = () => state.extFilter.size > 0 || state.foldersOnly || state.favOnly || !!state.tagFilter;
  function updateExtCount() {
    const c = document.getElementById('extfilter-count'), b = document.getElementById('extfilter-btn');
    const extra = [state.favOnly ? '⭐' : '', state.tagFilter ? '🏷️' : ''].filter(Boolean).join('');
    if (c) c.textContent = state.foldersOnly ? ' (폴더)' : ((state.extFilter.size || extra) ? ` (${extra}${state.extFilter.size || ''})` : '');
    if (b) b.classList.toggle('on', filterActive());
  }
  function buildExtFilterPanel() {
    const panel = document.getElementById('extfilter-panel'); if (!panel) return;
    const chips = state.allowedExt.map((e) => `<label class="ext-chip${state.extFilter.has(e) ? ' on' : ''}"><input type="checkbox" value="${e}" ${state.extFilter.has(e) ? 'checked' : ''}><span class="ei">${UI.extIcon(e)}</span> .${UI.escapeHtml(e)}</label>`).join('');
    const tagChipsHtml = state.tags.length
      ? state.tags.map((t) => `<label class="ext-chip tagf${String(state.tagFilter) === String(t.id) ? ' on' : ''}" data-tagf="${t.id}"><span class="ei" style="color:${UI.escapeHtml(t.color)}">●</span> ${UI.escapeHtml(t.name)}</label>`).join('')
      : '<span class="muted" style="font-size:12px">태그가 없습니다.</span>';
    panel.innerHTML = `<div class="ext-panel-head"><b>보기 필터</b><button class="btn btn-sm btn-ghost" id="ext-clear">전체 해제</button></div>
      <label class="ext-chip only-folders${state.foldersOnly ? ' on' : ''}" style="margin-bottom:6px"><input type="checkbox" id="only-folders" ${state.foldersOnly ? 'checked' : ''}><span class="ei">📁</span> 폴더만 보기</label>
      <label class="ext-chip only-folders${state.favOnly ? ' on' : ''}" style="margin-bottom:8px"><input type="checkbox" id="fav-only" ${state.favOnly ? 'checked' : ''}><span class="ei">⭐</span> 즐겨찾기만</label>
      <div class="ext-chip-grid"${state.foldersOnly ? ' style="opacity:.4;pointer-events:none"' : ''}>${chips || '<span class="muted">허용 확장자가 없습니다.</span>'}</div>
      <div class="ext-panel-head" style="margin-top:10px"><b>태그</b><button class="btn btn-sm btn-ghost" id="tag-manage">관리</button></div>
      <div class="ext-chip-grid"${state.foldersOnly ? ' style="opacity:.4;pointer-events:none"' : ''}>${tagChipsHtml}</div>
      <button class="btn btn-sm btn-secondary" id="adv-search" style="width:100%;margin-top:10px">🔎 고급 검색(기간·크기)</button>`;
    panel.querySelector('#only-folders').addEventListener('change', (e) => { state.foldersOnly = e.target.checked; state.selected.clear(); state.anchor = null; buildExtFilterPanel(); updateExtCount(); renderListing(); });
    panel.querySelector('#fav-only').addEventListener('change', (e) => { state.favOnly = e.target.checked; state.selected.clear(); state.anchor = null; buildExtFilterPanel(); updateExtCount(); renderListing(); });
    panel.querySelectorAll('.ext-chip-grid input[type=checkbox]').forEach((c) => c.addEventListener('change', () => {
      if (c.checked) state.extFilter.add(c.value); else state.extFilter.delete(c.value);
      c.closest('.ext-chip').classList.toggle('on', c.checked);
      state.selected.clear(); state.anchor = null; updateExtCount(); renderListing();
    }));
    panel.querySelectorAll('[data-tagf]').forEach((el) => el.addEventListener('click', () => {
      state.tagFilter = String(state.tagFilter) === el.dataset.tagf ? null : el.dataset.tagf;
      state.selected.clear(); state.anchor = null; buildExtFilterPanel(); updateExtCount(); renderListing();
    }));
    panel.querySelector('#tag-manage')?.addEventListener('click', () => { panel.classList.add('hidden'); tagManageModal(); });
    panel.querySelector('#adv-search')?.addEventListener('click', () => { panel.classList.add('hidden'); advancedSearchModal(); });
    panel.querySelector('#ext-clear')?.addEventListener('click', () => { state.extFilter.clear(); state.foldersOnly = false; state.favOnly = false; state.tagFilter = null; buildExtFilterPanel(); updateExtCount(); state.selected.clear(); renderListing(); });
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

  // ── 브라우저 뒤로가기 가로채기 ──────────
  // 모바일 웹에서 실수로 뒤로가기를 눌러 사이트를 벗어나는 걸 막고,
  // 대신 앱 내 뒤로(모달 닫기 → 선택 해제 → 검색 종료 → 상위/이전 폴더)로 동작시킨다.
  // 홈에서 되돌릴 게 없으면 "한 번 더 누르면 나가기"로 실수 이탈만 방지.
  function setupBackTrap() {
    if (backHooked) return; backHooked = true;
    const rearm = () => history.pushState({ bjGuard: 1 }, '');
    rearm(); // 상단에 가드 상태 하나를 항상 유지
    // 네이티브 카메라/파일 선택으로 페이지가 백그라운드 갔다 오면 가드 상태가 사라질 수 있음 →
    // 돌아왔을 때 가드가 없으면 다시 세워, 첫 뒤로가기에 바로 이탈하지 않게 한다(모달 열림 중엔 제외).
    const ensureGuard = () => { if (state.user && !document.querySelector('.modal-backdrop') && !(history.state && history.state.bjGuard)) rearm(); };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') ensureGuard(); });
    window.addEventListener('pageshow', ensureGuard);
    let exitArmed = false, exitTimer = null;
    window.addEventListener('popstate', () => {
      if (window.__bjModalHandledPop) return; // 모달은 common.js 가 처리(자체 히스토리 항목)
      if (!state.user) return; // 로그아웃 상태면 그냥 통과
      if (document.querySelector('.modal-backdrop')) { rearm(); return; } // 안전망: 모달이 남아있으면 이탈 방지만
      if (state.selected && state.selected.size) { state.selected.clear(); applySelectionClasses(); rearm(); return; }
      if (state.search.on) { clearSearch(); rearm(); return; }
      if (state.nav && state.nav.idx > 0) { navBack(); rearm(); return; }
      if (state.folder && state.folder !== '/') { navUp(); rearm(); return; }
      // 홈 + 되돌릴 것 없음 → 두 번 눌러야 이탈
      if (exitArmed) { history.back(); return; } // 재무장하지 않음 → 실제로 나감
      exitArmed = true; UI.toast('뒤로가기를 한 번 더 누르면 나갑니다', 'info');
      clearTimeout(exitTimer); exitTimer = setTimeout(() => { exitArmed = false; }, 2000);
      rearm();
    });
  }

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
      if (e.key === 'F2') { if (state.selected.size === 1) { e.preventDefault(); const it = [...state.selected.values()][0]; inlineRename(it.type, it.type === 'file' ? it.id : it.path); } return; }
      if (e.key === 'Enter') { if (state.selected.size === 1) { const it = [...state.selected.values()][0]; if (it.type === 'folder') openFolder(it.path); else downloadFile(it.id); } return; }
    });
  }

  // ── 선택 모델(클릭/Ctrl/Shift) · 드래그 이동 ──────────
  function orderedItems() {
    const fol = sortItems(filteredFolders(), true).map((f) => ({ key: `folder:${f.path}`, item: { type: 'folder', path: f.path, name: f.name } }));
    const fil = sortItems(filteredFiles(), false).map((f) => ({ key: `file:${f.id}`, item: { type: 'file', id: String(f.id), name: f.name } }));
    return [...fol, ...fil];
  }
  function applySelectionClasses() {
    document.querySelectorAll('#listing [data-row-key]').forEach((el) => {
      const on = state.selected.has(el.dataset.rowKey);
      el.classList.toggle('sel', on);
      el.classList.toggle('previewing', pvCurrentId != null && el.dataset.file != null && String(el.dataset.file) === String(pvCurrentId));
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
    // 모바일 아코디언 카드: 헤더 탭 = 펼치기/접기 (선택은 체크박스, 열기/다운로드는 버튼)
    box.querySelectorAll('.mcard').forEach((el) => {
      el.querySelector('.mcard-head').addEventListener('click', (e) => {
        if (e.target.closest('.rowcheck, button, a')) return;
        el.classList.toggle('expanded');
      });
    });
    box.querySelectorAll('button[data-open]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); openFolder(el.dataset.open); }));
    // 항목: 클릭=선택, 더블클릭=열기/다운로드, 드래그=이동 (모바일 카드는 위에서 별도 처리)
    box.querySelectorAll('[data-row-key]').forEach((el) => {
      if (el.classList.contains('mcard')) return;
      const key = el.dataset.rowKey; const isFolder = key.startsWith('folder:');
      const found = isFolder ? state.folders.find((f) => `folder:${f.path}` === key) : state.files.find((f) => `file:${f.id}` === key);
      const item = isFolder ? { type: 'folder', path: key.slice(7), name: found ? found.name : '' } : { type: 'file', id: key.slice(5), name: found ? found.name : '' };
      el.addEventListener('click', (e) => { if (e.target.closest(actionSel)) return; selectClick(e, key, item); });
      el.addEventListener('dblclick', (e) => { if (e.target.closest(actionSel)) return; if (isFolder) openFolder(item.path); else downloadFile(item.id); });
      el.addEventListener('contextmenu', (e) => { if (e.target.closest('input, a')) return; e.preventDefault(); openContextFor(e, isFolder, item); });
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
    box.querySelectorAll('.path-cell[data-goto], .mcard-path[data-goto]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); goTo(el.dataset.goto); }));
    box.querySelectorAll('[data-preview]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); openPreview(el.dataset.preview); }));
    box.querySelectorAll('[data-dl]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); downloadFile(el.dataset.dl); }));
    box.querySelectorAll('[data-del]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); deleteFile(el.dataset.del); }));
    box.querySelectorAll('[data-share]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); shareModal(el.dataset.share); }));
    box.querySelectorAll('[data-note]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); noteModal(el.dataset.note); }));
    box.querySelectorAll('[data-rename]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); inlineRename('file', el.dataset.rename); }));
    box.querySelectorAll('[data-tags]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); tagPickerModal(el.dataset.tags); }));
    // 즐겨찾기 별
    box.querySelectorAll('[data-fav-file]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); toggleFavFile(el.dataset.favFile); }));
    box.querySelectorAll('[data-fav-folder]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); toggleFavFolder(el.dataset.favFolder); }));
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
    const nImg = window.ISBN ? [...state.selected.values()].filter((it) => it.type === 'file' && isImage(it.name)).length : 0;
    const nFile = [...state.selected.values()].filter((it) => it.type === 'file').length;
    bar.innerHTML = `<b>${n > 0 ? `${n}개 선택` : '항목을 선택하세요'}</b><div style="flex:1"></div>
      <button class="btn btn-sm btn-ghost" id="sel-rename" ${n !== 1 ? 'disabled' : ''}>✏️ 이름변경</button>
      <button class="btn btn-sm btn-ghost" id="sel-bulkname" ${nFile < 2 ? 'disabled' : ''} title="선택 파일을 규칙(원본·연번·날짜)으로 한 번에 이름변경">🔢 일괄이름</button>
      ${window.ISBN ? `<button class="btn btn-sm btn-ghost" id="sel-barcode" ${nImg === 0 ? 'disabled' : ''} title="이미지에서 바코드/ISBN을 읽어 제목 변경">📕 바코드 제목변경</button>` : ''}
      <button class="btn btn-sm btn-primary" id="sel-dl" ${dis ? 'disabled' : ''}>⬇️ 다운로드(ZIP)</button>
      <button class="btn btn-sm btn-secondary" id="sel-move" ${dis ? 'disabled' : ''}>📂 폴더이동</button>
      <button class="btn btn-sm btn-ghost" id="sel-copy" ${nFile === 0 ? 'disabled' : ''} title="선택 파일을 다른 폴더로 복사">📄 복사</button>
      <button class="btn btn-sm btn-danger" id="sel-del" ${dis ? 'disabled' : ''}>🗑️ 삭제</button>
      <button class="btn btn-sm btn-ghost" id="sel-clear" ${dis ? 'disabled' : ''}>선택해제</button>`;
    bar.querySelector('#sel-clear').addEventListener('click', () => { state.selected.clear(); applySelectionClasses(); });
    bar.querySelector('#sel-del').addEventListener('click', bulkDelete);
    bar.querySelector('#sel-dl').addEventListener('click', bulkDownload);
    bar.querySelector('#sel-move').addEventListener('click', () => bulkMoveModal('move'));
    const cp = bar.querySelector('#sel-copy'); if (cp && !cp.disabled) cp.addEventListener('click', () => bulkMoveModal('copy'));
    const bc = bar.querySelector('#sel-barcode');
    if (bc && !bc.disabled) bc.addEventListener('click', () => barcodeRename([...state.selected.values()]));
    const brn = bar.querySelector('#sel-bulkname');
    if (brn && !brn.disabled) brn.addEventListener('click', () => bulkRenameModal([...state.selected.values()].filter((it) => it.type === 'file')));
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
    const fileIds = files.map((f) => f.id);
    const folderIds = folders.map((fo) => (state.folders.find((x) => x.path === fo.path) || {}).id).filter(Boolean);
    try {
      if (files.length) await API.bulkDelete(fileIds);
      for (const fo of folders) await API.deleteFolder(fo.path, state.ownerId);
      UI.toast(`${items.length}개 삭제됨 (휴지통 이동)`, 'success', undoOpts(fileIds, folderIds)); loadAll();
    } catch (err) { UI.toast(err.message, 'error'); }
  }

  // 삭제 직후 "실행취소" 토스트 옵션 — 열람 중인 계정(state.ownerId) 기준으로 복원
  function undoOpts(fileIds, folderIds) {
    const oid = state.ownerId || undefined;
    return { action: { label: '↩ 실행취소', onClick: async () => {
      try {
        for (const id of (fileIds || [])) await API.restoreSelfFile(id, oid).catch(() => {});
        for (const id of (folderIds || [])) await API.restoreSelfFolder(id, oid).catch(() => {});
        UI.toast('복원되었습니다', 'success'); loadAll();
      } catch (e) { UI.toast(e.message, 'error'); }
    } } };
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

  function bulkMoveModal(mode) {
    const isCopy = mode === 'copy';
    const items = [...state.selected.values()];
    const nFolders = items.filter((i) => i.type === 'folder').length;
    const movingFolders = items.filter((i) => i.type === 'folder').map((i) => i.path);
    // 폴더 자신·하위로는 이동 불가
    const blocked = new Set();
    for (const mf of movingFolders) { blocked.add(mf); for (const p of state.treeFolders) if (p === mf || p.startsWith(mf + '/')) blocked.add(p); }
    let dest = state.folder;
    const picked = () => (dest === '/' ? '🏠 홈(최상위)' : dest);
    const verb = isCopy ? '복사' : '이동';
    const note = isCopy && nFolders ? `<p class="muted" style="font-size:12px;margin-bottom:8px">※ 복사는 파일만 됩니다. 선택한 폴더 ${nFolders}개는 제외됩니다.</p>` : '';
    const m = UI.modal(`<h3>선택 항목 ${verb}</h3>
      <p class="muted" style="font-size:13px;margin-bottom:8px">아래에서 ${verb}할 폴더를 선택하세요.</p>${note}
      <div class="rec-box" id="rec-box"></div>
      <div class="folder-picker" id="picker"></div>
      <div class="picked-bar">${verb} 위치: <b id="picked">${UI.escapeHtml(picked())}</b></div>
      <div class="modal-actions"><button class="btn btn-ghost" id="c">취소</button><button class="btn btn-primary" id="ok">여기로 ${verb}</button></div>`);
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
    // 파일명 기반 폴더 추천 (지점명·날짜 매칭) — 경로째 보여줌
    const recs = recommendFolders(items.filter((i) => i.type === 'file'));
    if (recs.length) {
      m.q('#rec-box').innerHTML = `<div class="rec-title">📂 파일명 기반 추천 위치 <span class="muted">(눌러서 선택)</span></div>`
        + recs.map((p) => `<button type="button" class="rec-row" data-rec="${UI.escapeHtml(p)}"><span class="pk-ic">📁</span><span class="rec-path">${UI.escapeHtml(prettyPath(p))}</span></button>`).join('');
      m.q('#rec-box').querySelectorAll('[data-rec]').forEach((b) => b.addEventListener('click', () => {
        dest = b.dataset.rec; m.q('#picked').textContent = picked();
        for (const seg of pathChain(dest)) openSet.add(seg);
        drawPicker();
      }));
    }
    m.q('#c').addEventListener('click', m.close);
    m.q('#ok').addEventListener('click', async () => {
      const files = items.filter((i) => i.type === 'file'), folders = items.filter((i) => i.type === 'folder');
      try {
        if (isCopy) {
          if (!files.length) { UI.toast('복사할 파일이 없습니다.', 'info'); return; }
          const r = await API.bulkCopy(files.map((f) => f.id), dest);
          m.close(); state.selected.clear(); UI.toast(`${(r && r.copied) || files.length}개 복사 완료`, 'success'); loadAll();
        } else {
          if (files.length) await API.bulkMove(files.map((f) => f.id), dest);
          for (const fo of folders) { const target = (dest === '/' ? '' : dest) + '/' + fo.name; if (target !== fo.path) await API.renameFolder(fo.path, target, state.ownerId); }
          m.close(); UI.toast('이동 완료', 'success'); loadAll();
        }
      } catch (err) { UI.toast(err.message, 'error'); }
    });
  }

  // Cloudflare 무료플랜 본문 100MB 제한 → 80MB 초과 파일은 50MB 청크로 분할 업로드
  const CHUNK_THRESHOLD = 80 * 1024 * 1024;
  const CHUNK_SIZE = 50 * 1024 * 1024;

  async function uploadFiles(fileList) {
    const files = [...fileList];
    const small = files.filter((f) => f.size <= CHUNK_THRESHOLD);
    const large = files.filter((f) => f.size > CHUNK_THRESHOLD);
    try {
      if (small.length) {
        const fd = new FormData(); fd.append('folder', state.folder);
        small.forEach((f) => fd.append('file', f));
        UI.toast(`${small.length}개 업로드 중…`);
        const r = await API.upload(fd, state.ownerId);
        if (r && r.rejected && r.rejected.length) UI.toast(`⚠️ ${r.rejected.length}개 차단됨 (${r.rejected.map((x) => x.reason || '보안 정책').join(' · ')})`, 'error');
      }
      for (const f of large) await chunkedUploadFile(f, state.folder, state.ownerId); // 대용량은 하나씩 분할 전송
      UI.toast('업로드 완료 ✅', 'success');
      loadAll();
    } catch (err) { UI.toast(err.message, 'error'); }
  }

  // 대용량 파일(>80MB)을 50MB 조각으로 나눠 순차 전송 후 서버에서 합침. 진행률 토스트 표시.
  async function chunkedUploadFile(file, folder, ownerId) {
    const uid = (self.crypto && crypto.randomUUID) ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.floor(Math.random() * 16); return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16); });
    const total = Math.ceil(file.size / CHUNK_SIZE);
    try {
      for (let i = 0; i < total; i++) {
        const blob = file.slice(i * CHUNK_SIZE, Math.min(file.size, (i + 1) * CHUNK_SIZE));
        const fd = new FormData();
        fd.append('uploadId', uid); fd.append('index', String(i)); fd.append('chunk', blob, 'chunk');
        UI.toast(`${file.name} 업로드 중… ${i + 1}/${total}`, 'info');
        await API.uploadChunk(fd);
      }
      await API.uploadComplete({ uploadId: uid, filename: file.name, folder, totalChunks: total, mime: file.type || '' }, ownerId);
    } catch (err) {
      throw new Error(`'${file.name}' 업로드 실패: ${err.message}`);
    }
  }

  // ── 모바일 하단 FAB(⬆️) → 파일/촬영/스캔 선택 시트 ──────────
  function uploadSheet() {
    const m = UI.modal(`<h3>⬆️ 업로드</h3>
      <div class="upload-sheet">
        <button class="btn btn-primary" id="us-file">📁 파일 선택</button>
        <button class="btn btn-secondary" id="us-smart">🧭 추천 업로드 <span class="muted" style="font-weight:400;font-size:12px">· 파일명으로 폴더 추천</span></button>
        <button class="btn btn-accent" id="us-cam">📷 사진 촬영</button>
        ${window.ISBN ? `<button class="btn btn-secondary" id="us-scan">📷 바코드 단건 연속 촬영</button>` : ''}
        ${window.ISBN ? `<button class="btn btn-secondary" id="us-books">📷 바코드 다건 촬영</button>` : ''}
      </div>
      <div class="modal-actions"><button class="btn btn-ghost" id="us-cancel">취소</button></div>`);
    m.q('#us-file').addEventListener('click', () => { m.close(); document.getElementById('file-input')?.click(); });
    m.q('#us-smart').addEventListener('click', () => { m.close(); pickForSmartUpload(); });
    m.q('#us-cam').addEventListener('click', () => { m.close(); document.getElementById('cam-input')?.click(); });
    m.q('#us-scan')?.addEventListener('click', () => { m.close(); continuousBarcodeCapture(); });
    m.q('#us-books')?.addEventListener('click', () => { m.close(); multiBarcodeCapture(); });
    m.q('#us-cancel').addEventListener('click', m.close);
  }

  // ── 바코드 연속 촬영: '촬영' 버튼으로 한 장씩 찍으면 자동으로 바코드 인식→ISBN 이름 저장 ──────────
  //  · 저장 버튼 없음(백그라운드 자동 저장), 촬영 버튼을 다시 눌러 다음 장
  //  · 한 사진에 바코드가 여러 개면 이미지 위에 위치를 표시하고 선택 → 그 코드로 저장
  function continuousBarcodeCapture() {
    if (!window.ISBN) return UI.toast('바코드 모듈을 사용할 수 없습니다', 'error');
    const shots = []; let seq = 0;
    const cam = document.createElement('input');
    cam.type = 'file'; cam.accept = 'image/*'; cam.capture = 'environment'; cam.style.display = 'none';
    document.body.appendChild(cam);
    const m = UI.modal(`<h3>📷 바코드 단건 연속 촬영</h3><p class="muted" style="font-size:12px;margin:-8px 0 12px">한 장에 한 권씩 자동 저장</p>
      <div id="cap-pick" class="cap-pick" hidden></div>
      <button type="button" class="btn btn-primary cap-shoot" id="cap-shoot">📷 촬영</button>
      <div class="scan-list" id="cap-list"></div>
      <div class="modal-actions"><span style="flex:1"></span><button class="btn btn-primary" id="cap-done">완료</button></div>`,
      { onClose: () => { try { cam.remove(); } catch (_) {} loadAll(); } });
    m.el.querySelector('.modal').classList.add('modal-wide');
    const beep = () => { try { const A = window.AudioContext || window.webkitAudioContext; if (!A) return; const ac = new A(); const o = ac.createOscillator(); const g = ac.createGain(); o.connect(g); g.connect(ac.destination); o.frequency.value = 880; g.gain.value = 0.07; o.start(); setTimeout(() => { o.stop(); ac.close(); }, 90); } catch (_) {} };
    const feedback = () => { beep(); if (navigator.vibrate) try { navigator.vibrate(45); } catch (_) {} };
    const stLabel = (s) => ({ processing: '⏳ 인식중', choosing: '👆 선택필요', saving: '⏳ 저장중', done: '✓ 저장됨', nobar: '⚠️ 바코드없음', error: '✗ 실패' }[s] || s);
    function renderList() {
      m.q('#cap-list').innerHTML = shots.length
        ? shots.slice().reverse().map((x) => `<div class="cap-row">${x.thumb ? `<img class="cap-thumb" src="${x.thumb}" alt="">` : '<span class="cap-thumb cap-thumb-ph">🖼️</span>'}<span class="cap-code">${UI.escapeHtml(x.name || '…')}</span><span class="cap-status cap-${x.status}">${stLabel(x.status)}</span></div>`).join('')
        : '<p class="muted" style="text-align:center;padding:14px">📷 촬영 버튼을 눌러 책을 찍으세요</p>';
    }
    const setShoot = (on) => { const b = m.q('#cap-shoot'); if (b) b.disabled = !on; };
    function thumbData(img) { const s = Math.min(1, 120 / Math.max(img.naturalWidth, img.naturalHeight)); const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.naturalWidth * s)); c.height = Math.max(1, Math.round(img.naturalHeight * s)); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', 0.6); }

    async function saveShot(file, code, shot) {
      const ext = ((file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '')) || 'jpg';
      const p2 = (x) => String(x).padStart(2, '0'); const d = new Date();
      const base = code || `촬영_${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
      shot.name = base; shot.status = 'saving'; renderList();
      const fd = new FormData(); fd.append('folder', state.folder); fd.append('file', new File([file], `${base}.${ext}`, { type: file.type || 'image/jpeg' }));
      try { const r = await API.upload(fd, state.ownerId); shot.status = (r && r.rejected && r.rejected.length) ? 'error' : (code ? 'done' : 'nobar'); }
      catch (_) { shot.status = 'error'; }
      renderList();
    }

    // 여러 개일 때: 촬영 사진을 크게 띄우고, 감지된 바코드를 캡션(번호) 목록으로 탭 선택
    function showPicker(url, nw, nh, items, onPick, onSkip) {
      const box = m.q('#cap-pick'); box.hidden = false;
      m.q('#cap-shoot').style.display = 'none'; m.q('#cap-list').style.display = 'none';
      const caps = items.map((b) => `<button type="button" class="cap-cap" data-code="${b.code}">${b.code}</button>`).join('');
      box.innerHTML = `<p class="cap-pick-title">저장할 바코드 선택</p>
        <div class="cap-pick-img"><img src="${url}" alt=""></div>
        <p class="cap-pick-hint">저장할 바코드를 탭하세요</p>
        <div class="cap-caps">${caps}</div>
        <div class="cap-pick-actions"><button type="button" class="btn btn-ghost btn-sm" id="cap-skip">이 사진 건너뛰기</button></div>`;
      const finish = (fn, arg) => { box.hidden = true; box.innerHTML = ''; m.q('#cap-shoot').style.display = ''; m.q('#cap-list').style.display = ''; setShoot(true); fn(arg); };
      box.querySelectorAll('[data-code]').forEach((el) => el.addEventListener('click', () => finish(onPick, el.dataset.code)));
      box.querySelector('#cap-skip').addEventListener('click', () => finish(onSkip));
    }

    async function handleFile(file) {
      const shot = { id: ++seq, name: null, status: 'processing', thumb: null };
      shots.push(shot); renderList(); feedback();
      let img, url;
      try { url = URL.createObjectURL(file); img = await loadImgEl(url); shot.thumb = thumbData(img); renderList(); }
      catch (_) { shot.status = 'error'; renderList(); return; }
      // 사진 속 바코드를 모두 수집(하나 찾고 멈추지 않음)
      let found = []; try { found = await window.ISBN.scanMulti(img); } catch (_) {}
      if (found.length >= 2) { // 여러 개 → 사진 위 박스에서 선택
        shot.status = 'choosing'; renderList(); setShoot(false);
        showPicker(url, img.naturalWidth, img.naturalHeight, found,
          (code) => { URL.revokeObjectURL(url); saveShot(file, code, shot); },
          () => { URL.revokeObjectURL(url); const i = shots.indexOf(shot); if (i >= 0) shots.splice(i, 1); renderList(); });
        return;
      }
      URL.revokeObjectURL(url);
      if (found.length === 1) return saveShot(file, found[0].code, shot);
      // 0개 → OCR 포함 견고 단일 재시도
      let res; try { res = await window.ISBN.scan(img, { useOcr: true }); } catch (_) {}
      saveShot(file, (res && res.candidates && res.candidates[0]) || null, shot);
    }

    cam.addEventListener('change', async () => { const files = [...cam.files]; cam.value = ''; for (const f of files) await handleFile(f); });
    m.q('#cap-shoot').addEventListener('click', () => { try { cam.click(); } catch (_) {} });
    m.q('#cap-done').addEventListener('click', m.close);
    renderList();
  }

  // ── 책장/도서 스캔 → 도서 목록 테이블 (바코드 우선 · 제목검색 폴백 · CSV 내보내기) ──────────
  //  · 바코드가 보이면 scanMulti로 읽어 ISBN→교보 상세로 자동 채움
  //  · 바코드가 없으면(책등 사진 등) 제목으로 검색 → 후보 중 선택해 추가
  // ── 바코드 다건 촬영: 한 장에 여러 바코드면 각각 파일 생성(ISBN명 저장), 바코드 없으면 책등 OCR→검색→선택→저장 ──
  // ── 바코드 다건 촬영: 자동으로 여러 바코드면 각각 ISBN 파일로 저장. 0~1개만 잡히면 영역을 직접 지정 ──
  function multiBarcodeCapture() {
    if (!window.ISBN) return UI.toast('바코드 모듈을 사용할 수 없습니다', 'error');
    const shots = []; let seq = 0;
    const esc = UI.escapeHtml;
    const cam = document.createElement('input');
    cam.type = 'file'; cam.accept = 'image/*'; cam.capture = 'environment'; cam.multiple = true; cam.style.display = 'none';
    document.body.appendChild(cam);
    const m = UI.modal(`<h3>📷 바코드 다건 촬영</h3><p class="muted" style="font-size:12px;margin:-8px 0 12px">한 장에 여러 권 · ISBN 이름으로 저장</p>
      <button type="button" class="btn btn-primary cap-shoot" id="mb-shoot">📷 촬영·사진</button>
      <div class="bl-status" id="mb-status" hidden></div>
      <div class="scan-list" id="mb-list"></div>
      <div class="modal-actions"><span style="flex:1"></span><button class="btn btn-primary" id="mb-done">완료</button></div>`,
      { onClose: () => { try { cam.remove(); } catch (_) {} loadAll(); } });
    m.el.querySelector('.modal').classList.add('modal-wide');

    function setStatus(msg, kind) { const el = m.q('#mb-status'); if (!el) return; if (!msg) { el.hidden = true; el.textContent = ''; return; } el.hidden = false; el.textContent = msg; el.className = 'bl-status' + (kind ? ' bl-status-' + kind : ''); }
    function feedback() { try { const A = window.AudioContext || window.webkitAudioContext; if (A) { const ac = new A(); const o = ac.createOscillator(); const g = ac.createGain(); o.connect(g); g.connect(ac.destination); o.frequency.value = 880; g.gain.value = 0.06; o.start(); setTimeout(() => { o.stop(); ac.close(); }, 80); } } catch (_) {} if (navigator.vibrate) try { navigator.vibrate(40); } catch (_) {} }
    const stLabel = (s) => ({ saving: '⏳ 저장중', done: '✓ 저장됨', dup: '· 중복', error: '✗ 실패' }[s] || s);
    function renderList() {
      m.q('#mb-list').innerHTML = shots.length
        ? shots.slice().reverse().map((x) => `<div class="cap-row">${x.thumb ? `<img class="cap-thumb" src="${x.thumb}" alt="">` : '<span class="cap-thumb cap-thumb-ph">📕</span>'}<span class="cap-code">${esc(x.name || '…')}</span><span class="cap-status cap-${x.status}">${stLabel(x.status)}</span></div>`).join('')
        : '<p class="muted" style="text-align:center;padding:14px">📷 촬영해서 책을 담으세요 (한 장에 여러 권도 OK)</p>';
    }
    function thumbData(img) { const s = Math.min(1, 90 / Math.max(img.naturalWidth, img.naturalHeight)); const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.naturalWidth * s)); c.height = Math.max(1, Math.round(img.naturalHeight * s)); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', 0.6); }

    const savedIsbns = new Set();
    // 업로드 전 다운스케일(속도·용량) — 이미 작으면 원본 그대로
    function downscaleBlob(file, maxDim, q) {
      return new Promise((resolve) => {
        const url = URL.createObjectURL(file); const im = new Image();
        im.onload = () => {
          const s = Math.min(1, maxDim / Math.max(im.naturalWidth, im.naturalHeight));
          if (s >= 1) { try { URL.revokeObjectURL(url); } catch (_) {} return resolve(file); }
          const w = Math.round(im.naturalWidth * s), h = Math.round(im.naturalHeight * s);
          const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(im, 0, 0, w, h);
          try { URL.revokeObjectURL(url); } catch (_) {}
          c.toBlob((b) => resolve(b || file), 'image/jpeg', q);
        };
        im.onerror = () => { try { URL.revokeObjectURL(url); } catch (_) {} resolve(file); };
        im.src = url;
      });
    }
    async function saveFile(blob, isbn, thumb) {
      if (savedIsbns.has(isbn)) { shots.push({ id: ++seq, name: isbn, status: 'dup', thumb }); renderList(); return; }
      savedIsbns.add(isbn);
      const shot = { id: ++seq, name: `${isbn}.jpg`, status: 'saving', thumb };
      shots.push(shot); renderList(); feedback();
      const fd = new FormData(); fd.append('folder', state.folder);
      fd.append('file', new File([blob], `${isbn}.jpg`, { type: 'image/jpeg' }));
      try { const r = await API.upload(fd, state.ownerId); shot.status = (r && r.rejected && r.rejected.length) ? 'error' : 'done'; }
      catch (_) { shot.status = 'error'; }
      renderList();
    }

    async function handleFile(file) {
      let img, url;
      try { url = URL.createObjectURL(file); img = await loadImgEl(url); } catch (_) { setStatus('⚠️ 이미지를 열 수 없습니다', 'bad'); return; }
      const thumb = thumbData(img);
      setStatus('⏳ 바코드 인식 중…');
      let found = []; try { found = await window.ISBN.scanMulti(img); } catch (_) {}
      try { URL.revokeObjectURL(url); } catch (_) {}
      const upBlob = await downscaleBlob(file, 1600, 0.85);
      const codes = [...new Set(found.map((f) => f.code).filter((c) => window.ISBN.isBookIsbn(c)))];
      if (codes.length >= 2) { setStatus(`✓ 바코드 ${codes.length}개 → 각각 저장`, 'ok'); for (const c of codes) await saveFile(upBlob, c, thumb); return; }
      setStatus(codes.length === 1 ? '바코드 1개만 자동 인식 — 영역 지정에서 나머지를 추가하세요' : '자동 인식 실패 — 바코드 영역을 지정하세요', 'bad');
      regionPicker(file, img, upBlob, thumb, found);
    }

    // 영역 지정 v2: 자동 후보 제시(구조텐서) + 박스별 실시간 ✓/✗ + 자동 인식분 미리 표시
    function regionPicker(file, img, upBlob, thumb, prefound) {
      const url = URL.createObjectURL(file);
      const boxes = []; let sx = 0, sy = 0, drawing = false, cur = null;
      const rm = UI.modal(`<h3>🎯 바코드 영역 지정 <span class="muted" style="font-size:12px;font-weight:400">· 바코드마다 드래그</span></h3>
        <div class="region-wrap" id="rpw"><img class="region-img" id="rpimg" src="${url}" alt=""><div class="rp-layer" id="rpboxes"></div></div>
        <p class="muted" id="rp-hint" style="font-size:12px;margin:8px 0">바코드 위를 드래그로 감싸면 즉시 인식됩니다. 초록 ✓ = 인식됨, 빨강 ✗ = 실패(더 넓게). 사각형을 탭하면 삭제.</p>
        <div class="modal-actions"><button class="btn btn-ghost" id="rp-clear">전체 지우기</button><span style="flex:1"></span><button class="btn btn-ghost" id="rp-cancel">취소</button><button class="btn btn-primary" id="rp-go">저장</button></div>`,
        { onClose: () => { try { URL.revokeObjectURL(url); } catch (_) {} } });
      rm.el.querySelector('.modal').classList.add('modal-wide');
      const imgEl = rm.q('#rpimg'), layer = rm.q('#rpboxes');
      const dispScale = () => (imgEl.clientWidth || img.naturalWidth) / img.naturalWidth;
      const fromNat = (r) => { const s = dispScale(); return { x: r.x * s, y: r.y * s, w: r.w * s, h: r.h * s }; };
      const toNat = (b, pad) => {
        const s = img.naturalWidth / (imgEl.clientWidth || img.naturalWidth);
        let x = b.x * s, y = b.y * s, w = b.w * s, h = b.h * s;
        const px = w * (pad || 0), py = h * (pad || 0);
        x = Math.max(0, x - px); y = Math.max(0, y - py);
        w = Math.min(img.naturalWidth - x, w + px * 2); h = Math.min(img.naturalHeight - y, h + py * 2);
        return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
      };
      const overlap = (a, b) => {
        const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
        const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        return (ix * iy) / (Math.min(a.w * a.h, b.w * b.h) || 1) > 0.4;
      };
      function updateHint() {
        const ok = boxes.filter((b) => b.status === 'ok').length, bad = boxes.filter((b) => b.status === 'fail').length;
        const h = rm.q('#rp-hint'); if (h) h.textContent = `인식됨 ${ok}개${bad ? ` · 미인식 ${bad}개(더 넓게)` : ''} — 저장하면 각 ISBN 이름으로 저장됩니다.`;
      }
      function render() {
        layer.innerHTML = boxes.map((b, i) => {
          const label = b.status === 'ok' ? '✓ ' + String(b.code).slice(-4) : b.status === 'scanning' ? '⏳' : b.status === 'fail' ? '✗' : (i + 1);
          return `<div class="region-box rp-box rp-${b.status}" data-i="${i}" style="left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px"><span class="rp-num">${label}</span></div>`;
        }).join('') + (cur ? `<div class="region-box" style="left:${cur.x}px;top:${cur.y}px;width:${cur.w}px;height:${cur.h}px"></div>` : '');
        layer.querySelectorAll('.rp-box').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); boxes.splice(+el.dataset.i, 1); render(); updateHint(); }));
      }
      async function decodeBox(b) {
        b.status = 'scanning'; render();
        let code = null;
        try { const r = await window.ISBN.scan(img, { region: toNat(b, 0.2), useOcr: false }); code = (r.candidates && r.candidates[0]) || null; } catch (_) {}
        if (!code) { try { const r = await window.ISBN.scan(img, { region: toNat(b, 0.45), useOcr: true }); code = (r.candidates && r.candidates[0]) || null; } catch (_) {} }
        b.code = (code && window.ISBN.isBookIsbn(code)) ? code : null;
        b.status = b.code ? 'ok' : 'fail'; render(); updateHint();
      }
      const pos = (e) => { const r = imgEl.getBoundingClientRect(); return { x: Math.max(0, Math.min(r.width, e.clientX - r.left)), y: Math.max(0, Math.min(r.height, e.clientY - r.top)) }; };
      imgEl.addEventListener('pointerdown', (e) => { e.preventDefault(); drawing = true; const p = pos(e); sx = p.x; sy = p.y; cur = { x: sx, y: sy, w: 0, h: 0 }; try { imgEl.setPointerCapture(e.pointerId); } catch (_) {} render(); });
      imgEl.addEventListener('pointermove', (e) => { if (!drawing) return; const p = pos(e); cur = { x: Math.min(sx, p.x), y: Math.min(sy, p.y), w: Math.abs(p.x - sx), h: Math.abs(p.y - sy) }; render(); });
      imgEl.addEventListener('pointerup', () => {
        drawing = false;
        if (cur && cur.w > 8 && cur.h > 8) { const b = { x: cur.x, y: cur.y, w: cur.w, h: cur.h, code: null, status: 'pending' }; boxes.push(b); cur = null; render(); decodeBox(b); }
        else { cur = null; render(); }
      });
      rm.q('#rp-clear').addEventListener('click', () => { boxes.length = 0; render(); updateHint(); });
      rm.q('#rp-cancel').addEventListener('click', rm.close);
      rm.q('#rp-go').addEventListener('click', async () => {
        if (boxes.some((b) => b.status === 'scanning' || b.status === 'pending')) return UI.toast('인식 중인 영역이 있어요. 잠시 후 다시.', 'info');
        const okBoxes = boxes.filter((b) => b.status === 'ok' && b.code);
        if (!okBoxes.length) return UI.toast('인식된 바코드가 없어요. 영역을 넉넉히 그려보세요.', 'info');
        rm.close();
        let n = 0; const seen = new Set();
        for (const b of okBoxes) { if (seen.has(b.code)) continue; seen.add(b.code); await saveFile(upBlob, b.code, thumb); n++; }
        const failN = boxes.filter((b) => b.status === 'fail').length;
        setStatus(`✓ ${n}개 저장${failN ? ` · ✗ ${failN}개 미인식` : ''}`, 'ok');
      });
      // 초기화: 자동 인식분(6) 미리 ✓ + 구조텐서 후보(1) 자동 제시→디코드→✓만 유지
      async function init() {
        for (const f of (prefound || [])) {
          if (f.box && f.code && window.ISBN.isBookIsbn(f.code)) boxes.push({ ...fromNat(f.box), code: f.code, status: 'ok' });
        }
        render(); updateHint();
        let regions = []; try { regions = window.ISBN.findBarcodeRegions(img) || []; } catch (_) {}
        for (const reg of regions.slice(0, 6)) {
          const db = fromNat(reg);
          if (boxes.some((b) => overlap(b, db))) continue;
          const b = { ...db, code: null, status: 'pending' }; boxes.push(b); render();
          await decodeBox(b);
          if (b.status !== 'ok') { const i = boxes.indexOf(b); if (i >= 0) boxes.splice(i, 1); render(); updateHint(); }
        }
      }
      if (imgEl.complete && imgEl.clientWidth) init(); else imgEl.addEventListener('load', init, { once: true });
      render();
    }

    cam.addEventListener('change', async () => { const files = [...cam.files]; cam.value = ''; for (const f of files) await handleFile(f); });
    m.q('#mb-shoot').addEventListener('click', () => { try { cam.click(); } catch (_) {} });
    m.q('#mb-done').addEventListener('click', m.close);
    renderList();
  }

  // ── 카메라(사진) 업로드: 촬영 → 각 사진 제목·비고 입력 → 업로드 ──────────
  function cameraReviewModal(files) {
    const urls = files.map((f) => URL.createObjectURL(f));
    const rows = files.map((f, i) => `
      <div class="cam-item" data-i="${i}">
        <img class="cam-thumb" src="${urls[i]}" alt="">
        <div class="cam-fields">
          <input class="input cam-title" placeholder="제목(선택)">
          <input class="input cam-note" placeholder="비고(선택)">
        </div>
        <button class="icon-btn cam-rm" data-rm="${i}" title="제거">✕</button>
      </div>`).join('');
    const loc = state.folder === '/' ? '홈' : state.folder;
    const m = UI.modal(`<h3>📷 촬영 업로드 <span class="muted" style="font-size:13px;font-weight:400">· ${files.length}장 → ${UI.escapeHtml(loc)}</span></h3>
      <p class="muted" style="font-size:12px;margin-bottom:10px">각 사진의 제목·비고를 입력하고 업로드하세요. (제목 비우면 자동 이름) · 바코드로 ISBN 파일을 만들려면 <b>📷 바코드 다건 촬영</b>을 이용하세요.</p>
      <div id="cam-list">${rows}</div>
      <div class="modal-actions"><button class="btn btn-ghost" id="cam-cancel">취소</button><button class="btn btn-primary" id="cam-go">⬆️ ${files.length}장 업로드</button></div>`);
    m.el.querySelector('.modal').classList.add('modal-wide');
    const cleanup = () => urls.forEach((u) => URL.revokeObjectURL(u));
    const kept = new Set(files.map((_, i) => i));
    const itemEl = (i) => m.el.querySelector(`.cam-item[data-i="${i}"]`);

    m.q('#cam-cancel').addEventListener('click', () => { cleanup(); m.close(); });
    m.el.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => {
      kept.delete(Number(b.dataset.rm)); b.closest('.cam-item').remove();
      if (!kept.size) { cleanup(); m.close(); }
      else m.q('#cam-go').textContent = `⬆️ ${kept.size}장 업로드`;
    }));

    m.q('#cam-go').addEventListener('click', () => {
      const count = kept.size;
      const targetOwner = state.ownerId;
      const fd = new FormData(); fd.append('folder', state.folder);
      [...kept].forEach((i) => {
        const item = itemEl(i);
        fd.append('file', files[i]);
        fd.append('titles', item.querySelector('.cam-title').value.trim());
        fd.append('notes', item.querySelector('.cam-note').value.trim());
      });
      cleanup(); m.close();
      UI.toast(`${count}장 업로드 중… (백그라운드)`, 'info');
      API.upload(fd, targetOwner)
        .then((r) => {
          if (r && r.rejected && r.rejected.length) UI.toast(`⚠️ ${r.rejected.length}장 차단됨`, 'error');
          UI.toast('촬영 업로드 완료 ✅', 'success');
          loadAll();
        })
        .catch((err) => UI.toast('업로드 실패: ' + err.message, 'error'));
    });
  }

  // ── 업로드된 이미지 파일을 바코드 스캔해 ISBN으로 제목 변경 (개별·다건) ──────────
  function loadImgEl(url) {
    return new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = () => reject(new Error('이미지 로드 실패')); im.src = url; });
  }
  // 저장된 파일 이미지를 받아 ISBN 스캔 → { isbn, candidates, method } (실패 시 null)
  async function scanStoredImage(id) {
    const res = await fetch(API.downloadUrl(id), { headers: { Authorization: 'Bearer ' + API.getToken() }, credentials: 'include' });
    if (!res.ok) throw new Error('이미지 불러오기 실패');
    const url = URL.createObjectURL(await res.blob());
    try { const img = await loadImgEl(url); return await window.ISBN.scan(img, { useOcr: true }); }
    finally { URL.revokeObjectURL(url); }
  }
  // items: 선택 항목 배열({type,id,name}) 또는 단일 파일. 이미지 파일만 대상.
  async function barcodeRename(items) {
    if (!window.ISBN) return UI.toast('ISBN 인식 모듈을 사용할 수 없습니다', 'error');
    const imgs = items.filter((it) => it.type === 'file' && isImage(it.name));
    if (!imgs.length) return UI.toast('이미지 파일을 선택하세요', 'info');
    const m = UI.modal(`<h3>📕 바코드로 제목 변경 <span class="muted" style="font-size:13px;font-weight:400">· ${imgs.length}개</span></h3>
      <div id="bc-prog" class="muted" style="padding:8px 0">준비 중…</div>
      <div class="modal-actions"><button class="btn btn-ghost" id="bc-cancel">중단</button></div>`);
    let cancelled = false; m.q('#bc-cancel').addEventListener('click', () => { cancelled = true; m.close(); });
    let done = 0, renamed = 0; const failed = [];
    for (const it of imgs) {
      if (cancelled) break;
      m.q('#bc-prog').textContent = `${done + 1}/${imgs.length} 스캔 중… (${it.name})`;
      try {
        const r = await scanStoredImage(it.id);
        if (r && r.isbn) { const ext = (it.name.split('.').pop() || '').toLowerCase(); await API.renameFile(it.id, r.isbn + (ext ? '.' + ext : '')); renamed++; }
        else failed.push(it.name);
      } catch (_) { failed.push(it.name); }
      done++;
    }
    if (!cancelled) m.close();
    if (renamed) { state.selected.clear(); await loadFiles(); }
    if (!cancelled) {
      const msg = `📕 ${renamed}개 제목 변경${failed.length ? ` · ${failed.length}개 실패(ISBN 못 찾음)` : ''}`;
      UI.toast(msg, failed.length && !renamed ? 'error' : 'success');
    }
  }

  // ── 일괄 이름변경 (구성요소를 골라 조합: 앞텍스트·원본이름·날짜·연번) ──────────
  function bulkRenameModal(items) {
    const files = (items || []).filter((it) => it.type === 'file');
    if (files.length < 2) return UI.toast('파일을 2개 이상 선택하세요', 'info');
    files.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    const splitExt = (nm) => { const i = nm.lastIndexOf('.'); return i > 0 ? [nm.slice(0, i), nm.slice(i)] : [nm, '']; };
    const now = new Date(); const p2 = (x) => String(x).padStart(2, '0');
    const todayIso = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
    const fmtDate = (iso, fmt) => { if (!iso) return ''; const [Y, M, D] = iso.split('-'); if (fmt === 'YYYYMMDD') return `${Y}${M}${D}`; if (fmt === 'YYMMDD') return `${Y.slice(2)}${M}${D}`; return `${Y}-${M}-${D}`; };
    const m = UI.modal(`<h3>🔢 일괄 이름변경 <span class="muted" style="font-size:13px;font-weight:400">· ${files.length}개</span></h3>
      <p class="muted" style="font-size:12px;margin-bottom:10px">넣을 항목을 켜서 순서대로 조합됩니다. (확장자는 유지)</p>
      <div class="br-build">
        <div class="br-item">
          <label class="br-opt"><input type="checkbox" id="br-usePrefix"><span class="br-name">앞 텍스트</span><input class="input br-inline" id="br-prefix" placeholder="예: 정산" maxlength="40" disabled></label>
          <p class="br-desc">이름 맨 앞에 붙일 고정 글자</p>
        </div>
        <div class="br-item">
          <label class="br-opt"><input type="checkbox" id="br-useName" checked><span class="br-name">원본 이름</span></label>
          <p class="br-desc">기존 파일 이름을 그대로 사용</p>
        </div>
        <div class="br-item">
          <label class="br-opt"><input type="checkbox" id="br-useDate"><span class="br-name">날짜</span><input class="input br-inline" id="br-datepick" type="date" value="${todayIso}" disabled><select class="input br-inline" id="br-date" disabled><option>YYYY-MM-DD</option><option>YYYYMMDD</option><option>YYMMDD</option></select></label>
          <p class="br-desc">기본은 오늘 · 원하면 특정 날짜 선택</p>
        </div>
        <div class="br-item">
          <label class="br-opt"><input type="checkbox" id="br-useSeq"><span class="br-name">연번</span><span class="br-inline2">시작 <input class="input" id="br-start" type="number" value="1" min="0" style="width:64px" disabled> 자릿수 <select class="input" id="br-pad" disabled><option value="1">1</option><option value="2">2</option><option value="3" selected>3</option><option value="4">4</option></select></span></label>
          <p class="br-desc">001, 002 … 순서대로 번호를 붙입니다</p>
        </div>
        <div class="br-item br-sep-row">
          <span class="br-name">구분자</span>
          <select class="input br-inline" id="br-sep"><option value="_">_ (밑줄)</option><option value="-">- (하이픈)</option><option value=" ">공백</option><option value="">없음</option></select>
          <p class="br-desc">항목 사이를 잇는 문자</p>
        </div>
      </div>
      <div class="field" style="margin-top:12px"><label>미리보기</label><div id="br-prev" class="br-prev"></div></div>
      <div class="modal-actions"><button class="btn btn-ghost" id="br-cancel">취소</button><button class="btn btn-primary" id="br-go">적용</button></div>`);
    m.el.querySelector('.modal').classList.add('modal-wide');
    // 체크박스로 개별 입력 활성/비활성
    const bind = (cb, ...ctrls) => { const on = m.q(cb).checked; ctrls.forEach((c) => { const el = m.q(c); if (el) el.disabled = !on; }); };
    const syncEnabled = () => { bind('#br-usePrefix', '#br-prefix'); bind('#br-useDate', '#br-datepick', '#br-date'); bind('#br-useSeq', '#br-start', '#br-pad'); };
    const buildName = (base, idx) => {
      const sep = m.q('#br-sep').value;
      const parts = [];
      if (m.q('#br-usePrefix').checked && m.q('#br-prefix').value.trim()) parts.push(m.q('#br-prefix').value.trim());
      if (m.q('#br-useName').checked) parts.push(base);
      if (m.q('#br-useDate').checked) parts.push(fmtDate(m.q('#br-datepick').value || todayIso, m.q('#br-date').value));
      if (m.q('#br-useSeq').checked) { const start = parseInt(m.q('#br-start').value, 10) || 0; const pad = parseInt(m.q('#br-pad').value, 10) || 1; parts.push(String(start + idx).padStart(pad, '0')); }
      return parts.join(sep).replace(/[/\\]/g, '_').replace(/[\x00-\x1f]/g, '').trim();
    };
    function renderPrev() {
      syncEnabled();
      const rows = files.slice(0, 8).map((f, i) => { const [base, ext] = splitExt(f.name); const nb = buildName(base, i); return `<div class="br-line"><span class="old">${UI.escapeHtml(f.name)}</span><span class="arr">→</span><span class="new ${nb ? '' : 'bad'}">${UI.escapeHtml(nb ? nb + ext : '(빈 이름)')}</span></div>`; }).join('');
      m.q('#br-prev').innerHTML = rows + (files.length > 8 ? `<div class="muted" style="font-size:12px;margin-top:4px">… 외 ${files.length - 8}개</div>` : '');
    }
    m.el.querySelectorAll('.br-build input, .br-build select').forEach((el) => { el.addEventListener('input', renderPrev); el.addEventListener('change', renderPrev); });
    renderPrev();
    m.q('#br-cancel').addEventListener('click', m.close);
    m.q('#br-go').addEventListener('click', async () => {
      const plan = files.map((f, i) => { const [base, ext] = splitExt(f.name); const nb = buildName(base, i); return { id: f.id, nb, nn: nb + ext }; });
      if (plan.some((p) => !p.nb)) return UI.toast('빈 이름이 생깁니다. 항목을 하나 이상 켜주세요.', 'error');
      const btn = m.q('#br-go'); btn.disabled = true; btn.innerHTML = '<span class="btn-spin"></span>변경 중…';
      let ok = 0; const fail = [];
      for (const p of plan) { try { await API.renameFile(p.id, p.nn); ok++; } catch (_) { fail.push(p.nn); } }
      m.close(); state.selected.clear(); await loadFiles();
      UI.toast(`🔢 ${ok}개 이름변경${fail.length ? ` · ${fail.length}개 실패` : ''}`, fail.length && !ok ? 'error' : 'success');
    });
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
  function loadThumbsIn(root) {
    const els = (root || document).querySelectorAll('[data-thumb]'); if (!els.length || !('IntersectionObserver' in window)) return;
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
  function loadThumbs() { loadThumbsIn(document.getElementById('listing')); }

  // ── 파일 미리보기 (우측 패널) ──────────────────────────
  const PV_IMG = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico']);
  const PV_TXT = new Set(['txt', 'md', 'log', 'json', 'xml', 'yml', 'yaml', 'html', 'css', 'js', 'ts', 'sql', 'ini', 'cfg', 'env']);
  const PV_OFFICE = new Set(['xlsx', 'xls', 'xlsm', 'csv']);   // 표 형식(엑셀/CSV)은 표로 렌더
  const PV_PPT = new Set(['pptx', 'ppsx']);                    // 서버 변환 실패 시 텍스트+이미지 폴백 가능
  const PV_DOC = new Set(['ppt', 'pptx', 'ppsx', 'pps', 'doc', 'docx', 'odp', 'odt', 'rtf']); // 서버 PDF 로 완전 레이아웃 렌더
  const canPreview = (name) => { const e = (name.split('.').pop() || '').toLowerCase(); return PV_IMG.has(e) || PV_TXT.has(e) || PV_OFFICE.has(e) || PV_DOC.has(e) || e === 'pdf'; };
  let pvObjUrl = null, pvCurrentId = null, pvExtraUrls = [];
  function revokeExtra() { pvExtraUrls.forEach((u) => { try { URL.revokeObjectURL(u); } catch (_) {} }); pvExtraUrls = []; }
  function closePreview() {
    const panel = document.getElementById('preview-panel'); if (!panel) return;
    panel.classList.add('hidden'); panel.setAttribute('aria-hidden', 'true');
    document.getElementById('preview-backdrop')?.classList.remove('show');
    document.body.classList.remove('pv-open');
    const body = document.getElementById('pp-body'); if (body) body.innerHTML = '';
    if (pvObjUrl) { URL.revokeObjectURL(pvObjUrl); pvObjUrl = null; }
    revokeExtra();
    pvCurrentId = null; applySelectionClasses();
  }
  function openPreview(id) {
    const panel = document.getElementById('preview-panel'); if (!panel) return;
    const f = state.files.find((x) => String(x.id) === String(id));
    const name = f ? f.name : '파일'; const ext = (name.split('.').pop() || '').toLowerCase();
    if (pvObjUrl) { URL.revokeObjectURL(pvObjUrl); pvObjUrl = null; }
    revokeExtra();
    pvCurrentId = id;
    panel.classList.remove('hidden'); panel.setAttribute('aria-hidden', 'false');
    document.getElementById('preview-backdrop')?.classList.add('show');
    document.body.classList.add('pv-open');
    const nm = document.getElementById('pp-name'); nm.textContent = name; nm.title = name;
    applySelectionClasses();
    const body = document.getElementById('pp-body');
    body.innerHTML = '<p class="muted pp-msg">불러오는 중…</p>';
    if (PV_DOC.has(ext)) { renderDocPdf(body, id, ext); return; } // PPT·워드 등은 서버 PDF 로 완전 렌더
    fetch(API.downloadUrl(id), { headers: { Authorization: 'Bearer ' + API.getToken() }, credentials: 'include' })
      .then((r) => { if (!r.ok) throw new Error('불러오기 실패'); return r.blob(); })
      .then(async (blob) => {
        if (pvCurrentId !== id) return;                       // 그 사이 다른 파일을 열었으면 무시
        if (PV_IMG.has(ext)) { pvObjUrl = URL.createObjectURL(blob); body.innerHTML = `<img class="pp-img" alt="" src="${pvObjUrl}">`; }
        else if (ext === 'pdf') { pvObjUrl = URL.createObjectURL(blob); body.innerHTML = `<iframe class="pp-frame" src="${pvObjUrl}"></iframe>`; }
        else if (PV_OFFICE.has(ext)) { await renderSheetPreview(body, blob); }
        else { let text = await blob.text(); if (text.length > 200000) text = text.slice(0, 200000) + '\n…(생략됨)'; const pre = document.createElement('pre'); pre.className = 'pp-text'; pre.textContent = text; body.innerHTML = ''; body.appendChild(pre); }
      })
      .catch((e) => { if (pvCurrentId === id) body.innerHTML = `<p class="muted pp-msg" style="color:var(--danger)">${UI.escapeHtml(e.message)}</p>`; });
  }
  // 오피스 문서 → 서버에서 PDF 로 변환해 완전한 레이아웃으로 렌더. 변환 불가/실패 시 폴백(사유 표시).
  async function renderDocPdf(body, id, ext) {
    body.innerHTML = '<p class="muted pp-msg">📄 레이아웃 변환 중… (처음 한 번만 잠시 걸려요)</p>';
    let status = 0;
    try {
      const r = await fetch(API.pdfUrl(id), { headers: { Authorization: 'Bearer ' + API.getToken() }, credentials: 'include' });
      status = r.status;
      if (!r.ok) throw new Error(String(r.status));
      const blob = await r.blob();
      if (pvCurrentId !== id) return;
      pvObjUrl = URL.createObjectURL(blob);
      body.innerHTML = `<iframe class="pp-frame" src="${pvObjUrl}"></iframe>`;
      return;
    } catch (_) { /* 아래에서 폴백 */ }
    if (pvCurrentId !== id) return;
    const reason = status === 404 ? '백엔드가 아직 업데이트되지 않았습니다(서버 재배포 필요).'
      : status === 501 ? '서버에 문서 변환기(LibreOffice)가 설치되어 있지 않습니다.'
        : status === 415 ? '변환할 수 없는 형식입니다.'
          : status ? `변환 실패(${status}).` : '서버에 연결하지 못했습니다.';
    const banner = `<div class="pp-sheet-note">⚠️ 완전 레이아웃(PDF) 미리보기를 못 불러왔습니다 — ${UI.escapeHtml(reason)} 아래는 내용 미리보기입니다.</div>`;
    if (PV_PPT.has(ext)) {                                     // pptx·ppsx 는 텍스트+이미지 폴백 + 사유 배너
      try {
        const fb = await (await fetch(API.downloadUrl(id), { headers: { Authorization: 'Bearer ' + API.getToken() }, credentials: 'include' })).blob();
        if (pvCurrentId !== id) return;
        await renderPptPreview(body, fb, id);
        if (pvCurrentId === id) body.insertAdjacentHTML('afterbegin', banner);
      } catch (_) { if (pvCurrentId === id) body.innerHTML = banner; }
    } else if (pvCurrentId === id) {
      body.innerHTML = banner + '<p class="muted pp-msg">다운로드해서 확인해 주세요.</p>';
    }
  }
  // 엑셀/CSV 미리보기 — 표가 크면 앞 N행 × M열만 읽어 렌더(로딩 지연 방지)
  const PV_MAX_ROWS = 100, PV_MAX_COLS = 40;
  let xlsxLoading = null;
  function ensureXLSX() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (xlsxLoading) return xlsxLoading;
    xlsxLoading = new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'vendor/xlsx.min.js?v=95'; s.onload = () => res(window.XLSX); s.onerror = () => { xlsxLoading = null; rej(new Error('엑셀 뷰어를 불러오지 못했습니다.')); }; document.head.appendChild(s); });
    return xlsxLoading;
  }
  async function renderSheetPreview(body, blob) {
    let XLSX; try { XLSX = await ensureXLSX(); } catch (e) { body.innerHTML = `<p class="muted pp-msg">${UI.escapeHtml(e.message)}</p>`; return; }
    let wb; try { wb = XLSX.read(await blob.arrayBuffer(), { type: 'array' }); } catch (_) { body.innerHTML = '<p class="muted pp-msg">시트를 읽을 수 없습니다.</p>'; return; }
    const names = wb.SheetNames || []; const esc = UI.escapeHtml;
    const renderSheet = (sn) => {
      const ws = wb.Sheets[sn]; if (!ws) return;
      let truncated = false, totalRows = 0, totalCols = 0, range = null;
      if (ws['!ref']) {
        range = XLSX.utils.decode_range(ws['!ref']); totalRows = range.e.r - range.s.r + 1; totalCols = range.e.c - range.s.c + 1;
        if (range.e.r > range.s.r + PV_MAX_ROWS - 1) { range.e.r = range.s.r + PV_MAX_ROWS - 1; truncated = true; }
        if (range.e.c > range.s.c + PV_MAX_COLS - 1) { range.e.c = range.s.c + PV_MAX_COLS - 1; truncated = true; }
      }
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, range: range ? XLSX.utils.encode_range(range) : undefined, blankrows: false, defval: '' });
      const tabs = names.length > 1 ? `<div class="pp-sheet-tabs">${names.map((n) => `<button type="button" class="pp-sheet-tab${n === sn ? ' on' : ''}" data-sheet="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : '';
      const note = truncated ? `<div class="pp-sheet-note">📏 표가 커서 앞 ${Math.min(PV_MAX_ROWS, totalRows)}행 × ${Math.min(PV_MAX_COLS, totalCols)}열만 표시 · 전체 ${totalRows}행 × ${totalCols}열 (전체는 다운로드)</div>` : '';
      const table = `<div class="pp-sheet-scroll"><table class="pp-sheet"><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c == null ? '' : String(c))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      body.innerHTML = tabs + note + table;
      body.querySelectorAll('[data-sheet]').forEach((el) => el.addEventListener('click', () => renderSheet(el.dataset.sheet)));
    };
    renderSheet(names[0]);
  }
  // ── PPTX 미리보기 — 슬라이드별 이미지 + 텍스트 (pptx 는 XML 압축파일) ──────────
  const PV_MAX_SLIDES = 40;
  let jszipLoading = null;
  function ensureJSZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    if (jszipLoading) return jszipLoading;
    jszipLoading = new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'vendor/jszip.min.js?v=96'; s.onload = () => res(window.JSZip); s.onerror = () => { jszipLoading = null; rej(new Error('슬라이드 뷰어를 불러오지 못했습니다.')); }; document.head.appendChild(s); });
    return jszipLoading;
  }
  const decodeXml = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/&amp;/g, '&');
  function resolveZipPath(base, target) {          // base='ppt/slides/slide1.xml', target='../media/x.png'
    if (target.startsWith('/')) return target.slice(1);
    const parts = (base.replace(/\/[^/]*$/, '') + '/' + target).split('/'), out = [];
    for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.' && p !== '') out.push(p); }
    return out.join('/');
  }
  async function renderPptPreview(body, blob, id) {
    let JSZip; try { JSZip = await ensureJSZip(); } catch (e) { body.innerHTML = `<p class="muted pp-msg">${UI.escapeHtml(e.message)}</p>`; return; }
    let zip; try { zip = await JSZip.loadAsync(await blob.arrayBuffer()); } catch (_) { body.innerHTML = '<p class="muted pp-msg">슬라이드를 읽을 수 없습니다.</p>'; return; }
    if (pvCurrentId !== id) return;
    const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => parseInt(a.match(/(\d+)/)[1], 10) - parseInt(b.match(/(\d+)/)[1], 10));
    if (!slides.length) { body.innerHTML = '<p class="muted pp-msg">슬라이드가 없습니다.</p>'; return; }
    const total = slides.length, shown = slides.slice(0, PV_MAX_SLIDES), esc = UI.escapeHtml;
    const cards = [];
    for (let i = 0; i < shown.length; i++) {
      const sname = shown[i];
      let xml = ''; try { xml = await zip.file(sname).async('string'); } catch (_) {}
      if (pvCurrentId !== id) return;                // 그 사이 다른 파일 열림
      const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1])).filter((t) => t.trim());
      const imgs = [];
      const relFile = zip.file(sname.replace(/slides\/(slide\d+)\.xml$/, 'slides/_rels/$1.xml.rels'));
      if (relFile) {
        let rel = ''; try { rel = await relFile.async('string'); } catch (_) {}
        const map = {};
        for (const m of rel.matchAll(/<Relationship\b[^>]*>/g)) { const t = m[0], idm = t.match(/Id="([^"]+)"/), tg = t.match(/Target="([^"]+)"/), ty = t.match(/Type="([^"]+)"/); if (idm && tg && ty && /image/i.test(ty[1])) map[idm[1]] = tg[1]; }
        for (const m of xml.matchAll(/r:embed="([^"]+)"/g)) {
          const tgt = map[m[1]]; if (!tgt) continue;
          const mf = zip.file(resolveZipPath(sname, tgt)); if (!mf) continue;
          try { const u = URL.createObjectURL(await mf.async('blob')); pvExtraUrls.push(u); imgs.push(u); } catch (_) {}
          if (imgs.length >= 6) break;
        }
      }
      cards.push({ n: i + 1, texts, imgs });
    }
    if (pvCurrentId !== id) return;
    const note = total > shown.length ? `<div class="pp-sheet-note">📏 슬라이드가 많아 앞 ${shown.length}장만 표시 · 전체 ${total}장 (전체는 다운로드)</div>` : '';
    body.innerHTML = note + '<div class="pp-ppt">' + cards.map((c) => `
      <div class="pp-slide"><div class="pp-slide-n">슬라이드 ${c.n} / ${total}</div>
        ${c.imgs.length ? `<div class="pp-slide-imgs">${c.imgs.map((u) => `<img src="${u}" alt="">`).join('')}</div>` : ''}
        ${c.texts.length ? `<div class="pp-slide-text">${c.texts.map((t) => `<p>${esc(t)}</p>`).join('')}</div>` : (c.imgs.length ? '' : '<p class="pp-slide-empty">(텍스트 없음)</p>')}
      </div>`).join('') + '</div>';
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
    try { await API.deleteFile(id); UI.toast('삭제됨 (휴지통 이동)', 'success', undoOpts([id], [])); loadFiles(); } catch (err) { UI.toast(err.message, 'error'); }
  }

  async function deleteFolder(path) {
    const name = path.split('/').pop();
    const fid = (state.folders.find((x) => x.path === path) || {}).id;
    const ok = await UI.confirm({ title: '폴더 삭제', danger: true, confirmText: '휴지통으로', message: `'${name}' 폴더와 그 안의 모든 파일을 삭제할까요?\n관리자 휴지통에서 복원할 수 있습니다.` });
    if (!ok) return;
    try { await API.deleteFolder(path, state.ownerId); UI.toast('폴더 삭제됨 (휴지통 이동)', 'success', undoOpts([], fid ? [fid] : [])); loadAll(); } catch (err) { UI.toast(err.message, 'error'); }
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

  // ── 인라인 이름변경 (모달 없이 항목에서 바로 편집) ──────────
  function inlineRename(type, ref) {
    const key = type === 'folder' ? `folder:${ref}` : `file:${ref}`;
    let row; try { row = document.querySelector(`#listing [data-row-key="${CSS.escape(key)}"]`); } catch { row = null; }
    const nameEl = row && row.querySelector('.name-cell, .file-name, .mcard-name');
    if (!nameEl) return type === 'file' ? renameFileModal(ref) : folderSettingsModal(ref); // 폴백: 모달
    if (nameEl.querySelector('.inline-rename')) return;
    const cur = type === 'folder' ? String(ref).split('/').pop() : ((state.files.find((f) => String(f.id) === String(ref)) || {}).name || '');
    const orig = nameEl.innerHTML;
    const input = document.createElement('input');
    input.className = 'input inline-rename'; input.value = cur;
    nameEl.innerHTML = ''; nameEl.appendChild(input);
    input.focus();
    const dot = cur.lastIndexOf('.');
    input.setSelectionRange(0, (type === 'file' && dot > 0) ? dot : cur.length);
    let done = false;
    const cancel = () => { if (done) return; done = true; nameEl.innerHTML = orig; };
    const commit = async () => {
      if (done) return; const v = input.value.trim();
      if (!v || v === cur) return cancel();
      done = true;
      try {
        if (type === 'file') {
          // 확장자 유지: 새 이름에 원래 확장자가 없으면 자동으로 붙임
          const od = cur.lastIndexOf('.'); const ext = od > 0 ? cur.slice(od) : '';
          const finalName = (ext && !v.toLowerCase().endsWith(ext.toLowerCase())) ? v + ext : v;
          await API.renameFile(ref, finalName);
        } else { const parent = String(ref).slice(0, String(ref).lastIndexOf('/')) || ''; await API.renameFolder(ref, parent + '/' + v, state.ownerId); }
        UI.toast('이름 변경됨', 'success'); loadAll();
      } catch (e) { UI.toast(e.message, 'error'); nameEl.innerHTML = orig; }
    };
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') { e.preventDefault(); cancel(); } });
    input.addEventListener('blur', commit);
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
  }

  // ── 우클릭 컨텍스트 메뉴 ──────────
  let ctxEl = null;
  const ctxKey = (e) => { if (e.key === 'Escape') closeCtx(); };
  function closeCtx() { if (!ctxEl) return; ctxEl.remove(); ctxEl = null; document.removeEventListener('click', closeCtx); document.removeEventListener('keydown', ctxKey); window.removeEventListener('scroll', closeCtx, true); }
  function showContextMenu(x, y, items) {
    closeCtx();
    const el = document.createElement('div'); el.className = 'ctx-menu';
    el.innerHTML = items.map((it, i) => it.sep ? '<div class="ctx-sep"></div>' : `<button class="ctx-item${it.danger ? ' danger' : ''}" data-ci="${i}"><span class="ci-ic">${it.icon || ''}</span>${UI.escapeHtml(it.label)}</button>`).join('');
    document.body.appendChild(el);
    el.style.left = Math.max(6, Math.min(x, window.innerWidth - el.offsetWidth - 8)) + 'px';
    el.style.top = Math.max(6, Math.min(y, window.innerHeight - el.offsetHeight - 8)) + 'px';
    el.querySelectorAll('[data-ci]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); const it = items[Number(b.dataset.ci)]; closeCtx(); it.onClick(); }));
    ctxEl = el;
    setTimeout(() => { document.addEventListener('click', closeCtx); document.addEventListener('keydown', ctxKey); window.addEventListener('scroll', closeCtx, true); }, 0);
  }
  function openContextFor(e, isFolder, item) {
    const items = isFolder ? [
      { icon: '📂', label: '열기', onClick: () => openFolder(item.path) },
      { icon: '🔗', label: '폴더 공유', onClick: () => folderShareModal(item.path) },
      { icon: '📥', label: '업로드 요청', onClick: () => uploadRequestModal(item.path) },
      { icon: '⚙️', label: '폴더 설정', onClick: () => folderSettingsModal(item.path) },
      { icon: '📝', label: '비고', onClick: () => folderNoteModal(item.path) },
      { icon: '✏️', label: '이름 변경', onClick: () => inlineRename('folder', item.path) },
      { sep: true },
      { icon: (state.folders.find((x) => x.path === item.path) || {}).fav ? '⭐' : '☆', label: '즐겨찾기', onClick: () => toggleFavFolder(item.path) },
      { icon: '🗑️', label: '삭제', danger: true, onClick: () => deleteFolder(item.path) },
    ] : [
      { icon: '⬇️', label: '다운로드', onClick: () => downloadFile(item.id) },
      ...(canPreview(item.name) ? [{ icon: '👁️', label: '미리보기', onClick: () => openPreview(item.id) }] : []),
      { icon: '🔗', label: '공유 링크', onClick: () => shareModal(item.id) },
      { icon: '🏷️', label: '태그', onClick: () => tagPickerModal(item.id) },
      { icon: '📝', label: '비고', onClick: () => noteModal(item.id) },
      { icon: '✏️', label: '이름 변경', onClick: () => inlineRename('file', item.id) },
      ...((window.ISBN && isImage(item.name)) ? [{ icon: '📕', label: '바코드로 제목변경', onClick: () => barcodeRename([{ type: 'file', id: String(item.id), name: item.name }]) }] : []),
      { sep: true },
      { icon: (state.files.find((x) => String(x.id) === String(item.id)) || {}).fav ? '⭐' : '☆', label: '즐겨찾기', onClick: () => toggleFavFile(item.id) },
      { icon: '🗑️', label: '삭제', danger: true, onClick: () => deleteFile(item.id) },
    ];
    showContextMenu(e.clientX, e.clientY, items);
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
    const curCover = f.cover || folderStyle(path).cover || null;
    const m = UI.modal(`<h3>폴더 설정</h3>
      <div class="field"><label>폴더 이름</label><input class="input" id="nm" value="${UI.escapeHtml(name)}"></div>
      ${stylePickerHTML(st.icon, st.color)}
      <div class="field"><label>커버 이미지 <span class="muted" style="font-weight:400;font-size:12px">· 폴더 안 사진 하나를 대표로</span></label>
        <div class="cover-picker" id="cover-pick"><p class="muted" style="font-size:13px">불러오는 중…</p></div>
      </div>
      <div class="modal-actions"><button class="btn btn-ghost" id="c">취소</button><button class="btn btn-primary" id="ok">저장</button></div>`);
    m.el.querySelector('.modal').classList.add('modal-wide');
    const picker = wireStylePicker(m);
    let coverSel = curCover ? String(curCover) : '';
    // 폴더 안 이미지 목록을 불러와 커버 후보로 표시
    (async () => {
      try {
        const list = await API.listFiles(path, state.ownerId);
        const imgs = (list.files || []).filter((x) => isImage(x.name));
        const box = m.q('#cover-pick');
        if (!imgs.length) { box.innerHTML = '<p class="muted" style="font-size:13px">이 폴더에 이미지 파일이 없습니다.</p>'; return; }
        box.innerHTML = `<button type="button" class="cover-opt cover-none${coverSel ? '' : ' on'}" data-cover="">없음</button>` +
          imgs.map((x) => `<button type="button" class="cover-opt${coverSel === String(x.id) ? ' on' : ''}" data-cover="${x.id}" data-thumb="${x.id}" title="${UI.escapeHtml(x.name)}">🖼️</button>`).join('');
        box.querySelectorAll('[data-cover]').forEach((b) => b.addEventListener('click', () => { coverSel = b.dataset.cover; box.querySelectorAll('.cover-opt').forEach((x) => x.classList.toggle('on', x === b)); }));
        loadThumbsIn(box); // 썸네일 지연 로딩
      } catch (_) { m.q('#cover-pick').innerHTML = '<p class="muted" style="font-size:13px">목록을 불러오지 못했습니다.</p>'; }
    })();
    m.q('#c').addEventListener('click', m.close);
    m.q('#ok').addEventListener('click', async () => {
      const nn = m.q('#nm').value.trim().replace(/\//g, ''); if (!nn) return;
      try {
        let target = path;
        if (nn !== name) { const r = await API.renameFolder(path, (parent || '') + '/' + nn, state.ownerId); target = r.path || (parent || '') + '/' + nn; if (state.folder === path || state.folder.startsWith(path + '/')) state.folder = target; }
        await API.setFolderStyle(target, picker.icon, picker.color, state.ownerId, coverSel || '');
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
    const qrBtn = state.qrEnabled ? `<button class="btn btn-secondary btn-sm" id="qrbtn">📱 QR 코드</button>` : '';
    m.animate(() => { m.q('#result').innerHTML = `<div class="field" style="margin-top:14px"><label>공유 링크 (누구나 접근 가능)</label><input class="input" id="lnk" readonly value="${UI.escapeHtml(url)}"></div><div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn btn-secondary btn-sm" id="copy">📋 링크 복사</button>${qrBtn}</div><div id="qrbox" style="text-align:center;margin-top:12px"></div>`; });
    m.q('#lnk').select();
    m.q('#copy').addEventListener('click', () => { m.q('#lnk').select(); navigator.clipboard?.writeText(url); UI.toast('링크 복사됨', 'success'); });
    m.q('#qrbtn')?.addEventListener('click', () => showQr(m, url));
  }
  // 공유 링크 QR 표시(토글). 관리자가 껐으면 버튼이 없으므로 호출되지 않음.
  async function showQr(m, url) {
    const box = m.q('#qrbox'); if (!box) return;
    if (box.dataset.shown) { m.animate(() => { box.innerHTML = ''; box.dataset.shown = ''; }); return; }
    try { const { qr } = await API.qr(url); m.animate(() => { box.innerHTML = `<img src="${qr}" alt="QR" style="width:200px;height:200px;border:1px solid var(--border);border-radius:8px;padding:6px;background:#fff"><div class="muted" style="font-size:12px;margin-top:6px">카메라로 스캔해 열기</div>`; box.dataset.shown = '1'; }); }
    catch (e) { UI.toast(e.message, 'error'); }
  }

  // ── 즐겨찾기 토글 ──────────
  async function toggleFavFile(id) {
    try { const r = await API.toggleFav({ kind: 'file', id: Number(id) }); const f = state.files.find((x) => String(x.id) === String(id)); if (f) f.fav = r.fav; renderListing(); }
    catch (e) { UI.toast(e.message, 'error'); }
  }
  async function toggleFavFolder(path) {
    try { const r = await API.toggleFav({ kind: 'folder', path, ownerId: state.ownerId || undefined }); const f = state.folders.find((x) => x.path === path); if (f) f.fav = r.fav; renderListing(); }
    catch (e) { UI.toast(e.message, 'error'); }
  }


  // ── 파일 태그 지정 ──────────
  function tagPickerModal(fileId) {
    const file = state.files.find((f) => String(f.id) === String(fileId));
    const current = new Set((file?.tags || []).map((t) => String(t.id)));
    const m = UI.modal(`<h3>🏷️ 태그 지정</h3><p class="muted" style="font-size:13px;margin-bottom:10px">${UI.escapeHtml(file?.name || '')}</p>
      <div id="tp-list"></div>
      <div class="field" style="margin-top:12px"><label>새 태그 추가</label><div style="display:flex;gap:6px"><input class="input" id="tp-new" placeholder="태그 이름" maxlength="40"><input type="color" id="tp-color" value="#118AB2" style="width:46px;padding:2px"><button class="btn btn-secondary btn-sm" id="tp-add">추가</button></div></div>
      <div class="modal-actions"><button class="btn btn-ghost" id="tp-cancel">취소</button><button class="btn btn-primary" id="tp-save">저장</button></div>`);
    function renderList() {
      m.q('#tp-list').innerHTML = state.tags.length
        ? state.tags.map((t) => `<label class="tag-pick"><input type="checkbox" value="${t.id}" ${current.has(String(t.id)) ? 'checked' : ''}><span class="tag-chip" style="--tc:${UI.escapeHtml(t.color)}">${UI.escapeHtml(t.name)}</span></label>`).join('')
        : '<p class="muted" style="font-size:13px">태그가 없습니다. 아래에서 추가하세요.</p>';
      m.el.querySelectorAll('#tp-list input').forEach((c) => c.addEventListener('change', () => { if (c.checked) current.add(c.value); else current.delete(c.value); }));
    }
    renderList();
    m.q('#tp-cancel').addEventListener('click', m.close);
    m.q('#tp-add').addEventListener('click', async () => {
      const name = m.q('#tp-new').value.trim(); if (!name) return;
      try { const t = await API.createTag({ name, color: m.q('#tp-color').value, ownerId: state.ownerId }); state.tags.push({ id: t.id, name: t.name, color: t.color, count: 0 }); state.tags.sort((a, b) => a.name.localeCompare(b.name, 'ko')); current.add(String(t.id)); m.q('#tp-new').value = ''; renderList(); }
      catch (e) { UI.toast(e.message, 'error'); }
    });
    m.q('#tp-save').addEventListener('click', async () => {
      try { await API.setFileTags(fileId, [...current].map(Number)); UI.toast('태그 저장됨', 'success'); m.close(); await loadFiles(true); }
      catch (e) { UI.toast(e.message, 'error'); }
    });
  }

  // ── 태그 관리 ──────────
  function tagManageModal() {
    const m = UI.modal(`<h3>🏷️ 태그 관리</h3><div id="tm-list"><p class="muted">불러오는 중…</p></div>
      <div class="field" style="margin-top:12px"><label>새 태그</label><div style="display:flex;gap:6px"><input class="input" id="tm-new" placeholder="이름" maxlength="40"><input type="color" id="tm-color" value="#118AB2" style="width:46px;padding:2px"><button class="btn btn-secondary btn-sm" id="tm-add">추가</button></div></div>
      <div class="modal-actions"><button class="btn btn-primary" id="tm-close">닫기</button></div>`);
    m.q('#tm-close').addEventListener('click', () => { m.close(); loadTags().then(() => { if (document.getElementById('listing')) renderListing(); }); });
    async function load() {
      try {
        const { tags } = await API.tags(state.ownerId); state.tags = tags;
        m.q('#tm-list').innerHTML = tags.length
          ? tags.map((t) => `<div class="tag-row"><span class="tag-chip" style="--tc:${UI.escapeHtml(t.color)}">${UI.escapeHtml(t.name)}</span><span class="muted" style="font-size:12px;margin-left:8px">${t.count}개</span><div style="flex:1"></div><button class="btn btn-sm btn-ghost" data-td="${t.id}">삭제</button></div>`).join('')
          : '<p class="muted" style="font-size:13px">태그가 없습니다.</p>';
        m.el.querySelectorAll('[data-td]').forEach((b) => b.addEventListener('click', async () => { if (!(await UI.confirm({ title: '태그 삭제', message: '이 태그를 삭제할까요? 파일에서도 제거됩니다.', danger: true, confirmText: '삭제' }))) return; try { await API.deleteTag(b.dataset.td, state.ownerId); load(); } catch (e) { UI.toast(e.message, 'error'); } }));
      } catch (e) { m.q('#tm-list').innerHTML = `<p class="muted" style="color:var(--danger)">${UI.escapeHtml(e.message)}</p>`; }
    }
    m.q('#tm-add').addEventListener('click', async () => { const name = m.q('#tm-new').value.trim(); if (!name) return; try { await API.createTag({ name, color: m.q('#tm-color').value, ownerId: state.ownerId }); m.q('#tm-new').value = ''; load(); } catch (e) { UI.toast(e.message, 'error'); } });
    load();
  }

  // ── 고급 검색 (유형·기간·크기·태그·즐겨찾기) ──────────
  function advancedSearchModal() {
    const m = UI.modal(`<h3>🔎 고급 검색</h3>
      <div class="field"><label>이름 포함</label><input class="input" id="as-q" placeholder="파일 이름"></div>
      <div class="field"><label>유형(확장자)</label><div class="ext-chip-grid" id="as-exts">${state.allowedExt.map((e) => `<label class="ext-chip"><input type="checkbox" value="${e}"><span class="ei">${UI.extIcon(e)}</span> .${UI.escapeHtml(e)}</label>`).join('')}</div></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div class="field"><label>등록일(부터)</label><input class="input" type="date" id="as-from"></div>
        <div class="field"><label>등록일(까지)</label><input class="input" type="date" id="as-to"></div>
        <div class="field"><label>최소 크기(MB)</label><input class="input" type="number" id="as-min" min="0" step="0.1"></div>
        <div class="field"><label>최대 크기(MB)</label><input class="input" type="number" id="as-max" min="0" step="0.1"></div>
      </div>
      <div class="field"><label>태그</label><select class="input" id="as-tag"><option value="">전체</option>${state.tags.map((t) => `<option value="${t.id}">${UI.escapeHtml(t.name)}</option>`).join('')}</select></div>
      <label class="autosort" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="as-fav"> ⭐ 즐겨찾기만</label>
      <div class="modal-actions"><button class="btn btn-ghost" id="as-cancel">취소</button><button class="btn btn-primary" id="as-go">검색</button></div>`);
    m.el.querySelector('.modal').classList.add('modal-wide');
    m.q('#as-cancel').addEventListener('click', m.close);
    m.q('#as-go').addEventListener('click', () => {
      const params = {
        q: m.q('#as-q').value.trim(),
        exts: [...m.el.querySelectorAll('#as-exts input:checked')].map((c) => c.value).join(','),
        dateFrom: m.q('#as-from').value, dateTo: m.q('#as-to').value,
        minSize: m.q('#as-min').value, maxSize: m.q('#as-max').value,
        tagId: m.q('#as-tag').value, favOnly: m.q('#as-fav').checked,
      };
      m.close(); runAdvancedSearch(params);
    });
  }
  function runAdvancedSearch(params) {
    API.searchAdvanced(params, state.ownerId).then((r) => {
      state.search = { on: true, q: params.q || '고급검색' };
      state.folders = r.folders || []; state.files = r.files || [];
      state.selected.clear(); state.anchor = null; renderContent();
    }).catch((e) => UI.toast(e.message, 'error'));
  }

  async function shareModal(id) {
    const f = state.files.find((x) => String(x.id) === String(id));
    const m = UI.modal(`<h3>🔗 공유 링크</h3><p class="muted" style="font-size:13px;margin-bottom:8px">${UI.escapeHtml(f ? f.name : '')}</p>${shareOptionFields()}<div class="modal-actions"><button class="btn btn-ghost" id="c">닫기</button><button class="btn btn-primary" id="gen">링크 생성</button></div><div id="result"></div>`);
    m.q('#c').addEventListener('click', m.close);
    m.q('#gen').addEventListener('click', (e) => UI.busy(e.currentTarget, async () => {
      try { const r = await API.share(id, shareOptionValues(m)); shareResult(m, r.url); }
      catch (err) { UI.toast(err.message, 'error'); }
    }));
  }

  function trashModal() {
    const oid = state.ownerId || undefined; // 담당자·관리자가 다른 계정 열람 중이면 그 계정의 휴지통
    const who = oid ? (state.ownerName ? `${state.ownerName} 계정 휴지통` : '열람 계정 휴지통') : '내 휴지통';
    const m = UI.modal(`<h3>🗑️ ${UI.escapeHtml(who)} <span class="muted" id="trash-sub" style="font-size:13px;font-weight:400"></span></h3><div id="trash-body"><p class="muted">불러오는 중…</p></div><div class="modal-actions"><button class="btn btn-danger" id="empty" style="margin-right:auto">휴지통 비우기</button><button class="btn btn-ghost" id="tc">닫기</button></div>`);
    m.el.querySelector('.modal').classList.add('modal-wide');
    m.q('#tc').addEventListener('click', m.close);
    let days = 30;
    const daysLeft = (iso) => Math.max(0, days - Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
    m.q('#empty').addEventListener('click', async () => {
      if (!(await UI.confirm({ title: '휴지통 비우기', danger: true, confirmText: '영구 삭제', message: '휴지통의 모든 항목을 영구 삭제합니다. 복원할 수 없습니다.' }))) return;
      try { await API.emptySelfTrash(oid); UI.toast('휴지통을 비웠습니다', 'success'); load(); loadAll(); } catch (e) { UI.toast(e.message, 'error'); }
    });
    async function purge(kind, id) {
      if (!(await UI.confirm({ title: '영구 삭제', danger: true, confirmText: '영구 삭제', message: '이 항목을 영구 삭제합니다. 복원할 수 없습니다.' }))) return;
      try { await (kind === 'folder' ? API.purgeSelfFolder(id, oid) : API.purgeSelfFile(id, oid)); UI.toast('영구 삭제됨', 'success'); load(); loadAll(); } catch (e) { UI.toast(e.message, 'error'); }
    }
    async function load() {
      try {
        const res = await API.selfTrash(oid); const { folders, files } = res; days = res.days || 30;
        m.q('#trash-sub').textContent = `· 최근 ${days}일 이내 복원 가능`;
        m.q('#empty').style.display = (folders.length || files.length) ? '' : 'none';
        if (!folders.length && !files.length) { m.q('#trash-body').innerHTML = '<p class="muted" style="text-align:center;padding:24px">휴지통이 비어 있습니다.</p>'; return; }
        const acts = (kind, id, restore) => `<button class="btn btn-sm btn-secondary" data-${restore}="${id}">복원</button> <button class="btn btn-sm btn-ghost" data-p${kind}="${id}" title="영구 삭제">🗑️</button>`;
        const frows = folders.map((f) => `<tr><td>📁 <b>${UI.escapeHtml(f.name)}</b> <span class="muted" style="font-size:12px">(${f.fileCount}개)</span><br><span class="muted" style="font-size:11px">${UI.escapeHtml(f.path)}</span></td><td class="num muted">${daysLeft(f.deletedAt)}일 남음</td><td style="text-align:right;white-space:nowrap">${acts('folder', f.id, 'rf')}</td></tr>`).join('');
        const rows = files.map((f) => `<tr><td>📄 ${UI.escapeHtml(f.name)}<br><span class="muted" style="font-size:11px">${UI.escapeHtml(f.folder)} · ${UI.bytes(f.size)}</span></td><td class="num muted">${daysLeft(f.deletedAt)}일 남음</td><td style="text-align:right;white-space:nowrap">${acts('file', f.id, 'rfile')}</td></tr>`).join('');
        m.q('#trash-body').innerHTML = `<div class="table-wrap"><table><tbody>${frows}${rows}</tbody></table></div>`;
        m.el.querySelectorAll('[data-rf]').forEach((b) => b.addEventListener('click', async () => { try { await API.restoreSelfFolder(b.dataset.rf, oid); UI.toast('폴더 복원됨', 'success'); load(); loadAll(); } catch (e) { UI.toast(e.message, 'error'); } }));
        m.el.querySelectorAll('[data-rfile]').forEach((b) => b.addEventListener('click', async () => { try { await API.restoreSelfFile(b.dataset.rfile, oid); UI.toast('파일 복원됨', 'success'); load(); loadAll(); } catch (e) { UI.toast(e.message, 'error'); } }));
        m.el.querySelectorAll('[data-pfolder]').forEach((b) => b.addEventListener('click', () => purge('folder', b.dataset.pfolder)));
        m.el.querySelectorAll('[data-pfile]').forEach((b) => b.addEventListener('click', () => purge('file', b.dataset.pfile)));
      } catch (e) { m.q('#trash-body').innerHTML = `<p class="muted" style="color:var(--danger)">${UI.escapeHtml(e.message)}</p>`; }
    }
    load();
  }

  // 서버(호스트 VM) 실시간 상태 — 일반 사용자 포함 전원 열람 가능. 열려 있는 동안 4초 폴링.
  function serverStatusModal() {
    const m = UI.modal(`<h3>🖥️ 서버 상태 <span class="muted" id="ss-time" style="font-size:12px;font-weight:400"></span></h3><div id="ss-body"><p class="muted">불러오는 중…</p></div><div class="modal-actions"><button class="btn btn-primary" id="ss-close">닫기</button></div>`);
    m.el.querySelector('.modal').classList.add('modal-wide');
    const stop = () => clearInterval(timer);
    m.q('#ss-close').addEventListener('click', () => { stop(); m.close(); });
    const dur = (s) => { s = Math.floor(s); const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), mi = Math.floor((s % 3600) / 60); return d ? `${d}일 ${h}시간` : h ? `${h}시간 ${mi}분` : `${mi}분`; };
    const bar = (label, pct, detail) => {
      const p = Math.max(0, Math.min(100, Math.round(pct)));
      const color = p >= 90 ? 'var(--danger)' : p >= 70 ? '#f0a500' : 'var(--accent)';
      return `<div class="ss-row"><div class="ss-head"><span>${label}</span><span class="num">${detail}</span></div><div class="ss-bar"><span style="width:${p}%;background:${color}"></span></div></div>`;
    };
    async function load() {
      if (!document.body.contains(m.el)) { stop(); return; } // 배경클릭·ESC 등으로 닫혔으면 폴링 종료
      try {
        const s = await API.serverStatus();
        m.q('#ss-time').textContent = '· ' + new Date(s.time).toLocaleTimeString('ko-KR');
        m.q('#ss-body').innerHTML =
          bar('CPU 부하', s.cpu.loadPct, `${s.cpu.loadPct}% · load ${s.cpu.load1.toFixed(2)} / ${s.cpu.cores}코어`) +
          bar('메모리', s.memory.usedPct, `${s.memory.usedPct}% · ${UI.bytes(s.memory.used)} / ${UI.bytes(s.memory.total)}`) +
          bar('디스크', s.disk.usedPct, `${s.disk.usedPct}% · ${UI.bytes(s.disk.used)} / ${UI.bytes(s.disk.total)}`) +
          `<div class="ss-meta">
            <div><span class="muted">서버 가동</span><b>${dur(s.uptime.server)}</b></div>
            <div><span class="muted">서비스 가동</span><b>${dur(s.uptime.process)}</b></div>
            <div><span class="muted">데이터베이스</span><b style="color:${s.db.connected ? 'var(--accent)' : 'var(--danger)'}">${s.db.connected ? '정상' : '끊김'}</b></div>
          </div>`;
      } catch (e) { m.q('#ss-body').innerHTML = `<p class="muted" style="color:var(--danger)">${UI.escapeHtml(e.message)}</p>`; }
    }
    load();
    const timer = setInterval(load, 4000);
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
  let notifTimer = null, lastUnread = -1, visHooked = false, resizeHooked = false, lastMobile = null, backHooked = false;
  async function refreshNotifBadge() {
    try {
      const d = await API.notifications(1);
      const badges = [document.getElementById('notif-badge'), document.getElementById('notif-badge-menu'), document.getElementById('notif-badge-tab')].filter(Boolean);
      if (!badges.length) return;
      badges.forEach((badge) => {
        if (d.unread > 0) { badge.textContent = d.unread > 99 ? '99+' : d.unread; badge.classList.remove('hidden'); }
        else badge.classList.add('hidden');
      });
      // 새 알림이 늘었으면 토스트로만 알림(목록 자동 새로고침 없음 → 상단 🔄 버튼으로 수동)
      if (lastUnread >= 0 && d.unread > lastUnread) UI.toast(`🔔 새 알림 ${d.unread - lastUnread}건 · 🔄로 새로고침`, 'info');
      lastUnread = d.unread;
    } catch {}
  }
  function startNotifPolling() {
    if (notifTimer) clearInterval(notifTimer);
    notifTimer = setInterval(refreshNotifBadge, 30000);      // 알림 배지 30초 폴링(목록 자동 새로고침은 없음)
    if (!visHooked) { visHooked = true; document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshNotifBadge(); }); }
    if (!resizeHooked) {
      resizeHooked = true; lastMobile = isMobile();
      window.addEventListener('resize', () => {
        const m = isMobile(); if (m === lastMobile) return; lastMobile = m; // 브레이크포인트 넘을 때만 다시 그림
        if (state.user && document.getElementById('listing')) renderListing();
      });
    }
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
