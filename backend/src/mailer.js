'use strict';

// SMTP 메일 발송 (nodemailer). 환경변수로 설정하며, 미설정 시 비활성(발송 시도 시 명확한 오류).
//   SMTP_HOST, SMTP_PORT(기본 587), SMTP_SECURE(true=465), SMTP_USER, SMTP_PASS
//   MAIL_FROM(기본 SMTP_USER), REPORT_TO(리포트 수신자, 여러 명은 콤마)
const nodemailer = require('nodemailer');

const HOST = process.env.SMTP_HOST || '';
const PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SECURE = process.env.SMTP_SECURE === 'true' || PORT === 465;
const USER = process.env.SMTP_USER || '';
const PASS = process.env.SMTP_PASS || '';
// 표시 이름을 붙이면 받는 사람에게 "북적북적 알림"으로 보임(주소는 Gmail이 강제하므로 그대로).
const FROM = process.env.MAIL_FROM || (USER ? `북적북적 알림 <${USER}>` : '');
const REPLY_TO = process.env.MAIL_REPLY_TO || '';

const enabled = () => !!HOST && !!USER;

let transport = null;
function getTransport() {
  if (!enabled()) return null;
  if (!transport) transport = nodemailer.createTransport({ host: HOST, port: PORT, secure: SECURE, auth: { user: USER, pass: PASS } });
  return transport;
}

// 수신자 목록(콤마 구분). 인자 우선, 없으면 REPORT_TO.
function recipients(to) {
  const raw = (to || process.env.REPORT_TO || '').trim();
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

async function send({ to, subject, html, text }) {
  const t = getTransport();
  if (!t) throw new Error('SMTP가 설정되지 않았습니다. SMTP_HOST/SMTP_USER/SMTP_PASS 환경변수를 설정하세요.');
  const rcpt = recipients(to);
  if (!rcpt.length) throw new Error('수신자가 없습니다. REPORT_TO 환경변수를 설정하거나 수신자를 지정하세요.');
  const msg = { from: FROM, to: rcpt.join(', '), subject, html, text };
  if (REPLY_TO) msg.replyTo = REPLY_TO;
  return t.sendMail(msg);
}

// 설정 점검(연결 확인). 실패해도 throw하지 않고 결과 반환.
async function verify() {
  const t = getTransport();
  if (!t) return { ok: false, reason: 'SMTP 미설정' };
  try { await t.verify(); return { ok: true }; }
  catch (e) { return { ok: false, reason: e.message }; }
}

module.exports = { enabled, send, verify, recipients, config: () => ({ host: HOST, port: PORT, secure: SECURE, user: USER, from: FROM, to: recipients() }) };
