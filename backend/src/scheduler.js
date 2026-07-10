'use strict';

// 주간 리포트 자동 발송 스케줄러 (node-cron).
//   REPORT_CRON  기본 '0 8 * * 1' (매주 월요일 08:00)
//   REPORT_TZ    기본 'Asia/Seoul'
//   SMTP/REPORT_TO 미설정 시 스케줄하지 않음(로그만 남김).
const cron = require('node-cron');
const mailer = require('./mailer');
const report = require('./report');

const CRON = process.env.REPORT_CRON || '0 8 * * 1';
const TZ = process.env.REPORT_TZ || 'Asia/Seoul';

async function runOnce(reason = 'scheduled') {
  const { subject, html, text } = await report.buildWeekly();
  const info = await mailer.send({ subject, html, text });
  console.log(`[report] 주간 리포트 발송(${reason}) → ${mailer.recipients().join(', ')} (id=${info.messageId || '?'})`);
  return info;
}

function start() {
  if (!mailer.enabled()) { console.log('[report] SMTP 미설정 — 주간 리포트 자동발송 비활성(설정 시 활성화됨)'); return; }
  if (!mailer.recipients().length) { console.log('[report] REPORT_TO 미설정 — 수신자 없음, 자동발송 비활성'); return; }
  if (!cron.validate(CRON)) { console.warn(`[report] 잘못된 REPORT_CRON: ${CRON} — 자동발송 비활성`); return; }
  cron.schedule(CRON, () => { runOnce('cron').catch((e) => console.error('[report] 발송 실패:', e.message)); }, { timezone: TZ });
  console.log(`[report] 주간 리포트 예약됨: '${CRON}' (${TZ}) → ${mailer.recipients().join(', ')}`);
}

module.exports = { start, runOnce };
