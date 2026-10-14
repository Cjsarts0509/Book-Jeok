/* 재고조사 오차 → 혼자 열리는 HTML 보고서(파일 하나, 인터넷 없이도 동작).
   화면 표와 같은 열·같은 필터(분야)에 검색·스캔차이·대분류 필터, 열 제목 정렬, 합계를 더했다.
   ISBN 하나가 서가 여러 곳이면 항목 칸은 행을 합쳐(rowspan) 한 번만 보이고, 필터는 '항목 단위'로 걸린다 —
   엑셀처럼 합친 칸의 첫 줄만 숨고 나머지 줄이 남는 일이 없다.
   내려받을 때만 불러온다(app.js 의 downloadHtml). */
(function () {
  'use strict';

  const CSS = `
:root{--bg:#f6f7f9;--surface:#fff;--text:#1f2328;--muted:#6b7280;--border:#e5e7eb;--head:#f1f3f5;--accent:#f5b400;--accent-soft:#fff6d6;
  --neg:#d1242f;--neg-soft:#fff1f1;--pos:#0a7c42;--pos-soft:#ecfdf3;--chip:#eef2ff;--chip-text:#3b4cca;--group:#fafbfc}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--surface:#171a21;--text:#e6e8eb;--muted:#9aa3ae;--border:#2a2f3a;--head:#1d212a;--accent:#f5b400;--accent-soft:#3a2f0a;
  --neg:#ff6b6b;--neg-soft:#3a1517;--pos:#4ade80;--pos-soft:#0f2a1a;--chip:#232a45;--chip-text:#a5b4fc;--group:#1a1e26}}
*{box-sizing:border-box}html,body{margin:0}
body{background:var(--bg);color:var(--text);font:14px/1.5 "Pretendard","Apple SD Gothic Neo","Malgun Gothic",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:1600px;margin:0 auto;padding:24px 20px 60px}
header h1{margin:0;font-size:22px;letter-spacing:-.3px}header .sub{color:var(--muted);font-size:13px;margin-top:4px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:18px 0}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:12px 14px}
.card .k{font-size:12px;color:var(--muted)}.card .v{font-size:22px;font-weight:800;margin-top:2px;font-variant-numeric:tabular-nums}
.card .v small{font-size:12px;font-weight:500;color:var(--muted)}.card.neg .v{color:var(--neg)}.card.pos .v{color:var(--pos)}
.bar{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;gap:8px;align-items:center;background:var(--bg);padding:10px 0;border-bottom:1px solid var(--border)}
.bar input[type=search],.bar select,.btn{height:34px;border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:8px;padding:0 10px;font:inherit;font-size:13px}
.bar input[type=search]{min-width:240px;flex:1 1 240px;max-width:380px}
.btn{cursor:pointer;display:inline-flex;align-items:center;gap:6px}.btn:hover{border-color:var(--accent)}
.btn.on{background:var(--accent-soft);border-color:var(--accent);font-weight:700}
.dd{position:relative}.dd-panel{display:none;position:absolute;top:38px;left:0;z-index:20;background:var(--surface);border:1px solid var(--border);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.15);padding:8px;min-width:220px;max-height:60vh;overflow:auto}
.dd.open .dd-panel{display:block}.dd-panel label{display:flex;gap:8px;align-items:center;padding:5px 6px;border-radius:6px;cursor:pointer;font-size:13px;white-space:nowrap}
.dd-panel label:hover{background:var(--head)}.dd-panel .dd-act{display:flex;gap:6px;padding:4px 4px 8px;border-bottom:1px solid var(--border);margin-bottom:4px}
.dd-panel .dd-act button{flex:1;height:28px;border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:6px;cursor:pointer;font-size:12px}
.count{color:var(--muted);font-size:13px;margin-left:auto}
.tbl-wrap{background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:auto;margin-top:12px}
table{border-collapse:collapse;width:100%;font-size:13px}
thead th{position:sticky;top:0;background:var(--head);text-align:left;font-weight:700;padding:9px 10px;border-bottom:1px solid var(--border);white-space:nowrap;cursor:pointer;user-select:none;z-index:2}
thead th.num{text-align:right}thead th:hover{color:var(--chip-text)}thead th .ar{font-size:10px;margin-left:3px;color:var(--chip-text)}
td{padding:7px 10px;border-bottom:1px solid var(--border);vertical-align:top;white-space:nowrap}
td.num{text-align:right;font-variant-numeric:tabular-nums}td.name{white-space:normal;min-width:220px;font-weight:600}
td.code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--muted)}
td.isbn{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:700}
tbody.g:nth-of-type(even) td{background:var(--group)}tbody.g:hover td{background:var(--accent-soft)}
td.diff{font-weight:800}td.diff.neg{color:var(--neg);background:var(--neg-soft)!important}td.diff.pos{color:var(--pos);background:var(--pos-soft)!important}td.diff.zero{color:var(--muted)}
.chip{display:inline-block;padding:1px 8px;border-radius:999px;background:var(--chip);color:var(--chip-text);font-size:12px;font-weight:600}
tfoot td{position:sticky;bottom:0;background:var(--head);font-weight:800;border-top:2px solid var(--border)}
.empty{padding:40px;text-align:center;color:var(--muted)}
.hint{color:var(--muted);font-size:12px;margin-top:10px}
@media print{.bar,.hint,.noprint{display:none!important}body{background:#fff}.wrap{max-width:none;padding:0}.tbl-wrap{border:none;overflow:visible}thead th{position:static}tfoot td{position:static}
  td,th{padding:4px 6px;font-size:11px}tbody.g{break-inside:avoid}.card{padding:6px 10px}.card .v{font-size:16px}}
`;

  // 보고서 페이지 안에서 돌아가는 코드. 문자열로 직렬화해 넣으므로 바깥 변수를 쓰면 안 된다.
  function pageMain() {
    const D = JSON.parse(document.getElementById('sa-data').textContent);
    const items = D.items;
    const $ = (s) => document.querySelector(s);
    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmt = (n) => Number(n || 0).toLocaleString('ko-KR');
    const sgn = (n) => (n > 0 ? '+' + fmt(n) : fmt(n));
    const st = { q: '', fields: new Set(), diff: '', maj: '', sort: { k: null, dir: 1 } };
    const fields = [...new Set(items.map((x) => x.f).filter((x) => x !== ''))].sort((a, b) => a.localeCompare(b, 'ko'));
    const majs = [...new Set(items.flatMap((x) => x.sh.map((s) => s[1])).filter(Boolean))].sort();
    const loc = (x) => (x.sh[0] ? x.sh[0].slice(0, 4).join('') : '￿');

    // 필터 막대 채우기
    $('#f-field-list').innerHTML = fields.map((f) => `<label><input type="checkbox" value="${esc(f)}"> ${esc(f)} <span style="color:var(--muted);margin-left:auto">${items.filter((x) => x.f === f).length}</span></label>`).join('');
    $('#f-maj').innerHTML = '<option value="">대분류 전체</option>' + majs.map((m) => `<option value="${esc(m)}">대분류 ${esc(m)}</option>`).join('');

    function view() {
      const q = st.q.trim().toLowerCase();
      const out = [];
      for (const x of items) {
        if (st.fields.size && !st.fields.has(x.f)) continue;
        if (q && !(x.i.toLowerCase().includes(q) || String(x.n).toLowerCase().includes(q) || String(x.p).toLowerCase().includes(q))) continue;
        if (st.diff === 'nz' && x.sd === 0) continue;
        if (st.diff === 'neg' && !(x.sd < 0)) continue;
        if (st.diff === 'pos' && !(x.sd > 0)) continue;
        if (st.diff === 'zero' && x.sd !== 0) continue;
        let sh = x.sh;
        if (st.maj) { sh = sh.filter((s) => s[1] === st.maj); if (!sh.length) continue; }
        out.push({ x, sh });
      }
      if (st.sort.k) {
        const k = st.sort.k, d = st.sort.dir;
        const val = (r) => (k === 'loc' ? loc(r.x) : r.x[k]);
        const numeric = ['s', 'ss', 'sd'].includes(k);
        out.sort((a, b) => (numeric ? (val(a) - val(b)) : String(val(a)).localeCompare(String(val(b)), 'ko', { numeric: true })) * d);
      }
      return out;
    }

    function render() {
      const rows = view();
      let html = '', sSys = 0, sQty = 0, sSum = 0, sDiff = 0;
      for (const { x, sh } of rows) {
        const shelves = sh.length ? sh : [['', '', '', '', '']];
        const n = shelves.length, rs = n > 1 ? ` rowspan="${n}"` : '';
        const dc = x.sd < 0 ? 'neg' : x.sd > 0 ? 'pos' : 'zero';
        sSys += x.s; sSum += x.ss; sDiff += x.sd;
        html += '<tbody class="g">';
        shelves.forEach((s, k) => {
          sQty += Number(s[4]) || 0;
          html += '<tr>';
          if (k === 0) html += `<td${rs}>${x.f ? `<span class="chip">${esc(x.f)}</span>` : ''}</td><td${rs} class="isbn">${esc(x.i)}</td><td${rs} class="name">${esc(x.n)}</td><td${rs}>${esc(x.p)}</td>`;
          html += `<td class="code">${esc(s[0])}</td><td class="code">${esc(s[1])}</td><td class="code">${esc(s[2])}</td><td class="code">${esc(s[3])}</td>`;
          if (k === 0) html += `<td${rs} class="num">${fmt(x.s)}</td>`;
          html += `<td class="num">${s[4] === '' ? '' : fmt(s[4])}</td>`;
          if (k === 0) html += `<td${rs} class="num">${fmt(x.ss)}</td><td${rs} class="num diff ${dc}">${sgn(x.sd)}</td>`;
          html += '</tr>';
        });
        html += '</tbody>';
      }
      // 항목마다 <tbody class="g"> 하나(줄무늬·마우스 강조가 항목 단위로). tbody 안에 tbody 는 못 넣으므로
      // 표에 바로 붙인다 — 이전 묶음을 지우고 tfoot 앞에 끼운다.
      document.querySelectorAll('#t > tbody.g').forEach((g) => g.remove());
      if (rows.length) $('#tf').insertAdjacentHTML('beforebegin', html);
      $('#empty').style.display = rows.length ? 'none' : '';
      $('#tf').innerHTML = rows.length ? `<tr><td colspan="8">합계 · 항목 ${fmt(rows.length)}건</td><td class="num">${fmt(sSys)}</td><td class="num">${fmt(sQty)}</td><td class="num">${fmt(sSum)}</td><td class="num diff ${sDiff < 0 ? 'neg' : sDiff > 0 ? 'pos' : 'zero'}">${sgn(sDiff)}</td></tr>` : '';
      $('#count').textContent = rows.length === items.length ? `전체 ${fmt(items.length)}건` : `${fmt(rows.length)}건 / 전체 ${fmt(items.length)}건`;
      document.querySelectorAll('thead th[data-k]').forEach((th) => {
        const on = st.sort.k === th.dataset.k;
        th.querySelector('.ar').textContent = on ? (st.sort.dir > 0 ? '▲' : '▼') : '';
      });
      $('#f-field-btn').classList.toggle('on', st.fields.size > 0);
      $('#f-field-lbl').textContent = st.fields.size ? `${st.fields.size}개` : '전체';
    }

    // 이벤트
    let t = null;
    $('#f-q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { st.q = e.target.value; render(); }, 150); });
    $('#f-diff').addEventListener('change', (e) => { st.diff = e.target.value; e.target.classList.toggle('on', !!e.target.value); render(); });
    $('#f-maj').addEventListener('change', (e) => { st.maj = e.target.value; e.target.classList.toggle('on', !!e.target.value); render(); });
    const dd = $('#f-field');
    $('#f-field-btn').addEventListener('click', (e) => { e.stopPropagation(); dd.classList.toggle('open'); });
    document.addEventListener('click', (e) => { if (!dd.contains(e.target)) dd.classList.remove('open'); });
    $('#f-field-list').addEventListener('change', (e) => { if (e.target.checked) st.fields.add(e.target.value); else st.fields.delete(e.target.value); render(); });
    $('#f-field-all').addEventListener('click', () => { fields.forEach((f) => st.fields.add(f)); dd.querySelectorAll('input').forEach((c) => { c.checked = true; }); render(); });
    $('#f-field-none').addEventListener('click', () => { st.fields.clear(); dd.querySelectorAll('input').forEach((c) => { c.checked = false; }); render(); });
    $('#f-reset').addEventListener('click', () => {
      st.q = ''; st.fields.clear(); st.diff = ''; st.maj = ''; st.sort = { k: null, dir: 1 };
      $('#f-q').value = ''; $('#f-diff').value = ''; $('#f-maj').value = '';
      ['#f-diff', '#f-maj'].forEach((s) => $(s).classList.remove('on'));
      dd.querySelectorAll('input').forEach((c) => { c.checked = false; });
      render();
    });
    $('#f-print').addEventListener('click', () => window.print());
    document.querySelectorAll('thead th[data-k]').forEach((th) => th.addEventListener('click', () => {
      const k = th.dataset.k;
      if (st.sort.k === k) st.sort.dir = -st.sort.dir; else st.sort = { k, dir: 1 };
      render();
    }));
    render();
  }

  const escHtml = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // meta: { branch, title, generatedAt, source }, items: [{ f, i, n, p, s, ss, sd, sh:[[code,maj,mid,min,qty],…] }]
  function build(meta, items) {
    const sum = (k) => items.reduce((a, x) => a + (Number(x[k]) || 0), 0);
    const nShort = items.filter((x) => x.sd < 0).length, nOver = items.filter((x) => x.sd > 0).length;
    const sDiff = sum('sd');
    // </script> 로 데이터가 끊기지 않게 '<' 를 이스케이프
    const json = JSON.stringify({ items }).replace(/</g, '\\u003c').split('\u2028').join('\\u2028').split('\u2029').join('\\u2029');
    const fmt = (n) => Number(n || 0).toLocaleString('ko-KR');
    return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(meta.title)}</title><style>${CSS}</style></head>
<body><div class="wrap">
<header><h1>📊 ${escHtml(meta.title)}</h1>
<div class="sub">${escHtml(meta.source || '')}${meta.source ? ' · ' : ''}만든 시각 ${escHtml(meta.generatedAt)} · 북적북적 재고조사 오차체크</div></header>
<div class="cards">
  <div class="card"><div class="k">오차 항목</div><div class="v">${fmt(items.length)}<small> 건</small></div></div>
  <div class="card"><div class="k">전산재고 합계</div><div class="v">${fmt(sum('s'))}</div></div>
  <div class="card"><div class="k">스캔합계</div><div class="v">${fmt(sum('ss'))}</div></div>
  <div class="card ${sDiff < 0 ? 'neg' : sDiff > 0 ? 'pos' : ''}"><div class="k">스캔차이 합계</div><div class="v">${sDiff > 0 ? '+' : ''}${fmt(sDiff)}</div></div>
  <div class="card neg"><div class="k">부족 항목 (−)</div><div class="v">${fmt(nShort)}<small> 건</small></div></div>
  <div class="card pos"><div class="k">초과 항목 (+)</div><div class="v">${fmt(nOver)}<small> 건</small></div></div>
</div>
<div class="bar">
  <input type="search" id="f-q" placeholder="🔎 ISBN · 도서명 · 출판사 검색">
  <div class="dd" id="f-field"><button type="button" class="btn" id="f-field-btn">분야 <b id="f-field-lbl">전체</b> ▾</button>
    <div class="dd-panel"><div class="dd-act"><button type="button" id="f-field-all">모두</button><button type="button" id="f-field-none">해제(전체)</button></div><div id="f-field-list"></div></div></div>
  <select id="f-diff" class="btn"><option value="">스캔차이 전체</option><option value="nz">0 제외</option><option value="neg">부족만 (−)</option><option value="pos">초과만 (+)</option><option value="zero">0만</option></select>
  <select id="f-maj" class="btn"></select>
  <button type="button" class="btn" id="f-reset">초기화</button>
  <button type="button" class="btn noprint" id="f-print">🖨️ 인쇄</button>
  <span class="count" id="count"></span>
</div>
<div class="tbl-wrap"><table id="t">
<thead><tr>
  <th data-k="f">분야<span class="ar"></span></th><th data-k="i">ISBN<span class="ar"></span></th><th data-k="n">도서명<span class="ar"></span></th><th data-k="p">출판사<span class="ar"></span></th>
  <th data-k="loc">수불처코드<span class="ar"></span></th><th>대분류</th><th>중분류</th><th>소분류</th>
  <th data-k="s" class="num">전산재고<span class="ar"></span></th><th class="num">스캔수량</th><th data-k="ss" class="num">스캔합계<span class="ar"></span></th><th data-k="sd" class="num">스캔차이<span class="ar"></span></th>
</tr></thead>
<tfoot id="tf"></tfoot></table>
<div class="empty" id="empty" style="display:none">조건에 맞는 항목이 없습니다.</div></div>
<p class="hint">열 제목을 누르면 정렬(한 번 더 누르면 반대로). 필터는 ISBN 단위로 걸려서 서가가 여러 줄인 항목도 함께 보이고 숨습니다. 대분류를 고르면 그 대분류의 서가 줄만 남습니다(이때 스캔수량은 남은 서가만, 스캔합계·스캔차이는 그 ISBN 전체 기준). 스캔차이 = 스캔합계 − 전산재고(모자라면 −).</p>
</div>
<script type="application/json" id="sa-data">${json}</script>
<script>(${pageMain.toString()})();</script>
</body></html>`;
  }

  window.SAReport = { build };
})();
