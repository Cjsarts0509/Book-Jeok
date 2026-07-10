'use strict';

// 주간 시스템 상태 리포트 생성 — 계정별 디스크, 최근 7일 활동/실패, 특이사항.
// 이메일용 HTML(인라인 스타일)과 텍스트를 함께 생성한다.
const { query } = require('./db');
const { diskTotalBytes, allocatedBytes } = require('./disk');

function fmtBytes(n) {
  n = Number(n) || 0;
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
}
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function collect() {
  const [disk, alloc, accountsR, actsR, failByUserR, dailyR] = await Promise.all([
    diskTotalBytes(),
    allocatedBytes(),
    query(`SELECT u.id, u.username, u.display_name, u.role, u.quota_bytes,
             COALESCE(SUM(f.size_bytes),0) AS used, COUNT(f.id)::int AS files
           FROM users u LEFT JOIN files f ON f.owner_id=u.id AND f.deleted_at IS NULL
           GROUP BY u.id ORDER BY used DESC`),
    query(`SELECT action, count(*)::int AS c FROM audit_log
           WHERE created_at > now() - interval '7 days' GROUP BY action`),
    query(`SELECT u.username, u.display_name, a.action, count(*)::int AS c
           FROM audit_log a JOIN users u ON u.id=a.user_id
           WHERE a.created_at > now() - interval '7 days'
             AND a.action IN ('login_failed','file_blocked','malware_blocked')
           GROUP BY u.username, u.display_name, a.action ORDER BY c DESC`),
    query(`SELECT to_char(date_trunc('day',created_at),'MM-DD') AS d,
             count(*) FILTER (WHERE action='upload')::int AS uploads,
             count(*) FILTER (WHERE action='download')::int AS downloads,
             count(*) FILTER (WHERE action IN ('file_blocked','malware_blocked'))::int AS blocked,
             count(*) FILTER (WHERE action='login_failed')::int AS login_failed
           FROM audit_log WHERE created_at > now() - interval '7 days' GROUP BY 1 ORDER BY 1`),
  ]);

  const total = disk;
  const used = accountsR.rows.reduce((s, r) => s + Number(r.used), 0);
  const acts = Object.fromEntries(actsR.rows.map((r) => [r.action, r.c]));
  const accounts = accountsR.rows.map((r) => ({
    username: r.username, displayName: r.display_name, role: r.role,
    quota: Number(r.quota_bytes), used: Number(r.used), files: r.files,
    pct: Number(r.quota_bytes) > 0 ? pct(Number(r.used), Number(r.quota_bytes)) : null,
  }));

  // 특이사항
  const anomalies = [];
  const diskPct = pct(used, total);
  if (diskPct >= 90) anomalies.push(`디스크 사용량 ${diskPct}% (${fmtBytes(used)}/${fmtBytes(total)}) — 정리/증설 검토 필요`);
  const allocPct = pct(alloc, total);
  if (allocPct >= 95) anomalies.push(`할당 합계가 디스크의 ${allocPct}% — 추가 발급 제한 임박`);
  accounts.filter((a) => a.pct != null && a.pct >= 90).forEach((a) => anomalies.push(`${a.displayName}(@${a.username}) 할당량 ${a.pct}% 사용`));
  const blocked = (acts.file_blocked || 0) + (acts.malware_blocked || 0);
  if (blocked > 0) anomalies.push(`업로드 차단 ${blocked}건 (형식위장/악성패턴) — 아래 계정별 실패 이력 참고`);
  if ((acts.login_failed || 0) >= 10) anomalies.push(`로그인 실패 ${acts.login_failed}건 — 비정상 접근 가능성 점검`);

  return {
    range: '최근 7일',
    storage: { total, used, alloc, available: Math.max(0, total - alloc), usedPct: diskPct, allocPct },
    activity: {
      uploads: acts.upload || 0, downloads: acts.download || 0,
      blocked, malware: acts.malware_blocked || 0, fileBlocked: acts.file_blocked || 0,
      loginFailed: acts.login_failed || 0,
    },
    accounts, failByUser: failByUserR.rows, daily: dailyR.rows, anomalies,
  };
}

function render(d) {
  const actionKo = { login_failed: '로그인 실패', file_blocked: '형식위장 차단', malware_blocked: '악성패턴 차단' };
  const s = d.storage;
  const accRows = d.accounts.map((a) => {
    const barPct = a.pct != null ? Math.min(100, a.pct) : Math.min(100, pct(a.used, s.used || 1));
    const warn = a.pct != null && a.pct >= 90;
    const label = a.quota > 0 ? `${fmtBytes(a.used)} / ${fmtBytes(a.quota)} (${a.pct}%)` : `${fmtBytes(a.used)} · ${a.role === 'admin' ? '무제한' : '미할당'}`;
    return `<tr>
      <td style="padding:6px 8px;border-bottom:1px solid #eee">${esc(a.displayName)} <span style="color:#888;font-size:12px">@${esc(a.username)}</span></td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;width:180px">
        <div style="background:#eef1f4;border-radius:4px;height:10px;overflow:hidden"><div style="height:10px;width:${barPct}%;background:${warn ? '#EA4B54' : '#118AB2'}"></div></div>
      </td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;font-size:13px;color:${warn ? '#EA4B54' : '#333'}">${label}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;color:#666">${a.files}개</td>
    </tr>`;
  }).join('');

  const failRows = d.failByUser.length
    ? d.failByUser.map((r) => `<tr><td style="padding:4px 8px;border-bottom:1px solid #eee">${esc(r.display_name)} <span style="color:#888">@${esc(r.username)}</span></td><td style="padding:4px 8px;border-bottom:1px solid #eee">${actionKo[r.action] || r.action}</td><td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">${r.c}건</td></tr>`).join('')
    : '<tr><td colspan="3" style="padding:8px;color:#888">실패 이력 없음 👍</td></tr>';

  const anomalyList = d.anomalies.length
    ? `<ul style="margin:6px 0 0;padding-left:18px">${d.anomalies.map((a) => `<li style="margin:3px 0">${esc(a)}</li>`).join('')}</ul>`
    : '<p style="color:#0a0;margin:6px 0 0">특이사항 없음 ✅</p>';

  const html = `<div style="font-family:-apple-system,'Malgun Gothic',sans-serif;max-width:720px;margin:0 auto;color:#222">
    <div style="background:#FFD166;padding:18px 20px;border-radius:12px 12px 0 0">
      <div style="font-size:20px;font-weight:800">📮 북적북적 주간 리포트</div>
      <div style="font-size:13px;color:#5a4a00;margin-top:2px">${esc(d.range)} 시스템 상태 요약</div>
    </div>
    <div style="border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px;padding:20px">
      <h3 style="margin:0 0 8px">⚠️ 특이사항</h3>${anomalyList}
      <h3 style="margin:20px 0 8px">💾 디스크</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><td style="padding:4px 8px">전체</td><td style="padding:4px 8px;text-align:right">${fmtBytes(s.total)}</td>
            <td style="padding:4px 8px">사용 중</td><td style="padding:4px 8px;text-align:right">${fmtBytes(s.used)} (${s.usedPct}%)</td></tr>
        <tr><td style="padding:4px 8px">할당 합계</td><td style="padding:4px 8px;text-align:right">${fmtBytes(s.alloc)} (${s.allocPct}%)</td>
            <td style="padding:4px 8px">할당 가능</td><td style="padding:4px 8px;text-align:right">${fmtBytes(s.available)}</td></tr>
      </table>
      <h3 style="margin:20px 0 8px">📊 최근 7일 활동</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px;text-align:center">
        <tr style="color:#666;font-size:12px"><td>업로드</td><td>다운로드</td><td>차단(형식/악성)</td><td>로그인 실패</td></tr>
        <tr style="font-weight:700;font-size:18px"><td>${d.activity.uploads}</td><td>${d.activity.downloads}</td><td style="color:${d.activity.blocked ? '#EA4B54' : '#222'}">${d.activity.blocked}</td><td style="color:${d.activity.loginFailed ? '#EA4B54' : '#222'}">${d.activity.loginFailed}</td></tr>
      </table>
      <h3 style="margin:20px 0 8px">🗄️ 계정별 디스크 사용량</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px">${accRows || '<tr><td>계정 없음</td></tr>'}</table>
      <h3 style="margin:20px 0 8px">🚫 계정별 실패 이력 (7일)</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px">${failRows}</table>
      <p style="color:#999;font-size:12px;margin-top:20px">이 메일은 북적북적 관리자 시스템이 매주 자동 발송합니다.</p>
    </div>
  </div>`;

  const text = [
    `북적북적 주간 리포트 (${d.range})`, '',
    '[특이사항]', ...(d.anomalies.length ? d.anomalies.map((a) => ' - ' + a) : [' - 없음']), '',
    `[디스크] 사용 ${fmtBytes(s.used)}/${fmtBytes(s.total)} (${s.usedPct}%), 할당 ${fmtBytes(s.alloc)} (${s.allocPct}%), 가능 ${fmtBytes(s.available)}`, '',
    `[7일 활동] 업로드 ${d.activity.uploads} · 다운로드 ${d.activity.downloads} · 차단 ${d.activity.blocked} · 로그인실패 ${d.activity.loginFailed}`, '',
    '[계정별 사용량]',
    ...d.accounts.map((a) => ` - ${a.displayName}(@${a.username}): ${fmtBytes(a.used)}${a.quota > 0 ? '/' + fmtBytes(a.quota) + ' (' + a.pct + '%)' : ''} · ${a.files}개`),
  ].join('\n');

  return { subject: `[북적북적] 주간 리포트 · ${new Date().toLocaleDateString('ko-KR')}`, html, text };
}

async function buildWeekly() {
  const data = await collect();
  return { ...render(data), data };
}

module.exports = { buildWeekly, collect, render };
