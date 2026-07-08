/* 북적북적 관리자 페이지 */
const Admin = (() => {
  const state = { user: null, tab: 'users', users: [] };
  const root = () => document.getElementById('app');

  async function boot() {
    if (!API.hasToken()) return (location.href = 'index.html');
    try {
      const { user } = await API.me();
      if (user.role !== 'admin') { UI.toast('관리자만 접근할 수 있습니다', 'error'); return (location.href = 'index.html'); }
      state.user = user;
      renderShell();
      loadUsers();
    } catch {
      location.href = 'index.html';
    }
  }

  function renderShell() {
    root().innerHTML = `
      <div class="app">
        <aside class="sidebar">
          <div class="brand"><img src="assets/logo.svg"><span class="brand-name">북적북적</span></div>
          <div class="nav-item ${state.tab === 'users' ? 'active' : ''}" data-tab="users"><span class="ico">👥</span> 계정 관리</div>
          <div class="nav-item ${state.tab === 'db' ? 'active' : ''}" data-tab="db"><span class="ico">🗄️</span> DB 상태</div>
          <div class="nav-item ${state.tab === 'audit' ? 'active' : ''}" data-tab="audit"><span class="ico">📜</span> 감사 로그</div>
          <a class="nav-item" href="index.html"><span class="ico">📁</span> 파일로 돌아가기</a>
          <div class="sidebar-spacer"></div>
          <div class="user-chip"><b>${UI.escapeHtml(state.user.displayName)}</b><span>관리자</span></div>
        </aside>
        <main class="main">
          <div class="mobile-topbar">
            <img src="assets/logo.svg"><span class="brand-name">관리자</span>
            <div class="topbar-spacer"></div>
            <a class="btn btn-ghost btn-sm" href="index.html">📁</a>
          </div>
          <header class="topbar"><h1 id="page-title">계정 관리</h1></header>
          <div class="content" id="view"></div>
          <nav class="mobile-nav">
            <div class="m-item ${state.tab === 'users' ? 'active' : ''}" data-tab="users"><span class="ico">👥</span>계정</div>
            <div class="m-item ${state.tab === 'db' ? 'active' : ''}" data-tab="db"><span class="ico">🗄️</span>DB</div>
            <div class="m-item ${state.tab === 'audit' ? 'active' : ''}" data-tab="audit"><span class="ico">📜</span>로그</div>
          </nav>
        </main>
      </div>`;
    root().querySelectorAll('[data-tab]').forEach((el) => el.addEventListener('click', () => switchTab(el.dataset.tab)));
  }

  function switchTab(tab) {
    state.tab = tab;
    renderShell();
    if (tab === 'users') loadUsers();
    else if (tab === 'db') loadDb();
    else if (tab === 'audit') loadAudit();
    const titles = { users: '계정 관리', db: 'DB 상태', audit: '감사 로그' };
    document.getElementById('page-title').textContent = titles[tab];
  }

  // ── 계정 관리 ──────────────────────────
  async function loadUsers() {
    const view = document.getElementById('view');
    view.innerHTML = '<div class="empty"><div class="big">⏳</div>불러오는 중…</div>';
    try {
      const { users } = await API.adminUsers();
      state.users = users;
      renderUsers();
    } catch (err) { view.innerHTML = `<div class="empty">⚠️ ${UI.escapeHtml(err.message)}</div>`; }
  }

  function renderUsers() {
    const view = document.getElementById('view');
    const rows = state.users.map((u) => `
      <tr>
        <td><b>${UI.escapeHtml(u.username)}</b><br><span style="color:var(--text-muted);font-size:12px">${UI.escapeHtml(u.displayName)}</span></td>
        <td><span class="badge ${u.role}">${u.role === 'admin' ? '관리자' : '일반'}</span></td>
        <td><span class="badge ${u.isActive ? 'on' : 'off'}">${u.isActive ? '활성' : '정지'}</span></td>
        <td class="num">${u.fileCount}개 · ${UI.bytes(u.usedBytes)}${u.quotaBytes > 0 ? ' / ' + UI.bytes(u.quotaBytes) : ''}</td>
        <td style="text-align:right">
          <button class="btn btn-sm btn-ghost" data-view-files="${u.id}" data-name="${UI.escapeHtml(u.displayName)}">📁 열람</button>
          <button class="btn btn-sm btn-ghost" data-pw="${u.id}">🔑 암호</button>
          <button class="btn btn-sm btn-ghost" data-edit="${u.id}">✏️</button>
          ${u.id !== state.user.id ? `<button class="btn btn-sm btn-danger" data-del="${u.id}">🗑️</button>` : ''}
        </td>
      </tr>`).join('');

    view.innerHTML = `
      <div class="toolbar">
        <div style="flex:1"></div>
        <button class="btn btn-primary" id="add-user">＋ 계정 발급</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>계정</th><th>권한</th><th>상태</th><th>사용량</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

    document.getElementById('add-user').addEventListener('click', createUserModal);
    view.querySelectorAll('[data-view-files]').forEach((el) => el.addEventListener('click', () =>
      location.href = `index.html?ownerId=${el.dataset.viewFiles}&name=${encodeURIComponent(el.dataset.name)}`));
    view.querySelectorAll('[data-pw]').forEach((el) => el.addEventListener('click', () => passwordModal(el.dataset.pw)));
    view.querySelectorAll('[data-edit]').forEach((el) => el.addEventListener('click', () => editUserModal(el.dataset.edit)));
    view.querySelectorAll('[data-del]').forEach((el) => el.addEventListener('click', () => deleteUser(el.dataset.del)));
  }

  function createUserModal() {
    const m = UI.modal(`
      <h3>새 계정 발급</h3>
      <div class="field"><label>아이디 (영소문자/숫자)</label><input class="input" id="username" placeholder="예: hong.gd"></div>
      <div class="field"><label>표시 이름</label><input class="input" id="displayName" placeholder="예: 홍길동"></div>
      <div class="field"><label>초기 비밀번호 (비우면 자동 생성)</label><input class="input" id="password" placeholder="자동 생성"></div>
      <div class="field"><label>권한</label>
        <select class="input" id="role"><option value="user">일반</option><option value="admin">관리자</option></select>
      </div>
      <div class="field"><label>할당량 (GB, 0=무제한)</label><input class="input num" id="quota" type="number" value="0" min="0"></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="cancel">취소</button>
        <button class="btn btn-primary" id="ok">발급</button>
      </div>`);
    m.q('#cancel').addEventListener('click', m.close);
    m.q('#ok').addEventListener('click', async () => {
      try {
        const res = await API.createUser({
          username: m.q('#username').value.trim(),
          displayName: m.q('#displayName').value.trim(),
          password: m.q('#password').value.trim(),
          role: m.q('#role').value,
          quotaBytes: Math.round((parseFloat(m.q('#quota').value) || 0) * 1024 * 1024 * 1024),
        });
        m.close();
        showSecret('계정 발급 완료', `아이디: ${res.username}`, res.password);
        loadUsers();
      } catch (err) { UI.toast(err.message, 'error'); }
    });
  }

  async function passwordModal(id) {
    try {
      const { username, password } = await API.viewPassword(id);
      const m = UI.modal(`
        <h3>🔑 ${UI.escapeHtml(username)} 비밀번호</h3>
        <div class="secret-box">${UI.escapeHtml(password)}</div>
        <p style="font-size:12px;color:var(--text-muted);margin-top:10px">
          이 열람 기록은 감사 로그에 남습니다. 아래에서 새 비밀번호로 재설정할 수도 있습니다.
        </p>
        <div class="field" style="margin-top:14px"><label>새 비밀번호로 재설정 (선택)</label>
          <input class="input" id="newpw" placeholder="비우면 자동 생성"></div>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="cancel">닫기</button>
          <button class="btn btn-secondary" id="reset">재설정</button>
        </div>`);
      m.q('#cancel').addEventListener('click', m.close);
      m.q('#reset').addEventListener('click', async () => {
        try {
          const res = await API.resetPassword(id, m.q('#newpw').value.trim());
          m.close();
          showSecret('비밀번호 재설정 완료', `아이디: ${username}`, res.password);
        } catch (err) { UI.toast(err.message, 'error'); }
      });
    } catch (err) { UI.toast(err.message, 'error'); }
  }

  function editUserModal(id) {
    const u = state.users.find((x) => String(x.id) === String(id));
    const m = UI.modal(`
      <h3>계정 수정 — ${UI.escapeHtml(u.username)}</h3>
      <div class="field"><label>표시 이름</label><input class="input" id="dn" value="${UI.escapeHtml(u.displayName)}"></div>
      <div class="field"><label>권한</label>
        <select class="input" id="role"><option value="user" ${u.role === 'user' ? 'selected' : ''}>일반</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>관리자</option></select></div>
      <div class="field"><label>상태</label>
        <select class="input" id="active"><option value="true" ${u.isActive ? 'selected' : ''}>활성</option><option value="false" ${!u.isActive ? 'selected' : ''}>정지</option></select></div>
      <div class="field"><label>할당량 (GB, 0=무제한)</label><input class="input num" id="quota" type="number" min="0" value="${u.quotaBytes > 0 ? (u.quotaBytes / 1024 / 1024 / 1024).toFixed(1) : 0}"></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="cancel">취소</button>
        <button class="btn btn-primary" id="ok">저장</button>
      </div>`);
    m.q('#cancel').addEventListener('click', m.close);
    m.q('#ok').addEventListener('click', async () => {
      try {
        await API.updateUser(id, {
          displayName: m.q('#dn').value.trim(),
          role: m.q('#role').value,
          isActive: m.q('#active').value === 'true',
          quotaBytes: Math.round((parseFloat(m.q('#quota').value) || 0) * 1024 * 1024 * 1024),
        });
        m.close(); UI.toast('저장되었습니다', 'success'); loadUsers();
      } catch (err) { UI.toast(err.message, 'error'); }
    });
  }

  async function deleteUser(id) {
    const u = state.users.find((x) => String(x.id) === String(id));
    if (!confirm(`'${u.username}' 계정과 모든 파일을 삭제합니다. 계속할까요?`)) return;
    try { await API.deleteUser(id); UI.toast('삭제되었습니다', 'success'); loadUsers(); }
    catch (err) { UI.toast(err.message, 'error'); }
  }

  function showSecret(title, sub, secret) {
    const m = UI.modal(`
      <h3>${title}</h3>
      <p style="color:var(--text-muted);font-size:14px;margin-bottom:10px">${UI.escapeHtml(sub)}</p>
      <div class="secret-box">${UI.escapeHtml(secret)}</div>
      <p style="font-size:12px;color:var(--text-muted);margin-top:10px">이 비밀번호를 안전하게 전달하세요. 관리자 페이지에서 언제든 다시 열람할 수 있습니다.</p>
      <div class="modal-actions"><button class="btn btn-primary" id="ok">확인</button></div>`);
    m.q('#ok').addEventListener('click', m.close);
  }

  // ── DB 상태 ──────────────────────────
  async function loadDb() {
    const view = document.getElementById('view');
    view.innerHTML = '<div class="empty"><div class="big">⏳</div>확인 중…</div>';
    try {
      const s = await API.dbStatus();
      const tables = (s.tables || []).map((t) => `<tr><td>${UI.escapeHtml(t.table)}</td><td class="num">${t.rows.toLocaleString()}</td></tr>`).join('');
      view.innerHTML = `
        <div class="stat-grid">
          <div class="stat"><div class="k">연결 상태</div><div class="v"><span class="dot ok"></span>정상</div></div>
          <div class="stat"><div class="k">데이터베이스</div><div class="v" style="font-size:20px">${UI.escapeHtml(s.database)}</div></div>
          <div class="stat"><div class="k">DB 크기</div><div class="v">${UI.bytes(s.sizeBytes)}</div></div>
          <div class="stat"><div class="k">활성 연결</div><div class="v">${s.activeConnections}</div></div>
        </div>
        <div class="card">
          <h3 style="margin-bottom:12px">테이블별 행 수</h3>
          <div class="table-wrap"><table><thead><tr><th>테이블</th><th>행 수</th></tr></thead><tbody>${tables || '<tr><td colspan=2>데이터 없음</td></tr>'}</tbody></table></div>
          <p style="font-size:12px;color:var(--text-muted);margin-top:12px">서버 시각: ${s.serverTime}</p>
        </div>`;
    } catch (err) {
      view.innerHTML = `<div class="card"><div class="stat"><div class="k">연결 상태</div><div class="v"><span class="dot bad"></span>오류</div></div><p style="color:var(--danger);margin-top:8px">${UI.escapeHtml(err.message)}</p></div>`;
    }
  }

  // ── 감사 로그 ──────────────────────────
  async function loadAudit() {
    const view = document.getElementById('view');
    view.innerHTML = '<div class="empty"><div class="big">⏳</div>불러오는 중…</div>';
    try {
      const { logs } = await API.audit(100);
      const rows = logs.map((l) => `
        <tr>
          <td class="num" style="color:var(--text-muted)">${new Date(l.created_at).toLocaleString('ko-KR')}</td>
          <td>${UI.escapeHtml(l.username || '—')}</td>
          <td><span class="badge user">${UI.escapeHtml(l.action)}</span></td>
          <td style="color:var(--text-muted)">${UI.escapeHtml(l.detail)}</td>
          <td class="num" style="color:var(--text-muted)">${UI.escapeHtml(l.ip)}</td>
        </tr>`).join('');
      view.innerHTML = `<div class="table-wrap"><table><thead><tr><th>시각</th><th>사용자</th><th>동작</th><th>상세</th><th>IP</th></tr></thead><tbody>${rows || '<tr><td colspan=5>기록 없음</td></tr>'}</tbody></table></div>`;
    } catch (err) { view.innerHTML = `<div class="empty">⚠️ ${UI.escapeHtml(err.message)}</div>`; }
  }

  return { boot };
})();

document.addEventListener('DOMContentLoaded', Admin.boot);
