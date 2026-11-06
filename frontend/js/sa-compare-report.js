/* 전 지점 재고조사 오차 비교(두 해) → 혼자 열리는 HTML 보고서(파일 하나, 인터넷 없이 동작)
   - 보기: 지점별(분야 펼치기) · 분야별(전 지점 합) · 지점×분야(평평한 표)
   - 필터: 검색(지점 · 분야) · 지점 고르기 · 분야 고르기 · 증감 방향(나빠진 곳만 · 좋아진 곳만 · 한 해만 있는 곳)
   - 열 제목 정렬 · 합계 줄 · 카드(전체 숫자) · 지점 누르면 상세(분야별 표 · 쓴 파일) · 📥 엑셀(시트 3개) · 🖨️ 인쇄
   - 사진 · 확인 같은 작업 기능은 없다(비교는 보는 용도).
   내려받을 때만 불러온다(app.js 의 전 지점 비교 창). 자료는 app.js 의 cmpBuild 결과(지점 · 분야별 요약)다. */
(function () {
  'use strict';

  const CSS = `
:root{--bg:#f6f7f9;--surface:#fff;--text:#1f2328;--muted:#6b7280;--border:#e5e7eb;--head:#f1f3f5;--accent:#f5b400;--accent-soft:#fff6d6;
  --neg:#d1242f;--neg-soft:#fff1f1;--pos:#0a7c42;--pos-soft:#ecfdf3;--chip:#eef2ff;--chip-text:#3b4cca;--group:#fafbfc;--shadow:0 12px 40px rgba(0,0,0,.18)}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--surface:#171a21;--text:#e6e8eb;--muted:#9aa3ae;--border:#2a2f3a;--head:#1d212a;--accent:#f5b400;--accent-soft:#3a2f0a;
  --neg:#ff6b6b;--neg-soft:#3a1517;--pos:#4ade80;--pos-soft:#0f2a1a;--chip:#232a45;--chip-text:#a5b4fc;--group:#1a1e26;--shadow:0 12px 40px rgba(0,0,0,.6)}}
*{box-sizing:border-box}html,body{margin:0}
body{background:var(--bg);color:var(--text);font:14px/1.5 "Pretendard","Apple SD Gothic Neo","Malgun Gothic",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:1680px;margin:0 auto;padding:20px 20px 40px}
header{display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px}header .ttl{flex:1 1 auto}
header h1{margin:0;font-size:22px;letter-spacing:-.3px}header .sub{color:var(--muted);font-size:13px;margin-top:4px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:16px 0}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:11px 14px}
.card .k{font-size:12px;color:var(--muted)}.card .v{font-size:21px;font-weight:800;margin-top:2px;font-variant-numeric:tabular-nums}
.card .v small{font-size:12px;font-weight:500;color:var(--muted)}.card .d{font-size:12px;font-weight:700;margin-top:2px}.d.up{color:var(--neg)}.d.down{color:var(--pos)}
.bar{position:sticky;top:0;z-index:30;display:flex;flex-wrap:wrap;gap:8px;align-items:center;background:var(--bg);padding:10px 0}
.bar input[type=search],.bar select,.btn{height:36px;border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:9px;padding:0 11px;font:inherit;font-size:13px}
.bar input[type=search]{min-width:180px;flex:1 1 200px;max-width:320px}
.btn{cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}.btn:hover{border-color:var(--accent)}.btn.on,select.on{background:var(--accent-soft);border-color:var(--accent);font-weight:700}
.seg{display:inline-flex;border:1px solid var(--border);border-radius:9px;overflow:hidden}.seg button{height:34px;border:0;background:var(--surface);color:var(--text);padding:0 12px;font:inherit;font-size:13px;cursor:pointer}
.seg button.on{background:var(--accent);color:#1f2328;font-weight:800}
.dd{position:relative}.dd-panel{display:none;position:absolute;top:40px;left:0;z-index:40;background:var(--surface);border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow);padding:8px;min-width:220px;max-height:60vh;overflow:auto}
.dd.open .dd-panel{display:block}.dd-panel label{display:flex;gap:8px;align-items:center;padding:5px 6px;border-radius:6px;cursor:pointer;font-size:13px;white-space:nowrap}
.dd-panel label:hover{background:var(--head)}.dd-panel .dd-act{display:flex;gap:6px;padding:4px 4px 8px;border-bottom:1px solid var(--border);margin-bottom:4px}
.dd-panel .dd-act button{flex:1;height:28px;border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:6px;cursor:pointer;font-size:12px}
.count{color:var(--muted);font-size:13px;margin-left:auto}
.tbl-wrap{background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:auto;max-height:calc(100vh - 70px)}
table{border-collapse:separate;border-spacing:0;width:100%;font-size:13px}
thead th{position:sticky;background:var(--head);text-align:left;font-weight:700;padding:8px 10px;border-bottom:1px solid var(--border);white-space:nowrap;cursor:pointer;user-select:none;z-index:3}
thead tr:first-child th{top:0;text-align:center;border-right:1px solid var(--border)}thead tr:first-child th:first-child,thead tr:first-child th:last-child{text-align:left;border-right:0}
thead tr:nth-child(2) th{top:34px;font-weight:600;color:var(--muted);font-size:12px}
thead th.num{text-align:right}thead th:hover{color:var(--chip-text)}thead th .ar{font-size:10px;margin-left:3px;color:var(--chip-text)}
td{padding:7px 10px;border-bottom:1px solid var(--border);vertical-align:top;white-space:nowrap}
td.num{text-align:right;font-variant-numeric:tabular-nums}td small{color:var(--muted);font-size:11px}
tbody tr.br{cursor:pointer}tbody tr.br:hover td{background:var(--accent-soft)}tbody tr.ev td{background:var(--group)}
tbody tr.sub td{color:var(--muted);font-size:12px;padding-top:4px;padding-bottom:4px;background:var(--group)}tbody tr.sub td:first-child{padding-left:26px}
td.up{color:var(--neg);font-weight:800}td.down{color:var(--pos);font-weight:800}td.file{font-size:11px;color:var(--muted);white-space:normal;min-width:200px;max-width:360px}
tfoot td{position:sticky;bottom:0;background:var(--head);font-weight:800;border-top:2px solid var(--border);z-index:2}
.empty{padding:40px;text-align:center;color:var(--muted)}.hint{color:var(--muted);font-size:12px;margin-top:10px}
.mbg{position:fixed;inset:0;background:rgba(15,17,21,.55);z-index:100;display:flex;align-items:flex-start;justify-content:center;padding:4vh 12px;overflow:auto}
.modal{background:var(--surface);color:var(--text);border-radius:16px;box-shadow:var(--shadow);width:min(1100px,100%);padding:18px 18px 14px;position:relative}
.modal h3{margin:0 0 12px;font-size:17px}.modal .x{position:absolute;top:10px;right:10px;width:34px;height:34px;border-radius:50%;border:1px solid var(--border);background:var(--surface);color:var(--text);cursor:pointer;font-size:16px}
.modal .files{font-size:12px;color:var(--muted);margin:-6px 0 10px}.modal .tbl-wrap{max-height:60vh}
.acts{display:flex;gap:8px;align-items:center;margin-top:14px;flex-wrap:wrap}.acts .sp{flex:1}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#1f2328;color:#fff;padding:10px 16px;border-radius:10px;z-index:200;font-size:13px;box-shadow:var(--shadow);max-width:92vw}
.toast.err{background:#d1242f}.toast.ok{background:#0a7c42}
@media (max-width:700px){.bar{position:static}.wrap{padding:12px 10px 30px}header h1{font-size:18px}.card .v{font-size:17px}.bar input[type=search]{max-width:none}
  table{font-size:12px}td,thead th{padding:6px 6px}.tbl-wrap{max-height:none}.m-hide{display:none}}
@media print{.bar,.hint,.noprint{display:none!important}body{background:#fff}.wrap{max-width:none;padding:0}.tbl-wrap{border:none;overflow:visible;max-height:none}thead th,tfoot td{position:static}
  td,th{padding:4px 6px;font-size:11px}.card{padding:6px 10px}.card .v{font-size:16px}}
`;

  // 보고서 페이지 안에서 돌아가는 코드. 문자열로 직렬화해 넣으므로 바깥 변수를 쓰면 안 된다.
  function pageMain() {
    const D = JSON.parse(document.getElementById('cmp-data').textContent);
    const META = D.meta || {}, Y1 = D.y1, Y2 = D.y2;
    const $ = (s, r) => (r || document).querySelector(s);
    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmt = (n) => Number(n || 0).toLocaleString('ko-KR');
    const sgn = (n) => (n > 0 ? '+' + fmt(n) : fmt(n));
    const KEYS = ['items', 'negN', 'neg', 'posN', 'pos', 'abs', 'sd', 'sys'];
    const empty = () => ({ items: 0, negN: 0, neg: 0, posN: 0, pos: 0, abs: 0, sd: 0, sys: 0 });
    const add = (a, b) => { for (const k of KEYS) a[k] += Number(b && b[k]) || 0; return a; };
    // 지점 · 분야 목록
    const branches = D.branches.map((b) => ({ ...b, fields: (b.fields || []).map((f) => ({ ...f })) }));
    const branchNames = branches.map((b) => b.name);
    const fieldNames = [...new Set(branches.flatMap((b) => b.fields.map((f) => f.name)))].sort((a, b) => a.localeCompare(b, 'ko'));
    const st = { view: 'branch', q: '', br: new Set(), fd: new Set(), dir: '', sort: { k: null, dir: 1 }, sub: false };

    // ── 필터 · 정렬 ─────────────────────────────
    const q = () => st.q.trim().toLowerCase();
    const dirOk = (a, b) => {
      if (!st.dir) return true;
      if (st.dir === 'one') return (!!a) !== (!!b);
      if (!a || !b) return false;
      const d = a.abs - b.abs; return st.dir === 'worse' ? d > 0 : d < 0;
    };
    // 지점별: 지점 줄(분야 필터가 있으면 그 분야만 합쳐서)
    function branchRows() {
      const out = [];
      for (const b of branches) {
        if (st.br.size && !st.br.has(b.name)) continue;
        let a = b.a, bb = b.b, fields = b.fields;
        if (st.fd.size) { fields = b.fields.filter((f) => st.fd.has(f.name)); a = fields.some((f) => f.a) ? fields.reduce((o, f) => add(o, f.a), empty()) : null; bb = fields.some((f) => f.b) ? fields.reduce((o, f) => add(o, f.b), empty()) : null; }
        if (!a && !bb) continue;
        if (q() && !b.name.toLowerCase().includes(q()) && !fields.some((f) => f.name.toLowerCase().includes(q()))) continue;
        if (!dirOk(a, bb)) continue;
        out.push({ key: b.name, label: b.name, a, b: bb, fields, files: b });
      }
      return sortRows(out);
    }
    // 분야별(전 지점 합): 지점 필터가 있으면 그 지점들만
    function fieldRows() {
      const m = new Map();
      for (const b of branches) {
        if (st.br.size && !st.br.has(b.name)) continue;
        for (const f of b.fields) { let e = m.get(f.name); if (!e) { e = { key: f.name, label: f.name, a: null, b: null, nA: 0, nB: 0 }; m.set(f.name, e); } if (f.a) { e.a = add(e.a || empty(), f.a); e.nA++; } if (f.b) { e.b = add(e.b || empty(), f.b); e.nB++; } }
      }
      let out = [...m.values()];
      if (st.fd.size) out = out.filter((r) => st.fd.has(r.key));
      if (q()) out = out.filter((r) => r.key.toLowerCase().includes(q()));
      out = out.filter((r) => dirOk(r.a, r.b));
      return sortRows(out);
    }
    // 지점×분야: 평평한 표
    function flatRows() {
      const out = [];
      for (const b of branches) {
        if (st.br.size && !st.br.has(b.name)) continue;
        for (const f of b.fields) {
          if (st.fd.size && !st.fd.has(f.name)) continue;
          if (q() && !b.name.toLowerCase().includes(q()) && !f.name.toLowerCase().includes(q())) continue;
          if (!dirOk(f.a, f.b)) continue;
          out.push({ key: b.name + '|' + f.name, label: b.name, label2: f.name, a: f.a, b: f.b, files: b });
        }
      }
      return sortRows(out);
    }
    const val = (r, k) => {
      if (k === 'label') return r.label; if (k === 'label2') return r.label2 || '';
      const [side, key] = k.split('.');   // 'a.items' · 'b.abs' · 'd.items'(증감) · 'd.abs'
      if (side === 'd') return r.a && r.b ? r.a[key] - r.b[key] : null;
      const o = r[side]; return o ? o[key] : null;
    };
    function sortRows(rows) {
      const k = st.sort.k || 'd.abs', d = st.sort.k ? st.sort.dir : -1;   // 기본: 오차 수량 증감이 큰(나빠진) 순
      return rows.sort((x, y) => {
        const a = val(x, k), b = val(y, k);
        if (typeof a === 'string' || typeof b === 'string') return String(a == null ? '' : a).localeCompare(String(b == null ? '' : b), 'ko', { numeric: true }) * d;
        if (a == null && b == null) return 0; if (a == null) return 1; if (b == null) return -1;
        return (a - b) * d;
      });
    }

    // ── 표 ─────────────────────────────
    const dash = '<span class="muted">—</span>';
    const dcell = (a, b, key) => { if (!a || !b) return `<td class="num">${dash}</td>`; const d = a[key] - b[key]; return `<td class="num ${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${d > 0 ? '+' : ''}${fmt(d)}</td>`; };
    const np = (o, nk, qk) => (o ? `${fmt(o[nk])}<small> / ${fmt(o[qk])}</small>` : dash);
    const COLS = [['a.items', Y1, 1], ['b.items', Y2, 1], ['d.items', '증감', 1], ['a.negN', Y1, 1], ['b.negN', Y2, 1], ['a.posN', Y1, 1], ['b.posN', Y2, 1], ['a.abs', Y1, 1], ['b.abs', Y2, 1], ['d.abs', '증감', 1], ['a.sd', Y1, 1], ['b.sd', Y2, 1]];
    const th = (k, label, num, cls) => `<th${k ? ` data-k="${k}"` : ''} class="${num ? 'num' : ''}${cls ? ' ' + cls : ''}">${label}${k ? `<span class="ar">${st.sort.k === k ? (st.sort.dir > 0 ? '▲' : '▼') : ''}</span>` : ''}</th>`;
    function headHTML(first, second, withFile) {
      const g = `<th colspan="3">오차 건수</th><th colspan="2" class="m-hide">부족 (건 / 수량)</th><th colspan="2" class="m-hide">초과 (건 / 수량)</th><th colspan="3">오차 수량 (부족+초과)</th><th colspan="2" class="m-hide">스캔차이 합계</th>`;
      const r1 = `<tr>${th('label', first)}${second ? th('label2', second) : ''}${g}${withFile ? '<th>쓴 파일</th>' : ''}</tr>`;
      const r2 = `<tr><th></th>${second ? '<th></th>' : ''}${COLS.map(([k, l, n]) => th(k, l, n, /negN|posN|\.sd/.test(k) ? 'm-hide' : '')).join('')}${withFile ? '<th></th>' : ''}</tr>`;
      return `<thead>${r1}${r2}</thead>`;
    }
    const fileTxt = (b) => [b.fileA ? `${Y1}: ${esc(b.fileA.name)}` : `${Y1}: 없음`, b.fileB ? `${Y2}: ${esc(b.fileB.name)}` : `${Y2}: 없음`].join('<br>');
    const line = (r, cls, label, label2, file) => `<tr class="${cls}" data-key="${esc(r.key)}"><td>${label}</td>${label2 != null ? `<td>${label2}</td>` : ''}
      <td class="num">${r.a ? fmt(r.a.items) : dash}</td><td class="num">${r.b ? fmt(r.b.items) : dash}</td>${dcell(r.a, r.b, 'items')}
      <td class="num m-hide">${np(r.a, 'negN', 'neg')}</td><td class="num m-hide">${np(r.b, 'negN', 'neg')}</td>
      <td class="num m-hide">${np(r.a, 'posN', 'pos')}</td><td class="num m-hide">${np(r.b, 'posN', 'pos')}</td>
      <td class="num">${r.a ? fmt(r.a.abs) : dash}</td><td class="num">${r.b ? fmt(r.b.abs) : dash}</td>${dcell(r.a, r.b, 'abs')}
      <td class="num m-hide">${r.a ? fmt(r.a.sd) : dash}</td><td class="num m-hide">${r.b ? fmt(r.b.sd) : dash}</td>${file != null ? `<td class="file">${file}</td>` : ''}</tr>`;
    function totals(rows) {
      const t = { a: empty(), b: empty(), nA: 0, nB: 0 };
      for (const r of rows) { if (r.a) { add(t.a, r.a); t.nA++; } if (r.b) { add(t.b, r.b); t.nB++; } }
      return t;
    }
    function render() {
      const view = st.view;
      const rows = view === 'branch' ? branchRows() : view === 'field' ? fieldRows() : flatRows();
      const t = totals(rows);
      let body = '';
      rows.forEach((r, i) => {
        if (view === 'branch') {
          body += line(r, 'br' + (i % 2 ? ' ev' : ''), `<b>${esc(r.label)}</b>`, null, fileTxt(r.files));
          if (st.sub) for (const f of sortRows(r.fields.map((x) => ({ key: r.key + '|' + x.name, label: x.name, a: x.a, b: x.b })))) body += line(f, 'sub', `↳ ${esc(f.label)}`, null, '');
        } else if (view === 'field') body += line(r, i % 2 ? 'ev' : '', `<b>${esc(r.label)}</b> <small>(${r.nA}/${r.nB}지점)</small>`, null, null);
        else body += line(r, 'br' + (i % 2 ? ' ev' : ''), esc(r.label), esc(r.label2), null);
      });
      const first = view === 'field' ? '분야' : '지점', second = view === 'flat' ? '분야' : null, withFile = view === 'branch';
      const totLabel = `합계 <small>(${Y1}: ${t.nA}${view === 'field' ? '분야' : '줄'} · ${Y2}: ${t.nB})</small>`;
      const tot = line({ key: '', a: t.nA ? t.a : null, b: t.nB ? t.b : null }, 'tot', totLabel, second ? '' : null, withFile ? '' : null);
      $('#t').innerHTML = rows.length ? headHTML(first, second, withFile) + `<tbody>${body}</tbody><tfoot>${tot}</tfoot>` : '';
      $('#empty').style.display = rows.length ? 'none' : '';
      $('#count').textContent = `${fmt(rows.length)}${view === 'field' ? '분야' : view === 'flat' ? '줄' : '지점'}`;
      $('#f-br-lbl').textContent = st.br.size ? `${st.br.size}곳` : '전체'; $('#f-br-btn').classList.toggle('on', st.br.size > 0);
      $('#f-fd-lbl').textContent = st.fd.size ? `${st.fd.size}개` : '전체'; $('#f-fd-btn').classList.toggle('on', st.fd.size > 0);
      $('#f-sub').style.display = view === 'branch' ? '' : 'none';
      cards(rows, t);
      $('#t').querySelectorAll('th[data-k]').forEach((h) => h.addEventListener('click', () => { const k = h.dataset.k; if (st.sort.k === k) st.sort.dir = -st.sort.dir; else st.sort = { k, dir: k.startsWith('label') ? 1 : -1 }; render(); }));
      $('#t').querySelectorAll('tr.br').forEach((tr) => tr.addEventListener('click', () => openBranch(tr.dataset.key.split('|')[0])));
    }
    function cards(rows, t) {
      const a = t.nA ? t.a : null, b = t.nB ? t.b : null;
      const d = (k) => (a && b ? `<div class="d ${a[k] - b[k] > 0 ? 'up' : a[k] - b[k] < 0 ? 'down' : ''}">${a[k] - b[k] > 0 ? '+' : ''}${fmt(a[k] - b[k])} ${Y2} 대비</div>` : '');
      const vv = (o, k, unit) => (o ? `${fmt(o[k])}<small> ${unit || ''}</small>` : '—');
      const scope = st.view === 'field' ? '분야' : '지점';
      $('#cards').innerHTML = `
        <div class="card"><div class="k">${scope} 수</div><div class="v">${fmt(rows.length)}<small> (${Y1} ${t.nA} · ${Y2} ${t.nB})</small></div></div>
        <div class="card"><div class="k">오차 건수 ${Y1}</div><div class="v">${vv(a, 'items', '건')}</div>${d('items')}</div>
        <div class="card"><div class="k">오차 건수 ${Y2}</div><div class="v">${vv(b, 'items', '건')}</div></div>
        <div class="card"><div class="k">오차 수량 ${Y1} <small>(부족+초과)</small></div><div class="v">${vv(a, 'abs')}</div>${d('abs')}</div>
        <div class="card"><div class="k">오차 수량 ${Y2}</div><div class="v">${vv(b, 'abs')}</div></div>
        <div class="card"><div class="k">부족 ${Y1} <small>건 / 수량</small></div><div class="v" style="color:var(--neg)">${a ? `${fmt(a.negN)}<small> / ${fmt(a.neg)}</small>` : '—'}</div></div>
        <div class="card"><div class="k">초과 ${Y1} <small>건 / 수량</small></div><div class="v" style="color:var(--pos)">${a ? `${fmt(a.posN)}<small> / +${fmt(a.pos)}</small>` : '—'}</div></div>`;
    }

    // ── 지점 상세 ─────────────────────────────
    function modal(html) {
      const bg = document.createElement('div'); bg.className = 'mbg';
      bg.innerHTML = `<div class="modal" role="dialog"><button class="x" type="button" aria-label="닫기">✕</button>${html}</div>`;
      document.body.appendChild(bg); document.body.style.overflow = 'hidden';
      const close = () => { bg.remove(); if (!document.querySelector('.mbg')) document.body.style.overflow = ''; };
      bg.addEventListener('click', (e) => { if (e.target === bg) close(); }); $('.x', bg).addEventListener('click', close);
      return { el: bg, q: (s) => $(s, bg), close };
    }
    function openBranch(name) {
      const b = branches.find((x) => x.name === name); if (!b) return;
      const rows = sortRows(b.fields.map((x) => ({ key: x.name, label: x.name, a: x.a, b: x.b })));
      const t = totals(rows);
      const m = modal(`<h3>🏬 ${esc(b.name)} — ${Y1} vs ${Y2}</h3><div class="files">${fileTxt(b)}</div>
        <div class="tbl-wrap"><table>${headHTML('분야', null, false)}<tbody>${rows.map((r, i) => line(r, i % 2 ? 'ev' : '', esc(r.label), null, null)).join('')}</tbody><tfoot>${line({ key: '', a: t.nA ? t.a : null, b: t.nB ? t.b : null }, 'tot', '합계', null, null)}</tfoot></table></div>
        <div class="acts"><button class="btn" type="button" id="d-only">이 지점만 보기</button><span class="sp"></span><button class="btn" type="button" id="d-close">닫기</button></div>`);
      m.q('#d-close').addEventListener('click', m.close);
      m.q('#d-only').addEventListener('click', () => { st.br = new Set([b.name]); syncDD('#f-br-list', st.br); m.close(); render(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
    }

    // ── 엑셀(xlsx) 받기: 라이브러리 없이 zip(저장) + XML ─────────────────────────────
    function makeZip(files) {
      const T = new Uint32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
      const crc32 = (b) => { let c = 0xFFFFFFFF; for (let k = 0; k < b.length; k++) c = T[(c ^ b[k]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
      const enc = new TextEncoder(); const parts = [], central = []; let off = 0;
      for (const f of files) {
        const name = enc.encode(f.name), d = new Date();
        const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
        const crc = crc32(f.data), size = f.data.length;
        const lh = new DataView(new ArrayBuffer(30)); lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true); lh.setUint16(26, name.length, true);
        parts.push(lh.buffer, name, f.data);
        const ch = new DataView(new ArrayBuffer(46)); ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true); ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
        central.push(ch.buffer, name); off += 30 + name.length + size;
      }
      const cdSize = central.reduce((a, b) => a + (b.byteLength || b.length), 0);
      const end = new DataView(new ArrayBuffer(22)); end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, off, true);
      return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
    }
    function buildXlsx(sheets) {
      const enc = new TextEncoder();
      const xe = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
      const colName = (i) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
      const cell = (ref, v, style) => { const st2 = style ? ` s="${style}"` : ''; if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${st2}><v>${v}</v></c>`; if (v == null || v === '') return ''; return `<c r="${ref}" t="inlineStr"${st2}><is><t xml:space="preserve">${xe(v)}</t></is></c>`; };
      const sheetXml = (sh) => { const rows = [sh.head, ...sh.rows]; const cols = (sh.widths || []).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join(''); const data = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => cell(colName(ci) + (ri + 1), v, ri === 0 ? 1 : 0)).join('')}</row>`).join(''); const ref = `A1:${colName(sh.head.length - 1)}${rows.length}`;
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${ref}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols ? `<cols>${cols}</cols>` : ''}<sheetData>${data}</sheetData><autoFilter ref="${ref}"/></worksheet>`; };
      const files = []; const addF = (name, xml) => files.push({ name, data: enc.encode(xml) });
      addF('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
      addF('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
      addF('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sh, i) => `<sheet name="${xe(sh.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
      addF('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
      addF('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Malgun Gothic"/></font><font><b/><sz val="11"/><name val="Malgun Gothic"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`);
      sheets.forEach((sh, i) => addF(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sh)));
      return makeZip(files);
    }
    function exportXlsx() {
      const H = (lbl, extra) => [...(extra || []), lbl, `오차건수 ${Y1}`, `오차건수 ${Y2}`, '증감', `부족건수 ${Y1}`, `부족수량 ${Y1}`, `부족건수 ${Y2}`, `부족수량 ${Y2}`, `초과건수 ${Y1}`, `초과수량 ${Y1}`, `초과건수 ${Y2}`, `초과수량 ${Y2}`, `오차수량 ${Y1}`, `오차수량 ${Y2}`, '증감', `스캔차이합계 ${Y1}`, `스캔차이합계 ${Y2}`];
      const R = (lbl, a, b, extra, tail) => [...(extra || []), lbl, a ? a.items : '', b ? b.items : '', a && b ? a.items - b.items : '', a ? a.negN : '', a ? a.neg : '', b ? b.negN : '', b ? b.neg : '', a ? a.posN : '', a ? a.pos : '', b ? b.posN : '', b ? b.pos : '', a ? a.abs : '', b ? b.abs : '', a && b ? a.abs - b.abs : '', a ? a.sd : '', b ? b.sd : '', ...(tail || [])];
      const bRows = branchRows(), fRows = fieldRows(), xRows = flatRows();
      const tb = totals(bRows);
      const s1 = { name: '지점별', widths: [14, 10, 10, 8, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 8, 12, 12, 40, 40], head: [...H('지점'), `파일 ${Y1}`, `파일 ${Y2}`], rows: [...bRows.map((r) => R(r.label, r.a, r.b, null, [r.files.fileA ? r.files.fileA.name : '', r.files.fileB ? r.files.fileB.name : ''])), R('합계', tb.nA ? tb.a : null, tb.nB ? tb.b : null, null, ['', ''])] };
      const s2 = { name: '지점×분야', widths: [14, 14, 10, 10, 8, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 8, 12, 12], head: H('분야', ['지점']), rows: xRows.map((r) => R(r.label2, r.a, r.b, [r.label])) };
      const tf = totals(fRows);
      const s3 = { name: '분야별(전 지점)', widths: [14, 10, 10, 8, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 8, 12, 12], head: H('분야'), rows: [...fRows.map((r) => R(r.label, r.a, r.b)), R('합계', tf.nA ? tf.a : null, tf.nB ? tf.b : null)] };
      const url = URL.createObjectURL(buildXlsx([s1, s2, s3]));
      const a = document.createElement('a'); a.href = url; a.download = `${META.fileBase || '재고조사오차_지점비교'}.xlsx`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast(`지점 ${fmt(bRows.length)}곳 · 분야 ${fmt(fRows.length)}개를 엑셀로 저장했습니다${st.br.size || st.fd.size || q() || st.dir ? ' (지금 필터 기준)' : ''}`, 'ok');
    }

    // ── 공통 UI ─────────────────────────────
    let toastT = null;
    function toast(msg, kind) { let el = $('.toast'); if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); } el.className = 'toast' + (kind ? ' ' + kind : ''); el.textContent = msg; el.style.display = ''; clearTimeout(toastT); toastT = setTimeout(() => { el.style.display = 'none'; }, 3200); }
    function fillDD(listSel, names, set) { $(listSel).innerHTML = names.map((n) => `<label><input type="checkbox" value="${esc(n)}"${set.has(n) ? ' checked' : ''}> ${esc(n)}</label>`).join(''); }
    function syncDD(listSel, set) { $(listSel).querySelectorAll('input').forEach((c) => { c.checked = set.has(c.value); }); }
    fillDD('#f-br-list', branchNames, st.br); fillDD('#f-fd-list', fieldNames, st.fd);
    for (const [btn, dd, list, set] of [['#f-br-btn', '#f-br', '#f-br-list', st.br], ['#f-fd-btn', '#f-fd', '#f-fd-list', st.fd]]) {
      $(btn).addEventListener('click', (e) => { e.stopPropagation(); $(dd).classList.toggle('open'); });
      $(list).addEventListener('change', (e) => { if (e.target.checked) set.add(e.target.value); else set.delete(e.target.value); render(); });
      $(dd + '-all').addEventListener('click', () => { (dd === '#f-br' ? branchNames : fieldNames).forEach((n) => set.add(n)); syncDD(list, set); render(); });
      $(dd + '-none').addEventListener('click', () => { set.clear(); syncDD(list, set); render(); });
    }
    document.addEventListener('click', (e) => { document.querySelectorAll('.dd.open').forEach((d) => { if (!d.contains(e.target)) d.classList.remove('open'); }); });
    let t = null; $('#f-q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { st.q = e.target.value; render(); }, 150); });
    $('#f-dir').addEventListener('change', (e) => { st.dir = e.target.value; e.target.classList.toggle('on', !!st.dir); render(); });
    $('#f-sub').addEventListener('change', (e) => { st.sub = e.target.checked; render(); });
    document.querySelectorAll('#view button').forEach((b) => b.addEventListener('click', () => { st.view = b.dataset.v; document.querySelectorAll('#view button').forEach((x) => x.classList.toggle('on', x === b)); st.sort = { k: null, dir: 1 }; render(); }));
    $('#f-reset').addEventListener('click', () => { Object.assign(st, { q: '', dir: '', sort: { k: null, dir: 1 } }); st.br.clear(); st.fd.clear(); $('#f-q').value = ''; $('#f-dir').value = ''; $('#f-dir').classList.remove('on'); syncDD('#f-br-list', st.br); syncDD('#f-fd-list', st.fd); render(); });
    $('#f-print').addEventListener('click', () => window.print());
    $('#f-xlsx').addEventListener('click', exportXlsx);
    render();
  }

  const safeJs = (code) => String(code || '').replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
  const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
  const safeJson = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c').split(LS).join('\\u2028').split(PS).join('\\u2029');
  const escHtml = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // meta: { title, generatedAt, fileBase, note }, built: app.js 의 cmpBuild 결과 { y1, y2, branches: [{ name, a, b, fileA, fileB, fields: [{ name, a, b }] }] }
  function build(meta, built) {
    const data = { meta, y1: built.y1, y2: built.y2, branches: built.branches.map((b) => ({ name: b.name, a: b.a && strip(b.a), b: b.b && strip(b.b), fileA: b.fileA ? { name: b.fileA.name } : null, fileB: b.fileB ? { name: b.fileB.name } : null, fields: (b.fields || []).map((f) => ({ name: f.name, a: f.a && strip(f.a), b: f.b && strip(f.b) })) })) };
    return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(meta.title)}</title><style>${CSS}</style></head>
<body><div class="wrap">
<header><div class="ttl"><h1>📈 ${escHtml(meta.title)}</h1>
<div class="sub">만든 시각 ${escHtml(meta.generatedAt)} · 북적북적 재고조사 오차체크${meta.note ? ' · ' + escHtml(meta.note) : ''}</div></div></header>
<div class="cards" id="cards"></div>
<div class="bar">
  <span class="seg" id="view"><button type="button" data-v="branch" class="on">지점별</button><button type="button" data-v="field">분야별</button><button type="button" data-v="flat">지점×분야</button></span>
  <input type="search" id="f-q" placeholder="🔎 지점 · 분야">
  <div class="dd" id="f-br"><button type="button" class="btn" id="f-br-btn">지점 <b id="f-br-lbl">전체</b> ▾</button>
    <div class="dd-panel"><div class="dd-act"><button type="button" id="f-br-all">모두</button><button type="button" id="f-br-none">해제(전체)</button></div><div id="f-br-list"></div></div></div>
  <div class="dd" id="f-fd"><button type="button" class="btn" id="f-fd-btn">분야 <b id="f-fd-lbl">전체</b> ▾</button>
    <div class="dd-panel"><div class="dd-act"><button type="button" id="f-fd-all">모두</button><button type="button" id="f-fd-none">해제(전체)</button></div><div id="f-fd-list"></div></div></div>
  <select id="f-dir" class="btn" title="오차 수량(부족+초과)이 ${escHtml(String(built.y2))} 보다 늘었는지 줄었는지"><option value="">증감 전체</option><option value="worse">나빠진 곳만 (오차 수량 늘어남)</option><option value="better">좋아진 곳만 (줄어듦)</option><option value="one">한 해만 있는 곳</option></select>
  <label class="btn" id="f-sub-wrap" style="gap:6px"><input type="checkbox" id="f-sub"> 분야 펼치기</label>
  <button type="button" class="btn" id="f-reset">초기화</button>
  <button type="button" class="btn noprint" id="f-xlsx" title="지금 보이는 기준(필터 · 정렬)으로 엑셀 파일(지점별 · 지점×분야 · 분야별)">📥 엑셀</button>
  <button type="button" class="btn noprint" id="f-print">🖨️ 인쇄</button>
  <span class="count" id="count"></span>
</div>
<div class="tbl-wrap"><table id="t"></table><div class="empty" id="empty" style="display:none">조건에 맞는 줄이 없습니다.</div></div>
<p class="hint">증감 = ${escHtml(String(built.y1))} − ${escHtml(String(built.y2))} (빨강 = 늘어남 · 초록 = 줄어듦). 지점을 누르면 그 지점의 분야별 표. 예외 항목과 '문구'는 뺀 숫자이고, 스캔차이 = 스캔합계 + 누락재고 − 전산재고.</p>
</div>
<script type="application/json" id="cmp-data">${safeJson(data)}</script>
<script>(${safeJs(pageMain.toString())})();</script>
</body></html>`;
  }
  const strip = (o) => { const r = {}; for (const k of ['items', 'negN', 'neg', 'posN', 'pos', 'abs', 'sd', 'sys']) r[k] = Number(o[k]) || 0; return r; };

  window.SACompareReport = { build };
})();
