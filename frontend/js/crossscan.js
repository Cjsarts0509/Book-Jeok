/* 교차 스캔 의심 찾기 — 재고조사 오차에서 '비슷한 책을 바꿔 찍은' 짝을 찾는다.
 *
 * 학습지 1-1 · 1-2, 소설 1권 · 2권, 같은 책의 판(키링북 · 일반판)처럼 생김새가 비슷한 책이 한 자리에 있으면
 * B 를 찍어야 할 것을 A 로 찍기 쉽다. 그러면 A 는 더 찍히고(+) B 는 덜 찍힌다(−).
 * 2026-10-16 광화문점 결과(오차 2,224건 · 더 찍힘 253건)에서 이 모양의 짝이 28쌍(그중 23쌍은 수량까지 일치) 나왔다
 *   예) 퇴마록 외전3 +1 / 외전2 −1, 교열부의 쿠쥬 씨 2 +2 / 1 −2, 블루 아카이브 VOL.7 +3 / VOL.6 −3,
 *       큐브 개념 초등 수학 1-1 +1 / 1-2 −1, 위대한 개츠비(키링북) +3 / 위대한 개츠비 −3
 *
 * 짝이 되는 조건: 같은 출판사 · 한쪽은 +, 한쪽은 − · '권 · 학년 · 단계 · 판'을 지운 제목이 같거나 아주 비슷함.
 * 판단(높을수록 의심이 큼)
 *   3 강함  — 지운 제목이 같고 수량도 맞음(+2 / −2)
 *   2 보통  — 지운 제목이 같음, 또는 아주 비슷하고(0.85↑) 수량이 맞음
 *   1 약함  — 비슷함(0.8↑)
 *   같은 서가에서 둘 다 찍혔으면 한 단계 올린다(최대 3).
 * 사람이 확인할 목록을 좁혀 주는 것이지 확정이 아니다 — 판단과 근거를 같이 보여 준다.
 */
(function (g) {
  'use strict';
  const GRADE = { 3: '강함', 2: '보통', 1: '약함' };

  // 같은 시리즈 안에서 달라지는 부분(숫자 · 낱글자 A/B · 상/중/하 · 괄호 속 판 정보 · 권/편/단계 …)을 지운 제목
  function baseTitle(t) {
    return String(t == null ? '' : t).toLowerCase()
      .replace(/\(.*?\)|\[.*?\]/g, ' ')
      .replace(/[0-9０-９]+/g, '#')
      .replace(/(^|[^a-z])[a-z](?=[^a-z]|$)/g, '$1@')
      .replace(/[ⅰ-ⅻⅠ-Ⅻ]/g, '#')
      .replace(/(상|중|하|上|中|下)(권)?(?=\s|$)/g, '#')
      .replace(/권|편|단계|레벨|level|step|vol\.?|part/g, '')
      .replace(/[^0-9a-z가-힣#@]+/g, '');
  }
  const pubKey = (p) => String(p == null ? '' : p).replace(/\(.*?\)/g, '').replace(/\s+/g, '').toLowerCase();
  function bigrams(s) { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); m.set(k, (m.get(k) || 0) + 1); } return m; }
  function dice(a, b) {
    if (a === b) return 1;
    const A = bigrams(a), B = bigrams(b); let x = 0, na = 0, nb = 0;
    for (const v of A.values()) na += v;
    for (const v of B.values()) nb += v;
    for (const [k, v] of A) if (B.has(k)) x += Math.min(v, B.get(k));
    return na + nb ? (2 * x) / (na + nb) : 0;
  }

  /**
   * @param items [{ key, name, pub, diff, shelves: ['서가번호', …] }] — diff 는 스캔 − 전산(모자라면 −). 예외 항목은 넣지 않는다.
   * @returns { pairs: [{ plus, minus, grade, label, why: [...], sim }], byKey: Map(key → [{ other, grade, label, why }]), groupOf: Map(key → 묶음 번호) }
   */
  function find(items) {
    const prep = items.filter((x) => x && x.key && Number(x.diff) !== 0 && x.name).map((x) => ({
      ...x, diff: Number(x.diff), b: baseTitle(x.name), p: pubKey(x.pub), sh: new Set((x.shelves || []).map(String)),
    }));
    const minusByPub = new Map();
    for (const x of prep) if (x.diff < 0 && x.p) { if (!minusByPub.has(x.p)) minusByPub.set(x.p, []); minusByPub.get(x.p).push(x); }
    const pairs = [];
    for (const P of prep) {
      if (P.diff <= 0 || !P.p || P.b.length < 2) continue;
      for (const M of minusByPub.get(P.p) || []) {
        if (M.key === P.key || M.b.length < 2) continue;
        const sim = dice(P.b, M.b);
        if (sim < 0.8) continue;
        const same = P.b === M.b, qty = P.diff === -M.diff;
        let grade = same && qty ? 3 : (same || (sim >= 0.85 && qty)) ? 2 : 1;
        const why = [same ? '권 · 판만 다른 같은 제목' : `제목 비슷함 ${Math.round(sim * 100)}%`];
        if (qty) why.push(`수량 일치 (+${P.diff} / ${M.diff})`);
        const shared = [...P.sh].filter((s) => M.sh.has(s));
        if (shared.length) { why.push(`같은 서가 ${shared.slice(0, 2).join(', ')}${shared.length > 2 ? ' 외' : ''}`); grade = Math.min(3, grade + 1); }
        pairs.push({ plus: P.key, minus: M.key, grade, label: GRADE[grade], why, sim });
      }
    }
    pairs.sort((a, b) => (b.grade - a.grade) || (b.sim - a.sim));
    const byKey = new Map();
    const add = (k, other, p) => { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push({ other, grade: p.grade, label: p.label, why: p.why }); };
    for (const p of pairs) { add(p.plus, p.minus, p); add(p.minus, p.plus, p); }
    // 짝끼리 이어진 것을 한 묶음으로(1권 + / 2권 − / 3권 − 처럼 셋 이상도) — 목록에서 붙여 보여 주려고
    const parent = new Map(); const root = (k) => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
    for (const k of byKey.keys()) parent.set(k, k);
    for (const p of pairs) { const a = root(p.plus), b = root(p.minus); if (a !== b) parent.set(a, b); }
    const groupOf = new Map(); const ids = new Map(); let n = 0;
    for (const p of pairs) for (const k of [p.plus, p.minus]) { const r = root(k); if (!ids.has(r)) ids.set(r, ++n); groupOf.set(k, ids.get(r)); }
    return { pairs, byKey, groupOf };
  }

  g.CrossScan = { find, baseTitle, dice, GRADE };
})(typeof window !== 'undefined' ? window : globalThis);
