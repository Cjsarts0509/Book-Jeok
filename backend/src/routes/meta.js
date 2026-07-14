'use strict';

// 로그인 사용자 공용: 영업점 목록, 활성 공지사항, 서버 상태
const os = require('os');
const fsp = require('fs/promises');
const express = require('express');
const { query } = require('../db');
const { diskUsage } = require('../disk');
const procstat = require('../procstat');
const { authenticate } = require('../middleware/auth');
const { wrap } = require('../util');

const router = express.Router();
router.use(authenticate);

// 실제 가용 메모리(캐시 제외)를 /proc/meminfo 로 계산 — os.freemem()은 캐시를 사용중으로 봐 과다 표기됨
async function memoryInfo() {
  try {
    const txt = await fsp.readFile('/proc/meminfo', 'utf8');
    const val = (k) => { const m = txt.match(new RegExp('^' + k + ':\\s+(\\d+)', 'm')); return m ? Number(m[1]) * 1024 : null; };
    const total = val('MemTotal'), avail = val('MemAvailable');
    if (total && avail != null) return { total, free: avail, used: Math.max(0, total - avail) };
  } catch { /* 컨테이너/OS에 따라 없을 수 있음 → os로 폴백 */ }
  const total = os.totalmem(), free = os.freemem();
  return { total, free, used: Math.max(0, total - free) };
}

// 서버(호스트 VM) 상태: CPU 부하·메모리·디스크·가동시간·DB 연결. 민감정보 없음 → 로그인 사용자 공용.
router.get('/server-status', wrap(async (req, res) => {
  const cores = os.cpus().length || 1;
  const [l1, l5, l15] = os.loadavg();
  const mem = await memoryInfo();
  const disk = await diskUsage();
  let dbOk = true;
  try { await query('SELECT 1'); } catch { dbOk = false; }
  // CPU·메모리 상위 프로세스(무엇이 쓰고 있는지). /proc 접근 실패 시 생략.
  let procs = null;
  try { procs = await procstat.top(); } catch { procs = null; }
  const pct = (u, t) => (t > 0 ? Math.round((u / t) * 100) : 0);
  res.json({
    time: new Date().toISOString(),
    cpu: { cores, load1: l1, load5: l5, load15: l15, loadPct: Math.min(100, Math.round((l1 / cores) * 100)) },
    memory: { total: mem.total, used: mem.used, free: mem.free, usedPct: pct(mem.used, mem.total) },
    disk: { total: disk.total, used: disk.used, free: disk.avail, usedPct: pct(disk.used, disk.total) },
    uptime: { server: os.uptime(), process: process.uptime() },
    db: { connected: dbOk },
    procs, // { topCpu:[{name,cpu}], topMem:[{name,rss}], scope:'host'|'container' } 또는 null
  });
}));

// 영업점 목록 (새 폴더 생성용)
router.get('/branches', wrap(async (req, res) => {
  const r = await query('SELECT id, name FROM branches ORDER BY sort_order, name');
  res.json({ branches: r.rows });
}));

// 현재 노출 기간 + 내 권한이 대상인 공지사항
router.get('/notices/active', wrap(async (req, res) => {
  const r = await query(
    `SELECT id, title, body, start_at, end_at, created_at FROM notices
     WHERE (start_at IS NULL OR start_at <= now()) AND (end_at IS NULL OR end_at >= now())
       AND (target_roles IS NULL OR $1 = ANY(target_roles))
     ORDER BY created_at DESC`,
    [req.user.role]
  );
  res.json({ notices: r.rows });
}));

module.exports = router;
