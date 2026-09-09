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
          <a class="brand" href="index.html" title="홈으로"><img src="assets/logo.svg?v=64"><span class="brand-name">북적북적</span></a>
          <nav class="appbar-nav">
            ${item('dashboard', '🏠', '대시보드')}
            ${item('health', '📈', '상태')}
            ${item('checkups', '🧪', '점검')}
            ${item('users', '👥', '계정')}
            ${item('branches', '🏢', '영업점')}
            ${item('notices', '📢', '공지')}
            ${item('ext', '🧩', '확장자')}
            ${item('shares', '🔗', '공유')}
            ${item('trash', '🗑️', '휴지통')}
            ${item('capacity', '📊', '용량')}
            ${item('report', '📧', '리포트')}
            ${item('db', '🗄️', 'DB')}
            ${item('backup', '💾', '백업')}
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
    stopHealth();          // 다른 탭으로 가면 상태 폴링을 멈춘다
    state.tab = tab;
    renderShell();
    if (tab === 'dashboard') loadDashboard();
    else if (tab === 'health') loadHealth();
    else if (tab === 'checkups') loadCheckups();
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
    else if (tab === 'backup') loadBackup();
    else if (tab === 'manual') loadManual();
    const titles = { dashboard: '대시보드', health: '시스템 상태', checkups: '정기 점검', users: '계정 관리', branches: '영업점 관리', notices: '공지사항', ext: '허용 확장자', shares: '공유 통합 관리', trash: '휴지통', capacity: '용량 리포트', report: '주간 리포트', db: 'DB 상태', backup: '백업 현황', audit: '감사 로그', manual: '사용자 매뉴얼' };
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
          <div class="stat"><div class="k">사용자 파일</div><div class="v num">${UI.bytes(s.diskUsed)}</div><div class="k">디스크 ${UI.bytes(s.diskTotal)} · ${s.usedPct}%</div></div>
          <div class="stat"><div class="k">시스템/기타</div><div class="v num">${UI.bytes(s.systemBytes || 0)}</div><div class="k">변환캐시 ${UI.bytes(s.pdfCacheBytes || 0)} · 압축임시 ${UI.bytes(s.bundleBytes || 0)}</div></div>
          <div class="stat"><div class="k">디스크 실사용</div><div class="v num">${UI.bytes(s.diskUsedActual || 0)}</div><div class="k">여유 ${UI.bytes(s.diskFree || 0)} · ${s.usedActualPct || 0}%</div></div>
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

  // ── 시스템 상태 (S1) ───────────────────
  // 상시 감시 중인 수치를 5초마다 갱신해 보여준다. 다른 탭으로 가면 폴링을 멈춘다.
  let healthTimer = null;
  function stopHealth() { if (healthTimer) { clearInterval(healthTimer); healthTimer = null; } }

  const LV = { ok: { c: 'var(--accent)', i: '✅' }, info: { c: '#118AB2', i: 'ℹ️' }, warn: { c: '#f0a500', i: '⚠️' }, danger: { c: 'var(--danger)', i: '🚨' } };
  const dur = (sec) => { sec = Math.floor(sec); const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60); return d ? `${d}일 ${h}시간` : h ? `${h}시간 ${m}분` : `${m}분`; };
  const ago = (iso) => { const s = Math.floor((Date.now() - new Date(iso)) / 1000); return s < 60 ? '방금' : s < 3600 ? `${Math.floor(s / 60)}분 전` : s < 86400 ? `${Math.floor(s / 3600)}시간 전` : `${Math.floor(s / 86400)}일 전`; };
  // 값 배열 → 작은 꺾은선(SVG). 추세를 숫자 대신 눈으로 보게 한다.
  function spark(values, color = 'var(--secondary)', h = 40) {
    const v = (values || []).filter((x) => Number.isFinite(x));
    if (v.length < 2) return '<div class="hl-nospark muted">추세를 그릴 만큼 표본이 모이지 않았습니다</div>';
    const min = Math.min(...v), max = Math.max(...v), span = (max - min) || 1, w = 100;
    const pts = v.map((y, i) => `${(i / (v.length - 1) * w).toFixed(2)},${(h - ((y - min) / span) * (h - 4) - 2).toFixed(2)}`).join(' ');
    return `<svg class="hl-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
  }
  function hcard(title, value, sub, level, extra = '') {
    const L = LV[level] || LV.ok;
    return `<div class="hl-card" style="border-left-color:${L.c}">
      <div class="hl-t">${L.i} ${title}</div>
      <div class="hl-v num">${value}</div>
      <div class="hl-s">${sub}</div>${extra}</div>`;
  }

  async function loadHealth() {
    document.getElementById('view').innerHTML = '<div class="empty"><div class="big">⏳</div>불러오는 중…</div>';
    stopHealth();
    await drawHealth();
    healthTimer = setInterval(drawHealth, 5000);
  }

  async function drawHealth() {
    if (state.tab !== 'health') return stopHealth();
    const view = document.getElementById('view');
    if (!view) return stopHealth();
    let d;
    try { d = await API.health(); }
    catch (err) { view.innerHTML = `<div class="empty">⚠️ ${UI.escapeHtml(err.message)}</div>`; return stopHealth(); }
    const esc = UI.escapeHtml;

    // 지금 떠 있는 경보 — 가장 먼저 눈에 들어와야 한다
    const act = d.alerts.active;
    const banner = act.length
      ? `<div class="hl-alerts">${act.map((a) => { const L = LV[a.level] || LV.warn; return `<div class="hl-alert" style="border-left-color:${L.c}">
          <span class="hl-ai">${L.i}</span>
          <div><b>${esc(a.message)}</b><div class="muted">${esc(a.detail || '')}</div>
          <div class="muted" style="font-size:11px">${ago(a.since)}부터 · ${a.count}회 감지</div></div></div>`; }).join('')}</div>`
      : '<div class="hl-ok">✅ 지금 떠 있는 경보가 없습니다.</div>';

    const loop = d.loop, mem = d.memory, disk = d.disk, dbp = d.dbPool, err = d.errors, pr = d.process;
    const loopLevel = loop.p95 >= loop.dangerMs ? 'danger' : loop.p95 >= loop.warnMs ? 'warn' : 'ok';
    // 힙 '비율'은 그 자체로 신호가 아니다(V8 은 필요할 때 heapTotal 을 늘린다).
    // 서버의 누수 판정과 같은 기준 — 우상향 추세 + 힙 포화, 또는 절대량이 큰 채로 거의 참.
    const memLeaking = mem.growthPerHour > 32 * 1048576 && mem.heapPct >= 80;
    const memLevel = (mem.heapPct >= 95 && mem.heapUsed >= 256 * 1048576) ? 'danger' : memLeaking ? 'warn' : 'ok';
    const poolLevel = dbp.waiting > 0 ? 'warn' : dbp.inUse / Math.max(1, dbp.max) >= 0.8 ? 'info' : 'ok';
    const errLevel = err.errorPct >= 20 ? 'danger' : err.errorPct >= 5 ? 'warn' : 'ok';
    const mb = (b) => (b / 1048576).toFixed(0) + 'MB';
    const growth = mem.growthPerHour > 0 ? `▲ 시간당 +${mb(mem.growthPerHour)}` : mem.growthPerHour < 0 ? `▼ 시간당 ${mb(mem.growthPerHour)}` : '변화 없음';

    const cards = [
      hcard('서비스 가동', dur(pr.uptime), `${pr.boots}회 기동 · ${pr.unexpectedRestart ? '<b style="color:var(--danger)">직전 비정상 종료</b>' : '직전 정상 종료'} · Node ${esc(pr.node)}`, pr.unexpectedRestart ? 'warn' : 'ok'),
      hcard('이벤트 루프 지연', `${loop.p95}ms`, `p50 ${loop.p50}ms · 최대 ${loop.max}ms · 기준 ${loop.warnMs}/${loop.dangerMs}ms`, loopLevel),
      hcard('메모리(힙)', `${mem.heapPct}%`, `${mb(mem.heapUsed)} / ${mb(mem.heapTotal)} · RSS ${mb(mem.rss)}<br>${growth} (최근 ${mem.windowMinutes}분)`, memLevel,
        spark(mem.series.map((x) => x.heapUsed), memLevel === 'ok' ? 'var(--secondary)' : LV[memLevel].c)),
      hcard('디스크', `${disk.usedPct}%`, `남은 공간 ${UI.bytes(disk.avail || 0)} / ${UI.bytes(disk.total || 0)}<br>경보 단계 75 · 85 · 92 · 96%`, disk.level || 'ok'),
      hcard('DB 커넥션', `${dbp.inUse} / ${dbp.max}`, `대기 ${dbp.waiting}건 · 30분 최대 사용 ${dbp.peakInUse} · 최대 대기 ${dbp.peakWaiting}`, poolLevel,
        spark(dbp.series.map((x) => x.inUse), poolLevel === 'ok' ? 'var(--secondary)' : LV[poolLevel].c)),
      hcard('오류율(최근 5분)', `${err.errorPct}%`, `요청 ${err.total}건 · 서버오류 ${err.e5xx}건 · 클라이언트오류 ${err.e4xx}건`, errLevel),
    ].join('') + hardeningCards(d);

    // 분당 요청/오류 막대 — 언제 튀었는지 눈으로 본다
    const maxReq = Math.max(1, ...err.perMinute.map((x) => x.total));
    const minuteBars = err.perMinute.length
      ? err.perMinute.map((x) => {
        const t = new Date(x.minute * 60000).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
        return `<div class="hl-bar" title="${t} · 요청 ${x.total} · 5xx ${x.e5xx} · 4xx ${x.e4xx}">
          <div class="hl-bcol"><span class="e5" style="height:${x.e5xx / maxReq * 100}%"></span><span class="e4" style="height:${x.e4xx / maxReq * 100}%"></span><span class="ok" style="height:${(x.total - x.e5xx - x.e4xx) / maxReq * 100}%"></span></div>
          <div class="hl-blabel">${t}</div></div>`;
      }).join('')
      : '<p class="muted">아직 요청 기록이 없습니다.</p>';

    const routes = err.topRoutes.length
      ? `<table class="hl-table"><thead><tr><th>경로</th><th class="num">요청</th><th class="num">5xx</th><th class="num">평균</th></tr></thead><tbody>
          ${err.topRoutes.map((r) => `<tr><td>${esc(r.route)}</td><td class="num">${r.total}</td><td class="num" style="${r.e5xx ? 'color:var(--danger);font-weight:700' : ''}">${r.e5xx}</td><td class="num">${r.avgMs}ms</td></tr>`).join('')}
        </tbody></table>`
      : '<p class="muted">집계된 요청이 없습니다.</p>';

    const hist = d.alerts.history.length
      ? d.alerts.history.map((h) => { const L = LV[h.level] || LV.info; return `<div class="hl-hrow"><span class="hl-hi">${L.i}</span><div><b>${esc(h.title)}</b><div class="muted">${esc(h.body || '')}</div></div><span class="muted hl-hago">${ago(h.at)}</span></div>`; }).join('')
      : '<p class="muted">기록된 경보가 없습니다.</p>';

    const dbInfo = d.db.connected
      ? `DB 정상 · ${esc(d.db.database)} · ${UI.bytes(d.db.sizeBytes)} · 연결 ${d.db.activeConnections}개`
      : `<b style="color:var(--danger)">DB 연결 끊김</b> ${esc(d.db.error || '')}`;

    // 인덱스 점검(S22)은 무거워 접어둔다 — 이미 열려 있으면 결과를 그대로 살린다(5초 갱신에 지워지지 않게)
    const idxBody = document.getElementById('hl-idx-body');
    const idxOpen = idxBody && !idxBody.classList.contains('hidden');
    const idxHtml = idxOpen ? idxBody.innerHTML : '';

    view.innerHTML = `
      ${banner}
      <div class="hl-grid">${cards}</div>
      <div class="dash-card"><div class="dash-h">분당 요청 <span class="muted" style="font-size:12px;font-weight:400">· <span class="hl-leg ok"></span> 정상 <span class="hl-leg e4"></span> 4xx <span class="hl-leg e5"></span> 5xx</span></div>
        <div class="hl-chart">${minuteBars}</div>
        <div class="muted" style="font-size:12px;margin-top:8px">${dbInfo} · 호스트 부하 ${d.host.loadPct}% (${d.host.cores}코어)</div>
      </div>
      <div class="dash-2col">
        <div class="dash-card"><div class="dash-h">경로별 요청·오류 (최근 5분)</div>${routes}</div>
        <div class="dash-card"><div class="dash-h">경보 이력</div><div class="hl-hist">${hist}</div></div>
      </div>
      <div class="dash-card">
        <div class="dash-h">인덱스 사용률 점검
          <button class="btn btn-sm btn-secondary" id="hl-idx-run" style="margin-left:auto">${idxOpen ? '다시 검사' : '검사 실행'}</button>
        </div>
        <p class="muted" style="font-size:12px;margin:0 0 8px">한 번도 쓰이지 않은 인덱스(쓰기만 느리게 하는 것)와, 순차 스캔이 잦아 인덱스가 필요해 보이는 테이블을 찾습니다.</p>
        <div id="hl-idx-body" class="${idxOpen ? '' : 'hidden'}">${idxHtml}</div>
      </div>`;
    document.getElementById('hl-idx-run').addEventListener('click', runIndexCheck);
  }

  // 묶음4(요청 처리 하드닝)의 현재 상태 — 캐시가 듣고 있는지, 변환이 밀렸는지, 한 계정이 몰아치는지
  function hardeningCards(d) {
    const c = d.listCache, cv = d.converter, al = d.accountLimit;
    if (!c && !cv && !al) return '';   // 구버전 백엔드와 섞여도 화면이 깨지지 않게
    const out = [];
    if (c) {
      out.push(hcard('목록 캐시 적중률', c.enabled ? `${c.hitRate}%` : '꺼짐',
        `적중 ${c.hit} · 빗나감 ${c.miss} · 보관 ${c.entries}/${c.maxEntries}건<br>쓰기로 버린 횟수 ${c.invalidate} · 만료 ${c.stale}`,
        !c.enabled ? 'info' : c.hitRate >= 50 ? 'ok' : 'info'));
    }
    if (cv) {
      out.push(hcard('문서 변환 대기', `${cv.queued} / ${cv.queueMax}`,
        `변환 ${cv.done}건 완료 · 실패 ${cv.failed} · 붐벼서 거절 ${cv.rejected} · 대기중 취소 ${cv.timedOut}<br>최근 변환 ${(cv.lastMs / 1000).toFixed(1)}초 · 최대 대기열 ${cv.peakQueue}`,
        cv.queued >= cv.queueMax ? 'danger' : cv.queued > 0 ? 'warn' : 'ok'));
    }
    const mq = d.mailQueue;
    if (mq && !mq.error) {
      const lvl = mq.breakerOpen || mq.failed > 0 ? 'warn' : mq.pending > 0 ? 'info' : 'ok';
      out.push(hcard('메일 재시도 큐', `${mq.pending}`,
        `대기 ${mq.pending} · 발송완료 ${mq.sent} · 끝내 실패 ${mq.failed}<br>${
          !mq.enabled ? 'SMTP 미설정'
            : mq.breakerOpen ? `<b style="color:var(--danger)">연속 실패로 잠시 중지</b> (${new Date(mq.breakerUntil).toLocaleTimeString('ko-KR')}까지)`
              : mq.nextAttemptAt ? `다음 시도 ${new Date(mq.nextAttemptAt).toLocaleTimeString('ko-KR')}` : '보낼 것 없음'}`, lvl));
    }
    if (al) {
      const top = (al.top || [])[0];
      out.push(hcard('계정별 요청량', `${top ? top.count : 0}`,
        `이번 1분에 가장 많이 부른 계정 기준 · 한도 ${al.max}(관리자 ${al.adminMax})<br>활동 중 ${al.active}개 계정${top && top.blocked ? ` · <b style="color:var(--danger)">차단 ${top.blocked}건</b>` : ''}`,
        top && top.blocked > 0 ? 'warn' : 'ok'));
    }
    return out.join('');
  }

  async function runIndexCheck() {
    const box = document.getElementById('hl-idx-body'), btn = document.getElementById('hl-idx-run');
    if (!box) return;
    box.classList.remove('hidden');
    box.innerHTML = '<p class="muted">검사 중…</p>';
    if (btn) btn.disabled = true;
    try {
      const d = await API.healthIndexes(true);
      const esc = UI.escapeHtml;
      const unused = d.unused.length
        ? `<table class="hl-table"><thead><tr><th>테이블</th><th>인덱스</th><th class="num">크기</th></tr></thead><tbody>
            ${d.unused.map((x) => `<tr><td>${esc(x.table)}</td><td>${esc(x.index)}</td><td class="num">${UI.bytes(x.bytes)}</td></tr>`).join('')}</tbody></table>
           <p class="muted" style="font-size:12px">합계 ${UI.bytes(d.unusedBytes)} — PK·UNIQUE 는 무결성 목적이라 제외했습니다. 지우기 전에 통계가 충분히 쌓였는지 확인하세요.</p>`
        : '<p class="muted">쓰이지 않는 인덱스가 없습니다. 👍</p>';
      const need = d.needIndex.length
        ? `<table class="hl-table"><thead><tr><th>테이블</th><th class="num">행</th><th class="num">순차</th><th class="num">인덱스</th><th class="num">순차비율</th></tr></thead><tbody>
            ${d.needIndex.map((x) => `<tr><td>${esc(x.table)}</td><td class="num">${x.rows.toLocaleString()}</td><td class="num">${x.seqScan.toLocaleString()}</td><td class="num">${x.idxScan.toLocaleString()}</td><td class="num" style="color:var(--danger);font-weight:700">${x.seqPct}%</td></tr>`).join('')}</tbody></table>`
        : '<p class="muted">인덱스가 부족해 보이는 테이블이 없습니다. 👍</p>';
      box.innerHTML = `<div class="dash-2col" style="margin:0">
          <div><div class="hl-sub">🗑️ 쓰이지 않는 인덱스 (${d.unused.length}개)</div>${unused}</div>
          <div><div class="hl-sub">🔎 인덱스가 필요해 보이는 테이블 (${d.needIndex.length}개)</div>${need}</div>
        </div>
        <p class="muted" style="font-size:11px;margin-top:8px">${esc(d.note)} · 검사 시각 ${new Date(d.at).toLocaleString('ko-KR')}</p>`;
    } catch (e) { box.innerHTML = `<p class="muted" style="color:var(--danger)">${UI.escapeHtml(e.message)}</p>`; }
    finally { if (btn) { btn.disabled = false; btn.textContent = '다시 검사'; } }
  }

  // ── 정기 점검 (S7 S8 S9 S24 S26 S29) ───
  // 앱 안에서 도는 점검과 서버 스크립트가 남긴 결과를 한 화면에 모은다.
  const CK_META = {
    integrity:       { icon: '🧩', title: '파일 실물 ↔ DB 정합성', how: 'app',  every: '매주',  desc: '목록엔 보이는데 실제 파일이 없는 것, 크기가 기록과 다른 것, 주인 없는 파일을 찾습니다.' },
    cleanup:         { icon: '🧹', title: '좀비 리소스 정리 리포트', how: 'app',  every: '매일',  desc: '지금 지우면 얼마나 회수되는지 — 휴지통·캐시·중단된 업로드·만료 번들.' },
    'audit-chain':   { icon: '🔗', title: '감사로그 변조 탐지',      how: 'app',  every: '필요할 때', desc: '감사 기록을 앞 기록의 해시와 엮어 둡니다. 누가 한 줄이라도 고치거나 지우면 여기서 드러납니다.' },
    'backup-verify': { icon: '🔐', title: '백업 무결성 검증',        how: 'host', every: '매일',  desc: '백업이 끝까지 풀리는지, 덤프가 잘리지 않았는지, 해시가 그대로인지 확인합니다.',
      cmd: './scripts/bookjeok-verify-backups.sh' },
    'restore-drill': { icon: '🚑', title: '백업 복원 리허설',        how: 'host', every: '매주',  desc: '최신 백업을 임시 DB에 실제로 복원해 봅니다. 운영 DB는 건드리지 않습니다.',
      cmd: './scripts/bookjeok-restore-drill.sh' },
    deps:            { icon: '📦', title: '의존성 취약점 점검',      how: 'host', every: '매주',  desc: '쓰고 있는 패키지에 새로 공개된 취약점이 있는지 확인합니다.',
      cmd: './scripts/bookjeok-audit-deps.sh' },
    deploy:          { icon: '🚀', title: '마지막 배포',              how: 'host', every: '필요할 때', desc: '배포 결과입니다. 건강검진에 실패하면 자동으로 이전 버전으로 되돌립니다.',
      cmd: './scripts/bookjeok-deploy.sh --pull' },
  };
  const ckAgo = (iso) => {
    if (!iso) return '아직 실행된 적 없음';
    const s = Math.floor((Date.now() - new Date(iso)) / 1000);
    const t = s < 3600 ? `${Math.max(1, Math.floor(s / 60))}분 전` : s < 86400 ? `${Math.floor(s / 3600)}시간 전` : `${Math.floor(s / 86400)}일 전`;
    return `${t} · ${new Date(iso).toLocaleString('ko-KR')}`;
  };
  // 마지막 실행이 예정 주기의 3배를 넘겼으면 '점검이 멈춘 것' — 결과보다 이게 더 큰 문제다.
  // 배포처럼 '주기가 없는' 것은 오래됐다고 문제가 아니다.
  const ckStale = (iso, every) => {
    if (every === '필요할 때') return false;
    if (!iso) return true;
    const limit = (every === '매일' ? 1 : 7) * 3 * 86400000;
    return Date.now() - new Date(iso) > limit;
  };

  async function loadCheckups() {
    const view = document.getElementById('view');
    view.innerHTML = '<div class="empty"><div class="big">⏳</div>불러오는 중…</div>';
    let d;
    try { d = (await API.checkups()).checkups; }
    catch (err) { view.innerHTML = `<div class="empty">⚠️ ${UI.escapeHtml(err.message)}</div>`; return; }
    view.innerHTML = Object.keys(CK_META).map((k) => ckCard(k, d[k])).join('')
      + ckLoadTestCard();
    view.querySelectorAll('[data-ckrun]').forEach((el) => el.addEventListener('click', () => runCheckup(el.dataset.ckrun, el.dataset.deep === '1')));
    view.querySelectorAll('[data-copy]').forEach((el) => el.addEventListener('click', () => {
      navigator.clipboard.writeText(el.dataset.copy).then(() => UI.toast('명령을 복사했습니다', 'success')).catch(() => UI.toast('복사하지 못했습니다', 'error'));
    }));
  }

  function ckCard(key, r) {
    const m = CK_META[key], esc = UI.escapeHtml;
    const stale = ckStale(r && r.at, m.every);
    const level = !r ? 'info' : (r.ok === false ? 'danger' : stale ? 'warn' : 'ok');
    const L = LV[level] || LV.info;
    const runBtn = m.how === 'app'
      ? `<button class="btn btn-sm btn-secondary" data-ckrun="${key}">지금 검사</button>` +
        (key === 'integrity' ? `<button class="btn btn-sm btn-ghost" data-ckrun="${key}" data-deep="1" title="크기까지 대조합니다 — 파일이 많으면 오래 걸립니다">정밀 검사</button>` : '')
      : `<button class="btn btn-sm btn-ghost" data-copy="${esc(m.cmd)}" title="서버에서 실행할 명령을 복사합니다">명령 복사</button>`;
    return `<div class="dash-card ck-card" style="border-left:4px solid ${L.c}">
      <div class="dash-h">${m.icon} ${esc(m.title)}
        <span class="ck-badge">${m.how === 'app' ? '앱' : '서버 스크립트'} · ${m.every}</span>
        <span style="flex:1"></span>${runBtn}</div>
      <p class="muted" style="font-size:12px;margin:0 0 6px">${esc(m.desc)}</p>
      <div class="ck-when ${stale ? 'stale' : ''}">${L.i} 마지막 실행: ${esc(ckAgo(r && r.at))}${stale && r ? ' — 예정보다 오래 안 돌았습니다' : ''}</div>
      <div class="ck-body" id="ck-${key}">${r ? ckBody(key, r) : ckNeverHTML(m)}</div>
    </div>`;
  }
  function ckNeverHTML(m) {
    return m.how === 'app'
      ? '<p class="muted">서버가 뜬 지 얼마 안 됐거나 아직 예정 시각이 오지 않았습니다. 위 버튼으로 바로 돌려볼 수 있습니다.</p>'
      : `<p class="muted">서버에서 아래 명령을 한 번 돌리면 여기에 결과가 뜹니다. 크론에 넣어두면 자동으로 갱신됩니다.</p>
         <pre class="ck-cmd">${UI.escapeHtml(m.cmd)}</pre>`;
  }

  function ckBody(key, r) {
    const esc = UI.escapeHtml, B = UI.bytes;
    if (r.error) return `<p class="muted" style="color:var(--danger)">${esc(r.error)}</p>`;

    if (key === 'integrity') {
      const rows = [];
      if (r.missingCount) rows.push(`<tr><td>실물이 없는 파일</td><td class="num" style="color:var(--danger);font-weight:700">${r.missingCount}건</td><td class="num">${B(r.missingBytes)}</td></tr>`);
      if (r.mismatchCount) rows.push(`<tr><td>크기가 기록과 다른 파일</td><td class="num" style="color:var(--danger);font-weight:700">${r.mismatchCount}건</td><td class="num">—</td></tr>`);
      if (r.orphanCount) rows.push(`<tr><td>DB에 없는 실물 파일</td><td class="num">${r.orphanCount}건</td><td class="num">${B(r.orphanBytes)}</td></tr>`);
      const sample = (r.missing || []).slice(0, 10).map((x) => `<li>${esc(x.name)} <span class="muted">${esc(x.folder)} · ${B(x.size)}${x.trashed ? ' · 휴지통' : ''}</span></li>`).join('');
      return `<div class="ck-sum">${r.checked.toLocaleString()}건 검사 · ${(r.elapsedMs / 1000).toFixed(1)}초 소요${r.deep ? ' · 정밀(크기 대조)' : ''}</div>`
        + (rows.length
          ? `<table class="hl-table"><tbody>${rows.join('')}</tbody></table>`
            + (sample ? `<div class="ck-sub">실물이 없는 파일 (앞 10개)</div><ul class="ck-list">${sample}</ul>` : '')
            + `<p class="muted" style="font-size:11px">${esc(r.note)}</p>`
          : '<p class="ck-good">✅ 모든 파일이 기록과 일치합니다.</p>');
    }

    if (key === 'cleanup') {
      const max = Math.max(1, ...r.items.map((x) => x.bytes));
      return `<div class="ck-sum">지금 회수 가능: <b>${B(r.reclaimableBytes)}</b> · 휴지통(보관기간 내) ${B(r.trashLiveBytes)} · 디스크 ${r.disk.usedPct}% 사용</div>`
        + `<table class="hl-table"><thead><tr><th>항목</th><th class="num">개수</th><th class="num">크기</th><th style="width:34%"></th></tr></thead><tbody>
            ${r.items.map((x) => `<tr><td>${esc(x.label)}<div class="muted" style="font-size:11px">${esc(x.hint)}</div></td>
              <td class="num">${x.count.toLocaleString()}</td><td class="num">${x.bytes ? B(x.bytes) : '—'}</td>
              <td><span class="ck-bar"><span style="width:${(x.bytes / max * 100).toFixed(1)}%"></span></span></td></tr>`).join('')}
          </tbody></table><p class="muted" style="font-size:11px">${esc(r.note)}</p>`;
    }

    if (key === 'backup-verify') {
      const bad = (r.files || []).filter((f) => f.status !== 'ok');
      const st = { ok: '정상', corrupt: '압축 손상', truncated: '덤프 중단', notdump: '덤프 아님', changed: '해시 변경' };
      return `<div class="ck-sum">${r.checked}개 검사 · 실패 ${r.failed}개${r.newHashes ? ` · 해시 신규등록 ${r.newHashes}개` : ''}</div>`
        + (bad.length ? '' : '<p class="ck-good">✅ 검사한 백업이 모두 정상입니다.</p>')
        + `<table class="hl-table"><thead><tr><th>백업</th><th class="num">크기</th><th>상태</th><th>해시</th></tr></thead><tbody>
            ${(r.files || []).map((f) => `<tr>
              <td>${esc(f.name)}${f.detail ? `<div class="muted" style="font-size:11px">${esc(f.detail)}</div>` : ''}</td>
              <td class="num">${B(f.size)}</td>
              <td style="${f.status === 'ok' ? '' : 'color:var(--danger);font-weight:700'}">${esc(st[f.status] || f.status)}</td>
              <td class="muted" style="font-size:11px">${esc(f.hash)}… ${f.hashState === 'changed' ? '<b style="color:var(--danger)">변경됨</b>' : f.hashState === 'new' ? '신규' : '일치'}</td>
            </tr>`).join('')}</tbody></table>`;
    }

    if (key === 'restore-drill') {
      return `<div class="ck-sum">${esc(r.file || '')} · ${r.elapsedSec}초</div>`
        + `<p class="${r.ok ? 'ck-good' : 'ck-bad'}">${r.ok ? '✅' : '🚨'} ${esc(r.detail || '')}</p>`
        + ((r.tables || []).length
          ? `<table class="hl-table"><thead><tr><th>테이블</th><th class="num">복원본</th><th class="num">운영</th></tr></thead><tbody>
              ${r.tables.map((t) => `<tr><td>${esc(t.table)}</td><td class="num"${t.odd ? ' style="color:var(--danger);font-weight:700"' : ''}>${Number(t.restored).toLocaleString()}</td><td class="num">${Number(t.live).toLocaleString()}</td></tr>`).join('')}
            </tbody></table><p class="muted" style="font-size:11px">백업 시점 이후의 변경분만큼은 차이가 나는 것이 정상입니다.</p>`
          : '');
    }

    if (key === 'audit-chain') {
      if (r.reason === 'not_initialized') return `<p class="ck-bad">🚨 ${esc(r.message)}</p>`;
      const TYPE = { modified: '내용이 바뀜', missing: '기록이 사라짐', broken_link: '연결이 끊김', tail_mismatch: '마지막이 안 맞음', tail_missing: '마지막이 사라짐' };
      return `<div class="ck-sum">${r.checked.toLocaleString()}건 검증 · ${r.elapsedMs}ms${r.prunedSeq ? ` · 보관기간 지나 정리된 앞부분 ${r.prunedSeq}건은 정상으로 봄` : ''}</div>`
        + (r.ok
          ? '<p class="ck-good">✅ 모든 기록이 남긴 그대로입니다. 고쳐지거나 지워진 흔적이 없습니다.</p>'
          : `<p class="ck-bad">🚨 ${r.problemCount}건의 이상이 발견됐습니다 — 누군가 DB를 직접 건드렸을 수 있습니다.</p>
             <table class="hl-table"><thead><tr><th>종류</th><th>위치</th><th>설명</th></tr></thead><tbody>
             ${r.problems.map((p) => `<tr><td style="color:var(--danger);font-weight:700">${esc(TYPE[p.type] || p.type)}</td><td class="num">${p.seq || (p.from ? `${p.from}~${p.to}` : '—')}</td><td>${esc(p.message)}</td></tr>`).join('')}
             </tbody></table>`)
        + (r.legacyRows ? `<p class="muted" style="font-size:11px">사슬 도입 전 기록 ${r.legacyRows.toLocaleString()}건은 해시가 없어 검증 대상이 아닙니다.</p>` : '')
        + `<p class="muted" style="font-size:11px">${esc(r.note || '')}</p>`;
    }

    if (key === 'deploy') {
      return `<div class="ck-sum">${esc(r.fromCommit || '?')} → ${esc(r.toCommit || '?')} · ${r.elapsedSec}초 · 단계 ${esc(r.stage || '')}</div>`
        + `<p class="${r.ok ? 'ck-good' : 'ck-bad'}">${r.ok ? '✅' : r.rolledBack ? '↩️' : '🚨'} ${esc(r.detail || '')}</p>`
        + (r.rolledBack ? '<p class="muted" style="font-size:12px">서비스는 이전 버전으로 계속 돌아가고 있습니다. 원인을 고친 뒤 다시 배포하세요.</p>' : '');
    }

    if (key === 'deps') {
      const v = r.vulnerabilities || {};
      const chip = (k, label, color) => (v[k] ? `<span class="ck-chip" style="background:${color}">${label} ${v[k]}</span>` : '');
      return `<div class="ck-sum">${chip('critical', '치명', 'var(--danger)')}${chip('high', '높음', '#f0a500')}${chip('moderate', '보통', '#118AB2')}${chip('low', '낮음', '#868E96')}${v.total ? '' : '<span class="ck-good">✅ 알려진 취약점이 없습니다.</span>'}</div>`
        + ((r.packages || []).length
          ? `<table class="hl-table"><thead><tr><th>패키지</th><th>심각도</th><th>내용</th><th>수정</th></tr></thead><tbody>
              ${r.packages.map((p) => `<tr><td>${esc(p.name)}${p.direct ? ' <span class="muted" style="font-size:11px">직접 의존</span>' : ''}</td>
                <td style="${['critical', 'high'].includes(p.severity) ? 'color:var(--danger);font-weight:700' : ''}">${esc(p.severity)}</td>
                <td class="muted" style="font-size:11px">${esc((p.via || []).join(' · ')).slice(0, 120)}</td>
                <td class="muted" style="font-size:11px">${esc(p.fixAvailable)}</td></tr>`).join('')}
            </tbody></table><p class="muted" style="font-size:11px">${esc(r.note || '')}</p>`
          : '');
    }
    return '';
  }

  // S29 — 부하 테스트는 화면에서 돌릴 일이 아니다(운영에 부하를 준다). 실행 방법만 안내.
  function ckLoadTestCard() {
    const cmd = "node scripts/bookjeok-loadtest.js --url https://bookjeok.cjs0509.xyz --user admin --pass '비밀번호' --totp 123456 --users 20 --duration 30 --yes";
    return `<div class="dash-card ck-card" style="border-left:4px solid #118AB2">
      <div class="dash-h">🏋️ 부하 테스트 <span class="ck-badge">서버 스크립트 · 필요할 때</span>
        <span style="flex:1"></span><button class="btn btn-sm btn-ghost" data-copy="${UI.escapeHtml(cmd)}">명령 복사</button></div>
      <p class="muted" style="font-size:12px;margin:0 0 6px">동시 사용자를 늘려가며 몇 명까지 버티는지 재봅니다. 읽기 전용이라 데이터는 바뀌지 않지만, 실제 서버에 부하를 주니 한가한 시간에 짧게 시작하세요.</p>
      <pre class="ck-cmd">${UI.escapeHtml(cmd)}</pre>
      <p class="muted" style="font-size:11px">--users 를 10 → 20 → 40 으로 올려가며 반복하면, 오류율이 오르거나 p95 가 꺾이는 지점이 이 서버의 한계입니다.
      이 페이지의 <b>상태</b> 탭을 함께 열어 두면 그 순간 무엇이 병목인지(이벤트루프·DB 커넥션) 같이 보입니다.</p>
    </div>`;
  }

  async function runCheckup(name, deep) {
    const box = document.getElementById('ck-' + name);
    if (box) box.innerHTML = '<p class="muted">검사 중… (파일이 많으면 몇 분 걸릴 수 있습니다)</p>';
    try {
      // 감사로그 검증은 전용 엔드포인트를 쓴다(전체를 다시 계산하므로)
      const r = name === 'audit-chain' ? await API.verifyAuditChain() : await API.runCheckup(name, deep);
      if (box) box.innerHTML = ckBody(name, r);
      UI.toast('점검을 마쳤습니다', 'success');
      loadCheckups();   // 마지막 실행 시각·색상까지 새로 반영
    } catch (e) {
      if (box) box.innerHTML = `<p class="muted" style="color:var(--danger)">${UI.escapeHtml(e.message)}</p>`;
      UI.toast(e.message, 'error');
    }
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
        <td><span class="badge ${u.role}">${({admin:'관리자',manager:'담당자',user:'외부업체',branch:'영업점'})[u.role] || u.role}</span></td>
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
          <option value="user">외부업체 (본인 파일만)</option>
          <option value="branch">영업점 (본인 파일만 · 담당자 접근 불가, 관리자만 열람)</option>
          <option value="manager">담당자 (외부업체 파일 열람·업로드, 관리기능 제외)</option>
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
          <option value="user" ${u.role === 'user' ? 'selected' : ''}>외부업체</option>
          <option value="branch" ${u.role === 'branch' ? 'selected' : ''}>영업점</option>
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
          <div style="flex:1"></div>
          <button class="btn btn-secondary" id="bulk-branch-accts" title="현재 등록된 영업점으로 kyobo_코드 계정을 만듭니다">🔑 영업점 계정 일괄생성</button>
          <button class="btn btn-primary" id="add-branch">＋ 영업점 추가</button>
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
      document.getElementById('bulk-branch-accts').addEventListener('click', branchAccountsModal);
      document.getElementById('branch-search').addEventListener('input', (e) => renderGrid(e.target.value));
    } catch (err) { view.innerHTML = `<div class="empty">⚠️ ${UI.escapeHtml(err.message)}</div>`; }
  }

  // 영업점 계정 일괄생성 — 미리보기(무엇이 생성될지) → 확인 후 생성. 초기 비번=아이디, 용량은 관리자 풀(무제한).
  async function branchAccountsModal() {
    let data;
    try { data = await API.branchAccountsPreview(); } catch (err) { return UI.toast(err.message, 'error'); }
    const { items } = data;
    const willCreate = items.filter((x) => x.matched && !x.exists);
    const existing = items.filter((x) => x.exists);
    const unmatched = items.filter((x) => !x.matched);
    const row = (x) => {
      const st = x.exists ? `<span class="muted">이미 있음</span>` : (x.matched ? '<span style="color:var(--accent,#06D6A0)">생성 예정</span>' : '<span style="color:var(--danger)">코드 없음</span>');
      const cb = (x.matched && !x.exists) ? `<input type="checkbox" class="ba-cb" value="${x.code}" checked>` : '';
      return `<tr><td style="text-align:center">${cb}</td><td>${UI.escapeHtml(x.branchName)}</td><td class="num">${x.code || '—'}</td><td><span style="font-family:monospace">${x.username ? UI.escapeHtml(x.username) : '—'}</span></td><td>${st}</td></tr>`;
    };
    const m = UI.modal(`<h3>🔑 영업점 계정 일괄생성</h3>
      <p style="font-size:13px;color:var(--text-muted);margin:0 0 10px">현재 등록된 영업점 ${items.length}개 중 <b>생성 예정 ${willCreate.length}개</b> · 이미 있음 ${existing.length} · 코드없음 ${unmatched.length}. 아이디=<b>kyobo_코드</b>, 초기 비밀번호=아이디와 동일. 용량은 <b>관리자 풀(무제한)</b>에 귀속됩니다.</p>
      <div style="margin-bottom:10px"><label style="font-size:13px;display:inline-flex;align-items:center;gap:6px"><input type="checkbox" id="ba-all" checked> 전체 선택</label></div>
      <div class="table-wrap" style="max-height:46vh;overflow:auto"><table class="filetable"><thead><tr><th style="width:36px"></th><th>영업점</th><th>코드</th><th>아이디</th><th>상태</th></tr></thead><tbody>${items.map(row).join('')}</tbody></table></div>
      <div id="ba-result" style="margin-top:10px"></div>
      <div class="modal-actions"><button class="btn btn-ghost" id="ba-cancel">닫기</button><button class="btn btn-primary" id="ba-create" ${willCreate.length ? '' : 'disabled'}>선택 계정 생성</button></div>`);
    m.el.querySelector('.modal').classList.add('modal-wide');
    const cbs = () => Array.from(m.el.querySelectorAll('.ba-cb'));
    m.q('#ba-all').addEventListener('change', (e) => cbs().forEach((c) => { c.checked = e.target.checked; }));
    m.q('#ba-cancel').addEventListener('click', m.close);
    m.q('#ba-create').addEventListener('click', async () => {
      const codes = cbs().filter((c) => c.checked).map((c) => c.value);
      if (!codes.length) return UI.toast('생성할 계정을 선택하세요.', 'error');
      const ok = await UI.confirm({ title: '영업점 계정 생성', confirmText: '생성', message: `${codes.length}개 계정을 생성합니다.\n초기 비밀번호는 아이디와 동일하며, 용량은 관리자 풀(무제한)에 귀속됩니다.` });
      if (!ok) return;
      const btn = m.q('#ba-create'); btn.disabled = true; btn.textContent = '생성 중…';
      try {
        const res = await API.branchAccountsCreate({ codes });
        const lines = res.created.map((c) => `${c.username},${c.password},${c.branchName}`).join('\n');
        m.q('#ba-result').innerHTML = `<div class="card" style="padding:12px"><b>✅ ${res.created.length}개 생성 완료</b>${res.skipped.length ? ` · 건너뜀 ${res.skipped.length}` : ''}
          ${res.created.length ? `<p class="muted" style="font-size:12px;margin:6px 0 4px">아이디,비밀번호,영업점 (아래를 복사해 보관하세요)</p><pre class="pp-text" style="user-select:all;white-space:pre-wrap;max-height:160px;overflow:auto;font-family:monospace;font-size:12px">${UI.escapeHtml(lines)}</pre><button class="btn btn-ghost btn-sm" id="ba-copy">📋 계정 목록 복사</button>` : ''}</div>`;
        const cp = m.q('#ba-copy'); if (cp) cp.addEventListener('click', () => { try { navigator.clipboard.writeText('아이디,비밀번호,영업점\n' + lines); UI.toast('복사했습니다', 'success'); } catch (_) { UI.toast('복사 실패', 'error'); } });
        btn.textContent = '완료'; UI.toast(`${res.created.length}개 계정 생성`, 'success');
        loadBranches();
      } catch (err) { UI.toast(err.message, 'error'); btn.disabled = false; btn.textContent = '선택 계정 생성'; }
    });
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
        const roleLbl = { admin: '관리자', manager: '담당자', user: '외부업체', branch: '영업점' };
        const roles = Array.isArray(n.target_roles) ? n.target_roles : ['admin', 'manager', 'user', 'branch'];
        const roleText = roles.length >= 4 ? '전체' : roles.map((r) => roleLbl[r] || r).join(', ');
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
          ${[['admin', '관리자'], ['manager', '담당자'], ['user', '외부업체'], ['branch', '영업점']].map(([v, lbl]) => {
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
      let gen = { trashRetentionDays: 30, shareQrEnabled: true };
      try { gen = await API.getGeneralSettings(); } catch {}
      view.innerHTML = `
        <div class="ext-group" id="gen-settings">
          <div class="ext-group-head"><span>⚙️ 일반 설정</span></div>
          <div style="display:flex;flex-wrap:wrap;gap:18px;align-items:center;padding:6px 2px">
            <label style="display:flex;align-items:center;gap:8px;font-size:14px">🗑️ 휴지통 보관일수
              <input class="input" id="gen-trash" type="number" min="1" max="3650" value="${gen.trashRetentionDays}" style="width:90px"> 일</label>
            <label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer">📱 공유 링크 QR 코드
              <input type="checkbox" id="gen-qr" ${gen.shareQrEnabled ? 'checked' : ''} style="width:18px;height:18px"></label>
            <div style="flex:1"></div>
            <button class="btn btn-secondary btn-sm" id="save-gen">일반 설정 저장</button>
          </div>
        </div>
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
      document.getElementById('save-gen').addEventListener('click', async () => {
        try {
          const r = await API.setGeneralSettings({ trashRetentionDays: parseInt(document.getElementById('gen-trash').value, 10), shareQrEnabled: document.getElementById('gen-qr').checked });
          UI.toast(`일반 설정 저장됨 (휴지통 ${r.trashRetentionDays}일, QR ${r.shareQrEnabled ? 'ON' : 'OFF'})`, 'success');
        } catch (err) { UI.toast(err.message, 'error'); }
      });
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

  // ── 백업 현황 ──────────────────────────
  // 방침: 일간 백업 = 구글 드라이브(DB+파일 전체). 로컬 DB 덤프는 빠른 복구용 사본.
  async function loadBackup() {
    const view = document.getElementById('view');
    view.innerHTML = '<div class="empty"><div class="big">⏳</div>확인 중…</div>';
    const ago = (iso) => { if (!iso) return '기록 없음'; const mi = Math.floor((Date.now() - new Date(iso).getTime()) / 60000); if (mi < 1) return '방금'; if (mi < 60) return mi + '분 전'; if (mi < 1440) return Math.floor(mi / 60) + '시간 전'; return Math.floor(mi / 1440) + '일 전'; };
    const fresh = (iso, hrs) => iso && (Date.now() - new Date(iso).getTime()) < hrs * 3600000;
    const when = (iso) => (iso ? new Date(iso).toLocaleString('ko-KR') : '-');
    // 로컬 날짜키(YYYY-MM-DD) — 백엔드 KST 키와 맞추기 위해 로컬 구성요소 사용(사용자=국내)
    const dkey = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    const mondayOf = (dt) => { const d = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; };
    const weeksInMonth = (y, m0) => { const last = new Date(y, m0 + 1, 0); const weeks = []; let cur = mondayOf(new Date(y, m0, 1)); while (cur <= last) { weeks.push(new Date(cur)); cur = new Date(cur); cur.setDate(cur.getDate() + 7); } return weeks; };
    const WD = ['월', '화', '수', '목', '금', '토', '일'];
    try {
      const s = await API.backupStatus();
      const { db, offsite, dbList = [], dayMap = {} } = s;

      // 로컬 목록이 아직 없으면(구버전 스크립트) 최신 단일 상태(db.json)로 1건이라도 채운다
      let list = dbList.slice();
      if (!list.length && db && db.file) list = [{ name: db.file, size: db.size, at: db.at }];
      // 날짜별 로컬 DB 덤프 묶기(그리드에서 일자 클릭 시 상세로 사용)
      const byDate = {};
      for (const x of list) { const m = /(\d{4}-\d{2}-\d{2})/.exec(x.name || ''); const k = m ? m[1] : (x.at ? dkey(new Date(x.at)) : null); if (k) (byDate[k] = byDate[k] || []).push(x); }
      const latestKey = (list[0] && (/(\d{4}-\d{2}-\d{2})/.exec(list[0].name || '') || [])[1])
        || Object.keys(dayMap).filter((k) => dayMap[k] === true).sort().pop()
        || dkey(new Date());

      const oDot = offsite ? (offsite.ok === false ? 'bad' : (fresh(offsite.at, 50) ? 'ok' : 'warn')) : 'bad';
      const dbDot = db ? (fresh(db.at, 26) ? 'ok' : 'warn') : 'bad';

      // 상단 요약 — 구글 일간을 메인으로, 로컬 덤프는 보조
      view.innerHTML = `
        <div class="stat-grid">
          <div class="stat"><div class="k">일간 백업 · 구글 드라이브</div><div class="v">${offsite ? `<span class="dot ${oDot}"></span>${ago(offsite.at)}${offsite.ok === false ? ' · ⚠️ 실패' : ''}` : '<span class="dot bad"></span><span class="muted">미설정</span>'}</div></div>
          <div class="stat"><div class="k">로컬 DB 덤프 (복구용)</div><div class="v"><span class="dot ${dbDot}"></span>${ago(db && db.at)}</div></div>
          <div class="stat"><div class="k">로컬 DB 덤프 보관</div><div class="v">${db ? (db.localCount || list.length || 0) + '개' : list.length + '개'}</div></div>
        </div>
        <div class="card" style="margin-bottom:14px">
          <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px">
            <h3 style="margin:0;flex:1 1 auto">📅 일자별 백업 <span class="muted" style="font-size:12px;font-weight:400">· 주차별(월요일 시작)</span></h3>
            <select id="bkYear" class="input" style="width:auto;padding:5px 8px"></select>
            <select id="bkMonth" class="input" style="width:auto;padding:5px 8px"></select>
            <select id="bkWeek" class="input" style="width:auto;padding:5px 8px"></select>
          </div>
          <div id="bkGrid"></div>
          <p class="muted" style="font-size:11px;margin-top:8px">✅ 성공 · ❌ 실패/누락 · – 기록 없음 &nbsp;|&nbsp; 일자를 누르면 아래에 그 날 백업이 표시됩니다. 일간 백업(DB+파일)은 구글 드라이브로 올라갑니다.</p>
        </div>
        <div class="card" id="bkDetail"></div>`;

      const now = new Date();
      const yearsSet = new Set([now.getFullYear()]);
      Object.keys(dayMap).forEach((k) => yearsSet.add(+k.slice(0, 4)));
      list.forEach((x) => { const m = /(\d{4})-/.exec(x.name || ''); if (m) yearsSet.add(+m[1]); });
      const years = [...yearsSet].sort((a, b) => b - a);
      const state = { y: now.getFullYear(), m0: now.getMonth(), wIdx: 0 };

      const $y = view.querySelector('#bkYear'), $m = view.querySelector('#bkMonth'), $w = view.querySelector('#bkWeek');
      const $grid = view.querySelector('#bkGrid'), $detail = view.querySelector('#bkDetail');
      $y.innerHTML = years.map((y) => `<option value="${y}">${y}년</option>`).join('');
      $m.innerHTML = Array.from({ length: 12 }, (_, i) => `<option value="${i}">${i + 1}월</option>`).join('');

      function fillWeeks() {
        const wk = weeksInMonth(state.y, state.m0);
        $w.innerHTML = wk.map((mon, i) => { const end = new Date(mon); end.setDate(end.getDate() + 6); return `<option value="${i}">${i + 1}주차 (${mon.getMonth() + 1}/${mon.getDate()}~${end.getMonth() + 1}/${end.getDate()})</option>`; }).join('');
        // 오늘이 이 달이면 오늘 포함 주차를 기본 선택
        if (state.y === now.getFullYear() && state.m0 === now.getMonth()) {
          const tMon = +mondayOf(now); const idx = wk.findIndex((mon) => +mon === tMon); state.wIdx = idx >= 0 ? idx : 0;
        } else if (state.wIdx >= wk.length) state.wIdx = 0;
        $w.value = String(state.wIdx);
        return wk;
      }

      function renderGrid() {
        const wk = weeksInMonth(state.y, state.m0);
        const mon = wk[state.wIdx] || wk[0];
        const cells = Array.from({ length: 7 }, (_, i) => {
          const d = new Date(mon); d.setDate(d.getDate() + i); const k = dkey(d);
          const ok = Object.prototype.hasOwnProperty.call(dayMap, k) ? dayMap[k] : null;
          const icon = ok === true ? '✅' : ok === false ? '<span style="color:var(--danger)">❌</span>' : '<span class="muted">–</span>';
          const inMonth = d.getMonth() === state.m0;
          const sel = k === selDate;
          return `<td data-day="${k}" style="text-align:center;padding:8px 6px;cursor:pointer;border-radius:8px;${sel ? 'background:var(--accent-soft,#fff4d6);box-shadow:inset 0 0 0 2px var(--accent,#f5b301)' : ''};opacity:${inMonth ? 1 : 0.45}">
            <div style="font-size:11px;color:var(--text-muted)">${WD[i]}</div>
            <div style="font-size:13px;font-weight:600;margin:2px 0">${d.getMonth() + 1}/${d.getDate()}</div>
            <div style="font-size:16px">${icon}</div></td>`;
        }).join('');
        $grid.innerHTML = `<div class="table-wrap"><table style="width:100%;border-collapse:separate;border-spacing:4px"><tr>${cells}</tr></table></div>`;
        $grid.querySelectorAll('[data-day]').forEach((c) => c.addEventListener('click', () => { selDate = c.dataset.day; renderGrid(); renderDetail(); }));
      }

      // 복사 가능한 명령어 블록(선택한 날짜 맥락)
      const cmdPre = (cmd) => `<div style="display:flex;gap:6px;align-items:flex-start;margin-top:6px">
          <pre class="pp-text" style="flex:1;user-select:all;white-space:pre-wrap;font-family:monospace;font-size:12px;margin:0">${UI.escapeHtml(cmd)}</pre>
          <button class="btn btn-ghost btn-sm" data-copy="${UI.escapeHtml(cmd)}">📋</button></div>`;

      function renderDetail() {
        const entries = byDate[selDate] || [];
        const okState = Object.prototype.hasOwnProperty.call(dayMap, selDate) ? dayMap[selDate] : null;
        let dbBlock;
        if (entries.length) {
          dbBlock = `<div class="table-wrap"><table><thead><tr><th>시각</th><th>파일</th><th style="text-align:right">크기</th><th></th></tr></thead><tbody>${entries.map((x) => `<tr>
              <td style="white-space:nowrap">${when(x.at)}</td>
              <td><span class="muted" style="font-family:monospace;font-size:12px">${UI.escapeHtml(x.name)}</span></td>
              <td style="text-align:right">${x.size ? UI.bytes(x.size) : '-'}</td>
              <td style="text-align:right"><button class="btn btn-ghost btn-sm" data-restore="${UI.escapeHtml(x.name)}">↩ 이 백업으로 복구</button></td>
            </tr>`).join('')}</tbody></table></div>
            <p class="muted" style="font-size:12px;margin-top:8px">로컬 덤프로 빠르게 복구합니다. 구글 드라이브에도 같은 덤프가 보관됩니다.</p>`;
        } else if (okState === true) {
          dbBlock = `<p style="font-size:13px;color:var(--text-muted);margin:0">이 날은 <b>구글 드라이브 백업만</b> 있습니다(로컬 덤프 없음). 구글에서 이 날짜 덤프를 받아 복구하세요:</p>
            ${cmdPre(`rclone copy gdrive:bookjeok-backup/db ~/bookjeok-backups --include 'bookjeok-db-*${selDate}*'`)}
            ${cmdPre(`cd ~/Book-Jeok && BOOKJEOK_RESTORE_FILE=$(ls -t ~/bookjeok-backups/bookjeok-db-*${selDate}* | head -1 | xargs -n1 basename) ./scripts/restore.sh`)}`;
        } else if (okState === false) {
          dbBlock = `<p style="color:var(--danger);margin:0">이 날 백업이 <b>실패</b>로 기록되었습니다. 스케줄/로그를 확인하세요.</p>`;
        } else {
          dbBlock = `<p class="muted" style="margin:0">이 날 백업 기록이 없습니다.</p>`;
        }
        // 파일 복원 — storage/=최신 미러, storage-archive/<날짜>/=그날 삭제·변경된 예전 버전(60일 보관)
        const fileBlock = `<h4 style="margin:16px 0 4px">📁 이 날짜 파일 복원</h4>
          <p class="muted" style="font-size:12px;margin:0"><b>${selDate}</b>에 삭제·변경된 예전 파일은 <code style="font-family:monospace">storage-archive/${selDate}/</code>에 60일간 보관됩니다.</p>
          <p class="muted" style="font-size:12px;margin:8px 0 0">① 이 날 사라진/바뀐 파일 목록 보기</p>
          ${cmdPre(`rclone lsf gdrive:bookjeok-backup/storage-archive/${selDate}/ -R`)}
          <p class="muted" style="font-size:12px;margin:8px 0 0">② 그 예전 버전을 되받기(제자리로)</p>
          ${cmdPre(`rclone copy gdrive:bookjeok-backup/storage-archive/${selDate}/ /mnt/bookjeok-data/storage`)}
          <p class="muted" style="font-size:12px;margin:8px 0 0">전체 파일을 최신 상태로 되받기(계정 통째 복구용)</p>
          ${cmdPre('rclone copy gdrive:bookjeok-backup/storage /mnt/bookjeok-data/storage')}`;
        $detail.innerHTML = `<h3 style="margin-bottom:10px">🗄️ ${selDate} 백업 <span class="muted" style="font-size:13px;font-weight:400">${selDate === latestKey ? '· 최근 백업' : ''}</span></h3>${dbBlock}<div style="border-top:1px solid var(--border,#eee);margin-top:14px"></div>${fileBlock}`;
        $detail.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', () => restoreCmdModal(b.dataset.restore)));
        $detail.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => { try { navigator.clipboard.writeText(b.dataset.copy); UI.toast('명령을 복사했습니다', 'success'); } catch (_) { UI.toast('복사 실패 — 직접 선택해 복사하세요', 'error'); } }));
      }

      let selDate = latestKey;   // 상세 기본값 = 최근 백업 날짜
      // 그리드 기본 주차 = 오늘 포함 주(위 state 초기값). 최근 백업이 다른 달이어도 상세는 최근 백업을 보여준다.
      $y.value = String(state.y); $m.value = String(state.m0);
      $y.addEventListener('change', () => { state.y = +$y.value; fillWeeks(); renderGrid(); });
      $m.addEventListener('change', () => { state.m0 = +$m.value; fillWeeks(); renderGrid(); });
      $w.addEventListener('change', () => { state.wIdx = +$w.value; renderGrid(); });
      fillWeeks(); renderGrid(); renderDetail();
    } catch (err) {
      view.innerHTML = `<div class="card"><p style="color:var(--danger)">${UI.escapeHtml(err.message)}</p></div>`;
    }
  }

  // 선택한 DB 백업으로 복구 — 웹에서 직접 실행하지 않고(자기 DB 덮어쓰기 위험), 그 백업 전용 명령을 뽑아준다.
  function restoreCmdModal(name) {
    const cmd = `cd ~/Book-Jeok && BOOKJEOK_RESTORE_FILE=${name} ./scripts/restore.sh`;
    const m = UI.modal(`<h3>↩ DB 복구</h3>
      <p style="font-size:13px;color:var(--text-muted);margin:0 0 6px">선택: <b style="font-family:monospace">${UI.escapeHtml(name)}</b></p>
      <p style="font-size:13px;color:var(--text-muted);margin:0 0 8px">안전을 위해 <b>서버 터미널</b>에서 아래 명령을 실행하세요. 스크립트가 <b>복원 동안 API를 자동 정지</b>하고, <b>RESTORE</b> 입력 확인 후 복원하며, <b>복원 전 현재 DB도 자동 백업</b>합니다.</p>
      <pre class="pp-text" style="user-select:all;white-space:pre-wrap">${UI.escapeHtml(cmd)}</pre>
      <p style="font-size:12px;color:var(--text-muted);margin-top:8px">※ DB(메타데이터)만 복원됩니다. 파일은 구글 드라이브 백업에서 복원: <code style="font-family:monospace">rclone copy gdrive:bookjeok-backup/storage /mnt/bookjeok-data/storage</code></p>
      <div class="modal-actions"><button class="btn btn-ghost" id="cp">📋 명령 복사</button><button class="btn btn-primary" id="ok">닫기</button></div>`);
    m.q('#ok').addEventListener('click', m.close);
    m.q('#cp').addEventListener('click', () => { try { navigator.clipboard.writeText(cmd); UI.toast('명령을 복사했습니다', 'success'); } catch (_) { UI.toast('복사 실패 — 직접 선택해 복사하세요', 'error'); } });
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
          <td style="white-space:nowrap">${l.owner_username ? `${UI.escapeHtml(l.owner_display_name || l.owner_username)} <span class="muted" style="font-size:11px">@${UI.escapeHtml(l.owner_username)}</span>` : '<span class="muted">—</span>'}</td>
          <td style="white-space:nowrap"><code class="act-code">${UI.escapeHtml(l.action)}</code></td>
          <td style="white-space:nowrap"><span class="badge ${danger.has(l.action) ? 'off' : 'user'}">${UI.escapeHtml(actionKo(l.action))}</span></td>
          <td class="audit-detail">${UI.escapeHtml(l.detail)}</td>
          <td class="num" style="color:var(--text-muted);white-space:nowrap">${UI.escapeHtml(l.ip)}</td>
        </tr>`).join('');
      view.innerHTML = `<div class="table-wrap"><table class="audit-table"><thead><tr><th>시각</th><th>사용자</th><th>대상 계정</th><th>동작코드</th><th>동작명</th><th style="width:99%">상세</th><th>IP</th></tr></thead><tbody>${rows || '<tr><td colspan=7>기록 없음</td></tr>'}</tbody></table></div>`;
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
      const userFiles = s.accounts.reduce((a, x) => a + x.used, 0);
      const sysB = s.systemBytes || 0, freeB = s.diskFree != null ? s.diskFree : Math.max(0, s.diskTotal - userFiles - sysB);
      const pdfB = s.pdfCacheBytes || 0, bunB = s.bundleBytes || 0, otherSys = Math.max(0, sysB - pdfB - bunB);
      const totForBar = s.diskTotal || (userFiles + sysB + freeB) || 1;
      const seg = (bytes, cls, label) => bytes > 0 ? `<span class="cap-seg ${cls}" style="width:${(bytes / totForBar * 100).toFixed(2)}%" title="${label} ${UI.bytes(bytes)}"></span>` : '';
      view.innerHTML = `
        <div class="stat-grid">
          <div class="stat"><div class="k">디스크 전체</div><div class="v num">${UI.bytes(s.diskTotal)}</div></div>
          <div class="stat"><div class="k">사용자 파일 (전 계정)</div><div class="v num">${UI.bytes(userFiles)}</div></div>
          <div class="stat"><div class="k">시스템/기타</div><div class="v num">${UI.bytes(sysB)}</div><div class="k">변환캐시 ${UI.bytes(pdfB)} · 압축임시 ${UI.bytes(bunB)}</div></div>
          <div class="stat"><div class="k">디스크 실사용</div><div class="v num">${UI.bytes(s.diskUsedActual || 0)}</div><div class="k">여유 ${UI.bytes(freeB)}</div></div>
          <div class="stat"><div class="k">할당 합계</div><div class="v num">${UI.bytes(s.allocated)}</div></div>
          <div class="stat"><div class="k">할당 가능 (남음)</div><div class="v num">${UI.bytes(s.available)}</div></div>
        </div>
        <div class="cap-compo">
          <div class="cap-bar">${seg(userFiles, 'uf', '사용자 파일')}${seg(pdfB, 'pdf', '변환 캐시')}${seg(bunB, 'zip', '압축 임시')}${seg(otherSys, 'sys', '시스템·DB·기타')}${seg(freeB, 'free', '여유')}</div>
          <div class="cap-legend">
            <span><i class="uf"></i>사용자 파일 ${UI.bytes(userFiles)}</span>
            <span><i class="pdf"></i>변환 캐시 ${UI.bytes(pdfB)}</span>
            <span><i class="zip"></i>압축 임시 ${UI.bytes(bunB)}</span>
            <span><i class="sys"></i>시스템·DB·기타 ${UI.bytes(otherSys)}</span>
            <span><i class="free"></i>여유 ${UI.bytes(freeB)}</span>
          </div>
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
