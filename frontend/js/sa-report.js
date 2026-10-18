/* 재고조사 오차 → 혼자 열리는 HTML 보고서(파일 하나, 인터넷 없이도 동작).
   - 화면 표와 같은 열. ISBN 하나가 서가 여러 곳이면 항목 칸은 행을 합쳐(rowspan) 한 번만 보인다.
   - 필터: 검색 · 분야 · 스캔차이 · 대분류 · 사진 · 예외. 필터는 '항목 단위'라 서가 여러 줄 항목이 통째로 보이고 숨는다.
   - 머리글 줄 틀 고정, 열 제목 정렬, 필터 결과 합계, 인쇄.
   - 앱의 재고조사와 같은 흐름: 📷 바코드로 찾기 → 항목 상세 → 📷 사진 촬영(사진 속 다른 바코드도 함께) → 비고 → 저장.
     바코드 인식 모듈(isbn.js + ZXing)을 파일 안에 넣어 인터넷 없이 인식한다.
   - 사진은 이 HTML 파일 안에 저장된다: '💾 사진 포함 저장'을 누르면 사진이 들어간 새 HTML 파일을 내려받는다.
     그 사이에는 브라우저 임시 저장(되는 환경에서)으로 새로고침해도 남는다.
   내려받을 때만 불러온다(app.js 의 downloadHtml). */
(function () {
  'use strict';

  const CSS = `
:root{--bg:#f6f7f9;--surface:#fff;--text:#1f2328;--muted:#6b7280;--border:#e5e7eb;--head:#f1f3f5;--accent:#f5b400;--accent-soft:#fff6d6;
  --neg:#d1242f;--neg-soft:#fff1f1;--pos:#0a7c42;--pos-soft:#ecfdf3;--chip:#eef2ff;--chip-text:#3b4cca;--group:#fafbfc;--photo:#eaf7ff;--done:#e8f7ee;--done-text:#0a7c42;--exc:#fff4e5;--shadow:0 12px 40px rgba(0,0,0,.18)}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--surface:#171a21;--text:#e6e8eb;--muted:#9aa3ae;--border:#2a2f3a;--head:#1d212a;--accent:#f5b400;--accent-soft:#3a2f0a;
  --neg:#ff6b6b;--neg-soft:#3a1517;--pos:#4ade80;--pos-soft:#0f2a1a;--chip:#232a45;--chip-text:#a5b4fc;--group:#1a1e26;--photo:#10283a;--done:#123221;--done-text:#4ade80;--exc:#33270f;--shadow:0 12px 40px rgba(0,0,0,.6)}}
*{box-sizing:border-box}html,body{margin:0}
body{background:var(--bg);color:var(--text);font:14px/1.5 "Pretendard","Apple SD Gothic Neo","Malgun Gothic",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:1680px;margin:0 auto;padding:20px 20px 40px}
header{display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px}header .ttl{flex:1 1 auto}
header h1{margin:0;font-size:22px;letter-spacing:-.3px}header .sub{color:var(--muted);font-size:13px;margin-top:4px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:16px 0}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:11px 14px}
.card .k{font-size:12px;color:var(--muted)}.card .v{font-size:21px;font-weight:800;margin-top:2px;font-variant-numeric:tabular-nums}
.card .v small{font-size:12px;font-weight:500;color:var(--muted)}.card.neg .v{color:var(--neg)}.card.pos .v{color:var(--pos)}
.bar{position:sticky;top:0;z-index:30;display:flex;flex-wrap:wrap;gap:8px;align-items:center;background:var(--bg);padding:10px 0}
.bar input[type=search],.bar select,.btn{height:36px;border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:9px;padding:0 11px;font:inherit;font-size:13px}
.bar input[type=search]{min-width:200px;flex:1 1 220px;max-width:360px}
.btn{cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}.btn:hover{border-color:var(--accent)}.btn:disabled{opacity:.5;cursor:default}
.btn.on,select.on{background:var(--accent-soft);border-color:var(--accent);font-weight:700}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#1f2328;font-weight:800}
.btn.save{font-weight:700}.btn.save.dirty{background:#1f6feb;border-color:#1f6feb;color:#fff}
.dd{position:relative}.dd-panel{display:none;position:absolute;top:40px;left:0;z-index:40;background:var(--surface);border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow);padding:8px;min-width:220px;max-height:60vh;overflow:auto}
.dd.open .dd-panel{display:block}.dd-panel label{display:flex;gap:8px;align-items:center;padding:5px 6px;border-radius:6px;cursor:pointer;font-size:13px;white-space:nowrap}
.dd-panel label:hover{background:var(--head)}.dd-panel .dd-act{display:flex;gap:6px;padding:4px 4px 8px;border-bottom:1px solid var(--border);margin-bottom:4px}
.dd-panel .dd-act button{flex:1;height:28px;border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:6px;cursor:pointer;font-size:12px}
.count{color:var(--muted);font-size:13px;margin-left:auto}
/* 표: 머리글 줄 틀 고정 — 표 칸이 화면 높이만큼만 차지하고 그 안에서 스크롤, 머리글·합계 줄은 위·아래에 붙는다 */
.tbl-wrap{background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:auto;max-height:calc(100vh - var(--barh,60px) - 12px)}
@supports (height:100dvh){.tbl-wrap{max-height:calc(100dvh - var(--barh,60px) - 12px)}}
table{border-collapse:separate;border-spacing:0;width:100%;font-size:13px}
thead th{position:sticky;top:0;background:var(--head);text-align:left;font-weight:700;padding:9px 10px;border-bottom:1px solid var(--border);white-space:nowrap;cursor:pointer;user-select:none;z-index:3}
thead th.num{text-align:right}thead th:hover{color:var(--chip-text)}thead th .ar{font-size:10px;margin-left:3px;color:var(--chip-text)}
td{padding:7px 10px;border-bottom:1px solid var(--border);vertical-align:top;white-space:nowrap}
td.num{text-align:right;font-variant-numeric:tabular-nums}td.name{white-space:normal;min-width:200px;font-weight:600}
td.code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--muted)}
td.isbn{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:700}
tbody.g{cursor:pointer}tbody.g:nth-of-type(even) td{background:var(--group)}tbody.g.done td{background:var(--done)}tbody.g:hover td{background:var(--accent-soft)}
td.diff{font-weight:800}td.diff.neg{color:var(--neg);background:var(--neg-soft)!important}td.diff.pos{color:var(--pos);background:var(--pos-soft)!important}td.diff.zero{color:var(--muted)}
.chip{display:inline-block;padding:1px 8px;border-radius:999px;background:var(--chip);color:var(--chip-text);font-size:12px;font-weight:600}
.tag{display:inline-block;margin-left:6px;padding:0 6px;border-radius:6px;font-size:11px;font-weight:700;vertical-align:1px}
.tag.xs{background:#fde7ef;color:#b4235a;border:1px solid #f4a3c0}.tag.ph{background:#1f6feb;color:#fff}.tag.ok{background:var(--done-text);color:#fff}.tag.ex{background:var(--exc);color:#b45309;border:1px solid #f0bc3c}
tfoot td{position:sticky;bottom:0;background:var(--head);font-weight:800;border-top:2px solid var(--border);z-index:2}
.empty{padding:40px;text-align:center;color:var(--muted)}
.hint{color:var(--muted);font-size:12px;margin-top:10px}
/* 상세 창 */
.mbg{position:fixed;inset:0;background:rgba(15,17,21,.55);z-index:100;display:flex;align-items:flex-start;justify-content:center;padding:4vh 12px;overflow:auto}
.modal{background:var(--surface);color:var(--text);border-radius:16px;box-shadow:var(--shadow);width:min(760px,100%);padding:18px 18px 14px;position:relative}
.modal h3{margin:0 0 12px;font-size:17px}.modal .x{position:absolute;top:10px;right:10px;width:34px;height:34px;border-radius:50%;border:1px solid var(--border);background:var(--surface);color:var(--text);cursor:pointer;font-size:16px}
.d-top{display:flex;gap:14px}.d-cover{width:110px;min-width:110px;height:150px;border-radius:10px;background:var(--head);display:flex;align-items:center;justify-content:center;overflow:hidden;color:var(--muted);font-size:12px;position:relative;cursor:pointer}
.d-cover img{width:100%;height:100%;object-fit:cover}.d-cover .more{position:absolute;right:4px;bottom:4px;background:rgba(0,0,0,.6);color:#fff;border-radius:6px;font-size:10px;padding:1px 5px}
.d-meta{flex:1;min-width:0}.d-title{font-size:16px;font-weight:800;line-height:1.35}.d-sub{color:var(--muted);font-size:13px;margin-top:2px}.d-isbn{font-family:ui-monospace,Menlo,monospace;font-size:13px;margin-top:4px}
.d-stock{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.d-stock span{flex:1;min-width:76px;text-align:center;padding:8px 6px;background:var(--bg);border:1px solid var(--border);border-radius:10px;font-size:12px;color:var(--muted)}
.d-stock b{display:block;font-size:18px;color:var(--text);margin-top:2px}.d-stock .neg b{color:var(--neg)}.d-stock .pos b{color:var(--pos)}
.d-lbl{font-size:13px;font-weight:700;margin:14px 0 6px}.d-chips{display:flex;gap:6px;flex-wrap:wrap}
.d-cross{margin:10px 0 4px;padding:9px 10px;border:1px solid #f4a3c0;background:#fff6f9;border-radius:10px;font-size:12.5px}.d-cross .xr{display:flex;width:100%;gap:8px;align-items:center;text-align:left;margin-top:6px;padding:7px 9px;border:1px solid var(--border);border-radius:8px;background:#fff;cursor:pointer;font:inherit}.d-cross .xr small{display:block;color:var(--muted);font-size:11px}.d-cross .g{font-weight:700;color:#b4235a;white-space:nowrap}.d-cross .n{flex:1;min-width:0}.d-cross .dv{font-weight:700;white-space:nowrap}
table.pairs{table-layout:fixed}table.pairs td{vertical-align:middle}table.pairs thead th{cursor:default}
table.pairs th.pg,table.pairs td.pg{width:62px;text-align:center}table.pairs th.pm,table.pairs td.pm{width:34px;text-align:center;font-size:18px;color:#b4235a;padding:0}
table.pairs th.pw{width:24%}table.pairs tbody.g{cursor:default}
.pside{cursor:pointer;border-radius:8px;padding:6px 8px;display:flex;gap:10px;align-items:center}.pside:hover{background:var(--accent-soft,#eef6fb)}
.pside .pn{flex:1;min-width:0}.pside .pn b{display:block;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pside .pn small{display:block;color:var(--muted);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pside .pq{text-align:right;white-space:nowrap;font-size:11.5px;color:var(--muted)}.pside .pq .diff{display:block;font-size:16px;font-weight:800}
.pgrade{display:inline-block;font-weight:800;font-size:12px;color:#b4235a;background:#fde7ef;border:1px solid #f4a3c0;border-radius:6px;padding:1px 6px}.pgrade.g1{color:#8a5a6b;background:#f6f0f2;border-color:#e3c9d3}
td.pwhy{font-size:11.5px;color:var(--muted)}
table.pairs.m thead th:nth-child(n){width:auto}table.pairs.m thead th.pg,table.pairs.m td.pg{width:40px;padding-left:4px;padding-right:2px}table.pairs.m thead th.pm,table.pairs.m td.pm{width:20px;font-size:14px}table.pairs.m td{padding-left:4px;padding-right:4px}table.pairs.m .pgrade{font-size:11px;padding:1px 3px}table.pairs.m .pside{padding:4px 2px;gap:4px;flex-direction:column;align-items:stretch}table.pairs.m .pside .pq{text-align:left;white-space:normal;font-size:11px}table.pairs.m .pside .pq .diff{display:inline;font-size:14px;margin-right:4px}
table.pairs.m td.pwhy{padding-top:0}
.d-shelves{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:5px}
.d-shelves .d-chip{font-size:11.5px;padding:3px 7px;border-radius:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.d-chip{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;padding:4px 10px;background:var(--bg);border:1px solid var(--border);border-radius:999px}.d-chip b{color:var(--chip-text)}.d-chip.cur{border-color:var(--accent);background:var(--accent-soft)}
.d-photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px}
.d-photo{position:relative;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--bg)}
.d-photo img{width:100%;height:120px;object-fit:cover;display:block;cursor:zoom-in}.d-photo .meta{font-size:11px;color:var(--muted);padding:4px 6px;line-height:1.35}
.d-photo .del{position:absolute;top:4px;right:4px;width:26px;height:26px;border-radius:50%;border:none;background:rgba(0,0,0,.6);color:#fff;cursor:pointer}
.stage{display:flex;gap:12px;flex-wrap:wrap;margin-top:12px;padding:12px;border:2px dashed var(--accent);border-radius:12px;background:var(--accent-soft)}
.stage img{width:180px;max-width:100%;border-radius:8px}.stage .sb{flex:1;min-width:200px;display:flex;flex-direction:column;gap:8px}
.stage input{height:36px;border:1px solid var(--border);border-radius:8px;padding:0 10px;background:var(--surface);color:var(--text);font:inherit}
.acts{display:flex;gap:8px;align-items:center;margin-top:14px;flex-wrap:wrap}.acts .sp{flex:1}
.btn.ok{background:var(--done-text);border-color:var(--done-text);color:#fff;font-weight:800}.btn.ok.undo{background:var(--surface);color:var(--done-text)}
/* 휴대폰 표: 분야·상품코드·상품명·차이 + 서가 두 줄 */
table.m{table-layout:fixed;font-size:12.5px}table.m th,table.m td{padding:6px 6px;overflow:hidden;text-overflow:ellipsis}
table.m thead th:nth-child(1){width:19%}table.m thead th:nth-child(2){width:33%}table.m thead th:nth-child(4){width:14%}
table.m .chip{font-size:11px;padding:1px 6px;max-width:100%;overflow:hidden;text-overflow:ellipsis;vertical-align:middle}
table.m tfoot td{overflow:visible;white-space:nowrap}tbody.g{-webkit-tap-highlight-color:transparent}table.m td.isbn{font-size:12px}table.m td.mname{white-space:nowrap;font-weight:600}table.m .tag{margin-left:3px;padding:0 4px}
table.m td.msh{padding:0 6px 3px;border-bottom:none;font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--muted);white-space:nowrap}
table.m .mshr{display:grid;grid-template-columns:1fr 1fr;column-gap:8px}table.m .mshr span{overflow:hidden;text-overflow:ellipsis}
table.m .mshr b{font-weight:700;color:var(--chip-text);font-family:inherit}table.m .mmore{font-weight:700;color:var(--muted)}
table.m tbody.g tr:last-child td{border-bottom:1px solid var(--border);padding-bottom:6px}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#1f2328;color:#fff;padding:10px 16px;border-radius:10px;z-index:200;font-size:13px;box-shadow:var(--shadow);max-width:90vw}
.toast.err{background:#d1242f}.toast.ok{background:#0a7c42}
.zoom{position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:150;display:flex;align-items:center;justify-content:center;cursor:zoom-out}.zoom img{max-width:96vw;max-height:92vh;border-radius:8px}
.sync{margin:10px 0 0;padding:8px 12px;border-radius:10px;font-size:13px;font-weight:600;border:1px solid var(--border);background:var(--surface)}
.sync.ok{color:var(--done-text);border-color:var(--done-text)}.sync.busy{color:var(--chip-text)}.sync.warn{color:#b45309;border-color:#f0bc3c;background:var(--exc)}.sync.dead{color:var(--neg);border-color:var(--neg);background:var(--neg-soft)}
.banner{margin:10px 0 0;padding:10px 12px;border-radius:10px;background:var(--exc);border:1px solid #f0bc3c;font-size:13px}
@media (max-width:700px){.d-shelves{grid-template-columns:1fr 1fr}.bar{position:static}.wrap{padding:12px 10px 30px}header h1{font-size:18px}.card .v{font-size:17px}.bar input[type=search]{max-width:none}.count{width:100%;margin-left:0}
  .d-top{flex-direction:column}.d-cover{width:100%;height:220px}}
@media print{.bar,.hint,.noprint,.banner{display:none!important}body{background:#fff}.wrap{max-width:none;padding:0}.tbl-wrap{border:none;overflow:visible;max-height:none}thead th,tfoot td{position:static}
  td,th{padding:4px 6px;font-size:11px}tbody.g{break-inside:avoid}.card{padding:6px 10px}.card .v{font-size:16px}}
`;

  // 보고서 페이지 안에서 돌아가는 코드. 문자열로 직렬화해 넣으므로 바깥 변수를 쓰면 안 된다.
  function pageMain() {
    // 지금 이 순간의 문서 = 아직 아무것도 그리지 않은 원본. '사진 포함 저장' 때 사진 칸만 바꿔 끼워 새 파일로 만든다.
    const PRISTINE = '<!doctype html>\n' + document.documentElement.outerHTML;
    const D = JSON.parse(document.getElementById('sa-data').textContent);
    const items = D.items, META = D.meta || {};
    let PH = JSON.parse(document.getElementById('sa-photos').textContent || '{}');
    if (!PH.photos) PH = { photos: {}, updatedAt: 0 };
    if (!PH.checked) PH.checked = {};   // 확인완료: { isbn: 시각 } — 사진이 없어도 '확인' 버튼으로 표시
    const $ = (s, r) => (r || document).querySelector(s);
    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmt = (n) => Number(n || 0).toLocaleString('ko-KR');
    const sgn = (n) => (n > 0 ? '+' + fmt(n) : fmt(n));
    const byIsbn = new Map(items.map((x) => [x.i, x]));
    const st = { q: '', fields: new Set(), diff: '', maj: '', photo: '', exc: '', done: '', cross: '', sort: { k: null, dir: 1 } };
    // 교차 스캔 의심(앱이 계산해 넣음): x = [[짝 ISBN, 판단 3·2·1, '강함', '근거'], …], xg = 짝 묶음 번호
    const nCross = items.filter((x) => x.x).length;
    const MQ = window.matchMedia('(max-width:700px)');   // 휴대폰: 줄인 표
    const cut = (t, n) => { const a = [...String(t == null ? '' : t)]; return a.length > n ? a.slice(0, n).join('') + '…' : a.join(''); };
    const fields = [...new Set(items.map((x) => x.f).filter((x) => x !== ''))].sort((a, b) => a.localeCompare(b, 'ko'));
    const majs = [...new Set(items.flatMap((x) => x.sh.map((s) => s[1])).filter(Boolean))].sort();
    const nExc = items.filter((x) => x.e).length;
    const LAST = String.fromCharCode(65535);
    const loc = (x) => (x.sh[0] ? x.sh[0].slice(0, 4).join('') : LAST);
    let dirty = false;

    // ── 사진 보관 ─────────────────────────────
    const photosOf = (isbn) => Object.entries(PH.photos).filter(([, p]) => p.isbns.includes(isbn)).map(([id, p]) => ({ id, ...p })).sort((a, b) => a.at - b.at);
    const photoCount = (isbn) => { let n = 0; for (const p of Object.values(PH.photos)) if (p.isbns.includes(isbn)) n++; return n; };
    const nPhotos = () => Object.keys(PH.photos).length;
    // 확인완료 = 확인 버튼을 눌렀거나 사진을 찍은 항목
    const isDone = (isbn) => !!PH.checked[isbn] || photoCount(isbn) > 0;
    // 브라우저 임시 저장(IndexedDB). 파일로 연 HTML 은 브라우저에 따라 막혀 있을 수 있다 → 그땐 조용히 포기.
    const IDB = { db: null, ok: false };
    function idbOpen() {
      return new Promise((res) => {
        try {
          const r = indexedDB.open('bookjeok-sa-report', 1);
          r.onupgradeneeded = () => r.result.createObjectStore('photos');
          r.onsuccess = () => { IDB.db = r.result; IDB.ok = true; res(true); };
          r.onerror = () => res(false);
        } catch (_) { res(false); }
      });
    }
    function idbGet(key) { return new Promise((res) => { try { const g = IDB.db.transaction('photos').objectStore('photos').get(key); g.onsuccess = () => res(g.result || null); g.onerror = () => res(null); } catch (_) { res(null); } }); }
    function idbPut(key, val) { try { IDB.db.transaction('photos', 'readwrite').objectStore('photos').put(val, key); } catch (_) {} }
    function persist() { PH.updatedAt = Date.now(); if (IDB.ok) idbPut(META.rid, PH); }
    function changed(op) {
      dirty = true; persist();
      if (op && SY.on) enqueue(op);
      refreshSaveBtn(); render();
    }
    function refreshSaveBtn() {
      const b = $('#f-savefile');
      const syncing = SY.on && !SY.dead;
      // 웹하드 자동 저장이 되는 동안 '파일로 저장'은 예비용 — 강조하지 않는다
      b.classList.toggle('dirty', dirty && !syncing);
      b.innerHTML = syncing ? '💾 파일로도 저장' : `💾 저장 <span style="font-weight:400">(사진·확인 포함)</span>${dirty ? ' · 저장 안 됨' : ''}`;
      const z = $('#f-zip'); z.disabled = !nPhotos(); z.innerHTML = `📦 사진 ZIP 받기${nPhotos() ? ` <b>${nPhotos()}</b>` : ''}`;
    }
    // 웹하드로 아직 못 보낸 것이 있거나(자동 저장), 자동 저장이 없는데 파일로 저장 안 했으면 닫을 때 경고
    window.addEventListener('beforeunload', (e) => {
      if ((SY.on && !SY.dead && PH.q.length) || ((!SY.on || SY.dead) && dirty)) { e.preventDefault(); e.returnValue = ''; }
    });

    // ── 웹하드 자동 저장 ─────────────────────────────
    //  보고서를 만들 때 받은 열쇠(META.sync)로, 사진·확인 표시를 그 영업점 웹하드 폴더에 바로 저장한다.
    //  보낼 일은 대기열(PH.q)에 쌓고 순서대로 보낸다. 끊기면 모아 두었다가 연결되면 이어서(15초마다·온라인 복귀 시).
    //  열면 웹하드의 최신 상태(다른 휴대폰에서 찍은 것 포함)를 불러온다.
    const SYNC = META.sync && META.sync.token ? META.sync : null;
    const SY = { on: !!SYNC, dead: '', busy: false, last: 0, err: '', retry: null };
    if (!Array.isArray(PH.q)) PH.q = [];
    const apiUrl = (sub) => `${SYNC.api}/api/sa-report/${encodeURIComponent(SYNC.token)}${sub}`;
    const photoSrc = (p) => p.d || (SYNC && p.files && p.files[0] ? apiUrl(`/photo/${p.files[0].id}`) : '');
    const dataToBlob = (d) => { const bin = atob(d.slice(d.indexOf(',') + 1)); const u = new Uint8Array(bin.length); for (let k = 0; k < bin.length; k++) u[k] = bin.charCodeAt(k); return new Blob([u], { type: 'image/jpeg' }); };
    const DEAD_CODES = ['bad_key', 'revoked', 'expired', 'inactive'];
    function enqueue(op) {
      // 같은 ISBN 확인 표시는 마지막 것만, 아직 안 보낸 사진을 지우면 보낼 일과 함께 없앤다
      if (op.t === 'check') PH.q = PH.q.filter((o) => !(o.t === 'check' && o.isbn === op.isbn));
      if (op.t === 'del' && PH.q.some((o) => o.t === 'photo' && o.id === op.id)) { PH.q = PH.q.filter((o) => o.id !== op.id); persist(); syncUi(); return; }
      PH.q.push(op); persist(); flush();
    }
    async function flush() {
      if (!SY.on || SY.dead || SY.busy) { syncUi(); return; }
      if (!PH.q.length) { syncUi(); return; }
      SY.busy = true; syncUi();
      try {
        while (PH.q.length) {
          const op = PH.q[0]; let r;
          if (op.t === 'photo') {
            const p = PH.photos[op.id]; if (!p || !p.d) { PH.q.shift(); continue; }
            const fd = new FormData();
            fd.append('cid', op.id); fd.append('isbns', JSON.stringify(p.isbns)); fd.append('note', p.note || ''); fd.append('at', String(p.at));
            fd.append('file', dataToBlob(p.d), op.id + '.jpg');
            r = await fetch(apiUrl('/photo'), { method: 'POST', body: fd });
            if (r.ok) { const j = await r.json(); p.files = j.photo.files; p.synced = true; }
          } else if (op.t === 'del') {
            r = await fetch(apiUrl('/photo/' + encodeURIComponent(op.id)), { method: 'DELETE' });
          } else if (op.t === 'check') {
            r = await fetch(apiUrl('/check'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isbn: op.isbn, checked: op.on, at: op.at }) });
          } else { PH.q.shift(); continue; }
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            if (DEAD_CODES.includes(j.code)) { SY.dead = j.error || '보고서 열쇠를 쓸 수 없습니다'; break; }
            if (r.status >= 500 || r.status === 429 || r.status === 507) throw new Error(j.error || ('서버 ' + r.status));   // 나중에 다시
            toast('웹하드 저장 실패: ' + (j.error || r.status), 'err');   // 고쳐도 소용없는 거절 → 이 일은 버린다
          }
          PH.q.shift(); SY.last = Date.now(); SY.err = ''; persist();
        }
      } catch (e) {
        SY.err = navigator.onLine ? (e.message || '전송 실패') : '인터넷 연결 없음';
        clearTimeout(SY.retry); SY.retry = setTimeout(flush, 15000);
      } finally { SY.busy = false; syncUi(); refreshSaveBtn(); render(); }
    }
    async function pull() {
      if (!SY.on || SY.dead || SY.busy) return;
      try {
        const r = await fetch(apiUrl(''));
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { if (DEAD_CODES.includes(j.code)) SY.dead = j.error || '보고서 열쇠를 쓸 수 없습니다'; syncUi(); refreshSaveBtn(); return; }
        // 확인 표시: 웹하드 것 + 아직 못 보낸 내 변경
        const checked = { ...(j.checked || {}) };
        for (const op of PH.q) if (op.t === 'check') { if (op.on) checked[op.isbn] = op.at; else delete checked[op.isbn]; }
        // 사진: 웹하드 목록(내가 가진 사진 데이터는 그대로 씀) + 아직 못 보낸 내 사진. 지우려고 대기 중인 건 뺀다.
        const delQ = new Set(PH.q.filter((o) => o.t === 'del').map((o) => o.id));
        const next = {};
        for (const sp of (j.photos || [])) {
          if (delQ.has(sp.cid)) continue;
          const mine = PH.photos[sp.cid];
          next[sp.cid] = { isbns: sp.isbns, note: sp.note, at: sp.at, files: sp.files, synced: true, d: mine && mine.d };
        }
        for (const [id, p] of Object.entries(PH.photos)) if (!p.synced && !next[id]) next[id] = p;
        PH.checked = checked; PH.photos = next; SY.last = Date.now(); SY.err = '';
        persist(); render(); refreshSaveBtn();
      } catch (_) { SY.err = navigator.onLine ? '웹하드에 연결하지 못함' : '인터넷 연결 없음'; }
      syncUi();
    }
    function syncUi() {
      const el = $('#sync-st'); if (!el) return;
      if (!SY.on) { el.style.display = 'none'; return; }
      const n = PH.q.length;
      const hm = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
      let cls = 'ok', txt;
      if (SY.dead) { cls = 'dead'; txt = `⛔ 웹하드 저장 안 됨 — ${SY.dead} (💾 파일로 저장을 쓰세요)`; }
      else if (SY.busy) { cls = 'busy'; txt = `⏳ 웹하드로 보내는 중${n ? ` ${n}건` : ''}…`; }
      else if (n) { cls = 'warn'; txt = `⚠️ ${SY.err || '보내기 대기'} — ${n}건 대기 · 연결되면 자동 전송`; }
      else if (SY.err) { cls = 'warn'; txt = `⚠️ ${SY.err} — 다시 시도합니다`; }
      else txt = `☁️ 웹하드에 자동 저장됨${SY.last ? ` · ${hm(SY.last)}` : ''}`;
      el.className = 'sync ' + cls; el.textContent = txt; el.style.display = '';
      el.title = `${SYNC.owner || ''} 웹하드 ${SYNC.folder === '/' ? '최상위 폴더' : SYNC.folder || ''} · ${new Date(SYNC.expiresAt).toLocaleDateString('ko-KR')}까지`;
    }
    window.addEventListener('online', () => { SY.err = ''; flush(); });

    // 사진이 든 새 HTML 파일로 내려받기 = 이 파일 안에 사진 저장
    function saveFile() {
      const key = 'id="sa-photos">';
      const i = PRISTINE.indexOf(key); const j = PRISTINE.indexOf('<' + '/script>', i);   // 글자를 나눠 써야 이 스크립트가 HTML 안에서 끊기지 않는다
      if (i < 0 || j < 0) return toast('저장할 수 없습니다(파일 구조 오류)', 'err');
      const json = JSON.stringify(PH).replace(/</g, '\\u003c');
      const html = PRISTINE.slice(0, i + key.length) + json + PRISTINE.slice(j);
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
      const a = document.createElement('a'); a.href = url; a.download = (META.fileBase || '재고조사오차') + '.html';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
      dirty = false; refreshSaveBtn();
      toast(`사진 ${nPhotos()}장 · 확인 ${items.filter((x) => isDone(x.i)).length}건을 넣어 새 파일로 저장했습니다 — 앞으로는 그 파일을 여세요`, 'ok');
    }

    // 사진 ZIP 받기: 사진 한 장이 여러 항목에 들어가 있으면 항목마다 'ISBN.jpg'(같은 ISBN 이 또 있으면 'ISBN_2.jpg')로,
    //  앱이 웹하드에 올릴 때와 같은 이름. 사진 목록(ISBN·도서명·비고·시각)은 '사진목록.csv'로 함께 넣는다.
    //  JPEG 는 이미 압축된 형식이라 다시 압축하지 않고 그대로 담는다(ZIP 'stored') — 라이브러리 없이 작게.
    async function zipPhotos() {
      let skipped = 0;
      const list = Object.values(PH.photos).sort((a, b) => a.at - b.at);
      if (!list.length) return toast('저장된 사진이 없습니다', 'err');
      const files = []; const used = new Map();
      const p2 = (x) => String(x).padStart(2, '0');
      const when = (t) => { const d = new Date(t); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
      const csv = [['파일', 'ISBN', '도서명', '분야', '전산재고', '스캔차이', '비고', '찍은 시각']];
      for (const p of list) {
        let bytes;
        if (p.d) { const bin = atob(p.d.slice(p.d.indexOf(',') + 1)); bytes = new Uint8Array(bin.length); for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k); }
        else {   // 다른 휴대폰에서 찍어 웹하드에만 있는 사진은 받아서 넣는다
          try { const r = await fetch(photoSrc(p)); if (!r.ok) throw new Error(); bytes = new Uint8Array(await r.arrayBuffer()); }
          catch (_) { skipped++; continue; }
        }
        for (const isbn of p.isbns) {
          const n = (used.get(isbn) || 0) + 1; used.set(isbn, n);
          const name = n === 1 ? `${isbn}.jpg` : `${isbn}_${n}.jpg`;
          files.push({ name, data: bytes, at: p.at });
          const x = byIsbn.get(isbn) || {};
          csv.push([name, isbn, x.n || '', x.f || '', x.s == null ? '' : x.s, x.sd == null ? '' : x.sd, p.note || '', when(p.at)]);
        }
      }
      const cell = (v) => { const t = String(v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
      files.push({ name: '사진목록.csv', data: new TextEncoder().encode('\ufeff' + csv.map((r) => r.map(cell).join(',')).join('\r\n')), at: Date.now() });
      const blob = makeZip(files);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = (META.fileBase || '재고조사오차') + '_사진.zip';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast(`사진 ${files.length - 1}개 파일을 ZIP 으로 받았습니다${skipped ? ` (웹하드에서 못 받은 ${skipped}장 제외)` : ''}`, skipped ? '' : 'ok');
    }
    // 최소 ZIP 작성기(저장 방식 · UTF-8 파일 이름)
    function makeZip(files) {
      const T = new Uint32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
      const crc32 = (b) => { let c = 0xFFFFFFFF; for (let k = 0; k < b.length; k++) c = T[(c ^ b[k]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
      const enc = new TextEncoder();
      const parts = [], central = []; let off = 0;
      for (const f of files) {
        const name = enc.encode(f.name), d = new Date(f.at || Date.now());
        const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
        const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
        const crc = crc32(f.data), size = f.data.length;
        const lh = new DataView(new ArrayBuffer(30));
        lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
        lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true);
        lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
        parts.push(lh.buffer, name, f.data);
        const ch = new DataView(new ArrayBuffer(46));
        ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
        ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true);
        ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
        central.push(ch.buffer, name);
        off += 30 + name.length + size;
      }
      const cdSize = central.reduce((a, b) => a + (b.byteLength || b.length), 0);
      const end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
      end.setUint32(12, cdSize, true); end.setUint32(16, off, true);
      return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
    }

    // ── 공용 ─────────────────────────────
    let toastT = null;
    function toast(msg, kind) {
      let el = $('#toast'); if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
      el.className = 'toast ' + (kind || ''); el.textContent = msg; el.style.display = '';
      clearTimeout(toastT); toastT = setTimeout(() => { el.style.display = 'none'; }, 3200);
    }
    function modal(html, onClose) {
      const bg = document.createElement('div'); bg.className = 'mbg';
      bg.innerHTML = `<div class="modal" role="dialog"><button class="x" type="button" aria-label="닫기">✕</button>${html}</div>`;
      document.body.appendChild(bg); document.body.style.overflow = 'hidden';
      const close = () => { bg.remove(); if (!document.querySelector('.mbg')) document.body.style.overflow = ''; if (onClose) onClose(); };
      bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
      $('.x', bg).addEventListener('click', close);
      return { el: bg, q: (s) => $(s, bg), close };
    }
    const loadImg = (url) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('이미지를 읽지 못했습니다')); im.src = url; });
    // 사진을 긴 변 1280px JPEG 로 줄인다(파일 크기를 위해)
    async function shrink(file) {
      const url = URL.createObjectURL(file);
      try {
        const im = await loadImg(url);
        const k = Math.min(1, 1280 / Math.max(im.naturalWidth, im.naturalHeight));
        const c = document.createElement('canvas'); c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
        c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
        return { img: im, data: c.toDataURL('image/jpeg', 0.8) };
      } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
    }
    async function barcodes(img) {
      if (!window.ISBN) return [];
      try { const found = await window.ISBN.scanMulti(img); return [...new Set(found.map((f) => window.ISBN.clean(f.code)))]; } catch (_) { return []; }
    }
    function camera(onFile) {
      const cam = document.createElement('input'); cam.type = 'file'; cam.accept = 'image/*'; cam.capture = 'environment'; cam.style.display = 'none';
      document.body.appendChild(cam);
      cam.addEventListener('change', () => { const f = cam.files[0]; cam.remove(); if (f) onFile(f); });
      cam.click();
    }

    // ── 표 ─────────────────────────────
    $('#f-field-list').innerHTML = fields.map((f) => `<label><input type="checkbox" value="${esc(f)}"> ${esc(f)} <span style="color:var(--muted);margin-left:auto">${items.filter((x) => x.f === f).length}</span></label>`).join('');
    $('#f-maj').innerHTML = '<option value="">대분류 전체</option>' + majs.map((m) => `<option value="${esc(m)}">대분류 ${esc(m)}</option>`).join('');
    if (!nCross) $('#f-cross').style.display = 'none';
    if (!nExc) $('#f-exc').style.display = 'none'; else $('#f-exc').options[0].textContent = `예외 빼기 (${nExc}건)`;
    if (!window.ISBN) { $('#f-scan').title = '이 파일에는 바코드 인식 모듈이 없습니다'; }

    const excOk = (x) => (st.exc === 'all' ? true : st.exc === 'only' ? x.e : !x.e);
    function view() {
      const q = st.q.trim().toLowerCase();
      const out = [];
      for (const x of items) {
        if (!excOk(x)) continue;
        if (st.fields.size && !st.fields.has(x.f)) continue;
        if (q && !(x.i.toLowerCase().includes(q) || String(x.n).toLowerCase().includes(q) || String(x.p).toLowerCase().includes(q))) continue;
        if (st.diff === 'nz' && x.sd === 0) continue;
        if (st.diff === 'neg' && !(x.sd < 0)) continue;
        if (st.diff === 'pos' && !(x.sd > 0)) continue;
        if (st.diff === 'zero' && x.sd !== 0) continue;
        if (st.photo === 'has' && !photoCount(x.i)) continue;
        if (st.photo === 'no' && photoCount(x.i)) continue;
        if (st.done === 'done' && !isDone(x.i)) continue;
        if (st.done === 'todo' && isDone(x.i)) continue;
        if (st.cross === 'only' && !x.x) continue;
        let sh = x.sh;
        if (st.maj) { sh = sh.filter((s) => s[1] === st.maj); if (!sh.length) continue; }
        out.push({ x, sh });
      }
      // 교차 의심만: 짝끼리 붙여서(의심이 큰 묶음부터), 묶음 안에서는 더 찍힌 책(+) 먼저
      if (st.cross === 'only' && !st.sort.k) out.sort((a, b) => ((a.x.xg || 0) - (b.x.xg || 0)) || (b.x.sd - a.x.sd));
      if (st.sort.k) {
        const k = st.sort.k, d = st.sort.dir;
        const val = (r) => (k === 'loc' ? loc(r.x) : r.x[k]);
        const numeric = ['s', 'ss', 'sd'].includes(k);
        out.sort((a, b) => (numeric ? (val(a) - val(b)) : String(val(a)).localeCompare(String(val(b)), 'ko', { numeric: true })) * d);
      }
      return out;
    }
    function cards() {
      const base = items.filter(excOk);
      const sum = (k) => base.reduce((a, x) => a + (Number(x[k]) || 0), 0);
      const sd = sum('sd'), withPh = base.filter((x) => photoCount(x.i)).length;
      $('#cards').innerHTML = `
        <div class="card"><div class="k">오차 항목${st.exc === 'all' ? ' (예외 포함)' : st.exc === 'only' ? ' (예외만)' : ''}</div><div class="v">${fmt(base.length)}<small> 건</small></div></div>
        <div class="card"><div class="k">전산재고 합계</div><div class="v">${fmt(sum('s'))}</div></div>
        <div class="card"><div class="k">스캔합계</div><div class="v">${fmt(sum('ss'))}</div></div>
        <div class="card ${sd < 0 ? 'neg' : sd > 0 ? 'pos' : ''}"><div class="k">스캔차이 합계</div><div class="v">${sgn(sd)}</div></div>
        <div class="card neg"><div class="k">부족 항목 (−)</div><div class="v">${fmt(base.filter((x) => x.sd < 0).length)}<small> 건</small></div></div>
        <div class="card pos"><div class="k">초과 항목 (+)</div><div class="v">${fmt(base.filter((x) => x.sd > 0).length)}<small> 건</small></div></div>
        <div class="card"><div class="k">✅ 확인완료</div><div class="v" style="color:var(--done-text)">${fmt(base.filter((x) => isDone(x.i)).length)}<small> / ${fmt(base.length)}건 · 사진 ${fmt(withPh)}건</small></div></div>`;
    }
    // 머리글(PC: 12열 · 휴대폰: 분야·상품코드·상품명·차이)
    const HEAD_PC = [['f', '분야'], ['i', 'ISBN'], ['n', '도서명'], ['p', '출판사'], ['loc', '수불처코드'], ['', '대분류'], ['', '중분류'], ['', '소분류'], ['', '스캔수량', 1], ['s', '전산재고', 1], ['ss', '스캔합계', 1], ['sd', '스캔차이', 1]];
    const HEAD_M = [['f', '분야'], ['i', '상품코드'], ['n', '상품명'], ['sd', '차이', 1]];
    const shelfNo = (s) => `${s[0]}-${s[1]}-${s[2]}-${s[3]}`;
    // 휴대폰에선 수불처코드(앞 세 자리)는 빼고 대-중-소만 — 한 영업점 안에선 늘 같아 자리만 차지한다
    const shelfNoM = (s) => `${s[1]}-${s[2]}-${s[3]}`;
    const shelfTxt = (s) => `${shelfNo(s)} 스캔 ${fmt(s[4])}`;
    // 교차 의심만: 항목 표 대신 '더 찍힌 책 ↔ 덜 찍힌 책'을 한 줄에 — 짝을 나란히 놓고 보게.
    //  다른 필터(검색 · 분야 · 확인 …)는 그대로 — 둘 중 하나라도 남아 있으면 그 짝을 보인다. 양쪽 책을 누르면 그 책 상세.
    function pairList(rows) {
      const shown = new Set(rows.map((r) => r.x.i));
      const out = [], seen = new Set();
      for (const P of items) {
        if (!P.x || !(P.sd > 0)) continue;
        for (const c of P.x) {
          const M = byIsbn.get(c[0]); if (!M || !(M.sd < 0)) continue;
          const k = P.i + '|' + M.i; if (seen.has(k)) continue; seen.add(k);
          if (!shown.has(P.i) && !shown.has(M.i)) continue;
          out.push({ P, M, grade: c[1], label: c[2], why: c[3] });
        }
      }
      return out.sort((a, b) => (b.grade - a.grade) || ((a.P.xg || 0) - (b.P.xg || 0)));
    }
    function renderPairs(rows, mobile) {
      const list = pairList(rows);
      $('#t').classList.add('pairs'); $('#t').classList.toggle('m', mobile);
      $('#th').innerHTML = mobile
        ? '<tr><th class="pg">판단</th><th>더 찍힘 (+)</th><th class="pm">↔</th><th>덜 찍힘 (−)</th></tr>'
        : '<tr><th class="pg">판단</th><th>더 찍힌 책 (+)</th><th class="pm">↔</th><th>덜 찍힌 책 (−)</th><th class="pw">근거</th></tr>';
      const side = (o) => {
        const pc = photoCount(o.i), done = isDone(o.i);
        const where = (o.sh || []).slice(0, 2).map((s2) => (MQ.matches ? shelfNoM(s2) : shelfNo(s2))).join(', ') + ((o.sh || []).length > 2 ? ` 외 ${o.sh.length - 2}` : '');
        return `<div class="pside" data-oi="${esc(o.i)}" title="${esc(o.n)}"><div class="pn"><b>${esc(mobile ? cut(o.n, 18) : o.n)}${pc ? ` <span class="tag ph">📷 ${pc}</span>` : ''}${done && !pc ? ' <span class="tag ok">✓</span>' : ''}</b><small>${esc(o.i)}${where ? ' · ' + esc(where) : ' · 서가 없음'}</small></div>
          <div class="pq"><span class="diff ${o.sd < 0 ? 'neg' : 'pos'}">${sgn(o.sd)}</span>전산 ${fmt(o.s)} · 스캔 ${fmt(o.ss)}</div></div>`;
      };
      const html = list.map((p) => `<tbody class="g${isDone(p.P.i) && isDone(p.M.i) ? ' done' : ''}" data-i="${esc(p.P.i)}"><tr>
          <td class="pg"><span class="pgrade g${p.grade}">${esc(p.label)}</span></td><td>${side(p.P)}</td><td class="pm">↔</td><td>${side(p.M)}</td>${mobile ? '' : `<td class="pwhy">${esc(p.why)}</td>`}</tr>
          ${mobile ? `<tr><td></td><td class="pwhy" colspan="3">${esc(p.why)}</td></tr>` : ''}</tbody>`).join('');
      document.querySelectorAll('#t > tbody.g').forEach((g) => g.remove());
      if (list.length) $('#tf').insertAdjacentHTML('beforebegin', html);
      $('#empty').style.display = list.length ? 'none' : '';
      $('#tf').innerHTML = list.length ? `<tr><td colspan="${mobile ? 4 : 5}">교차 스캔 의심 · ${fmt(list.length)}쌍 — 책을 누르면 상세</td></tr>` : '';
      const total = items.filter(excOk).length;
      $('#count').textContent = `${fmt(list.length)}쌍 · 항목 ${fmt(rows.length)}건 / 전체 ${fmt(total)}건`;
      $('#f-field-btn').classList.toggle('on', st.fields.size > 0);
      $('#f-field-lbl').textContent = st.fields.size ? `${st.fields.size}개` : '전체';
      cards();
    }
    function render() {
      const rows = view(), mobile = MQ.matches;
      if (st.cross === 'only') return renderPairs(rows, mobile);
      $('#t').classList.remove('pairs');
      const head = mobile ? HEAD_M : HEAD_PC;
      $('#t').classList.toggle('m', mobile);
      $('#th').innerHTML = '<tr>' + head.map(([k, label, num]) => `<th${k ? ` data-k="${k}"` : ''}${num ? ' class="num"' : ''}>${label}${k ? `<span class="ar">${st.sort.k === k ? (st.sort.dir > 0 ? '▲' : '▼') : ''}</span>` : ''}</th>`).join('') + '</tr>';
      let html = '', sSys = 0, sQty = 0, sSum = 0, sDiff = 0;
      for (const { x, sh } of rows) {
        const dc = x.sd < 0 ? 'neg' : x.sd > 0 ? 'pos' : 'zero';
        const pc = photoCount(x.i), done = isDone(x.i);
        const xtip = x.x ? x.x.map((c) => { const o = byIsbn.get(c[0]); return `${o ? o.n : c[0]} ${o ? sgn(o.sd) : ''} (${c[2]})`; }).join('\n') : '';
        const tags = `${x.x ? `<span class="tag xs" title="교차 스캔 의심 — 같이 확인할 책\n${esc(xtip)}">🔀</span>` : ''}${pc ? `<span class="tag ph">📷 ${pc}</span>` : ''}${done && !pc ? '<span class="tag ok">✓</span>' : ''}${x.e ? '<span class="tag ex">예외</span>' : ''}`;
        sSys += x.s; sSum += x.ss; sDiff += x.sd;
        html += `<tbody class="g${done ? ' done' : ''}" data-i="${esc(x.i)}">`;
        if (mobile) {
          // 1줄: 분야 · 상품코드 · 상품명(10자 넘으면 …) · 차이 / 2~3줄: 서가 한 줄에 두 곳씩(최대 4곳, 넘치면 '외 N곳')
          //  5곳 이상이면 3곳까지 보이고 넷째 칸에 '외 N곳' — 세 줄을 넘지 않게
          const cells = sh.length > 4
            ? [...sh.slice(0, 3).map((s2) => `<span>${esc(shelfNoM(s2))} <b>스캔 ${fmt(s2[4])}</b></span>`), `<span class="mmore">외 ${sh.length - 3}곳</span>`]
            : sh.map((s2) => `<span>${esc(shelfNoM(s2))} <b>스캔 ${fmt(s2[4])}</b></span>`);
          const lines = []; for (let k = 0; k < cells.length; k += 2) lines.push(cells.slice(k, k + 2));
          const rs = lines.length + 1;
          html += `<tr><td>${x.f ? `<span class="chip">${esc(cut(x.f, 6))}</span>` : ''}</td><td class="isbn">${esc(x.i)}</td><td class="mname" title="${esc(x.n)}">${esc(cut(x.n, 10))}${tags}</td><td class="num diff ${dc}" rowspan="${rs}">${sgn(x.sd)}</td></tr>`;
          lines.forEach((pair) => { html += `<tr><td class="msh" colspan="3"><div class="mshr">${pair.join('')}</div></td></tr>`; });
        } else {
          const shelves = sh.length ? sh : [['', '', '', '', '']];
          const n = shelves.length, rs = n > 1 ? ` rowspan="${n}"` : '';
          shelves.forEach((s2, k) => {
            sQty += Number(s2[4]) || 0;
            html += '<tr>';
            if (k === 0) html += `<td${rs}>${x.f ? `<span class="chip">${esc(x.f)}</span>` : ''}</td><td${rs} class="isbn">${esc(x.i)}</td><td${rs} class="name">${esc(x.n)}${tags}</td><td${rs}>${esc(x.p)}</td>`;
            html += `<td class="code">${esc(s2[0])}</td><td class="code">${esc(s2[1])}</td><td class="code">${esc(s2[2])}</td><td class="code">${esc(s2[3])}</td>`;
            html += `<td class="num">${s2[4] === '' ? '' : fmt(s2[4])}</td>`;
            if (k === 0) html += `<td${rs} class="num">${fmt(x.s)}</td>`;
            if (k === 0) html += `<td${rs} class="num">${fmt(x.ss)}</td><td${rs} class="num diff ${dc}">${sgn(x.sd)}</td>`;
            html += '</tr>';
          });
        }
        html += '</tbody>';
      }
      // 항목마다 <tbody class="g"> 하나(줄무늬·강조·클릭이 항목 단위로). 이전 묶음을 지우고 tfoot 앞에 끼운다.
      document.querySelectorAll('#t > tbody.g').forEach((g) => g.remove());
      if (rows.length) $('#tf').insertAdjacentHTML('beforebegin', html);
      $('#empty').style.display = rows.length ? 'none' : '';
      const dcls = sDiff < 0 ? 'neg' : sDiff > 0 ? 'pos' : 'zero';
      $('#tf').innerHTML = !rows.length ? '' : mobile
        ? `<tr><td colspan="3">합계 · ${fmt(rows.length)}건</td><td class="num diff ${dcls}">${sgn(sDiff)}</td></tr>`
        : `<tr><td colspan="8">합계 · 항목 ${fmt(rows.length)}건</td><td class="num">${fmt(sQty)}</td><td class="num">${fmt(sSys)}</td><td class="num">${fmt(sSum)}</td><td class="num diff ${dcls}">${sgn(sDiff)}</td></tr>`;
      const total = items.filter(excOk).length;
      $('#count').textContent = rows.length === total ? `전체 ${fmt(total)}건` : `${fmt(rows.length)}건 / 전체 ${fmt(total)}건`;
      $('#f-field-btn').classList.toggle('on', st.fields.size > 0);
      $('#f-field-lbl').textContent = st.fields.size ? `${st.fields.size}개` : '전체';
      cards();
    }

    // ── 상세 · 사진 촬영 (앱과 같은 흐름) ─────────────────────────────
    function cover(el, isbn) {
      const i = String(isbn || '').replace(/[^0-9Xx]/g, '');
      if (i.length < 10) { el.textContent = '표지 없음'; return; }
      const main = `https://contents.kyobobook.co.kr/sih/fit-in/400x0/pdt/${i}.jpg`;
      const addt = (n) => `https://contents.kyobobook.co.kr/sih/fit-in/400x0/pdt/addt/${i}_${String(n).padStart(2, '0')}.jpg`;
      const ok = []; let view = 0;
      const img = document.createElement('img'); img.alt = '표지';
      img.onerror = () => { if (!ok.length) { img.remove(); el.textContent = navigator.onLine ? '표지 없음' : '표지(인터넷 필요)'; } };
      img.onload = () => { if (!ok.length) { ok.push(main); start(); } };
      img.src = main; el.appendChild(img);
      // 추가 이미지가 있으면 표지를 누를 때마다 넘긴다(마지막 다음은 처음으로).
      // 교보는 없는 번호에도 '이미지 준비중' 기본 그림을 200 으로 준다 — 예전엔 _01~_06 을 다 넣어 없는 것까지 7장이 됐다.
      // 앱(app.js attachCover)과 같이: 있을 수 없는 _97 의 크기를 '없음' 기준으로 잡고, _01 부터 차례로 보다가
      // 오류이거나 기준과 같은 크기가 나오면 멈춘다(교보는 번호를 빼먹지 않고 이어 붙인다).
      let none = null;
      function start() {
        const ref = new Image();
        ref.onload = () => { none = ref.naturalWidth > 1 ? ref.naturalWidth + 'x' + ref.naturalHeight : null; probe(1); };
        ref.onerror = () => { none = null; probe(1); };
        ref.src = addt(97);
      }
      function probe(n) {
        if (n > 20) return;
        const t = new Image();
        t.onload = () => { if (t.naturalWidth > 1 && t.naturalWidth + 'x' + t.naturalHeight !== none) { ok.push(addt(n)); badge(); probe(n + 1); } };
        t.src = addt(n);
      }
      function badge() { let b = $('.more', el); if (!b) { b = document.createElement('span'); b.className = 'more'; el.appendChild(b); } b.textContent = `⇄ ${view + 1}/${ok.length}`; }
      el.addEventListener('click', () => { if (ok.length < 2) return; view = (view + 1) % ok.length; img.src = ok[view]; badge(); });
    }
    function openDetail(isbn) {
      const x = byIsbn.get(isbn); if (!x) return;
      const dc = x.sd < 0 ? 'neg' : x.sd > 0 ? 'pos' : '';
      // 서가: 작게, 한 줄에 두 개씩
      const chips = x.sh.length
        ? `<div class="d-shelves">${x.sh.map((s) => `<span class="d-chip" title="${esc(shelfTxt(s))}">${esc(MQ.matches ? shelfNoM(s) : shelfNo(s))} <b>스캔 ${fmt(s[4])}</b></span>`).join('')}</div>`
        : '<div style="color:var(--muted);font-size:13px">서가 스캔 데이터 없음</div>';
      const checked = !!PH.checked[x.i];
      const m = modal(`<h3>📖 도서 상세${x.e ? ' <span class="tag ex">예외</span>' : ''}</h3>
        <div class="d-top"><div class="d-cover" id="d-cover"></div>
          <div class="d-meta"><div class="d-title">${esc(x.n || '(제목없음)')}</div><div class="d-sub">${esc(x.p)}${x.f ? ' · ' + esc(x.f) : ''}</div><div class="d-isbn">ISBN ${esc(x.i)}</div>
            <div class="d-stock"><span>전산재고<b>${fmt(x.s)}</b></span><span>스캔합계<b>${fmt(x.ss)}</b></span><span class="${dc}">스캔차이<b>${sgn(x.sd)}</b></span></div></div></div>
        <div class="d-lbl">서가 (${MQ.matches ? '대-중-소' : '수불처-대-중-소'} · 스캔수량)</div>${chips}
        ${x.x ? `<div class="d-cross">🔀 <b>교차 스캔 의심</b> — 이 책이 <b>${x.sd > 0 ? '더' : '덜'} 찍혔고</b> 비슷한 아래 책은 <b>${x.sd > 0 ? '덜' : '더'} 찍혔어요</b>. 같은 자리에서 바꿔 찍었는지 확인하세요.${x.x.map((c) => { const o = byIsbn.get(c[0]); return o ? `<button type="button" class="xr" data-xo="${esc(o.i)}"><span class="g">${esc(c[2])}</span><span class="n">${esc(o.n)}<small>${esc(o.i)} · ${esc(c[3])}</small></span><span class="dv diff ${o.sd < 0 ? 'neg' : 'pos'}">${sgn(o.sd)}</span></button>` : ''; }).join('')}</div>` : ''}
        <div class="d-lbl">📷 사진 <span id="d-pn" style="color:var(--muted);font-weight:400"></span></div><div class="d-photos" id="d-photos"></div>
        <div id="d-stage"></div>
        <div class="acts"><button class="btn" type="button" id="d-close">닫기</button><span class="sp"></span>
          <button class="btn ok${checked ? ' undo' : ''}" type="button" id="d-check">${checked ? '↩ 확인 취소' : '✅ 확인완료'}</button>
          <button class="btn primary" type="button" id="d-shoot">📷 사진 촬영</button></div>`);
      cover(m.q('#d-cover'), x.i);
      m.q('#d-close').addEventListener('click', m.close);
      m.el.querySelectorAll('[data-xo]').forEach((b) => b.addEventListener('click', () => { const o = b.dataset.xo; m.close(); openDetail(o); }));
      // 확인완료: 사진을 안 찍어도 '봤다'고 표시 → 창 닫고 목록에 색 표시. 다시 열어 누르면 취소.
      m.q('#d-check').addEventListener('click', () => {
        if (PH.checked[x.i]) {
          delete PH.checked[x.i]; changed({ t: 'check', isbn: x.i, on: false, at: Date.now() }); m.close();
          toast(photoCount(x.i) ? '확인 표시를 지웠습니다 — 사진이 있어 계속 확인완료로 보입니다' : '확인 취소');
        } else {
          const at = Date.now(); PH.checked[x.i] = at; changed({ t: 'check', isbn: x.i, on: true, at }); m.close();
          toast(SY.on && !SY.dead ? '✅ 확인완료 — 웹하드에 자동 저장' : '✅ 확인완료 — 끝나면 💾 저장', 'ok');
        }
      });
      const drawPhotos = () => {
        const list = photosOf(x.i);
        m.q('#d-pn').textContent = list.length ? `${list.length}장` : '아직 없음';
        m.q('#d-photos').innerHTML = list.map((p) => `<div class="d-photo"><img src="${photoSrc(p)}" data-z="${p.id}" alt="" loading="lazy"><button class="del" type="button" data-del="${p.id}" title="이 사진 지우기">✕</button>
          <div class="meta">${esc(new Date(p.at).toLocaleString('ko-KR'))}${p.isbns.length > 1 ? ` · 함께 찍힌 ${p.isbns.length - 1}건` : ''}${p.note ? '<br>' + esc(p.note) : ''}</div></div>`).join('');
        m.q('#d-photos').querySelectorAll('[data-z]').forEach((im) => im.addEventListener('click', () => zoom(photoSrc(PH.photos[im.dataset.z]))));
        m.q('#d-photos').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
          const p = PH.photos[b.dataset.del]; if (!p) return;
          if (!confirm(p.isbns.length > 1 ? `이 사진은 ${p.isbns.length}개 항목에 함께 들어가 있습니다. 모두에서 지울까요?` : '이 사진을 지울까요?')) return;
          const wasSynced = p.synced; delete PH.photos[b.dataset.del];
          changed(wasSynced ? { t: 'del', id: b.dataset.del } : null);
          if (!wasSynced) { PH.q = PH.q.filter((o) => o.id !== b.dataset.del); persist(); syncUi(); }
          drawPhotos();
        }));
      };
      drawPhotos();
      m.q('#d-shoot').addEventListener('click', () => camera(async (file) => {
        const btn = m.q('#d-shoot'); btn.disabled = true; btn.textContent = '⏳ 처리 중…';
        try {
          const { img, data } = await shrink(file);
          // 사진 속 바코드를 모두 인식 → 지금 항목 + 목록에 있는 다른 바코드도 저장 대상
          const codes = await barcodes(img);
          const targets = [x.i]; let skipped = 0;
          for (const c of codes) { if (c === x.i) continue; if (byIsbn.has(c)) targets.push(c); else skipped++; }
          stage(data, targets, skipped);
        } catch (e) { toast(e.message || '사진 처리 실패', 'err'); }
        finally { btn.disabled = false; btn.textContent = '📷 사진 촬영'; }
      }));
      function stage(data, targets, skipped) {
        m.q('#d-stage').innerHTML = `<div class="stage"><img src="${data}" alt="">
          <div class="sb"><div>저장 대상 <b>${targets.length}건</b></div><div class="d-chips">${targets.map((t) => `<span class="d-chip${t === x.i ? ' cur' : ''}">${esc(t)}</span>`).join('')}</div>
            ${skipped ? `<div style="color:var(--muted);font-size:12px">· 목록에 없는 바코드 ${skipped}건은 넣지 않음</div>` : ''}
            <input type="text" id="d-note" maxlength="200" placeholder="비고(선택) — 예: 파본·위치 등">
            <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" type="button" id="d-cancel">취소</button><button class="btn primary" type="button" id="d-save">💾 저장</button></div></div></div>`;
        m.q('#d-cancel').addEventListener('click', () => { m.q('#d-stage').innerHTML = ''; });
        m.q('#d-save').addEventListener('click', () => {
          const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          PH.photos[id] = { d: data, isbns: targets, note: (m.q('#d-note').value || '').trim(), at: Date.now(), synced: false };
          m.q('#d-stage').innerHTML = '';
          changed({ t: 'photo', id }); drawPhotos();
          toast(`${targets.length}건에 사진 저장${targets.length > 1 ? ` (함께 찍힌 ${targets.length - 1}건)` : ''}${SY.on && !SY.dead ? ' — 웹하드로 자동 저장' : " — 끝나면 '💾 저장'"}`, 'ok');
        });
      }
    }
    function zoom(src) { const z = document.createElement('div'); z.className = 'zoom'; z.innerHTML = `<img src="${src}" alt="">`; z.addEventListener('click', () => z.remove()); document.body.appendChild(z); }
    // 바코드로 찾기: 카메라 → 인식된 ISBN 중 목록에 있는 것 열기
    function scanFind() {
      if (!window.ISBN) return toast('이 파일에는 바코드 인식 모듈이 없습니다', 'err');
      camera(async (file) => {
        toast('바코드 인식 중…');
        try {
          const { img } = await shrink(file);
          const codes = await barcodes(img);
          const hits = codes.filter((c) => byIsbn.has(c));
          if (!hits.length) return toast(codes.length ? `인식된 바코드(${codes.join(', ')})가 오차 목록에 없습니다` : '바코드를 인식하지 못했습니다', 'err');
          if (hits.length === 1) return openDetail(hits[0]);
          const cm = modal(`<h3>🔎 찾은 항목 ${hits.length}건</h3>${hits.map((c) => `<button type="button" class="btn" data-pick="${esc(c)}" style="width:100%;justify-content:flex-start;margin-bottom:6px;height:auto;padding:8px 10px">${esc(c)} · ${esc(byIsbn.get(c).n)}</button>`).join('')}`);
          cm.el.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => { cm.close(); openDetail(b.dataset.pick); }));
        } catch (e) { toast(e.message || '인식 실패', 'err'); }
      });
    }

    // ── 이벤트 ─────────────────────────────
    let t = null;
    $('#f-q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { st.q = e.target.value; render(); }, 150); });
    const sel = (id, key) => $(id).addEventListener('change', (e) => { st[key] = e.target.value; e.target.classList.toggle('on', !!e.target.value); render(); });
    sel('#f-diff', 'diff'); sel('#f-maj', 'maj'); sel('#f-photo', 'photo'); sel('#f-exc', 'exc'); sel('#f-done', 'done'); sel('#f-cross', 'cross');
    const dd = $('#f-field');
    $('#f-field-btn').addEventListener('click', (e) => { e.stopPropagation(); dd.classList.toggle('open'); });
    document.addEventListener('click', (e) => { if (!dd.contains(e.target)) dd.classList.remove('open'); });
    $('#f-field-list').addEventListener('change', (e) => { if (e.target.checked) st.fields.add(e.target.value); else st.fields.delete(e.target.value); render(); });
    $('#f-field-all').addEventListener('click', () => { fields.forEach((f) => st.fields.add(f)); dd.querySelectorAll('input').forEach((c) => { c.checked = true; }); render(); });
    $('#f-field-none').addEventListener('click', () => { st.fields.clear(); dd.querySelectorAll('input').forEach((c) => { c.checked = false; }); render(); });
    $('#f-reset').addEventListener('click', () => {
      Object.assign(st, { q: '', diff: '', maj: '', photo: '', exc: '', done: '', cross: '', sort: { k: null, dir: 1 } }); st.fields.clear();
      ['#f-q', '#f-diff', '#f-maj', '#f-photo', '#f-exc', '#f-done', '#f-cross'].forEach((s) => { $(s).value = ''; $(s).classList.remove('on'); });
      dd.querySelectorAll('input').forEach((c) => { c.checked = false; });
      render();
    });
    $('#f-print').addEventListener('click', () => window.print());
    $('#f-scan').addEventListener('click', scanFind);
    $('#f-savefile').addEventListener('click', saveFile);
    $('#f-zip').addEventListener('click', zipPhotos);
    $('#th').addEventListener('click', (e) => {
      const th = e.target.closest('th[data-k]'); if (!th) return;
      const k = th.dataset.k;
      if (st.sort.k === k) st.sort.dir = -st.sort.dir; else st.sort = { k, dir: 1 };
      render();
    });
    MQ.addEventListener ? MQ.addEventListener('change', render) : MQ.addListener(render);   // 화면 돌리면 표 모양 바꿈
    $('#t').addEventListener('click', (e) => {
      const side = e.target.closest('[data-oi]'); if (side) { openDetail(side.dataset.oi); return; }   // 짝 표: 누른 쪽 책
      if ($('#t').classList.contains('pairs')) return;
      const g = e.target.closest('tbody.g'); if (g) openDetail(g.dataset.i);
    });
    // 틀 고정: 표 칸 높이 = 화면 − 필터 막대
    //  (휴대폰에선 필터 막대가 여러 줄이라 붙여 두지 않는다 → 표가 화면 전체를 쓰고 머리글만 고정)
    const fit = () => { const bar = $('.bar'); document.documentElement.style.setProperty('--barh', (getComputedStyle(bar).position === 'sticky' ? bar.offsetHeight : 0) + 'px'); };
    window.addEventListener('resize', fit); fit();

    refreshSaveBtn(); render(); syncUi();
    // 브라우저 임시 저장에 더 최근 것이 있으면(닫기 전에 못 보낸 것 등) 불러온 뒤 → 웹하드 최신 상태 → 남은 것 보내기
    idbOpen().then(async (ok) => {
      if (ok) {
        const saved = await idbGet(META.rid);
        if (saved && saved.photos && (saved.updatedAt || 0) > (PH.updatedAt || 0)) {
          PH = saved; if (!PH.checked) PH.checked = {}; if (!Array.isArray(PH.q)) PH.q = []; dirty = true;
          if (!SY.on) toast(`이 브라우저에 임시 저장된 사진 ${nPhotos()}장을 불러왔습니다 — 💾 저장으로 파일에 넣으세요`);
        }
      } else if (!SY.on) {
        $('#store-note').textContent = '이 브라우저에서는 임시 저장이 안 됩니다 — 사진을 찍은 뒤 꼭 💾 저장을 누르세요.'; $('#store-note').style.display = '';
      }
      refreshSaveBtn(); render();
      if (SY.on) { await pull(); flush(); setInterval(() => { if (!document.hidden && !PH.q.length) pull(); }, 60000); }
    });
  }

  const escHtml = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // 인라인 <script> 안에서 문서가 끊기지 않게
  const safeJs = (code) => String(code || '').replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
  const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
  const safeJson = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c').split(LS).join('\\u2028').split(PS).join('\\u2029');

  // meta: { title, source, generatedAt, fileBase }, items: [{ f, i, n, p, s, ss, sd, e, sh:[[code,maj,mid,min,qty],…] }]
  // libs: { zxing, isbn } — 바코드 인식 모듈 소스(없으면 사진만 찍을 수 있고 바코드 찾기는 꺼짐)
  function build(meta, items, libs) {
    const rid = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);   // 이 보고서 식별자(브라우저 임시 저장 열쇠)
    const data = { items, meta: { ...meta, rid } };
    const lib = libs && libs.zxing && libs.isbn ? `<script>${safeJs(libs.zxing)}</script>\n<script>${safeJs(libs.isbn)}</script>` : '';
    return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(meta.title)}</title><style>${CSS}</style></head>
<body><div class="wrap">
<header><div class="ttl"><h1>📊 ${escHtml(meta.title)}</h1>
<div class="sub">${escHtml(meta.source || '')}${meta.source ? ' · ' : ''}만든 시각 ${escHtml(meta.generatedAt)} · 북적북적 재고조사 오차체크</div></div>
<button type="button" class="btn noprint" id="f-zip" title="저장한 사진을 ZIP 하나로 받습니다(ISBN.jpg + 사진목록.csv)" disabled>📦 사진 ZIP 받기</button>
<button type="button" class="btn save noprint" id="f-savefile" title="찍은 사진을 넣어 이 보고서를 새 파일로 내려받습니다(이 파일 안에 사진 저장)">💾 사진 포함 저장</button></header>
<div class="sync" id="sync-st" style="display:none"></div>
<div class="banner" id="store-note" style="display:none"></div>
<div class="cards" id="cards"></div>
<div class="bar">
  <button type="button" class="btn primary noprint" id="f-scan">📷 바코드로 찾기</button>
  <input type="search" id="f-q" placeholder="🔎 ISBN · 도서명 · 출판사">
  <div class="dd" id="f-field"><button type="button" class="btn" id="f-field-btn">분야 <b id="f-field-lbl">전체</b> ▾</button>
    <div class="dd-panel"><div class="dd-act"><button type="button" id="f-field-all">모두</button><button type="button" id="f-field-none">해제(전체)</button></div><div id="f-field-list"></div></div></div>
  <select id="f-diff" class="btn"><option value="">스캔차이 전체</option><option value="nz">0 제외</option><option value="neg">부족만 (−)</option><option value="pos">초과만 (+)</option><option value="zero">0만</option></select>
  <select id="f-maj" class="btn"></select>
  <select id="f-done" class="btn"><option value="">확인 전체</option><option value="done">✅ 확인완료</option><option value="todo">미확인</option></select>
  <select id="f-photo" class="btn"><option value="">사진 전체</option><option value="has">사진 있음</option><option value="no">사진 없음</option></select>
  <select id="f-exc" class="btn"><option value="">예외 빼기</option><option value="all">예외 포함</option><option value="only">예외만</option></select>
  <select id="f-cross" class="btn" title="비슷한 책(1권·2권, 1-1·1-2, 판 차이…)이 한쪽은 더, 한쪽은 덜 찍힌 짝"><option value="">교차 전체</option><option value="only">🔀 교차 스캔 의심만</option></select>
  <button type="button" class="btn" id="f-reset">초기화</button>
  <button type="button" class="btn noprint" id="f-print">🖨️ 인쇄</button>
  <span class="count" id="count"></span>
</div>
<div class="tbl-wrap"><table id="t">
<thead id="th"></thead>
<tfoot id="tf"></tfoot></table>
<div class="empty" id="empty" style="display:none">조건에 맞는 항목이 없습니다.</div></div>

</div>
<script type="application/json" id="sa-data">${safeJson(data)}</script>
<script type="application/json" id="sa-photos">${safeJson({ photos: {}, updatedAt: 0 })}</script>
${lib}
<script>(${safeJs(pageMain.toString())})();</script>
</body></html>`;
  }

  window.SAReport = { build };
})();
