'use strict';

// 주간 시스템 상태 리포트 생성 — 계정별 디스크, 최근 7일 활동/실패, 특이사항.
// 이메일용 HTML(인라인 스타일)과 텍스트를 함께 생성한다.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { query } = require('./db');
const { diskTotalBytes, allocatedBytes } = require('./disk');

// 백업 상태 파일(_backup-status/*) 읽기 — 스크립트가 실행 결과를 여기에 기록한다.
const bkDir = () => path.join(config.storageRoot, '_backup-status');
const readJsonFile = (name) => { try { return JSON.parse(fs.readFileSync(path.join(bkDir(), name), 'utf8')); } catch { return null; } };
function readBackupStatus() {
  return { db: readJsonFile('db.json'), files: readJsonFile('files.json'), offsite: readJsonFile('offsite.json') };
}
const ageHours = (iso) => { const t = iso ? new Date(iso).getTime() : 0; return t ? (Date.now() - t) / 3600000 : Infinity; };
const KST = (t) => new Date(t + 9 * 3600000).toISOString().slice(0, 10);   // KST 기준 YYYY-MM-DD
function readOffsiteHistory() {
  try {
    return fs.readFileSync(path.join(bkDir(), 'offsite-history.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
// 최근 numDays일(오늘 포함)의 일자별 백업 성공 여부.
//  db: 날짜별 덤프 존재 여부(있으면 성공). offsite: 이력(true/false), 없으면 null(모름).
function backupDays(numDays = 7) {
  const dbHave = new Set();
  for (const x of (readJsonFile('db-list.json') || [])) { const m = /bookjeok-db-(\d{4}-\d{2}-\d{2})_/.exec(x.name || ''); if (m) dbHave.add(m[1]); }
  const offHave = new Map();
  for (const h of readOffsiteHistory()) { if (h && h.date) offHave.set(h.date, h.ok !== false); }
  const db = [], offsite = [];
  for (let i = numDays - 1; i >= 0; i--) {
    const key = KST(Date.now() - i * 86400000);
    db.push({ date: key, ok: dbHave.has(key) });
    offsite.push({ date: key, ok: offHave.has(key) ? offHave.get(key) : null });
  }
  return { db, offsite };
}

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

  // 백업 상태 → 일자별 성공 여부로 판정, 실패/누락이면 특이사항에 올린다.
  // 방침: DB 일간(로컬) + 계정 밖(구글 드라이브) 매일이 DB·파일의 주 오프사이트.
  const backup = readBackupStatus();
  const days = backupDays(7);
  const dbOkCnt = days.db.filter((x) => x.ok).length;
  if (dbOkCnt === 0) anomalies.push('DB 백업 기록이 없습니다 — 스케줄 확인 필요');
  else { const miss = days.db.filter((x) => !x.ok).length; if (miss > 0) anomalies.push(`최근 7일 중 DB 백업 누락 ${miss}일 — 확인 필요`); }
  if (!backup.offsite) anomalies.push('계정 밖(구글 드라이브) 백업 기록이 없습니다 — 설정/스케줄 확인');
  else {
    const offFail = days.offsite.filter((x) => x.ok === false).length;
    if (offFail > 0) anomalies.push(`최근 7일 중 계정 밖 백업 실패 ${offFail}일 — 확인 필요`);
    else if (ageHours(backup.offsite.at) > 50) anomalies.push(`계정 밖 백업이 ${Math.floor(ageHours(backup.offsite.at) / 24)}일째 갱신 안 됨`);
  }

  return {
    backup, backupDays: days,
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

  // 백업: 최근 7일 일자별 성공 여부 그리드
  const b = d.backup || {};
  const dd = d.backupDays || { db: [], offsite: [] };
  const cell = (ok) => `<td style="text-align:center;padding:4px 5px">${ok === true ? '✅' : ok === false ? '<span style="color:#EA4B54">❌</span>' : '<span style="color:#bbb">–</span>'}</td>`;
  const dayHdr = dd.db.map((x) => `<th style="padding:3px 5px;font-size:11px;color:#888;font-weight:600">${esc(x.date.slice(5).replace('-', '/'))}</th>`).join('');
  const lastRun = (st) => (st && st.at ? new Date(st.at).toLocaleString('ko-KR') : '기록 없음');
  const backupTable = `<table style="border-collapse:collapse;font-size:13px">
      <tr><td></td>${dayHdr}</tr>
      <tr><td style="padding:3px 8px 3px 0;white-space:nowrap">DB (일간)</td>${dd.db.map((x) => cell(x.ok)).join('')}</tr>
      <tr><td style="padding:3px 8px 3px 0;white-space:nowrap">계정 밖 (구글드라이브)</td>${dd.offsite.map((x) => cell(x.ok)).join('')}</tr>
    </table>
    <p style="color:#888;font-size:11px;margin:6px 0 0">✅ 성공 · ❌ 실패/누락 · – 기록 없음 &nbsp;|&nbsp; 최근 실행 — DB ${esc(lastRun(b.db))} · 계정 밖 ${b.offsite ? esc(lastRun(b.offsite)) : '미설정'}</p>`;

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
      <h3 style="margin:20px 0 8px">🛟 백업 (최근 7일 일자별)</h3>${backupTable}
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
    '[백업 · 최근 7일] (✅성공 ❌실패/누락 –기록없음)',
    ` - DB(일간):    ${dd.db.map((x) => x.date.slice(5) + ' ' + (x.ok ? '✅' : '❌')).join('  ')}`,
    ` - 계정밖(매일): ${dd.offsite.map((x) => x.date.slice(5) + ' ' + (x.ok === true ? '✅' : x.ok === false ? '❌' : '–')).join('  ')}`, '',
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

module.exports = { buildWeekly, collect, render, backupDays };
