'use strict';

// S14 · 메일 발송 실패 재시도 큐 + S15 · 전송 백오프
//
// 주간 리포트나 위험 경보는 "보냈다고 생각했는데 안 갔다"가 가장 나쁘다.
// SMTP 는 일시적으로 자주 흔들린다(네트워크·상대 서버 점검·속도 제한).
// 그래서 실패한 메일을 메모리가 아니라 DB에 남긴다 — 서버가 재시작돼도 살아남는다.
//
// 백오프(S15): 실패할 때마다 다음 시도를 점점 늦춘다. 여기에 지터를 섞어,
// 여러 건이 동시에 실패했을 때 같은 순간에 우르르 재시도하지 않게 한다.
//
// 회로 차단기(S15): SMTP 자체가 죽어 있으면 큐에 있는 모든 건이 연달아 실패한다.
// 연속 실패가 쌓이면 잠시 발송을 멈춘다 — 죽은 서버를 계속 때려도 얻는 게 없고,
// 상대 서버가 우리를 차단할 수도 있다.
const { query } = require('./db');
const mailer = require('./mailer');
const alerts = require('./alerts');

const MAX_ATTEMPTS = parseInt(process.env.MAIL_MAX_ATTEMPTS || '6', 10);
// 1분 → 5분 → 15분 → 1시간 → 6시간 (마지막 간격을 계속 사용)
const BACKOFF_MIN = [1, 5, 15, 60, 360];
const TICK_MS = parseInt(process.env.MAIL_QUEUE_TICK_MS || '60000', 10);
const BATCH = 10;

// 연속 실패가 이만큼 쌓이면 잠시 쉰다
const BREAKER_THRESHOLD = parseInt(process.env.MAIL_BREAKER_THRESHOLD || '5', 10);
const BREAKER_PAUSE_MS = parseInt(process.env.MAIL_BREAKER_PAUSE_MS || String(10 * 60 * 1000), 10);
const breaker = { consecutiveFailures: 0, openUntil: 0 };

function backoffMs(attempts) {
  const mins = BACKOFF_MIN[Math.min(attempts, BACKOFF_MIN.length - 1)];
  const jitter = 0.8 + Math.random() * 0.4;    // ±20% — 동시 실패분이 같은 순간에 몰리지 않게
  return Math.round(mins * 60 * 1000 * jitter);
}
const breakerOpen = () => Date.now() < breaker.openUntil;

function noteFailure() {
  breaker.consecutiveFailures++;
  if (breaker.consecutiveFailures >= BREAKER_THRESHOLD && !breakerOpen()) {
    breaker.openUntil = Date.now() + BREAKER_PAUSE_MS;
    alerts.raise('mail-breaker', 'warn', '메일 발송이 계속 실패해 잠시 멈춥니다',
      `연속 ${breaker.consecutiveFailures}회 실패 — ${Math.round(BREAKER_PAUSE_MS / 60000)}분 뒤 자동으로 다시 시도합니다. SMTP 설정과 비밀번호(앱 비밀번호 만료 등)를 확인해 주세요.`);
  }
}
function noteSuccess() {
  if (breaker.consecutiveFailures > 0 || breaker.openUntil) alerts.clear('mail-breaker');
  breaker.consecutiveFailures = 0;
  breaker.openUntil = 0;
}

// 큐에 넣기 — 지금 당장 보내려 하지 않고 기록만 한다. 워커가 곧 가져간다.
async function enqueue({ to, subject, html = '', text = '', kind = 'general' }) {
  const rcpt = mailer.recipients(to);
  if (!rcpt.length) throw new Error('수신자가 없습니다. REPORT_TO 환경변수를 설정하거나 수신자를 지정하세요.');
  const r = await query(
    `INSERT INTO mail_queue (recipients, subject, html, body_text, kind) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [rcpt.join(','), subject, html, text, kind]
  );
  return Number(r.rows[0].id);
}

// 지금 바로 보내 보고, 실패하면 큐에 넣어 재시도하게 한다.
// 호출자는 '보냈다'를 기다릴 수 있고(성공 시 즉시 반환), 실패해도 메일이 사라지지 않는다.
async function sendOrQueue(msg) {
  if (breakerOpen()) {
    const id = await enqueue(msg);
    return { sent: false, queued: true, id, reason: '메일 발송이 일시 중지된 상태라 큐에 넣었습니다.' };
  }
  try {
    const info = await mailer.send(msg);
    noteSuccess();
    return { sent: true, queued: false, messageId: info.messageId || null };
  } catch (e) {
    noteFailure();
    const id = await enqueue(msg);
    console.warn(`[mail] 즉시 발송 실패 → 큐에 보관(#${id}): ${e.message}`);
    return { sent: false, queued: true, id, reason: e.message };
  }
}

// 보낼 때가 된 것들을 한 번 처리한다.
async function processDue() {
  if (!mailer.enabled() || breakerOpen()) return { picked: 0, sent: 0, failed: 0 };
  const due = await query(
    `SELECT * FROM mail_queue WHERE status='pending' AND next_attempt_at <= now()
     ORDER BY next_attempt_at LIMIT $1`, [BATCH]);
  let sent = 0, failed = 0;
  for (const m of due.rows) {
    if (breakerOpen()) break;                      // 처리 도중 회로가 열리면 남은 건 다음 기회에
    try {
      await mailer.send({ to: m.recipients, subject: m.subject, html: m.html, text: m.body_text });
      await query("UPDATE mail_queue SET status='sent', sent_at=now(), attempts=attempts+1, last_error='' WHERE id=$1", [m.id]);
      noteSuccess(); sent++;
    } catch (e) {
      noteFailure(); failed++;
      const attempts = m.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await query("UPDATE mail_queue SET status='failed', attempts=$1, last_error=$2 WHERE id=$3", [attempts, String(e.message).slice(0, 500), m.id]);
        alerts.raise('mail-failed', 'warn', '메일을 끝내 보내지 못했습니다',
          `"${m.subject}" 을(를) ${attempts}번 시도했지만 실패했습니다: ${String(e.message).slice(0, 160)}`);
      } else {
        await query("UPDATE mail_queue SET attempts=$1, last_error=$2, next_attempt_at = now() + ($3 || ' milliseconds')::interval WHERE id=$4",
          [attempts, String(e.message).slice(0, 500), String(backoffMs(attempts)), m.id]);
      }
    }
  }
  if (sent || failed) console.log(`[mail] 큐 처리: 발송 ${sent}건, 실패 ${failed}건 (대기 ${due.rowCount - sent - failed}건)`);
  return { picked: due.rowCount, sent, failed };
}

async function stats() {
  try {
    const r = await query(`
      SELECT status, COUNT(*)::int AS c, MIN(next_attempt_at) AS next
      FROM mail_queue GROUP BY status`);
    const by = {}; let next = null;
    for (const row of r.rows) {
      by[row.status] = row.c;
      if (row.status === 'pending' && row.next) next = row.next;
    }
    const recent = await query(
      `SELECT id, subject, kind, status, attempts, last_error, next_attempt_at, created_at
       FROM mail_queue WHERE status <> 'sent' ORDER BY created_at DESC LIMIT 10`);
    return {
      enabled: mailer.enabled(),
      pending: by.pending || 0, sent: by.sent || 0, failed: by.failed || 0,
      nextAttemptAt: next,
      breakerOpen: breakerOpen(), breakerUntil: breaker.openUntil ? new Date(breaker.openUntil).toISOString() : null,
      consecutiveFailures: breaker.consecutiveFailures,
      recent: recent.rows,
    };
  } catch (e) { return { enabled: mailer.enabled(), error: e.message }; }
}

// 실패로 접힌 것을 사람이 다시 시도시킨다(설정을 고친 뒤).
async function retryFailed() {
  breaker.consecutiveFailures = 0; breaker.openUntil = 0;
  const r = await query("UPDATE mail_queue SET status='pending', next_attempt_at=now(), attempts=0 WHERE status='failed'");
  return { requeued: r.rowCount };
}

// 오래된 발송 완료 기록 정리(무한 증가 방지)
async function purgeOld() {
  try { await query("DELETE FROM mail_queue WHERE status='sent' AND sent_at < now() - interval '30 days'"); } catch (_) { /* noop */ }
}

let timer = null;
function start() {
  if (!mailer.enabled()) { console.log('[mail] SMTP 미설정 — 재시도 큐 대기 중(설정하면 자동으로 동작)'); }
  timer = setInterval(() => { processDue().catch((e) => console.error('[mail] 큐 처리 실패:', e.message)); }, TICK_MS);
  timer.unref();
  setInterval(purgeOld, 24 * 60 * 60 * 1000).unref();
  console.log(`[mail] 재시도 큐 시작 — ${Math.round(TICK_MS / 1000)}초마다 확인, 최대 ${MAX_ATTEMPTS}회 재시도`);
}
function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { enqueue, sendOrQueue, processDue, stats, retryFailed, start, stop, backoffMs, _breaker: breaker };
