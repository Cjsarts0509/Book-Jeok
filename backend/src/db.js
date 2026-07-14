'use strict';

const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  max: config.db.max,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  // 폭주한 단일 쿼리가 풀(최대 10개)을 모두 점유해 전체 요청이 멈추는 것을 방지.
  statement_timeout: 30000,                   // 서버측: 30초 넘는 쿼리는 중단
  idle_in_transaction_session_timeout: 30000, // 열린 채 방치된 트랜잭션이 커넥션을 잡고 있지 않도록
});

pool.on('error', (err) => {
  // 유휴 클라이언트 오류가 프로세스를 죽이지 않도록 방어
  console.error('[db] 유휴 클라이언트 오류:', err.message);
});

async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  if (config.env === 'development') {
    const ms = Date.now() - start;
    if (ms > 200) console.warn(`[db] 느린 쿼리 ${ms}ms: ${text.slice(0, 80)}`);
  }
  return res;
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// 관리자 페이지 "DB 상태" 확인용
async function healthStats() {
  const [conn, size, tables] = await Promise.all([
    query('SELECT count(*)::int AS active FROM pg_stat_activity WHERE datname = $1', [config.db.database]),
    query('SELECT pg_database_size($1) AS bytes', [config.db.database]),
    query(`
      SELECT relname AS table, n_live_tup::int AS rows
      FROM pg_stat_user_tables
      ORDER BY n_live_tup DESC
    `),
  ]);
  return {
    connected: true,
    database: config.db.database,
    activeConnections: conn.rows[0].active,
    sizeBytes: Number(size.rows[0].bytes),
    tables: tables.rows,
    serverTime: new Date().toISOString(),
  };
}

module.exports = { pool, query, withTransaction, healthStats };
