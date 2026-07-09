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
          <a class="brand" href="index.html" title="홈으로"><img src="assets/logo.svg?v=25"><span class="brand-name">북적북적</span></a>
          <nav class="appbar-nav">
            ${item('users', '👥', '계정')}
            ${item('branches', '🏢', '영업점')}
            ${item('notices', '📢', '공지')}
            ${item('ext', '🧩', '확장자')}
            ${item('trash', '🗑️', '휴지통')}
            ${item('capacity', '📊', '용량')}
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
    else if (tab === 'capacity') loadCapacity();
    else if (tab === 'manual') loadManual();
    const titles = { users: '계정 관리', branches: '영업점 관리', notices: '공지사항', ext: '허용 확장자', trash: '휴지통', capacity: '용량 리포트', db: 'DB 상태', audit: '감사 로그', manual: '사용자 매뉴얼' };
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
      const on = new Set(extensions.map((e) => e.toLowerCase()));
      // 카탈로그에 없는 커스텀 확장자도 유지
      const known = new Set(UI.EXT_CATALOG.flatMap((g) => g.exts));
      const custom = extensions.filter((e) => !known.has(e.toLowerCase()));
      const groups = UI.EXT_CATALOG.map((g) => `
        <div class="ext-group">
          <div class="ext-group-head"><span>${g.icon} ${g.group}</span>
            <button type="button" class="btn btn-sm btn-ghost ext-grp-toggle" data-grp="${g.exts.join(',')}">그룹 전체</button></div>
          <div class="ext-grid">${g.exts.map((e) => `
            <label class="ext-opt${on.has(e) ? ' on' : ''}"><input type="checkbox" value="${e}" ${on.has(e) ? 'checked' : ''}><span class="ei">${UI.extIcon(e)}</span> .${e}</label>`).join('')}</div>
        </div>`).join('');
      view.innerHTML = `
        <div class="toolbar"><span class="muted" style="font-size:13px">업로드를 허용할 확장자를 선택하세요. 현재 <b id="ext-count">${on.size}</b>종 허용 중.</span><div style="flex:1"></div><button class="btn btn-primary" id="save-ext">저장</button></div>
        ${groups}
        <div class="ext-group"><div class="ext-group-head"><span>➕ 직접 추가 (쉼표/공백 구분)</span></div>
          <input class="input" id="ext-custom" placeholder="예: dwg, psb" value="${UI.escapeHtml(custom.join(', '))}"></div>`;
      const view2 = document.getElementById('view');
      const recount = () => { document.getElementById('ext-count').textContent = view2.querySelectorAll('.ext-opt input:checked').length; };
      view2.querySelectorAll('.ext-opt input').forEach((c) => c.addEventListener('change', () => { c.closest('.ext-opt').classList.toggle('on', c.checked); recount(); }));
      view2.querySelectorAll('.ext-grp-toggle').forEach((b) => b.addEventListener('click', () => {
        const exts = b.dataset.grp.split(','); const boxes = exts.map((e) => view2.querySelector(`.ext-opt input[value="${e}"]`));
        const allOn = boxes.every((x) => x.checked); boxes.forEach((x) => { x.checked = !allOn; x.closest('.ext-opt').classList.toggle('on', !allOn); }); recount();
      }));
      document.getElementById('save-ext').addEventListener('click', async () => {
        const picked = [...view2.querySelectorAll('.ext-opt input:checked')].map((c) => c.value);
        const extra = (document.getElementById('ext-custom').value || '').split(/[\s,]+/).map((s) => s.trim().replace(/^\./, '').toLowerCase()).filter(Boolean);
        const all = [...new Set([...picked, ...extra])];
        if (!all.length) return UI.toast('최소 1개 이상 선택하세요', 'error');
        try { const r = await API.setExtensions(all); UI.toast(`저장됨 (${r.extensions.length}종)`, 'success'); loadExt(); } catch (err) { UI.toast(err.message, 'error'); }
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

  // ── 용량 리포트 (전 계정) ──────────────
  async function loadCapacity() {
    const view = document.getElementById('view');
    view.innerHTML = '<div class="empty"><div class="big">⏳</div>불러오는 중…</div>';
    try {
      const [{ users }, disk] = await Promise.all([API.adminUsers(), API.diskInfo()]);
      const totalUsed = users.reduce((s, u) => s + Number(u.usedBytes || 0), 0);
      const max = Math.max(1, ...users.map((u) => Number(u.usedBytes || 0)));
      const rows = users.slice().sort((a, b) => Number(b.usedBytes) - Number(a.usedBytes)).map((u) => {
        const used = Number(u.usedBytes || 0), quota = Number(u.quotaBytes || 0);
        const pctQ = quota > 0 ? Math.min(100, used / quota * 100) : 0;
        const label = quota > 0 ? `${UI.bytes(used)} / ${UI.bytes(quota)} (${pctQ.toFixed(0)}%)` : `${UI.bytes(used)}${u.role === 'admin' ? ' · 무제한' : ' · 미할당'}`;
        return `<div class="rep-row"><div class="rep-name">${UI.escapeHtml(u.displayName)} <span class="muted" style="font-size:11px">@${UI.escapeHtml(u.username)}</span></div>
          <div class="rep-bar"><span style="width:${(used / max * 100).toFixed(1)}%"></span></div>
          <div class="rep-val num">${label} · ${u.fileCount}개</div></div>`;
      }).join('');
      view.innerHTML = `
        <div class="stat-grid">
          <div class="stat"><div class="k">디스크 전체</div><div class="v num">${UI.bytes(disk.totalBytes)}</div></div>
          <div class="stat"><div class="k">사용 중 (전 계정)</div><div class="v num">${UI.bytes(totalUsed)}</div></div>
          <div class="stat"><div class="k">할당 합계</div><div class="v num">${UI.bytes(disk.allocatedBytes || 0)}</div></div>
          <div class="stat"><div class="k">할당 가능 (남음)</div><div class="v num">${UI.bytes(disk.availableBytes || 0)}</div></div>
        </div>
        <div class="muted" style="font-size:12px;margin-bottom:8px">계정별 사용량 (많은 순)</div>${rows || '<p class="muted">계정이 없습니다.</p>'}`;
    } catch (err) { view.innerHTML = `<div class="empty">⚠️ ${UI.escapeHtml(err.message)}</div>`; }
  }

  // ── 사용자 매뉴얼 (관리자용) ──────────────
  function loadManual() {
    document.getElementById('view').innerHTML = Manual.adminHTML();
  }

  return { boot };
})();

document.addEventListener('DOMContentLoaded', Admin.boot);
