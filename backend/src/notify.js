'use strict';

// 인앱 알림 헬퍼. 공유별 옵트인(notify_inapp)에 따라 이벤트 지점에서 호출한다.
// 실패해도 throw하지 않음(알림 때문에 본 기능이 막히면 안 됨).
const { query } = require('./db');

// { userId, type, title, body }
async function push({ userId, type, title, body = '' }) {
  if (!userId) return;
  try {
    await query('INSERT INTO notifications (user_id, type, title, body) VALUES ($1,$2,$3,$4)', [userId, type, title, body]);
  } catch (e) { console.warn('[notify] 인앱 실패:', e.message); }
}

module.exports = { push };
