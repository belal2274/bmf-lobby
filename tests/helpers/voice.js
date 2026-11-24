'use strict';
// Voice mode helpers (docs/TEST-CONTRACT.md, "Voice mode contract"). New file: it reuses room.js and does not change it.
const R = require('./room');
const { sleep } = require('./server');

// Creates and fills a room with the host option vm ('game' | 'ext'). Players are p1..pn, p1 is the host.
async function fillVoiceRoom(base, { n, vm, dur }) {
  const code = R.roomCode(n);
  const cids = Array.from({ length: n }, (_, i) => `p${i + 1}`);
  const host = await R.post(base, code, { t: 'j', c: cids[0], n: 'P1', a: '', v: 'full', host: true, vm, ...(dur ? { dur } : {}) });
  if (host.status !== 200) throw new Error(`host join ${host.status} ${host.text}`);
  const ls = [R.listen(base, code, cids[0])];
  for (let i = 1; i < n; i++) {
    ls.push(R.listen(base, code, cids[i]));
    await sleep(30);
    const j = await R.post(base, code, { t: 'j', c: cids[i], n: `P${i + 1}`, a: '', v: 'full' });
    if (j.status !== 200) throw new Error(`join ${cids[i]} ${j.status} ${j.text}`);
  }
  const roles = await Promise.all(ls.map((l) => l.role));
  const imps = cids.filter((c, i) => roles[i].imp);
  if (imps.length !== 1) throw new Error(`expected one impostor, got ${imps.length}`);
  return { code, cids, imp: imps[0], leader: cids[0], close: () => ls.forEach((l) => l.close()) };
}

const st = async (base, room, c = room.leader) => {
  const r = await R.post(base, room.code, { t: 'state', c, s: 0 });
  if (r.status !== 200 || !r.json) throw new Error(`state ${r.status} ${r.text}`);
  return r.json;
};

// Everyone ready, wait out the countdown, then return the first state seen during the reveal (rv set, el null).
async function readyAndCatchReveal(base, room) {
  let last;
  for (const c of room.cids) last = await R.post(base, room.code, { t: 'ready', c });
  await sleep(((last.json && last.json.ca) || 3000) + 300);
  return st(base, room);
}

// Poll state until the round clock runs (el set), up to 13 s. Returns that state.
async function waitPlay(base, room) {
  const end = Date.now() + 13000;
  for (;;) {
    const s = await st(base, room);
    if (s.el !== null && s.el !== undefined) return s;
    if (Date.now() > end) throw new Error('round clock did not start');
    await sleep(300);
  }
}

const ask = (base, room, c, v) => R.post(base, room.code, { t: 'ask', c, v });
const tdone = (base, room, c) => R.post(base, room.code, { t: 'tdone', c });

module.exports = { fillVoiceRoom, st, readyAndCatchReveal, waitPlay, ask, tdone };
