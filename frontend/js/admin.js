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
    const item = (tab, ico, label) => `<div class="nav-item ${state.tab === tab ? 'active' : ''}" data-tab="${tab}"><span class="ico">${ico}</span><span class="t">${label}</span></div>`;
    root().innerHTML = `
      <div class="layout">
        <header class="appbar">
          <a class="brand" href="index.html" title="홈으로"><img src="assets/logo.svg?v=19"><span class="brand-name">북적북적</span></a>
          <nav class="appbar-nav">
            ${item('users', '👥', '계정')}
            ${item('branches', '🏢', '영업점')}
            ${item('notices', '📢', '공지')}
            ${item('ext', '🧩', '확장자')}
            ${item('trash', '🗑️', '휴지통')}
            ${item('db', '🗄️', 'DB')}
            ${item('audit', '📜', '로그')}
            ${item('manual', '📖', '매뉴얼')}
            <a class="nav-item" href="index.html"><span class="ico">📁</span><span class="t">파일로</span></a>
          </nav>
          <div class="topbar-spacer"></div>
          <div class="user-chip-sm">${UI.escapeHtml(state.user.displayName)} · 관리자</div>
        </header>
        <main class="content admin-content">
          <h1 class="admin-title" id="page-title">계정 관리</h1>
          <div id="view"></div>
        </main>
      </div>`;
    root().querySelectorAll('[data-tab]').forEach((el) => el.addEventListener('click', () => switchTab(el.dataset.tab)));
  }

  function switchTab(tab) {
    state.tab = tab;
    renderShell();
    if (tab === 'users') loadUsers();
    else if (tab === 'branches') loadBranches();
    else if (tab === 'notices') loadNotices();
    else if (tab === 'ext') loadExt();
    else if (tab === 'trash') loadTrash();
    else if (tab === 'db') loadDb();
    else if (tab === 'audit') loadAudit();
    else if (tab === 'manual') loadManual();
    const titles = { users: '계정 관리', branches: '영업점 관리', notices: '공지사항', ext: '허용 확장자', trash: '휴지통', db: 'DB 상태', audit: '감사 로그', manual: '사용자 매뉴얼' };
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
        <td><span class="badge ${u.role}">${({admin:'관리자',manager:'담당자',user:'일반'})[u.role] || u.role}</span></td>
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

  async function createUserModal() {
    let disk = { availableBytes: 0, totalBytes: 0 };
    try { disk = await API.diskInfo(); } catch {}
    const m = UI.modal(`
      <h3>새 계정 발급</h3>
      <div class="field"><label>아이디 (영소문자/숫자)</label><input class="input" id="username" placeholder="예: hong.gd"></div>
      <div class="field"><label>표시 이름</label><input class="input" id="displayName" placeholder="예: 홍길동"></div>
      <div class="field"><label>초기 비밀번호 (비우면 자동 생성)</label><input class="input" type="password" id="password" placeholder="자동 생성"></div>
      <div class="field"><label>비밀번호 확인 (직접 입력 시)</label><input class="input" type="password" id="password2"><span class="pw-match muted" id="match"></span></div>
      <div class="field"><label>권한</label>
        <select class="input" id="role">
          <option value="user">일반 (본인 파일만)</option>
          <option value="manager">담당자 (일반 사용자 파일 열람·업로드, 관리기능 제외)</option>
          <option value="admin">관리자 (전체 + 관리기능, 무제한)</option>
        </select>
      </div>
      <div class="field" id="quota-field"><label>디스크 할당 (GB, 0=미할당)</label>
        <input class="input num" id="quota" type="number" value="0" min="0" step="0.1">
        <span class="muted" style="font-size:12px">할당 가능(남은) 용량: <b>${UI.bytes(disk.availableBytes)}</b> / 전체 ${UI.bytes(disk.totalBytes)}</span></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="cancel">취소</button>
        <button class="btn btn-primary" id="ok">발급</button>
      </div>`);
    const roleSel = m.q('#role'), quotaField = m.q('#quota-field');
    const syncRole = () => { const admin = roleSel.value === 'admin'; quotaField.style.display = admin ? 'none' : ''; };
    roleSel.addEventListener('change', () => m.animate(syncRole)); syncRole();
    const check = () => { const a = m.q('#password').value, b = m.q('#password2').value; const el = m.q('#match'); if (!a && !b) { el.textContent = ''; return; } if (a === b) { el.textContent = '✓ 일치'; el.className = 'pw-match ok'; } else { el.textContent = '✗ 불일치'; el.className = 'pw-match bad'; } };
    m.q('#password').addEventListener('input', check); m.q('#password2').addEventListener('input', check);
    m.q('#cancel').addEventListener('click', m.close);
    m.q('#ok').addEventListener('click', async () => {
      const pw = m.q('#password').value.trim();
      if (pw && pw !== m.q('#password2').value.trim()) return UI.toast('비밀번호가 일치하지 않습니다', 'error');
      try {
        const res = await API.createUser({
          username: m.q('#username').value.trim(),
          displayName: m.q('#displayName').value.trim(),
          password: pw,
          role: roleSel.value,
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
        <div class="field" style="margin-top:14px"><label>새 비밀번호로 재설정 (비우면 자동 생성)</label>
          <input class="input" type="password" id="newpw" placeholder="자동 생성"></div>
        <div class="field"><label>새 비밀번호 확인 (직접 입력 시)</label>
          <input class="input" type="password" id="newpw2"><span class="pw-match muted" id="match"></span></div>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="cancel">닫기</button>
          <button class="btn btn-secondary" id="reset">재설정</button>
        </div>`);
      const check = () => { const a = m.q('#newpw').value, b = m.q('#newpw2').value; const el = m.q('#match'); if (!a && !b) { el.textContent = ''; return; } if (a === b) { el.textContent = '✓ 일치'; el.className = 'pw-match ok'; } else { el.textContent = '✗ 불일치'; el.className = 'pw-match bad'; } };
      m.q('#newpw').addEventListener('input', check); m.q('#newpw2').addEventListener('input', check);
      m.q('#cancel').addEventListener('click', m.close);
      m.q('#reset').addEventListener('click', async () => {
        const pw = m.q('#newpw').value.trim();
        if (pw && pw !== m.q('#newpw2').value.trim()) return UI.toast('비밀번호가 일치하지 않습니다', 'error');
        try {
          const res = await API.resetPassword(id, pw);
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
        <select class="input" id="role">
          <option value="user" ${u.role === 'user' ? 'selected' : ''}>일반</option>
          <option value="manager" ${u.role === 'manager' ? 'selected' : ''}>담당자</option>
          <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>관리자</option>
        </select></div>
      <div class="field"><label>상태</label>
        <select class="input" id="active"><option value="true" ${u.isActive ? 'selected' : ''}>활성</option><option value="false" ${!u.isActive ? 'selected' : ''}>정지</option></select></div>
      <div class="field" id="quota-field"><label>디스크 할당 (GB, 0=미할당)</label><input class="input num" id="quota" type="number" min="0" step="0.1" value="${u.quotaBytes > 0 ? (u.quotaBytes / 1024 / 1024 / 1024).toFixed(1) : 0}">
        <span class="muted" style="font-size:12px">현재 사용량: ${UI.bytes(u.usedBytes)} · 사용량보다 작게 줄일 수 없습니다. 관리자는 무제한입니다.</span></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="cancel">취소</button>
        <button class="btn btn-primary" id="ok">저장</button>
      </div>`);
    const roleSel = m.q('#role'), quotaField = m.q('#quota-field');
    const syncRole = () => { quotaField.style.display = roleSel.value === 'admin' ? 'none' : ''; };
    roleSel.addEventListener('change', () => m.animate(syncRole)); syncRole();
    m.q('#cancel').addEventListener('click', m.close);
    m.q('#ok').addEventListener('click', async () => {
      const g = parseFloat(m.q('#quota').value) || 0;
      const bytes = Math.round(g * 1024 * 1024 * 1024);
      if (roleSel.value !== 'admin' && bytes > 0 && bytes < u.usedBytes) { UI.toast(`현재 사용량(${UI.bytes(u.usedBytes)})보다 작게 설정할 수 없습니다`, 'error'); return; }
      try {
        await API.updateUser(id, {
          displayName: m.q('#dn').value.trim(),
          role: roleSel.value,
          isActive: m.q('#active').value === 'true',
          quotaBytes: bytes,
        });
        m.close(); UI.toast('저장되었습니다', 'success'); loadUsers();
      } catch (err) { UI.toast(err.message, 'error'); }
    });
  }

  async function deleteUser(id) {
    const u = state.users.find((x) => String(x.id) === String(id));
    const ok = await UI.confirm({ title: '계정 삭제', danger: true, confirmText: '영구 삭제', message: `'${u.username}' 계정과 그 계정의 모든 파일을 영구 삭제합니다.\n이 작업은 되돌릴 수 없습니다. 계속할까요?` });
    if (!ok) return;
    try { await API.deleteUser(id); UI.toast('삭제되었습니다', 'success'); loadUsers(); }
    catch (err) { UI.toast(err.message, 'error'); }
  }

  // ── 휴지통 ──────────────────────────
  async function loadTrash() {
    const view = document.getElementById('view');
    view.innerHTML = '<div class="empty"><div class="big">⏳</div>불러오는 중…</div>';
    try {
      const t = await API.trash();
      const folderRows = t.folders.map((f) => `
        <tr class="fade-in">
          <td>📁 <b>${UI.escapeHtml(f.path)}</b><br><span class="muted" style="font-size:12px">폴더 · 파일 ${f.fileCount}개</span></td>
          <td>${UI.escapeHtml(f.displayName || f.username || '—')}</td>
          <td class="num muted">${new Date(f.deletedAt).toLocaleString('ko-KR')}</td>
          <td class="row-actions" style="text-align:right">
            <button class="btn btn-sm btn-secondary" data-rf="${f.id}">↩️ 복원</button>
            <button class="btn btn-sm btn-danger" data-pf="${f.id}">🗑️ 영구삭제</button>
          </td></tr>`).join('');
      const fileRows = t.files.map((f) => `
        <tr class="fade-in">
          <td>${UI.fileIcon(f.name)} <b>${UI.escapeHtml(f.name)}</b><br><span class="muted" style="font-size:12px">${UI.escapeHtml(f.folder)} · ${UI.bytes(f.size)}</span></td>
          <td>${UI.escapeHtml(f.displayName || f.username || '—')}</td>
          <td class="num muted">${new Date(f.deletedAt).toLocaleString('ko-KR')}</td>
          <td class="row-actions" style="text-align:right">
            <button class="btn btn-sm btn-secondary" data-rfi="${f.id}">↩️ 복원</button>
            <button class="btn btn-sm btn-danger" data-pfi="${f.id}">🗑️ 영구삭제</button>
          </td></tr>`).join('');
      const empty = t.folders.length === 0 && t.files.length === 0;
      view.innerHTML = `
        <p class="muted" style="margin-bottom:14px">삭제된 항목은 여기에 보관되며, <b>${t.retentionDays}일(1년) 후 자동으로 영구 삭제</b>됩니다. 복원 시 원래 위치로 돌아가고, 같은 이름이 있으면 자동으로 번호가 붙습니다.</p>
        ${empty ? '<div class="empty"><div class="big">🗑️</div>휴지통이 비어 있습니다.</div>' : `
        <div class="table-wrap fade-in"><table><thead><tr><th>항목</th><th>소유 계정</th><th>삭제 시각</th><th></th></tr></thead>
        <tbody>${folderRows}${fileRows}</tbody></table></div>`}`;
      view.querySelectorAll('[data-rf]').forEach((el) => el.addEventListener('click', () => restore('folder', el.dataset.rf)));
      view.querySelectorAll('[data-rfi]').forEach((el) => el.addEventListener('click', () => restore('file', el.dataset.rfi)));
      view.querySelectorAll('[data-pf]').forEach((el) => el.addEventListener('click', () => purge('folder', el.dataset.pf)));
      view.querySelectorAll('[data-pfi]').forEach((el) => el.addEventListener('click', () => purge('file', el.dataset.pfi)));
    } catch (err) { view.innerHTML = `<div class="empty">⚠️ ${UI.escapeHtml(err.message)}</div>`; }
  }

  async function restore(type, id) {
    try {
      const r = type === 'folder' ? await API.restoreFolder(id) : await API.restoreFile(id);
      UI.toast(`복원되었습니다${r.name ? ' → ' + r.name : (r.path ? ' → ' + r.path : '')}`, 'success');
      loadTrash();
    } catch (err) { UI.toast(err.message, 'error'); }
  }

  async function purge(type, id) {
    const ok = await UI.confirm({ title: '영구 삭제', danger: true, confirmText: '영구 삭제', message: '이 항목을 완전히 삭제합니다.\n디스크에서도 제거되며 복원할 수 없습니다. 계속할까요?' });
    if (!ok) return;
    try { if (type === 'folder') await API.purgeFolder(id); else await API.purgeFile(id); UI.toast('영구 삭제되었습니다', 'success'); loadTrash(); }
    catch (err) { UI.toast(err.message, 'error'); }
  }

  // ── 영업점 관리 ──────────────────────────
  async function loadBranches() {
    const view = document.getElementById('view');
    view.innerHTML = '<div class="empty"><div class="big">⏳</div>불러오는 중…</div>';
    try {
      const { branches } = await API.adminBranches();
      const rows = branches.map((b) => `
        <tr class="fade-in"><td><b>${UI.escapeHtml(b.name)}</b></td>
          <td class="row-actions" style="text-align:right">
            <button class="btn btn-sm btn-ghost" data-eb="${b.id}" data-name="${UI.escapeHtml(b.name)}">✏️ 수정</button>
            <button class="btn btn-sm btn-danger" data-db="${b.id}" data-name="${UI.escapeHtml(b.name)}">🗑️ 삭제</button>
          </td></tr>`).join('');
      view.innerHTML = `
        <div class="toolbar"><span class="muted">사용자가 '새 폴더 → 영업점 폴더'에서 선택하는 목록입니다. 총 ${branches.length}개</span><div style="flex:1"></div><button class="btn btn-primary" id="add-branch">＋ 영업점 추가</button></div>
        <div class="table-wrap fade-in"><table><thead><tr><th>영업점</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan=2 class="muted">등록된 영업점이 없습니다.</td></tr>'}</tbody></table></div>`;
      document.getElementById('add-branch').addEventListener('click', () => branchModal());
      view.querySelectorAll('[data-eb]').forEach((el) => el.addEventListener('click', () => branchModal(el.dataset.eb, el.dataset.name)));
      view.querySelectorAll('[data-db]').forEach((el) => el.addEventListener('click', async () => {
        const ok = await UI.confirm({ title: '영업점 삭제', danger: true, confirmText: '삭제', message: `'${el.dataset.name}' 영업점을 목록에서 삭제할까요?\n(이미 만들어진 폴더는 영향받지 않습니다)` });
        if (!ok) return;
        try { await API.deleteBranch(el.dataset.db); UI.toast('삭제됨', 'success'); loadBranches(); } catch (err) { UI.toast(err.message, 'error'); }
      }));
    } catch (err) { view.innerHTML = `<div class="empty">⚠️ ${UI.escapeHtml(err.message)}</div>`; }
  }
  function branchModal(id, name) {
    const m = UI.modal(`<h3>${id ? '영업점 수정' : '영업점 추가'}</h3><div class="field"><label>영업점 이름</label><input class="input" id="bn" value="${UI.escapeHtml(name || '')}" placeholder="예: 강남점"></div><div class="modal-actions"><button class="btn btn-ghost" id="c">취소</button><button class="btn btn-primary" id="ok">저장</button></div>`);
    m.q('#c').addEventListener('click', m.close);
    m.q('#ok').addEventListener('click', async () => {
      const v = m.q('#bn').value.trim(); if (!v) return;
      try { if (id) await API.editBranch(id, v); else await API.addBranch(v); m.close(); UI.toast('저장됨', 'success'); loadBranches(); } catch (err) { UI.toast(err.message, 'error'); }
    });
    setTimeout(() => m.q('#bn').focus(), 50);
  }

  // ── 공지사항 ──────────────────────────
  async function loadNotices() {
    const view = document.getElementById('view');
    view.innerHTML = '<div class="empty"><div class="big">⏳</div>불러오는 중…</div>';
    try {
      const { notices } = await API.adminNotices();
      const now = Date.now();
      const rows = notices.map((n) => {
        const active = (!n.start_at || new Date(n.start_at).getTime() <= now) && (!n.end_at || new Date(n.end_at).getTime() >= now);
        const roleLbl = { admin: '관리자', manager: '담당자', user: '일반' };
        const roles = Array.isArray(n.target_roles) ? n.target_roles : ['admin', 'manager', 'user'];
        const roleText = roles.length >= 3 ? '전체' : roles.map((r) => roleLbl[r] || r).join(', ');
        return `<tr class="fade-in">
          <td><b>${UI.escapeHtml(n.title)}</b><br><span class="muted" style="font-size:12px">${n.start_at ? UI.date(n.start_at) : '무기한'} ~ ${n.end_at ? UI.date(n.end_at) : '무기한'} · 👥 ${roleText}</span></td>
          <td><span class="badge ${active ? 'on' : 'off'}">${active ? '노출중' : '비노출'}</span></td>
          <td class="row-actions" style="text-align:right"><button class="btn btn-sm btn-ghost" data-en="${n.id}">✏️ 수정</button><button class="btn btn-sm btn-danger" data-dn="${n.id}">🗑️ 삭제</button></td></tr>`;
      }).join('');
      view.innerHTML = `
        <div class="toolbar"><span class="muted">노출 기간에 해당하면 사용자 로그인 시 팝업으로 표시됩니다.</span><div style="flex:1"></div><button class="btn btn-primary" id="add-notice">＋ 공지 작성</button></div>
        <div class="table-wrap fade-in"><table><thead><tr><th>제목 / 기간</th><th>상태</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan=3 class="muted">공지가 없습니다.</td></tr>'}</tbody></table></div>`;
      document.getElementById('add-notice').addEventListener('click', () => noticeModal());
      view.querySelectorAll('[data-en]').forEach((el) => el.addEventListener('click', () => noticeModal(notices.find((x) => String(x.id) === el.dataset.en))));
      view.querySelectorAll('[data-dn]').forEach((el) => el.addEventListener('click', async () => {
        const ok = await UI.confirm({ title: '공지 삭제', danger: true, confirmText: '삭제', message: '이 공지사항을 삭제할까요?' });
        if (!ok) return; try { await API.deleteNotice(el.dataset.dn); UI.toast('삭제됨', 'success'); loadNotices(); } catch (err) { UI.toast(err.message, 'error'); }
      }));
    } catch (err) { view.innerHTML = `<div class="empty">⚠️ ${UI.escapeHtml(err.message)}</div>`; }
  }
  function toLocalInput(iso) { if (!iso) return ''; const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
  function noticeModal(n) {
    const m = UI.modal(`<h3>${n ? '공지 수정' : '공지 작성'}</h3>
      <div class="field"><label>제목</label><input class="input" id="t" value="${n ? UI.escapeHtml(n.title) : ''}"></div>
      <div class="field"><label>내용</label>
        <div class="rte-toolbar">
          <button type="button" class="rte-btn" data-cmd="bold" title="굵게"><b>B</b></button>
          <button type="button" class="rte-btn" data-cmd="italic" title="기울임"><i>I</i></button>
          <button type="button" class="rte-btn" data-cmd="underline" title="밑줄"><u>U</u></button>
          <select class="rte-sel" data-cmd="fontSize" title="글자 크기">
            <option value="">크기</option><option value="2">작게</option><option value="3">보통</option><option value="5">크게</option><option value="6">매우 크게</option>
          </select>
          <label class="rte-color" title="글자 색상">🎨<input type="color" data-cmd="foreColor" value="#343A40"></label>
          <button type="button" class="rte-btn" data-cmd="createLink" title="링크">🔗</button>
          <button type="button" class="rte-btn" id="rte-img" title="이미지 첨부">🖼️</button>
          <input type="file" id="rte-file" accept="image/*" hidden>
        </div>
        <div class="rte-editor input" id="b" contenteditable="true">${n ? (n.body || '') : ''}</div>
      </div>
      <div style="display:flex;gap:10px">
        <div class="field" style="flex:1"><label>시작 (비우면 즉시)</label><input class="input" type="datetime-local" id="s" value="${n ? toLocalInput(n.start_at) : ''}"></div>
        <div class="field" style="flex:1"><label>종료 (비우면 무기한)</label><input class="input" type="datetime-local" id="e" value="${n ? toLocalInput(n.end_at) : ''}"></div>
      </div>
      <div class="field"><label>노출 대상 (권한)</label>
        <div class="role-picker" id="roles">
          ${[['admin', '관리자'], ['manager', '담당자'], ['user', '일반']].map(([v, lbl]) => {
            const checked = !n || !Array.isArray(n.target_roles) || n.target_roles.includes(v);
            return `<label class="role-chip"><input type="checkbox" value="${v}" ${checked ? 'checked' : ''}> ${lbl}</label>`;
          }).join('')}
        </div>
      </div>
      <div class="modal-actions"><button class="btn btn-ghost" id="c">취소</button><button class="btn btn-primary" id="ok">저장</button></div>`);
    m.el.querySelector('.modal').classList.add('modal-wide');
    const editor = m.q('#b');
    const exec = (cmd, val) => { editor.focus(); document.execCommand(cmd, false, val); };
    m.el.querySelectorAll('.rte-btn[data-cmd]').forEach((btn) => btn.addEventListener('click', () => {
      const cmd = btn.dataset.cmd;
      if (cmd === 'createLink') { const url = prompt('링크 주소(URL)를 입력하세요:', 'https://'); if (url) exec('createLink', url); }
      else exec(cmd);
    }));
    m.el.querySelector('.rte-sel[data-cmd=fontSize]').addEventListener('change', (e) => { if (e.target.value) exec('fontSize', e.target.value); e.target.value = ''; });
    m.el.querySelector('.rte-color input').addEventListener('input', (e) => exec('foreColor', e.target.value));
    m.q('#rte-img').addEventListener('click', () => m.q('#rte-file').click());
    m.q('#rte-file').addEventListener('change', (e) => {
      const file = e.target.files[0]; if (!file) return;
      if (file.size > 5 * 1024 * 1024) return UI.toast('이미지는 5MB 이하만 첨부할 수 있습니다', 'error');
      const reader = new FileReader();
      reader.onload = () => { exec('insertHTML', `<img src="${reader.result}" style="max-width:100%;vertical-align:middle">`); };
      reader.readAsDataURL(file);
    });
    m.q('#c').addEventListener('click', m.close);
    m.q('#ok').addEventListener('click', async () => {
      const targetRoles = [...m.el.querySelectorAll('#roles input:checked')].map((c) => c.value);
      if (targetRoles.length === 0) return UI.toast('노출 대상 권한을 하나 이상 선택하세요', 'error');
      const data = { title: m.q('#t').value.trim(), body: editor.innerHTML, startAt: m.q('#s').value ? new Date(m.q('#s').value).toISOString() : '', endAt: m.q('#e').value ? new Date(m.q('#e').value).toISOString() : '', targetRoles };
      if (!data.title) return UI.toast('제목을 입력하세요', 'error');
      try { if (n) await API.editNotice(n.id, data); else await API.addNotice(data); m.close(); UI.toast('저장됨', 'success'); loadNotices(); } catch (err) { UI.toast(err.message, 'error'); }
    });
    setTimeout(() => m.q('#t').focus(), 50);
  }

  // ── 허용 확장자 ──────────────────────────
  async function loadExt() {
    const view = document.getElementById('view');
    view.innerHTML = '<div class="empty"><div class="big">⏳</div>불러오는 중…</div>';
    try {
      const { extensions } = await API.getExtensions();
      view.innerHTML = `
        <div class="card" style="max-width:640px">
          <p class="muted" style="margin-bottom:12px">업로드를 허용할 파일 확장자를 입력하세요. 쉼표 또는 공백으로 구분하며, 점(.)은 있어도 없어도 됩니다. 예: <code>.txt, .csv, xlsx</code></p>
          <div class="field"><label>허용 확장자</label><textarea class="input" id="ext" rows="4">${extensions.join(', ')}</textarea></div>
          <div style="display:flex;gap:10px;justify-content:flex-end"><button class="btn btn-primary" id="save-ext">저장</button></div>
        </div>`;
      document.getElementById('save-ext').addEventListener('click', async () => {
        try { const r = await API.setExtensions(document.getElementById('ext').value); UI.toast(`저장됨 (${r.extensions.length}종)`, 'success'); loadExt(); } catch (err) { UI.toast(err.message, 'error'); }
      });
    } catch (err) { view.innerHTML = `<div class="empty">⚠️ ${UI.escapeHtml(err.message)}</div>`; }
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

  // ── 사용자 매뉴얼 ──────────────────────────
  function loadManual() {
    const view = document.getElementById('view');
    view.innerHTML = `
      <div class="manual">
        <p class="manual-intro">북적북적(Book-Jeok)은 우리끼리 파일을 나누는 웹 파일 창고입니다. 아래 안내로 사용자·관리자 기능을 모두 익힐 수 있어요. 인쇄가 필요하면 이 화면에서 <b>Ctrl/⌘ + P</b> 를 누르세요.</p>

        <section class="manual-sec">
          <h2>1. 시작하기</h2>
          <ul>
            <li><b>로그인</b> — 관리자에게 받은 아이디·비밀번호로 로그인합니다.</li>
            <li><b>비밀번호 변경</b> — 상단 <span class="kbd">🔑 비밀번호</span> 에서 언제든 바꿀 수 있습니다(현재 비밀번호 확인 필요, 8자 이상).</li>
            <li><b>로고 클릭</b> — 화면 어디서든 왼쪽 위 <b>북적북적</b> 로고를 누르면 홈(최상위 폴더)으로 갑니다.</li>
            <li><b>모바일</b> — 좁은 화면에서는 왼쪽 위 <span class="kbd">☰</span> 로 폴더 사이드바를 엽니다.</li>
          </ul>
        </section>

        <section class="manual-sec">
          <h2>2. 파일 올리기 / 내려받기</h2>
          <ul>
            <li><b>업로드</b> — 파일 영역의 점선 상자에 파일을 <b>끌어다 놓거나</b>, 상자를 클릭해 선택합니다. 상단 <span class="kbd">⬆️ 업로드</span> 버튼도 동일합니다. 여러 개 동시 업로드 가능.</li>
            <li><b>허용 형식</b> — 관리자가 지정한 확장자만 올라갑니다. 점선 상자 아래 <b>허용: …</b> 목록을 확인하세요.</li>
            <li><b>다운로드</b> — 목록에서 파일의 <span class="kbd">⬇️</span> 버튼(또는 그리드에서 파일 카드의 메뉴)을 누릅니다.</li>
            <li><b>용량</b> — 상단 사용량 막대에서 내 사용량/할당량을 볼 수 있습니다. 할당량이 0이면 업로드가 제한됩니다(관리자 문의).</li>
          </ul>
        </section>

        <section class="manual-sec">
          <h2>3. 폴더 다루기</h2>
          <ul>
            <li><b>새 폴더</b> — <span class="kbd">📂 새 폴더</span> → 이름 입력. 아이콘/색상도 지정할 수 있습니다.</li>
            <li><b>영업점 폴더</b> — 새 폴더 창의 <b>영업점 폴더</b> 탭에서 등록된 영업점을 골라 한 번에 만들 수 있습니다(전체 선택 지원).</li>
            <li><b>왼쪽 폴더 트리</b> — <b>한 번 클릭</b>: 그 폴더 열람(내용 보기). <b>더블 클릭</b> 또는 <span class="kbd">▸</span> 캐럿: 하위 폴더 펼치기/접기. 위쪽 <span class="kbd">⊞</span>/<span class="kbd">⊟</span> 로 전체 펴기/닫기.</li>
            <li><b>폴더 설정</b> — 폴더의 <span class="kbd">⚙️</span> 에서 이름 변경, 아이콘·색상 지정. 지정한 색은 폴더 아이콘에 입혀집니다.</li>
            <li><b>비고(메모)</b> — 폴더·파일마다 비고를 달 수 있습니다. 리스트의 <b>비고</b> 칸을 클릭해 바로 편집.</li>
          </ul>
        </section>

        <section class="manual-sec">
          <h2>4. 목록 보기 · 정렬 · 태그</h2>
          <ul>
            <li><b>보기 전환</b> — 오른쪽 위 <span class="kbd">▦</span>(미리보기) / <span class="kbd">☰</span>(리스트)로 전환.</li>
            <li><b>정렬</b> — 리스트 뷰에서 <b>이름·크기·등록일·수정일·비고</b> 머리글을 클릭하면 그 값 기준으로 정렬됩니다. 다시 누르면 오름/내림 전환(▲▼ 표시).</li>
            <li><b>업데이트 태그</b> — 최근 7일 내 추가된 항목엔 <span class="tagx new">NEW</span>, 수정된 항목엔 <span class="tagx upd">수정</span> 태그가 붙습니다.</li>
          </ul>
        </section>

        <section class="manual-sec">
          <h2>5. 여러 개 선택 · 공유 · 압축</h2>
          <ul>
            <li><b>선택</b> — 리스트 왼쪽 체크박스로 여러 항목 선택. 머리글 체크박스는 <b>전체 선택/해제 토글</b>입니다.</li>
            <li><b>일괄 작업</b> — 선택하면 아래 막대에 <b>이름변경 · 다운로드(ZIP) · 폴더이동 · 삭제 · 선택해제</b>가 나타납니다.</li>
            <li><b>압축 다운로드</b> — <span class="kbd">⬇️ 다운로드(ZIP)</span> 를 누르면 압축본이 만들어지고, <b>내 기기로 다운로드</b> 또는 <b>공유링크 만들기</b>를 선택할 수 있습니다. 폴더 하나만 골랐다면 파일명은 그 폴더 이름이 됩니다.</li>
            <li><b>공유 링크</b> — 파일의 <span class="kbd">🔗</span>(또는 압축 공유)로 <b>로그인 없이 접근 가능한</b> 다운로드 링크를 만듭니다. 만료 기간(무기한/1·7·30일)을 정할 수 있습니다. 링크를 아는 사람은 누구나 받을 수 있으니 주의하세요.</li>
          </ul>
        </section>

        <section class="manual-sec">
          <h2>6. 권한 체계</h2>
          <table class="manual-table">
            <thead><tr><th>권한</th><th>볼 수 있는 파일</th><th>관리 기능</th><th>디스크</th></tr></thead>
            <tbody>
              <tr><td><b>관리자</b></td><td>모든 계정</td><td>전체(계정·공지·휴지통 등)</td><td>무제한</td></tr>
              <tr><td><b>담당자</b></td><td>본인 + 일반 사용자</td><td>없음(열람·업로드만)</td><td>할당량</td></tr>
              <tr><td><b>일반</b></td><td>본인만</td><td>없음</td><td>할당량</td></tr>
            </tbody>
          </table>
          <p class="manual-note">관리자·담당자는 상단 <b>계정 전환</b> 선택으로 접근 가능한 다른 계정의 파일을 열람할 수 있습니다.</p>
        </section>

        <hr class="manual-hr">
        <h2 class="manual-admin-h">🛠️ 관리자 전용 기능</h2>

        <section class="manual-sec">
          <h3>계정 관리</h3>
          <ul>
            <li><b>계정 발급</b> — 아이디·표시이름·권한·<b>디스크 할당(GB)</b> 지정. 비밀번호는 비우면 자동 생성됩니다(발급 시 1회 표시). 할당은 남은 디스크 총량을 넘을 수 없습니다.</li>
            <li><b>비밀번호</b> — 계정별 <span class="kbd">🔑 암호</span>로 현재 비밀번호를 열람하거나 재설정할 수 있습니다(열람은 감사 로그에 기록됨).</li>
            <li><b>수정</b> — 권한·할당량·활성/정지·표시이름 변경. 현재 사용량보다 작게 할당량을 줄일 수는 없습니다.</li>
          </ul>
        </section>

        <section class="manual-sec">
          <h3>영업점 · 공지 · 확장자</h3>
          <ul>
            <li><b>영업점</b> — 사용자가 '영업점 폴더'에서 고르는 목록을 추가·수정·삭제합니다.</li>
            <li><b>공지사항</b> — 리치텍스트(굵게·색상·이미지·링크)로 작성. <b>노출 기간</b>과 <b>노출 대상 권한</b>(관리자/담당자/일반)을 정할 수 있습니다. 사용자는 자기 권한이 대상인 공지만 로그인 시 팝업으로 봅니다.</li>
            <li><b>허용 확장자</b> — 업로드 가능한 파일 형식을 관리합니다.</li>
          </ul>
        </section>

        <section class="manual-sec">
          <h3>휴지통 · DB · 로그</h3>
          <ul>
            <li><b>휴지통</b> — 삭제된 파일·폴더는 휴지통으로 이동하며 여기서 <b>복원</b>하거나 <b>영구 삭제</b>할 수 있습니다. 1년이 지난 항목은 자동으로 영구 삭제됩니다.</li>
            <li><b>DB 상태</b> — 데이터베이스 용량·연결·테이블 현황을 확인합니다.</li>
            <li><b>감사 로그</b> — 로그인, 업로드, 비밀번호 열람, 삭제 등 주요 동작의 시각·사용자·IP 기록을 봅니다.</li>
          </ul>
        </section>

        <section class="manual-sec manual-tips">
          <h3>💡 팁 &amp; 주의</h3>
          <ul>
            <li>공유 링크는 <b>링크를 아는 누구나</b> 접근합니다. 민감한 파일은 <b>만료 기간</b>을 짧게 설정하세요.</li>
            <li>압축 공유본은 공유 링크의 만료 기간까지 유지되고, 공유하지 않은 임시 압축본은 하루 뒤 자동 정리됩니다.</li>
            <li>삭제는 곧바로 사라지지 않고 휴지통으로 가니, 실수로 지워도 관리자 휴지통에서 되돌릴 수 있습니다.</li>
            <li>화면이 최신으로 안 보이면 <b>강력 새로고침</b>(Windows <span class="kbd">Ctrl+Shift+R</span> / Mac <span class="kbd">⌘+Shift+R</span>).</li>
          </ul>
        </section>
      </div>`;
  }

  return { boot };
})();

document.addEventListener('DOMContentLoaded', Admin.boot);
