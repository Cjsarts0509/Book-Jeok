'use strict';

// 인앱/이메일 알림 발송 헬퍼. 공유별 옵트인(notify_inapp/notify_email)에 따라
// 이벤트 지점에서 호출한다. 실패해도 throw하지 않음(알림 때문에 본 기능이 막히면 안 됨).
const { query } = require('./db');
const mailer = require('./mailer');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// { userId, type, title, body, inApp, email }
async function push({ userId, type, title, body = '', inApp = false, email = false }) {
  if (!userId || (!inApp && !email)) return;
  if (inApp) {
    try {
      await query('INSERT INTO notifications (user_id, type, title, body) VALUES ($1,$2,$3,$4)', [userId, type, title, body]);
    } catch (e) { console.warn('[notify] 인앱 실패:', e.message); }
  }
  if (email) {
    try {
      const r = await query('SELECT email FROM users WHERE id=$1', [userId]);
      const to = r.rows[0] && r.rows[0].email;
      if (to && mailer.enabled()) {
        await mailer.send({
          to,
          subject: `[북적북적] ${title}`,
          html: `<div style="font-family:-apple-system,'Malgun Gothic',sans-serif;max-width:560px"><h3 style="margin:0 0 8px">${esc(title)}</h3><p style="color:#333;line-height:1.6">${esc(body)}</p><p style="color:#999;font-size:12px;margin-top:18px">북적북적 알림 · 공유 설정에서 알림을 끌 수 있습니다.</p></div>`,
          text: `${title}\n\n${body}`,
        });
      }
    } catch (e) { console.warn('[notify] 이메일 실패:', e.message); }
  }
}

module.exports = { push };
