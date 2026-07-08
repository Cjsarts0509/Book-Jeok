/* 북적북적 메인 앱 — 파일 웹하드 */
const App = (() => {
  const state = {
    user: null,
    folder: '/',
    ownerId: null,        // 관리자가 다른 계정 열람 시 대상 id
    ownerName: null,
    files: [],
    folders: [],
    usage: null,
  };

  const root = () => document.getElementById('app');

  // ── 진입점 ──────────────────────────────
  async function boot() {
    if (API.hasToken()) {
      try {
        const { user } = await API.me();
        state.user = user;
        return renderApp();
      } catch {
        API.setToken(null);
      }
    }
    renderLogin();
  }

  // ── 로그인 ──────────────────────────────
  function renderLogin() {
    root().innerHTML = `
      <div class="login-screen">
        <form class="login-card" id="login-form">
          <img src="assets/logo.svg" class="login-logo" alt="북적북적">
          <div class="login-title">북적북적</div>
          <div class="login-sub">Book-Jeok · 우리끼리 나누는 파일 창고</div>
          <div class="field">
            <label>아이디</label>
            <input class="input" name="username" autocomplete="username" placeholder="아이디" required>
          </div>
          <div class="field">
            <label>비밀번호</label>
            <input class="input" name="password" type="password" autocomplete="current-password" placeholder="비밀번호" required>
          </div>
          <button class="btn btn-primary" style="width:100%;margin-top:6px" type="submit">로그인</button>
        </form>
      </div>`;
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const btn = f.querySelector('button');
      btn.disabled = true; btn.textContent = '로그인 중…';
      try {
        const { token, user } = await API.login(f.username.value.trim(), f.password.value);
        API.setToken(token);
        state.user = user;
        UI.toast(`${user.displayName}님 환영합니다 🎉`, 'success');
        renderApp();
      } catch (err) {
        UI.toast(err.message, 'error');
        btn.disabled = false; btn.textContent = '로그인';
      }
    });
  }

  // ── 앱 셸 ──────────────────────────────
  function renderApp() {
    const isAdmin = state.user.role === 'admin';
    root().innerHTML = `
      <div class="app">
        <aside class="sidebar">
          <div class="brand"><img src="assets/logo.svg"><span class="brand-name">북적북적</span></div>
          <div class="nav-item active" data-nav="files"><span class="ico">📁</span> 내 파일</div>
          ${isAdmin ? '<a class="nav-item" href="admin.html"><span class="ico">⚙️</span> 관리자</a>' : ''}
          <div class="nav-item" data-nav="password"><span class="ico">🔑</span> 비밀번호 변경</div>
          <div class="sidebar-spacer"></div>
          <div class="user-chip">
            <b>${UI.escapeHtml(state.user.displayName)}</b>
            <span>@${UI.escapeHtml(state.user.username)} · ${isAdmin ? '관리자' : '일반'}</span>
          </div>
          <div class="nav-item" data-nav="logout" style="margin-top:6px"><span class="ico">🚪</span> 로그아웃</div>
        </aside>

        <main class="main">
          <header class="topbar">
            <h1>내 파일</h1>
            <div class="topbar-spacer"></div>
            <button class="btn btn-ghost btn-sm" data-nav="refresh">🔄 새로고침</button>
          </header>

          <!-- 모바일 상단바 -->
          <div class="mobile-topbar">
            <img src="assets/logo.svg"><span class="brand-name">북적북적</span>
            <div class="topbar-spacer"></div>
            <button class="btn btn-ghost btn-sm" data-nav="password">🔑</button>
            ${isAdmin ? '<a class="btn btn-ghost btn-sm" href="admin.html">⚙️</a>' : ''}
          </div>

          <div class="content" id="view"></div>

          <!-- 모바일 하단 네비 -->
          <nav class="mobile-nav">
            <div class="m-item active" data-nav="files"><span class="ico">📁</span>파일</div>
            <div class="m-fab" data-nav="upload">＋</div>
            <div class="m-item" data-nav="logout"><span class="ico">🚪</span>로그아웃</div>
          </nav>
        </main>
      </div>`;

    root().querySelectorAll('[data-nav]').forEach((el) => {
      el.addEventListener('click', (e) => {
        const nav = el.dataset.nav;
        if (nav === 'logout') { doLogout(); }
        else if (nav === 'password') { changePasswordModal(); }
        else if (nav === 'refresh' || nav === 'files') { loadFiles(); }
        else if (nav === 'upload') { document.getElementById('file-input')?.click(); }
      });
    });

    loadFiles();
  }

  async function doLogout() {
    try { await API.logout(); } catch {}
    API.setToken(null);
    state.user = null;
    renderLogin();
  }

  // ── 파일 뷰 ──────────────────────────────
  async function loadFiles() {
    const view = document.getElementById('view');
    view.innerHTML = '<div class="empty"><div class="big">⏳</div>불러오는 중…</div>';
    try {
      const [list, usage] = await Promise.all([
        API.listFiles(state.folder, state.ownerId),
        API.usage(state.ownerId),
      ]);
      state.files = list.files;
      state.folders = list.folders;
      state.usage = usage;
      renderFiles();
    } catch (err) {
      view.innerHTML = `<div class="empty"><div class="big">⚠️</div>${UI.escapeHtml(err.message)}</div>`;
    }
  }

  function renderFiles() {
    const view = document.getElementById('view');
    const usage = state.usage;
    const pct = usage.quotaBytes > 0 ? Math.min(100, (usage.usedBytes / usage.quotaBytes) * 100) : 0;
    const crumbs = buildCrumbs();

    view.innerHTML = `
      ${state.ownerId ? `
        <div class="impersonate-banner">
          👁️ 관리자 열람: <b>${UI.escapeHtml(state.ownerName || '')}</b> 계정의 파일
          <div style="flex:1"></div>
          <button class="btn btn-sm btn-secondary" id="exit-impersonate">내 파일로 돌아가기</button>
        </div>` : ''}

      <div class="card" style="margin-bottom:18px">
        <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px">
          <div>
            <div style="font-size:13px;color:var(--text-muted);font-weight:600">저장 사용량</div>
            <div style="font-size:20px;font-weight:800" class="num">
              ${UI.bytes(usage.usedBytes)}
              <span style="font-size:13px;color:var(--text-muted);font-weight:600">
                ${usage.quotaBytes > 0 ? '/ ' + UI.bytes(usage.quotaBytes) : '· 무제한'} · ${usage.fileCount}개 파일
              </span>
            </div>
          </div>
        </div>
        ${usage.quotaBytes > 0 ? `<div class="usage-bar"><span style="width:${pct}%"></span></div>` : ''}
      </div>

      <div class="toolbar">
        <div class="breadcrumb">${crumbs}</div>
        <div style="flex:1"></div>
        <button class="btn btn-secondary btn-sm" id="new-folder">📂 <span class="label">새 폴더</span></button>
        <button class="btn btn-primary btn-sm" id="upload-btn">⬆️ <span class="label">업로드</span></button>
      </div>

      <label class="dropzone" id="dropzone" for="file-input">
        <div class="big">📥</div>
        <div>여기로 파일을 끌어다 놓거나 클릭해서 업로드</div>
        <input type="file" id="file-input" multiple hidden>
      </label>

      <div id="grid"></div>`;

    renderGrid();
    wireFileEvents();
  }

  function buildCrumbs() {
    const parts = state.folder.split('/').filter(Boolean);
    let acc = '';
    let html = `<span data-folder="/">🏠 홈</span>`;
    for (const p of parts) {
      acc += '/' + p;
      html += `<span class="sep">/</span><span data-folder="${acc}">${UI.escapeHtml(p)}</span>`;
    }
    return html;
  }

  function renderGrid() {
    const grid = document.getElementById('grid');
    if (state.folders.length === 0 && state.files.length === 0) {
      grid.innerHTML = `<div class="empty"><div class="big">🗂️</div>아직 파일이 없어요. 첫 파일을 올려보세요!</div>`;
      return;
    }
    const folderCards = state.folders.map((f) => {
      const name = f.split('/').pop();
      return `<div class="file-card" data-open-folder="${UI.escapeHtml(f)}">
        <div class="file-ico">📁</div>
        <div class="file-name">${UI.escapeHtml(name)}</div>
        <div class="file-meta">폴더</div>
      </div>`;
    }).join('');
    const fileCards = state.files.map((f) => `
      <div class="file-card">
        <div class="file-actions">
          <button class="icon-btn" data-dl="${f.id}" title="다운로드">⬇️</button>
          <button class="icon-btn" data-del="${f.id}" title="삭제">🗑️</button>
        </div>
        <div class="file-ico">${UI.fileIcon(f.name)}</div>
        <div class="file-name">${UI.escapeHtml(f.name)}</div>
        <div class="file-meta num">${UI.bytes(f.size)} · ${UI.date(f.createdAt)}</div>
      </div>`).join('');
    grid.innerHTML = `<div class="file-grid">${folderCards}${fileCards}</div>`;

    grid.querySelectorAll('[data-open-folder]').forEach((el) =>
      el.addEventListener('click', () => { state.folder = el.dataset.openFolder; loadFiles(); }));
    grid.querySelectorAll('[data-dl]').forEach((el) =>
      el.addEventListener('click', () => downloadFile(el.dataset.dl)));
    grid.querySelectorAll('[data-del]').forEach((el) =>
      el.addEventListener('click', () => deleteFile(el.dataset.del)));
  }

  function wireFileEvents() {
    document.querySelectorAll('.breadcrumb [data-folder]').forEach((el) =>
      el.addEventListener('click', () => { state.folder = el.dataset.folder; loadFiles(); }));

    document.getElementById('exit-impersonate')?.addEventListener('click', () => {
      state.ownerId = null; state.ownerName = null; state.folder = '/'; loadFiles();
    });

    const input = document.getElementById('file-input');
    const dz = document.getElementById('dropzone');
    document.getElementById('upload-btn').addEventListener('click', () => input.click());
    input.addEventListener('change', () => { if (input.files.length) uploadFiles(input.files); });

    ['dragover', 'dragenter'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', (e) => { if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files); });

    document.getElementById('new-folder').addEventListener('click', newFolderModal);
  }

  async function uploadFiles(fileList) {
    const fd = new FormData();
    fd.append('folder', state.folder);
    if (state.ownerId) fd.append('ownerId', state.ownerId);
    [...fileList].forEach((f) => fd.append('file', f));
    UI.toast(`${fileList.length}개 파일 업로드 중…`);
    try {
      await API.upload(fd);
      UI.toast('업로드 완료 ✅', 'success');
      loadFiles();
    } catch (err) {
      UI.toast(err.message, 'error');
    }
  }

  function downloadFile(id) {
    // 인증 헤더가 필요하므로 fetch → blob 방식
    const url = API.downloadUrl(id);
    fetch(url, { headers: API.hasToken() ? { Authorization: 'Bearer ' + localStorage.getItem('bj_token') } : {}, credentials: 'include' })
      .then((r) => { if (!r.ok) throw new Error('다운로드 실패'); return r.blob().then((b) => ({ b, r })); })
      .then(({ b, r }) => {
        const cd = r.headers.get('content-disposition') || '';
        const m = /filename\*?=(?:UTF-8'')?["']?([^"';]+)/i.exec(cd);
        const name = m ? decodeURIComponent(m[1]) : 'download';
        const a = document.createElement('a');
        a.href = URL.createObjectURL(b); a.download = name; a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch((err) => UI.toast(err.message, 'error'));
  }

  async function deleteFile(id) {
    if (!confirm('이 파일을 삭제할까요?')) return;
    try {
      await API.deleteFile(id);
      UI.toast('삭제되었습니다', 'success');
      loadFiles();
    } catch (err) { UI.toast(err.message, 'error'); }
  }

  function newFolderModal() {
    const m = UI.modal(`
      <h3>새 폴더 만들기</h3>
      <div class="field"><label>폴더 이름</label><input class="input" id="fname" placeholder="예: 2026-보고서"></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="cancel">취소</button>
        <button class="btn btn-primary" id="ok">만들기</button>
      </div>`);
    m.q('#cancel').addEventListener('click', m.close);
    m.q('#ok').addEventListener('click', () => {
      const name = m.q('#fname').value.trim().replace(/\//g, '');
      if (!name) return;
      // 폴더는 파일 업로드 시 경로로 생성됨 → 즉시 이동
      state.folder = (state.folder === '/' ? '' : state.folder) + '/' + name;
      m.close();
      UI.toast('폴더로 이동했어요. 파일을 올리면 폴더가 저장됩니다.', '');
      renderFiles();
    });
  }

  function changePasswordModal() {
    const m = UI.modal(`
      <h3>비밀번호 변경</h3>
      <div class="field"><label>현재 비밀번호</label><input class="input" type="password" id="cur"></div>
      <div class="field"><label>새 비밀번호 (8자 이상)</label><input class="input" type="password" id="nw"></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="cancel">취소</button>
        <button class="btn btn-primary" id="ok">변경</button>
      </div>`);
    m.q('#cancel').addEventListener('click', m.close);
    m.q('#ok').addEventListener('click', async () => {
      try {
        await API.changePassword(m.q('#cur').value, m.q('#nw').value);
        UI.toast('비밀번호가 변경되었습니다 🔐', 'success');
        m.close();
      } catch (err) { UI.toast(err.message, 'error'); }
    });
  }

  // 관리자 페이지에서 특정 계정 파일 열람 진입 (URL: index.html?ownerId=3&name=xxx)
  function checkImpersonate() {
    const p = new URLSearchParams(location.search);
    if (p.get('ownerId')) {
      state.ownerId = p.get('ownerId');
      state.ownerName = p.get('name') || '';
    }
  }

  return { boot, checkImpersonate };
})();

document.addEventListener('DOMContentLoaded', () => {
  App.checkImpersonate();
  App.boot();
});
