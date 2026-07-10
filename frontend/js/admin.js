/* 북적북적 관리자 페이지 */
const Admin = (() => {
  const state = { user: null, tab: 'dashboard', users: [] };
  const root = () => document.getElementById('app');

  async function boot() {
    if (!API.hasToken()) return (location.href = 'index.html');
    try {
      const { user } = await API.me();
      if (user.role !== 'admin') { UI.toast('관리자만 접근할 수 있습니다', 'error'); return (location.href = 'index.html'); }
      if (!user.totpEnabled) { UI.toast('2단계 인증 설정이 필요합니다', 'error'); return (location.href = 'index.html'); }
      state.user = user;
      renderShell();
      loadDashboard();
    } catch {
      location.href = 'index.html';
    }
  }

  function renderShell() {
    const item = (tab, ico, label) => `<div class="nav-item ${state.tab === tab ? 'active' : ''}" data-tab="${tab}"><span class="ico">${ico}</span><span class="t">${label}</span></div>`;
    root().innerHTML = `
      <div class="layout">
        <header class="appbar">
          <a class="brand" href="index.html" title="홈으로"><img src="assets/logo.svg?v=47"><span class="brand-name">북적북적</span></a>
          <nav class="appbar-nav">
            ${item('dashboard', '🏠', '대시보드')}
            ${item('users', '👥', '계정')}
            ${item('branches', '🏢', '영업점')}
            ${item('notices', '📢', '공지')}
            ${item('ext', '🧩', '확장자')}
            ${item('shares', '🔗', '공유')}
            ${item('trash', '🗑️', '휴지통')}
            ${item('capacity', '📊', '용량')}
            ${item('report', '📧', '리포트')}
            ${item('db', '🗄️', 'DB')}
            ${item('audit', '📜', '로그')}
            ${item('manual', '📖', '매뉴얼')}
            <a class="nav-item" href="index.html"><span class="ico">📁</span><span class="t">파일로</span></a>
          </nav>
          <div class="topbar-spacer"></div>
          <div class="user-chip-sm">${UI.escapeHtml(state.user.displayName)} · 관리자</div>
        </header>
        <main class="content admin-content">
          <h1 class="admin-title" id="page-title">대시보드</h1>
          <div id="view"></div>
        </main>
      </div>`;
    root().querySelectorAll('[data-tab]').forEach((el) => el.addEventListener('click', () => switchTab(el.dataset.tab)));
  }

  function switchTab(tab) {
    state.tab = tab;
    renderShell();
    if (tab === 'dashboard') loadDashboard();
    else if (tab === 'users') loadUsers();
    else if (tab === 'branches') loadBranches();
    else if (tab === 'notices') loadNotices();
    else if (tab === 'ext') loadExt();
    else if (tab === 'shares') loadShares();
    else if (tab === 'trash') loadTrash();
    else if (tab === 'db') loadDb();
    else if (tab === 'audit') loadAudit();
    else if (tab === 'capacity') loadCapacity();
    else if (tab === 'report') loadReport();
    else if (tab === 'manual') loadManual();
    const titles = { dashboard: '대시보드', users: '계정 관리', branches: '영업점 관리', notices: '공지사항', ext: '허용 확장자', shares: '공유 통합 관리', trash: '휴지통', capacity: '용량 리포트', report: '주간 리포트', db: 'DB 상태', audit: '감사 로그', manual: '사용자 매뉴얼' };
    document.getElementById('page-title').textContent = titles[tab];
  }

  // ── 대시보드 ──────────────────────────
  async function loadDashboard() {
    const view = document.getElementById('view');
    view.innerHTML = '<div class="empty"><div class="big">⏳</div>불러오는 중…</div>';
    try {
      const d = await API.dashboard();
      const s = d.storage;
      const diskWarn = s.usedPct >= 90 || s.allocPct >= 95;
      const warnItems = [];
      if (s.usedPct >= 90) warnItems.push(`디스크 사용량이 <b>${s.usedPct}%</b>에 도달했습니다 (${UI.bytes(s.diskUsed)} / ${UI.bytes(s.diskTotal)}).`);
      if (s.allocPct >= 95) warnItems.push(`할당 합계가 디스크의 <b>${s.allocPct}%</b>입니다. 추가 발급이 제한될 수 있습니다.`);
      d.quotaWarnings.forEach((q) => warnItems.push(`<b>${UI.escapeHtml(q.displayName)}</b>(@${UI.escapeHtml(q.username)}) 계정이 할당량의 <b>${q.pct}%</b>를 사용 중입니다.`));
      const warnBox = warnItems.length ? `<div class="dash-warn"><b>⚠️ 용량 임박 경고</b><ul>${warnItems.map((w) => `<li>${w}</li>`).join('')}</ul></div>` : '';

      const maxDay = Math.max(1, ...d.daily.map((x) => Math.max(x.logins, x.uploads)));
      const bars = d.daily.map((x) => `<div class="dash-bar" title="${x.date} · 로그인 ${x.logins} · 업로드 ${x.uploads}건(${UI.bytes(x.uploadBytes)})">
        <div class="dash-bcol"><span class="up" style="height:${x.uploads / maxDay * 100}%"></span><span class="lg" style="height:${x.logins / maxDay * 100}%"></span></div>
        <div class="dash-blabel">${x.date}</div></div>`).join('');

      const tops = d.topAccounts.map((t) => `<div class="rep-row"><div class="rep-name">${UI.escapeHtml(t.displayName)} <span class="muted" style="font-size:11px">@${UI.escapeHtml(t.username)}</span></div><div class="rep-bar"><span style="width:${d.topAccounts[0].usedBytes ? (t.usedBytes / d.topAccounts[0].usedBytes * 100) : 0}%"></span></div><div class="rep-val num">${UI.bytes(t.usedBytes)} · ${t.fileCount}개</div></div>`).join('') || '<p class="muted">데이터 없음</p>';

      const recent = d.recent.map((r) => `<tr><td class="num" style="color:var(--text-muted);white-space:nowrap">${new Date(r.createdAt).toLocaleString('ko-KR')}</td><td>${UI.escapeHtml(r.username || '—')}</td><td><span class="badge user">${UI.escapeHtml(r.action)}</span></td><td class="muted" style="font-size:12px">${UI.escapeHtml(r.detail || '')}</td></tr>`).join('');

      view.innerHTML = `
        ${warnBox}
        <div class="stat-grid">
          <div class="stat"><div class="k">계정</div><div class="v num">${d.users.active}<span style="font-size:14px;color:var(--text-muted)"> / ${d.users.total}</span></div></div>
          <div class="stat"><div class="k">전체 파일</div><div class="v num">${d.fileCount.toLocaleString()}</div></div>
          <div class="stat"><div class="k">사용 중</div><div class="v num">${UI.bytes(s.diskUsed)}</div><div class="k">디스크 ${UI.bytes(s.diskTotal)} · ${s.usedPct}%</div></div>
          <div class="stat"><div class="k">할당 / 남음</div><div class="v num">${UI.bytes(s.allocated)}</div><div class="k">남음 ${UI.bytes(s.available)}</div></div>
          <div class="stat"><div class="k">파일 보안 검사</div><div class="v num" style="font-size:16px">🛡️ 형식검증 ON</div><div class="k">악성패턴(YARA): ${d.yara ? '켜짐' : '꺼짐'}</div></div>
        </div>
        <div class="dash-card">
          <div class="dash-h">최근 14일 추이 <span class="muted" style="font-size:12px;font-weight:400">· <span class="dash-leg up"></span> 업로드 <span class="dash-leg lg"></span> 로그인</span></div>
          <div class="dash-chart">${bars}</div>
        </div>
        <div class="dash-2col">
          <div class="dash-card"><div class="dash-h">사용량 상위 계정</div>${tops}</div>
          <div class="dash-card"><div class="dash-h">최근 활동</div><div class="table-wrap" style="border:none"><table><tbody>${recent || '<tr><td class="muted">기록 없음</td></tr>'}</tbody></table></div></div>
        </div>`;
    } catch (err) { view.innerHTML = `<div class="empty">⚠️ ${UI.escapeHtml(err.message)}</div>`; }
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
      const ck = (type, id) => `<td style="width:34px"><input type="checkbox" class="tck" data-type="${type}" data-id="${id}"></td>`;
      const folderRows = t.folders.map((f) => `
        <tr class="fade-in">${ck('folder', f.id)}
          <td>📁 <b>${UI.escapeHtml(f.path)}</b><br><span class="muted" style="font-size:12px">폴더 · 파일 ${f.fileCount}개</span></td>
          <td>${UI.escapeHtml(f.displayName || f.username || '—')}</td>
          <td class="num muted">${new Date(f.deletedAt).toLocaleString('ko-KR')}</td>
          <td class="row-actions" style="text-align:right">
            <button class="btn btn-sm btn-secondary" data-rf="${f.id}">↩️ 복원</button>
            <button class="btn btn-sm btn-danger" data-pf="${f.id}">🗑️ 영구삭제</button>
          </td></tr>`).join('');
      const fileRows = t.files.map((f) => `
        <tr class="fade-in">${ck('file', f.id)}
          <td>${UI.fileIcon(f.name)} <b>${UI.escapeHtml(f.name)}</b><br><span class="muted" style="font-size:12px">${UI.escapeHtml(f.folder)} · ${UI.bytes(f.size)}</span></td>
          <td>${UI.escapeHtml(f.displayName || f.username || '—')}</td>
          <td class="num muted">${new Date(f.deletedAt).toLocaleString('ko-KR')}</td>
          <td class="row-actions" style="text-align:right">
            <button class="btn btn-sm btn-secondary" data-rfi="${f.id}">↩️ 복원</button>
            <button class="btn btn-sm btn-danger" data-pfi="${f.id}">🗑️ 영구삭제</button>
          </td></tr>`).join('');
      const empty = t.folders.length === 0 && t.files.length === 0;
      view.innerHTML = `
        <p class="muted" style="margin-bottom:12px">삭제된 항목은 여기에 보관되며, <b>${t.retentionDays}일(1년) 후 자동으로 영구 삭제</b>됩니다. 복원 시 원래 위치로 돌아가고, 같은 이름이 있으면 자동으로 번호가 붙습니다.</p>
        ${empty ? '<div class="empty"><div class="big">🗑️</div>휴지통이 비어 있습니다.</div>' : `
        <div class="trash-bulk" id="trash-bulk"><span id="tb-count">0개 선택</span><div style="flex:1"></div>
          <button class="btn btn-sm btn-secondary" id="tb-restore">↩️ 선택 복원</button>
          <button class="btn btn-sm btn-danger" id="tb-purge">🗑️ 선택 영구삭제</button></div>
        <div class="table-wrap fade-in"><table><thead><tr><th style="width:34px"><input type="checkbox" id="tck-all" title="전체 선택/해제"></th><th>항목</th><th>소유 계정</th><th>삭제 시각</th><th></th></tr></thead>
        <tbody>${folderRows}${fileRows}</tbody></table></div>`}`;
      view.querySelectorAll('[data-rf]').forEach((el) => el.addEventListener('click', () => restore('folder', el.dataset.rf)));
      view.querySelectorAll('[data-rfi]').forEach((el) => el.addEventListener('click', () => restore('file', el.dataset.rfi)));
      view.querySelectorAll('[data-pf]').forEach((el) => el.addEventListener('click', () => purge('folder', el.dataset.pf)));
      view.querySelectorAll('[data-pfi]').forEach((el) => el.addEventListener('click', () => purge('file', el.dataset.pfi)));
      if (!empty) wireTrashBulk(view);
    } catch (err) { view.innerHTML = `<div class="empty">⚠️ ${UI.escapeHtml(err.message)}</div>`; }
  }

  function wireTrashBulk(view) {
    const boxes = [...view.querySelectorAll('.tck')];
    const all = view.querySelector('#tck-all');
    const bar = view.querySelector('#trash-bulk');
    const count = view.querySelector('#tb-count');
    const rBtn = view.querySelector('#tb-restore');
    const pBtn = view.querySelector('#tb-purge');
    const sync = () => {
      const sel = boxes.filter((b) => b.checked);
      count.textContent = sel.length ? `${sel.length}개 선택` : '선택된 항목 없음';
      rBtn.disabled = pBtn.disabled = sel.length === 0;
      all.checked = sel.length > 0 && sel.length === boxes.length;
      all.indeterminate = sel.length > 0 && sel.length < boxes.length;
    };
    boxes.forEach((b) => b.addEventListener('change', sync));
    all.addEventListener('change', () => { boxes.forEach((b) => { b.checked = all.checked; }); sync(); });
    view.querySelector('#tb-restore').addEventListener('click', () => bulkTrash('restore', boxes));
    view.querySelector('#tb-purge').addEventListener('click', () => bulkTrash('purge', boxes));
    sync();
  }
  async function bulkTrash(kind, boxes) {
    const items = boxes.filter((b) => b.checked).map((b) => ({ type: b.dataset.type, id: b.dataset.id }));
    if (!items.length) return UI.toast('선택된 항목이 없습니다', 'error');
    if (kind === 'purge') {
      const ok = await UI.confirm({ title: '선택 영구 삭제', danger: true, confirmText: `${items.length}개 영구삭제`, message: `선택한 ${items.length}개 항목을 완전히 삭제합니다.\n디스크에서도 제거되며 복원할 수 없습니다.` });
      if (!ok) return;
    }
    let done = 0, fail = 0;
    for (const it of items) {
      try {
        if (kind === 'restore') { if (it.type === 'folder') await API.restoreFolder(it.id); else await API.restoreFile(it.id); }
        else { if (it.type === 'folder') await API.purgeFolder(it.id); else await API.purgeFile(it.id); }
        done++;
      } catch { fail++; }
    }
    UI.toast(`${done}개 ${kind === 'restore' ? '복원' : '영구삭제'}됨${fail ? `, ${fail}개 실패` : ''}`, fail ? 'error' : 'success');
    loadTrash();
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
      const card = (b) => `
        <div class="branch-card fade-in">
          <div class="bc-name" title="${UI.escapeHtml(b.name)}">🏢 ${UI.escapeHtml(b.name)}</div>
          <div class="bc-actions">
            <button class="icon-btn" data-eb="${b.id}" data-name="${UI.escapeHtml(b.name)}" title="수정">✏️</button>
            <button class="icon-btn" data-db="${b.id}" data-name="${UI.escapeHtml(b.name)}" title="삭제">🗑️</button>
          </div>
        </div>`;
      view.innerHTML = `
        <div class="toolbar">
          <input class="input" id="branch-search" placeholder="🔎 영업점 이름 검색" style="max-width:280px">
          <span class="muted" id="branch-count">총 ${branches.length}개</span>
          <div style="flex:1"></div><button class="btn btn-primary" id="add-branch">＋ 영업점 추가</button>
        </div>
        <div class="branch-mgmt fade-in" id="branch-grid"></div>`;
      const grid = document.getElementById('branch-grid');
      const cnt = document.getElementById('branch-count');
      const renderGrid = (q) => {
        const kw = (q || '').trim().toLowerCase();
        const list = kw ? branches.filter((b) => b.name.toLowerCase().includes(kw)) : branches;
        grid.innerHTML = list.length ? list.map(card).join('') : `<div class="empty" style="grid-column:1/-1"><div class="big">🏢</div>${branches.length ? '검색 결과가 없습니다.' : '등록된 영업점이 없습니다.'}</div>`;
        cnt.textContent = kw ? `${list.length} / ${branches.length}개` : `총 ${branches.length}개`;
        grid.querySelectorAll('[data-eb]').forEach((el) => el.addEventListener('click', () => branchModal(el.dataset.eb, el.dataset.name)));
        grid.querySelectorAll('[data-db]').forEach((el) => el.addEventListener('click', async () => {
          const ok = await UI.confirm({ title: '영업점 삭제', danger: true, confirmText: '삭제', message: `'${el.dataset.name}' 영업점을 목록에서 삭제할까요?\n(이미 만들어진 폴더는 영향받지 않습니다)` });
          if (!ok) return;
          try { await API.deleteBranch(el.dataset.db); UI.toast('삭제됨', 'success'); loadBranches(); } catch (err) { UI.toast(err.message, 'error'); }
        }));
      };
      renderGrid('');
      document.getElementById('add-branch').addEventListener('click', () => branchModal());
      document.getElementById('branch-search').addEventListener('input', (e) => renderGrid(e.target.value));
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
      const TKO = { users: '사용자(계정)', files: '파일', folders: '폴더', share_links: '공유 링크', folder_shares: '폴더 공유', upload_requests: '업로드 요청', zip_bundles: '압축 번들', notifications: '알림', notices: '공지사항', branches: '영업점', settings: '설정', audit_log: '감사 로그' };
      const tables = (s.tables || []).map((t) => `<tr><td>${UI.escapeHtml(TKO[t.table] || t.table)} <span class="muted" style="font-size:11px">${UI.escapeHtml(t.table)}</span></td><td class="num">${t.rows.toLocaleString()}</td></tr>`).join('');
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
  const ACTION_KO = {
    login: '로그인', login_failed: '로그인 실패', logout: '로그아웃',
    change_password_self: '비밀번호 변경(본인)', update_settings: '설정 변경',
    '2fa_enabled': '2단계 인증 켬', '2fa_disabled': '2단계 인증 끔',
    create_user: '계정 생성', update_user: '계정 수정', delete_user: '계정 삭제',
    reset_password: '비밀번호 재설정', view_password: '비밀번호 열람',
    create_folder: '폴더 생성', rename_folder: '폴더 이름변경', folder_note: '폴더 비고', folder_style: '폴더 색상/아이콘',
    upload: '업로드', download: '다운로드', rename: '이름 변경', update_note: '비고 수정',
    trash_file: '파일 삭제', trash_folder: '폴더 삭제', restore_file: '파일 복원', restore_folder: '폴더 복원',
    self_restore_file: '본인 파일 복원', self_restore_folder: '본인 폴더 복원',
    purge_file: '파일 영구삭제', purge_folder: '폴더 영구삭제',
    bulk_move: '일괄 이동', bulk_trash: '일괄 삭제', bulk_zip: '일괄 압축',
    create_share: '공유 생성', delete_share: '공유 삭제', admin_delete_share: '공유 폐기(관리자)',
    create_folder_share: '폴더 공유 생성', delete_folder_share: '폴더 공유 삭제',
    create_upload_request: '업로드 요청 생성', delete_upload_request: '업로드 요청 삭제',
    add_branch: '영업점 추가', edit_branch: '영업점 수정', delete_branch: '영업점 삭제',
    add_notice: '공지 추가', edit_notice: '공지 수정', delete_notice: '공지 삭제',
    set_extensions: '허용 확장자 설정', send_report: '주간 리포트 발송',
    file_blocked: '업로드 차단(형식위장)', malware_blocked: '업로드 차단(악성패턴)',
  };
  const actionKo = (a) => ACTION_KO[a] || '기타';
  async function loadAudit() {
    const view = document.getElementById('view');
    view.innerHTML = '<div class="empty"><div class="big">⏳</div>불러오는 중…</div>';
    try {
      const { logs } = await API.audit(100);
      const danger = new Set(['login_failed', 'delete_user', 'purge_file', 'purge_folder', 'file_blocked', 'malware_blocked', 'admin_delete_share', '2fa_disabled']);
      const rows = logs.map((l) => `
        <tr>
          <td class="num" style="color:var(--text-muted);white-space:nowrap">${new Date(l.created_at).toLocaleString('ko-KR')}</td>
          <td style="white-space:nowrap">${UI.escapeHtml(l.username || '—')}</td>
          <td style="white-space:nowrap"><code class="act-code">${UI.escapeHtml(l.action)}</code></td>
          <td style="white-space:nowrap"><span class="badge ${danger.has(l.action) ? 'off' : 'user'}">${UI.escapeHtml(actionKo(l.action))}</span></td>
          <td class="audit-detail">${UI.escapeHtml(l.detail)}</td>
          <td class="num" style="color:var(--text-muted);white-space:nowrap">${UI.escapeHtml(l.ip)}</td>
        </tr>`).join('');
      view.innerHTML = `<div class="table-wrap"><table class="audit-table"><thead><tr><th>시각</th><th>사용자</th><th>동작코드</th><th>동작명</th><th style="width:99%">상세</th><th>IP</th></tr></thead><tbody>${rows || '<tr><td colspan=6>기록 없음</td></tr>'}</tbody></table></div>`;
    } catch (err) { view.innerHTML = `<div class="empty">⚠️ ${UI.escapeHtml(err.message)}</div>`; }
  }

  // ── 용량 리포트 (전 계정) ──────────────
  // ── 공유 통합 관리 (전 계정) ──────────────
  async function loadShares() {
    const view = document.getElementById('view');
    view.innerHTML = '<div class="empty"><div class="big">⏳</div>불러오는 중…</div>';
    try {
      const d = await API.adminShares();
      const kindIco = { file: '📄', zip: '🗜️' };
      const owner = (r) => `<span class="muted" style="font-size:11px">${UI.escapeHtml(r.ownerName)} @${UI.escapeHtml(r.ownerUsername)}</span>`;
      const exp = (r) => (r.expiresAt ? UI.date(r.expiresAt) + '까지' : '무기한');
      const fileRows = d.fileShares.map((r) => {
        const meta = [r.hasPassword ? '🔒' : '', r.maxDownloads != null ? `${r.downloadCount}/${r.maxDownloads}회` : `${r.downloadCount}회`, exp(r)].filter(Boolean).join(' · ');
        return `<tr><td>${kindIco[r.kind] || '📄'} <b>${UI.escapeHtml(r.name || '(삭제된 대상)')}</b></td><td>${owner(r)}</td><td class="muted" style="font-size:12px">${meta}${r.reason ? `<br>💬 ${UI.escapeHtml(r.reason)}` : ''}</td>
          <td style="text-align:right"><button class="btn btn-sm btn-ghost" data-copy="${UI.escapeHtml(location.origin + '/share.html?t=' + r.token)}">📋</button><button class="btn btn-sm btn-danger" data-del="file:${r.id}">폐기</button></td></tr>`;
      }).join('') || '<tr><td colspan="4" class="muted">파일/압축 공유 없음</td></tr>';
      const folderRows = d.folderShares.map((r) => {
        const meta = [r.hasPassword ? '🔒' : '', r.disabled ? '중지' : '', exp(r), '조회 ' + r.viewCount].filter(Boolean).join(' · ');
        return `<tr><td>📁 <b>${UI.escapeHtml(r.label)}</b> <span class="muted" style="font-size:11px">${UI.escapeHtml(r.folder)}</span></td><td>${owner(r)}</td><td class="muted" style="font-size:12px">${meta}${r.reason ? `<br>💬 ${UI.escapeHtml(r.reason)}` : ''}</td>
          <td style="text-align:right"><button class="btn btn-sm btn-ghost" data-copy="${UI.escapeHtml(location.origin + '/folder.html?t=' + r.token)}">📋</button><button class="btn btn-sm btn-danger" data-del="folder:${r.id}">폐기</button></td></tr>`;
      }).join('') || '<tr><td colspan="4" class="muted">폴더 공유 없음</td></tr>';
      const reqRows = d.uploadRequests.map((r) => {
        const cap = [r.maxFiles ? `${r.uploadedCount}/${r.maxFiles}개` : `${r.uploadedCount}개`, r.maxBytes ? `${UI.bytes(r.uploadedBytes)}/${UI.bytes(r.maxBytes)}` : UI.bytes(r.uploadedBytes)].join(' · ');
        const meta = [r.hasPassword ? '🔒' : '', r.disabled ? '중지' : '', exp(r), '받음 ' + cap].filter(Boolean).join(' · ');
        return `<tr><td>📥 <b>${UI.escapeHtml(r.label)}</b> <span class="muted" style="font-size:11px">${UI.escapeHtml(r.folder)}</span></td><td>${owner(r)}</td><td class="muted" style="font-size:12px">${meta}${r.reason ? `<br>💬 ${UI.escapeHtml(r.reason)}` : ''}</td>
          <td style="text-align:right"><button class="btn btn-sm btn-ghost" data-copy="${UI.escapeHtml(location.origin + '/upload.html?t=' + r.token)}">📋</button><button class="btn btn-sm btn-danger" data-del="upload:${r.id}">폐기</button></td></tr>`;
      }).join('') || '<tr><td colspan="4" class="muted">업로드 요청 없음</td></tr>';
      const sec = (title, count, rows) => `<div class="dash-h" style="margin-top:16px">${title} <span class="muted" style="font-weight:400;font-size:12px">${count}건</span></div>
        <div class="table-wrap"><table><tbody>${rows}</tbody></table></div>`;
      view.innerHTML = `<p class="muted" style="font-size:13px;margin-bottom:4px">모든 계정의 외부 공유 링크를 한 곳에서 관리·폐기합니다.</p>
        ${sec('📄 파일 · 압축 공유', d.fileShares.length, fileRows)}
        ${sec('📁 폴더 공유(읽기 전용)', d.folderShares.length, folderRows)}
        ${sec('📥 업로드 요청(외부 업로드)', d.uploadRequests.length, reqRows)}`;
      view.querySelectorAll('[data-copy]').forEach((x) => x.addEventListener('click', () => { navigator.clipboard?.writeText(x.dataset.copy); UI.toast('링크 복사됨', 'success'); }));
      view.querySelectorAll('[data-del]').forEach((x) => x.addEventListener('click', async () => {
        const [kind, id] = x.dataset.del.split(':');
        if (!(await UI.confirm({ title: '공유 폐기', message: '이 공유 링크를 폐기할까요?\n외부에서 더 이상 접근할 수 없습니다.', confirmText: '폐기', danger: true }))) return;
        try { await API.deleteAdminShare(kind, id); UI.toast('폐기됨', 'success'); loadShares(); } catch (e) { UI.toast(e.message, 'error'); }
      }));
    } catch (err) { view.innerHTML = `<div class="empty">⚠️ ${UI.escapeHtml(err.message)}</div>`; }
  }

  // ── 용량 리포트 (SpaceSniffer식 트리맵) ────────
  const capState = { data: null, ownerId: null, path: '/' };
  async function loadCapacity() {
    const view = document.getElementById('view');
    view.innerHTML = '<div class="empty"><div class="big">⏳</div>불러오는 중…</div>';
    try {
      capState.data = await API.usageTree();
      capState.ownerId = null; capState.path = '/';
      const s = capState.data;
      view.innerHTML = `
        <div class="stat-grid">
          <div class="stat"><div class="k">디스크 전체</div><div class="v num">${UI.bytes(s.diskTotal)}</div></div>
          <div class="stat"><div class="k">사용 중 (전 계정)</div><div class="v num">${UI.bytes(s.accounts.reduce((a, x) => a + x.used, 0))}</div></div>
          <div class="stat"><div class="k">할당 합계</div><div class="v num">${UI.bytes(s.allocated)}</div></div>
          <div class="stat"><div class="k">할당 가능 (남음)</div><div class="v num">${UI.bytes(s.available)}</div></div>
        </div>
        <div class="tm-bar"><div id="tm-crumb"></div><div class="tm-legend"><span class="muted" style="font-size:12px">타일 크기 = 사용량 · 클릭하면 폴더별로 열림</span></div></div>
        <div id="treemap" class="treemap"></div>
        <div id="tm-tip" class="tm-tip" style="display:none"></div>`;
      window.addEventListener('resize', drawTreemapDebounced);
      drawTreemap();
    } catch (err) { view.innerHTML = `<div class="empty">⚠️ ${UI.escapeHtml(err.message)}</div>`; }
  }
  let tmTimer = null;
  function drawTreemapDebounced() { clearTimeout(tmTimer); tmTimer = setTimeout(() => { if (document.getElementById('treemap')) drawTreemap(); }, 150); }

  function squarify(items, W, H) {
    const total = items.reduce((s, i) => s + i.value, 0) || 1;
    const scale = (W * H) / total;
    const data = items.map((i) => ({ ...i, area: Math.max(i.value * scale, 0) })).sort((a, b) => b.area - a.area);
    const out = []; let rect = { x: 0, y: 0, w: W, h: H }; let row = [];
    const worst = (r, len) => { const sum = r.reduce((s, x) => s + x.area, 0); const mx = Math.max(...r.map((x) => x.area)); const mn = Math.min(...r.map((x) => x.area)); const l2 = len * len, s2 = sum * sum; return Math.max((l2 * mx) / s2, s2 / (l2 * mn)); };
    const layout = (r, rc, horiz) => { const sum = r.reduce((s, x) => s + x.area, 0); let off = 0; if (horiz) { const rh = sum / rc.w; for (const x of r) { const rw = x.area / rh; out.push({ ...x, x: rc.x + off, y: rc.y, w: rw, h: rh }); off += rw; } return { x: rc.x, y: rc.y + rh, w: rc.w, h: rc.h - rh }; } const rw = sum / rc.h; for (const x of r) { const rh = x.area / rw; out.push({ ...x, x: rc.x, y: rc.y + off, w: rw, h: rh }); off += rh; } return { x: rc.x + rw, y: rc.y, w: rc.w - rw, h: rc.h }; };
    const rem = data.slice();
    while (rem.length) {
      const horiz = rect.w >= rect.h; const len = horiz ? rect.w : rect.h;
      if (!row.length) { row.push(rem.shift()); continue; }
      if (worst(row, len) >= worst([...row, rem[0]], len)) row.push(rem.shift());
      else { rect = layout(row, rect, horiz); row = []; }
    }
    if (row.length) layout(row, rect, rect.w >= rect.h);
    return out;
  }

  // 계정의 폴더 경로들로 트리 구성(중간 폴더 자동 생성) + 하위합계 계산
  function buildAccountTree(ownerId) {
    const rows = capState.data.folders.filter((f) => f.ownerId === ownerId);
    const nodes = new Map();
    const parentOf = (p) => { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
    const ensure = (p) => {
      if (nodes.has(p)) return nodes.get(p);
      const name = p === '/' ? '홈(최상위)' : p.slice(p.lastIndexOf('/') + 1);
      const node = { path: p, name, selfBytes: 0, selfFiles: 0, children: [] };
      nodes.set(p, node);
      if (p !== '/') ensure(parentOf(p)).children.push(node);
      return node;
    };
    ensure('/');
    for (const r of rows) { const n = ensure(r.folder); n.selfBytes += r.used; n.selfFiles += r.files; }
    const total = (n) => { let b = n.selfBytes, f = n.selfFiles; for (const c of n.children) { const [cb, cf] = total(c); b += cb; f += cf; } n.totalBytes = b; n.totalFiles = f; return [b, f]; };
    total(nodes.get('/'));
    return nodes;
  }

  function drawTreemap() {
    const box = document.getElementById('treemap'); if (!box || !capState.data) return;
    const W = box.clientWidth || 900, H = 520;
    const s = capState.data;
    const crumb = document.getElementById('tm-crumb');
    let tiles, level;

    if (capState.ownerId == null) {
      level = 'account';
      tiles = s.accounts.filter((a) => a.used > 0).map((a) => ({ value: a.used, a }));
      crumb.innerHTML = '<b>전체 계정</b>';
    } else {
      level = 'folder';
      const acc = s.accounts.find((a) => a.id === capState.ownerId);
      const tree = buildAccountTree(capState.ownerId);
      const node = tree.get(capState.path) || tree.get('/');
      tiles = node.children.filter((c) => c.totalBytes > 0).map((c) => ({ value: c.totalBytes, node: c }));
      if (node.selfBytes > 0) tiles.push({ value: node.selfBytes, files: true, filesCount: node.selfFiles });
      // 브레드크럼: 전체 계정 / 계정명 / seg / seg …
      let html = '<a href="#" class="tm-link" data-goto="root">전체 계정</a>';
      const segs = capState.path.split('/').filter(Boolean);
      html += ' <span class="muted">/</span> ' + (segs.length ? `<a href="#" class="tm-link" data-path="/">${UI.escapeHtml(acc ? acc.displayName : '')}</a>` : `<b>${UI.escapeHtml(acc ? acc.displayName : '')}</b>`);
      let accP = '';
      segs.forEach((seg, i) => { accP += '/' + seg; const last = i === segs.length - 1; html += ' <span class="muted">/</span> ' + (last ? `<b>${UI.escapeHtml(seg)}</b>` : `<a href="#" class="tm-link" data-path="${UI.escapeHtml(accP)}">${UI.escapeHtml(seg)}</a>`); });
      crumb.innerHTML = html;
    }

    if (!tiles.length) { box.innerHTML = '<div class="empty" style="height:100%">이 폴더에는 파일이 없습니다.</div>'; wireCrumb(); return; }
    const rects = squarify(tiles, W, H);
    const maxV = Math.max(...tiles.map((t) => t.value));
    box.style.height = H + 'px';
    box.innerHTML = rects.map((r) => {
      let name, sub, color, key, drill = false, pathAttr = '';
      if (level === 'account') {
        const a = r.a; const q = a.quotaBytes;
        const fill = q > 0 ? Math.min(100, Math.round(a.used / q * 100)) : null;
        color = q > 0 ? heat(fill / 100) : ocean(r.value / maxV);
        name = a.displayName; sub = `${UI.bytes(a.used)}${q > 0 ? ' · ' + fill + '%' : ''} · ${a.files}개`; key = `acc:${a.id}`; drill = a.used > 0;
      } else if (r.files) {
        color = '#8592a0'; name = '📄 이 폴더 파일'; sub = `${UI.bytes(r.value)} · ${r.filesCount}개`; key = 'files';
      } else {
        const n = r.node; const kids = n.children.length;
        color = ocean(r.value / maxV);
        name = (kids ? '📁 ' : '📂 ') + n.name;
        sub = `${UI.bytes(n.totalBytes)} · ${n.totalFiles}개${kids ? ' · 하위 ' + kids : ''}`;
        key = 'fol'; drill = kids > 0; pathAttr = ` data-path="${UI.escapeHtml(n.path)}"`;
      }
      const small = r.w < 64 || r.h < 34;
      return `<div class="tm-tile${drill ? '' : ' nodrill'}" data-key="${key}" data-drill="${drill ? 1 : 0}"${pathAttr} style="left:${r.x}px;top:${r.y}px;width:${Math.max(0, r.w - 2)}px;height:${Math.max(0, r.h - 2)}px;background:${color}"
        data-name="${UI.escapeHtml(name)}" data-sub="${UI.escapeHtml(sub)}">
        ${small ? '' : `<div class="tm-name">${UI.escapeHtml(name)}</div><div class="tm-sub">${UI.escapeHtml(sub)}</div>`}</div>`;
    }).join('');
    wireCrumb();
    const tip = document.getElementById('tm-tip');
    box.querySelectorAll('.tm-tile').forEach((el) => {
      el.addEventListener('mousemove', (e) => {
        tip.style.display = 'block'; tip.innerHTML = `<b>${el.dataset.name}</b><br>${el.dataset.sub}`;
        const vr = document.getElementById('view').getBoundingClientRect(); const tw = tip.offsetWidth, th = tip.offsetHeight;
        let x = e.clientX - vr.left + 14; if (x + tw > vr.width) x = e.clientX - vr.left - tw - 14; if (x < 2) x = 2;
        let y = e.clientY - vr.top + 14; if (y + th > vr.height) y = e.clientY - vr.top - th - 14; if (y < 2) y = 2;
        tip.style.left = x + 'px'; tip.style.top = y + 'px';
      });
      el.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
      if (el.dataset.drill !== '1') return;
      el.addEventListener('click', () => {
        if (el.dataset.key.startsWith('acc:')) { capState.ownerId = parseInt(el.dataset.key.split(':')[1], 10); capState.path = '/'; }
        else if (el.dataset.key === 'fol') { capState.path = el.dataset.path; }
        drawTreemap();
      });
    });
  }
  function wireCrumb() {
    const crumb = document.getElementById('tm-crumb'); if (!crumb) return;
    crumb.querySelectorAll('[data-goto="root"]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); capState.ownerId = null; capState.path = '/'; drawTreemap(); }));
    crumb.querySelectorAll('[data-path]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); capState.path = a.dataset.path; drawTreemap(); }));
  }
  // 색상: 사용률 heat(0=파랑→1=빨강), 크기 ocean(옅은→진한 청록)
  function heat(t) { t = Math.max(0, Math.min(1, t)); const h = (1 - t) * 200; return `hsl(${h},70%,${t >= 0.9 ? 46 : 52}%)`; }
  function ocean(t) { t = Math.max(0.08, Math.min(1, t)); return `hsl(195,75%,${64 - t * 34}%)`; }

  // ── 주간 리포트 (미리보기 · 즉시 발송) ────────
  async function loadReport() {
    const view = document.getElementById('view');
    view.innerHTML = '<div class="empty"><div class="big">⏳</div>불러오는 중…</div>';
    try {
      const d = await API.reportPreview();
      const m = d.mail || {};
      const status = m.enabled
        ? `<span class="badge on">SMTP 설정됨</span> 수신자: ${m.to && m.to.length ? UI.escapeHtml(m.to.join(', ')) : '<span style="color:var(--danger)">REPORT_TO 미설정</span>'}`
        : '<span class="badge off">SMTP 미설정</span> — 서버 환경변수 설정 후 자동 발송됩니다.';
      view.innerHTML = `
        <div class="dash-card" style="margin-bottom:14px">
          <div class="dash-h">주간 리포트 자동 발송</div>
          <p class="muted" style="font-size:13px;margin:6px 0">매주 <b>월요일 오전</b>(기본 08:00, Asia/Seoul) 계정별 디스크·활동·실패 이력·특이사항을 이메일로 보냅니다.</p>
          <p style="font-size:13px;margin:6px 0">${status}</p>
          <div style="margin-top:8px"><button class="btn btn-primary btn-sm" id="rp-send">📧 지금 테스트 발송</button>
            <span class="muted" style="font-size:12px;margin-left:8px">아래는 이번 주 리포트 미리보기입니다.</span></div>
          <p class="muted" style="font-size:12px;margin-top:8px">설정: SMTP_HOST · SMTP_PORT · SMTP_USER · SMTP_PASS · MAIL_FROM · REPORT_TO(수신자) · REPORT_CRON(기본 <code>0 8 * * 1</code>) · REPORT_TZ(기본 Asia/Seoul)</p>
        </div>
        <div class="rp-preview">${d.html}</div>`;
      document.getElementById('rp-send').addEventListener('click', async (e) => {
        const btn = e.currentTarget; btn.disabled = true; btn.textContent = '발송 중…';
        try { const r = await API.reportSend(); UI.toast('리포트를 발송했습니다 ✅', 'success'); btn.textContent = '✅ 발송됨'; }
        catch (err) { UI.toast(err.message, 'error'); btn.disabled = false; btn.textContent = '📧 지금 테스트 발송'; }
      });
    } catch (err) { view.innerHTML = `<div class="empty">⚠️ ${UI.escapeHtml(err.message)}</div>`; }
  }

  // ── 사용자 매뉴얼 (관리자용) ──────────────
  function loadManual() {
    document.getElementById('view').innerHTML = Manual.adminHTML();
  }

  return { boot };
})();

document.addEventListener('DOMContentLoaded', Admin.boot);
