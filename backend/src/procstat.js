'use strict';

// CPU·메모리 상위 프로세스 집계. 서버 전체를 보려면 호스트 /proc 를 읽기전용 마운트(/host/proc).
// 마운트가 없으면 컨테이너 자기 프로세스만 보임. 프로세스 '이름(comm)'만 읽어 민감정보 노출 없음.
const fsp = require('fs/promises');

const PAGE = 4096; // 리눅스 표준 페이지 크기
let procRoot = null;

async function root() {
  if (procRoot) return procRoot;
  try { await fsp.access('/host/proc/stat'); procRoot = '/host/proc'; }
  catch { procRoot = '/proc'; }
  return procRoot;
}

async function totalJiffies(r) {
  const first = (await fsp.readFile(`${r}/stat`, 'utf8')).split('\n', 1)[0];
  return first.trim().split(/\s+/).slice(1).map(Number).reduce((a, b) => a + b, 0);
}

async function snapshot(r) {
  const pids = (await fsp.readdir(r)).filter((n) => /^\d+$/.test(n));
  const map = new Map();
  for (const pid of pids) {
    try {
      const stat = await fsp.readFile(`${r}/${pid}/stat`, 'utf8');
      const rp = stat.lastIndexOf(')');
      const comm = stat.slice(stat.indexOf('(') + 1, rp);
      const rest = stat.slice(rp + 2).split(' ');
      const jiffies = (Number(rest[11]) || 0) + (Number(rest[12]) || 0); // utime+stime
      map.set(pid, { comm, jiffies });
    } catch { /* 프로세스 종료됨 */ }
  }
  return map;
}

async function rssBytes(r, pid) {
  try {
    const statm = await fsp.readFile(`${r}/${pid}/statm`, 'utf8');
    const resident = Number(statm.split(' ')[1]) || 0; // 페이지 단위 실사용 메모리
    return resident * PAGE;
  } catch { return 0; }
}

// 두 시점(delayMs 간격) 샘플링으로 프로세스별 CPU 점유율(전체 대비 %)과 메모리 상위를 반환.
async function top(delayMs = 600) {
  const r = await root();
  const t0 = await totalJiffies(r);
  const s0 = await snapshot(r);
  await new Promise((res) => setTimeout(res, delayMs));
  const t1 = await totalJiffies(r);
  const s1 = await snapshot(r);
  const totalDelta = Math.max(1, t1 - t0);
  const rows = [];
  for (const [pid, cur] of s1) {
    const prev = s0.get(pid);
    const dj = prev ? cur.jiffies - prev.jiffies : 0;
    rows.push({ pid, name: cur.comm, cpu: Math.max(0, (dj / totalDelta) * 100), rss: await rssBytes(r, pid) });
  }
  const topCpu = [...rows].sort((a, b) => b.cpu - a.cpu).slice(0, 6).map((x) => ({ name: x.name, cpu: Math.round(x.cpu * 10) / 10 }));
  const topMem = [...rows].sort((a, b) => b.rss - a.rss).slice(0, 6).map((x) => ({ name: x.name, rss: x.rss }));
  return { topCpu, topMem, scope: r === '/host/proc' ? 'host' : 'container' };
}

module.exports = { top };
