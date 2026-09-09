'use strict';

// 시스템 경보 허브 — 감시 모듈(metrics.js 등)이 발견한 이상을 한 곳으로 모아
// 관리자에게 전달하고, 최근 경보 이력을 메모리에 남긴다(상태 대시보드가 읽음).
//
// 설계 원칙
//  · 같은 문제로 알림이 쏟아지지 않게 키별 쿨다운(기본 30분)을 둔다.
//  · '상태가 나아졌다'도 한 번은 알린다(해제 알림) — 사람이 언제 끝났는지 알 수 있게.
//  · 알림 실패가 본 기능을 막지 않는다. 모두 try/catch.
const { query } = require('./db');
const notify = require('./notify');
const mailer = require('./mailer');

const COOLDOWN_MS = parseInt(process.env.ALERT_COOLDOWN_MS || String(30 * 60 * 1000), 10);
const HISTORY_MAX = 200;

const LEVEL_ICON = { info: 'ℹ️', warn: '⚠️', danger: '🚨', ok: '✅' };
const LEVEL_RANK = { ok: 0, info: 1, warn: 2, danger: 3 };

const active = new Map();    // key -> { level, message, since, lastSentAt, count }
const history = [];          // 최근 경보/해제 이력(최신 우선)

const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function record(entry) {
  history.unshift(entry);
  if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
}

async function adminIds() {
  try {
    const r = await query("SELECT id FROM users WHERE role = 'admin' AND is_active = TRUE");
    return r.rows.map((x) => x.id);
  } catch (e) { console.warn('[alert] 관리자 조회 실패:', e.message); return []; }
}

async function deliver(level, title, body) {
  const icon = LEVEL_ICON[level] || 'ℹ️';
  console.warn(`[alert:${level}] ${title}${body ? ' — ' + body : ''}`);
  try {
    for (const id of await adminIds()) await notify.push({ userId: id, type: 'system', title: `${icon} ${title}`, body });
  } catch (e) { console.warn('[alert] 인앱 알림 실패:', e.message); }
  // 메일은 심각한 것만(경고 폭주로 메일함이 잠기지 않도록)
  if (level === 'danger' && mailer.enabled() && mailer.recipients().length) {
    try {
      await mailer.send({
        subject: `[북적북적] ${icon} ${title}`,
        text: `${title}\n\n${body}\n\n발생: ${new Date().toLocaleString('ko-KR')}`,
        html: `<h3>${icon} ${escapeHtml(title)}</h3><p>${escapeHtml(body).replace(/\n/g, '<br>')}</p><p style="color:#868E96;font-size:12px">발생: ${new Date().toLocaleString('ko-KR')}</p>`,
      });
    } catch (e) { console.warn('[alert] 메일 실패:', e.message); }
  }
}

// 이상 발생/지속을 알린다. 같은 key 는 쿨다운 안에서 다시 보내지 않되,
// 심각도가 올라가면(warn → danger) 쿨다운을 무시하고 즉시 보낸다.
function raise(key, level, title, body = '') {
  const now = Date.now();
  const prev = active.get(key);
  const worse = prev ? (LEVEL_RANK[level] || 0) > (LEVEL_RANK[prev.level] || 0) : true;
  const cooled = !prev || (now - prev.lastSentAt) >= COOLDOWN_MS;
  active.set(key, {
    level, message: title, detail: body,
    since: prev ? prev.since : now,
    lastSentAt: (worse || cooled) ? now : prev.lastSentAt,
    count: prev ? prev.count + 1 : 1,
  });
  if (worse || cooled) {
    record({ at: new Date(now).toISOString(), key, level, title, body });
    deliver(level, title, body).catch(() => {});
  }
}

// 이상이 사라졌다. 떠 있던 경보가 있을 때만 '해제' 알림을 한 번 보낸다.
function clear(key, title = '', body = '') {
  const prev = active.get(key);
  if (!prev) return;
  active.delete(key);
  const mins = Math.round((Date.now() - prev.since) / 60000);
  const t = title || `해소됨 — ${prev.message}`;
  const b = body || `${mins}분간 지속된 문제가 정상으로 돌아왔습니다.`;
  record({ at: new Date().toISOString(), key, level: 'ok', title: t, body: b });
  deliver('ok', t, b).catch(() => {});
}

// 한 번만 알리면 되는 사건(예: 예기치 않은 재시작). 지속 상태가 아니므로 active 에 남기지 않는다.
function event(key, level, title, body = '') {
  record({ at: new Date().toISOString(), key, level, title, body });
  deliver(level, title, body).catch(() => {});
}

const snapshot = () => ({
  active: [...active.entries()].map(([key, v]) => ({ key, level: v.level, message: v.message, detail: v.detail, since: new Date(v.since).toISOString(), count: v.count })),
  history: history.slice(0, 50),
});

module.exports = { raise, clear, event, snapshot, LEVEL_RANK };
