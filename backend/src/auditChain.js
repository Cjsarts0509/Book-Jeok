'use strict';

// S5 · 감사로그 변조 탐지
//
// 감사로그는 "누가 무엇을 했는지"의 마지막 근거다. 그런데 DB에 손댈 수 있는 사람이라면
// 자기 흔적만 조용히 지우거나 고칠 수 있다 — 그러면 로그는 있으나 마나다.
//
// 그래서 각 기록을 앞 기록의 해시와 엮어 사슬로 만든다.
//   hash(n) = HMAC(서버키, hash(n-1) + 이번 기록의 내용)
// 한 줄을 고치면 그 줄의 해시가 달라지고, 한 줄을 지우면 앞뒤가 이어지지 않는다.
// 서버키(MASTER_KEY)를 모르면 고친 뒤 해시를 다시 계산해 맞춰 둘 수도 없다.
//
// 순서 보장: 감사 기록은 동시에 들어올 수 있으므로 사슬 머리(audit_chain 1행)를
// 행 잠금으로 잡고 그 안에서만 이어 붙인다. 감사 쓰기끼리만 직렬화된다.
const crypto = require('crypto');
const config = require('./config');
const { query, withTransaction } = require('./db');

const KEY = crypto.createHash('sha256').update('bookjeok-audit-chain|' + config.masterKey).digest();

// 해시에 들어가는 내용은 '정확히 이 순서, 이 표현'이어야 나중에 똑같이 재계산된다.
function canonical(row) {
  return [
    row.chain_seq,
    row.user_id == null ? '' : row.user_id,
    row.action || '',
    row.detail || '',
    row.ip || '',
    row.owner_id == null ? '' : row.owner_id,
    new Date(row.created_at).toISOString(),
  ].join('');   // 필드 구분자: 내용에 나올 리 없는 문자
}
function hashOf(prevHash, row) {
  return crypto.createHmac('sha256', KEY).update((prevHash || '') + '' + canonical(row)).digest('hex');
}

// 감사 기록 한 줄을 사슬에 이어 붙인다. 실패해도 본 기능을 막지 않는다(호출자가 try/catch).
async function append({ userId, action, detail, ip, ownerId }) {
  return withTransaction(async (client) => {
    const head = await client.query('SELECT last_hash, seq FROM audit_chain WHERE id = 1 FOR UPDATE');
    if (head.rowCount === 0) throw new Error('audit_chain 이 초기화되지 않았습니다(마이그레이션 0009 확인).');
    const prev = head.rows[0].last_hash || '';
    const seq = Number(head.rows[0].seq) + 1;
    const createdAt = new Date();
    const row = {
      chain_seq: seq, user_id: userId ?? null, action, detail: detail || '',
      ip: ip || '', owner_id: ownerId ?? null, created_at: createdAt,
    };
    const hash = hashOf(prev, row);
    await client.query(
      `INSERT INTO audit_log (user_id, action, detail, ip, owner_id, created_at, chain_seq, prev_hash, chain_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [row.user_id, row.action, row.detail, row.ip, row.owner_id, createdAt, seq, prev, hash]
    );
    await client.query('UPDATE audit_chain SET last_hash = $1, seq = $2 WHERE id = 1', [hash, seq]);
    return { seq, hash };
  });
}

// 보관기간이 지나 앞부분을 잘라냈다면, 어디까지 잘랐는지 남긴다.
// 이 표시가 없으면 정상적인 정리도 '변조'로 보인다.
async function notePrune(throughSeq) {
  if (!throughSeq) return;
  await query('UPDATE audit_chain SET pruned_seq = GREATEST(pruned_seq, $1) WHERE id = 1', [throughSeq]);
}

// 사슬을 처음부터 끝까지 다시 계산해 어긋난 곳을 찾는다.
// 큰 테이블을 통째로 읽으므로 요청 시에만 수행한다.
const PAGE = 5000;
async function verify({ limit = 0 } = {}) {
  const started = Date.now();
  const headRow = await query('SELECT last_hash, seq, pruned_seq, started_at FROM audit_chain WHERE id = 1');
  if (headRow.rowCount === 0) {
    return { ok: false, reason: 'not_initialized', message: '사슬이 초기화되지 않았습니다. 마이그레이션 0009 를 적용해 주세요.' };
  }
  const head = headRow.rows[0];
  const prunedSeq = Number(head.pruned_seq || 0);

  // 사슬 이전에 쌓인 기록(도입 전 로그)은 검증 대상이 아니다 — 있는 그대로 알린다.
  const legacy = await query('SELECT COUNT(*)::int AS c FROM audit_log WHERE chain_seq IS NULL');

  const problems = [];
  let checked = 0, expectedSeq = prunedSeq + 1, prevHash = null;
  let lastSeq = 0;
  // 잘라낸 지점 바로 앞의 해시를 알 수 없으므로, 첫 행의 prev_hash 를 출발점으로 삼는다.
  let firstRow = true;

  const startSeq = limit > 0 ? Math.max(prunedSeq, Number(head.seq) - limit) : prunedSeq;
  if (limit > 0) { expectedSeq = startSeq + 1; }

  let cursor = startSeq;
  for (;;) {
    const r = await query(
      `SELECT id, chain_seq, user_id, action, detail, ip, owner_id, created_at, prev_hash, chain_hash
       FROM audit_log WHERE chain_seq IS NOT NULL AND chain_seq > $1
       ORDER BY chain_seq LIMIT $2`, [cursor, PAGE]);
    if (r.rowCount === 0) break;
    for (const row of r.rows) {
      const seq = Number(row.chain_seq);
      cursor = seq;
      // 빠진 번호 = 지워진 기록
      if (seq !== expectedSeq) {
        problems.push({
          type: 'missing', from: expectedSeq, to: seq - 1, count: seq - expectedSeq,
          message: `${expectedSeq}~${seq - 1}번 기록이 사라졌습니다(${seq - expectedSeq}건).`,
        });
        expectedSeq = seq;
        prevHash = row.prev_hash;      // 이어서 볼 수 있도록 출발점을 다시 잡는다
        firstRow = true;
      }
      if (firstRow) { prevHash = row.prev_hash; firstRow = false; }
      // 앞 기록의 해시와 이 기록이 기억하는 '앞 해시'가 다르면 중간이 바뀐 것
      if ((row.prev_hash || '') !== (prevHash || '')) {
        problems.push({ type: 'broken_link', seq, message: `${seq}번 기록의 연결 고리가 앞 기록과 맞지 않습니다.` });
      }
      const recomputed = hashOf(row.prev_hash, row);
      if (recomputed !== row.chain_hash) {
        problems.push({
          type: 'modified', seq, id: String(row.id), action: row.action, at: row.created_at,
          message: `${seq}번 기록(${row.action})의 내용이 기록 당시와 다릅니다.`,
        });
      }
      prevHash = row.chain_hash;
      expectedSeq = seq + 1;
      lastSeq = seq;
      checked++;
    }
    if (r.rowCount < PAGE) break;
  }

  // 마지막 기록의 해시가 사슬 머리와 같아야 한다 — 다르면 끝부분이 잘렸다는 뜻
  if (limit === 0 && lastSeq > 0 && prevHash !== head.last_hash) {
    problems.push({
      type: 'tail_mismatch',
      message: `가장 최근 기록이 사슬 머리와 맞지 않습니다. 마지막 기록들이 지워졌을 수 있습니다(머리 ${head.seq}번, 실제 마지막 ${lastSeq}번).`,
    });
  }
  if (limit === 0 && lastSeq < Number(head.seq)) {
    problems.push({
      type: 'tail_missing', from: lastSeq + 1, to: Number(head.seq),
      message: `${lastSeq + 1}~${head.seq}번 기록이 사라졌습니다(마지막 부분).`,
    });
  }

  return {
    ok: problems.length === 0,
    checked, problems: problems.slice(0, 50), problemCount: problems.length,
    headSeq: Number(head.seq), prunedSeq, chainStartedAt: head.started_at,
    legacyRows: legacy.rows[0].c,
    partial: limit > 0, elapsedMs: Date.now() - started,
    note: '사슬 도입 전에 쌓인 기록에는 해시가 없어 검증할 수 없습니다. 보관기간이 지나 정리된 앞부분은 정상으로 봅니다.',
  };
}

module.exports = { append, verify, notePrune, hashOf, canonical };
