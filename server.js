// BMF lobby server: tiny in-memory room relay with Server-Sent Events. No dependencies.
const http = require('http');
const crypto = require('crypto');
const PORT = process.env.PORT || 8080;
const TTL = 3 * 3600 * 1000;
const MAX_ROOMS = 5000, MAX_MSGS = 60, MAX_BODY = 4096, MAX_CLIENTS = 12;
const rooms = new Map(); // code -> {msgs:[], clients:Set, t:number}
const hits = new Map();
const users = new Map(); // fid -> {n,k,claims:Set,q:[],clients:Set,t}
let evc = 0;
function evid() { evc = (evc + 1) % 1000; return Date.now() * 1000 + evc; }  // ip -> {n, t}
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};
function limited(ip, max) {
  if (process.env.NOLIMIT) return false;
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || now - h.t > 60000) { h = { n: 0, t: now }; hits.set(ip, h); }
  return ++h.n > max;
}

const IMP_MIN = 5; // undiscovered impostor: room under 5 players = 5 points; 5 or more = number of players who did not pick them
function newRound(ids) {
  return { ids, imp: ids[crypto.randomInt(ids.length)], r: crypto.randomInt(2147483647), seen: new Set(), ready: new Set(), startAt: 0, goAt: 0, votes: new Map(), result: null, voice: new Set(), mail: new Map() };
}
function resolve(room) {
  const st = room.started;
  const tally = {}; for (const id of st.ids) tally[id] = 0;
  for (const v of st.votes.values()) tally[v]++;
  const top = Math.max.apply(null, st.ids.map(id => tally[id]));
  const disc = tally[st.imp] > 0 && tally[st.imp] === top && st.ids.filter(id => tally[id] === top).length === 1;
  const d = {};
  for (const id of st.ids) d[id] = 0;
  for (const [voter, tgt] of st.votes) if (voter !== st.imp) d[voter] = tgt === st.imp ? 1 : -1;
  const nonPick = st.ids.filter(id => id !== st.imp && st.votes.get(id) !== st.imp).length;
  d[st.imp] = disc ? -tally[st.imp] : (st.ids.length < 5 ? IMP_MIN : nonPick);
  const tot = {};
  for (const id of st.ids) { room.scores[id] = (room.scores[id] || 0) + d[id]; tot[id] = room.scores[id]; }
  const votes = {}; for (const [a, b] of st.votes) votes[a] = b;
  let win = [];
  if (room.round >= room.rounds) { const mx = Math.max.apply(null, st.ids.map(id => tot[id])); win = st.ids.filter(id => tot[id] === mx); }
  st.result = { win, bonus: 10, imp: st.imp, r: st.r, votes, d, tot, disc, round: room.round, rounds: room.rounds, at: Date.now() };
}
function stateOf(room, cid) {
  const st = room.started, now = Date.now();
  return { k: st.seen.size, n: st.ids.length, el: st.goAt ? now - st.goAt : null, nx: room.next || null,
    rd: st.ready.size, rm: st.ready.has(cid), ca: st.startAt ? st.startAt - now : null, sn: st.seen.has(cid),
    vt: st.votes.size, mine: st.votes.get(cid) || null, round: room.round, rounds: room.rounds, lead: room.leader, res: st.result };
}
function sendRole(room, cl) {
  const st = room.started;
  if (!st || st.ids.indexOf(cl.cid) < 0) return;
  const isImp = st.imp === cl.cid;
  cl.res.write('data: ' + JSON.stringify({ t: 'role', imp: isImp, r: isImp ? null : st.r }) + '\n\n');
}
function send(res, code, body, extra) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, CORS, extra || {}));
  res.end(body);
}
http.createServer((req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const u = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (u.pathname === '/' || u.pathname === '/health') return send(res, 200, 'ok');

  const fm = /^\/f\/([A-HJ-NP-Z2-9]{6})$/.exec(u.pathname);
  if (fm) {
    const fid = fm[1];
    if (limited(ip, 1500)) return send(res, 429, 'slow down');
    const key = s => String(s || '').slice(0, 40);
    if (req.method === 'GET') {
      const us = users.get(fid);
      if (!us || us.k !== key(u.searchParams.get('k'))) return send(res, 404, 'no');
      if (us.clients.size >= 6) return send(res, 429, 'busy');
      res.writeHead(200, Object.assign({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' }, CORS));
      res.write('retry: 2000\n\n');
      const last = +u.searchParams.get('s') || 0, now = Date.now();
      us.q = us.q.filter(e => now - e.ts < 24 * 3600e3);
      for (const e of us.q) if (e.i > last) res.write('data: ' + JSON.stringify(e) + '\n\n');
      const cl = { res }; us.clients.add(cl); us.t = now;
      const ka = setInterval(() => res.write(': ka\n\n'), 20000);
      req.on('close', () => { clearInterval(ka); us.clients.delete(cl); });
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > MAX_BODY) req.destroy(); });
      req.on('end', () => {
        let d; try { d = JSON.parse(body); } catch (e) { return send(res, 400, 'bad json'); }
        if (!d || typeof d.t !== 'string') return send(res, 400, 'bad msg');
        const J = { 'Content-Type': 'application/json' };
        if (d.t === 'hi') { // owner registers itself: fid is in the URL
          const k = key(d.k); if (k.length < 8) return send(res, 400, 'bad key');
          let us = users.get(fid);
          if (us && us.k !== k) return send(res, 403, 'taken');
          if (!us) { if (users.size >= 20000) return send(res, 429, 'busy'); us = { n: '', k, claims: new Set(), q: [], clients: new Set(), t: Date.now() }; users.set(fid, us); }
          us.n = String(d.n || '').slice(0, 14);
          us.claims = new Set((Array.isArray(d.fr) ? d.fr : []).filter(x => /^[A-HJ-NP-Z2-9]{6}$/.test(x)).slice(0, 200));
          us.t = Date.now();
          return send(res, 200, 'ok');
        }
        // everything else: d.f = sender fid, d.k = sender key; fid in URL is the target
        const sf = String(d.f || ''), su = users.get(sf), tu = users.get(fid);
        if (!su || su.k !== key(d.k)) return send(res, 403, 'who');
        if (!tu) return send(res, 404, 'unknown');
        if (sf === fid) return send(res, 400, 'self');
        if (d.t === 'who') return send(res, 200, JSON.stringify({ n: tu.n }), J);
        const mutual = su.claims.has(fid) && tu.claims.has(sf);
        let ev;
        if (d.t === 'fr' || d.t === 'fa') ev = { t: d.t };
        else if (d.t === 'inv') {
          if (!mutual) return send(res, 403, 'not friends');
          const code = String(d.code || '');
          if (!/^\d{5}$/.test(code)) return send(res, 400, 'bad code');
          ev = { t: 'inv', code };
        } else return send(res, 400, 'bad type');
        if (tu.q.length >= 40) tu.q.shift();
        ev.i = evid(); ev.ts = Date.now(); ev.f = sf; ev.n = su.n;
        tu.q.push(ev);
        for (const c of tu.clients) c.res.write('data: ' + JSON.stringify(ev) + '\n\n');
        return send(res, 200, JSON.stringify({ n: tu.n, ok: mutual }), J);
      });
      return;
    }
    return send(res, 405, 'method');
  }
  const m = /^\/r\/(\d{5})$/.exec(u.pathname);
  if (!m) return send(res, 404, 'not found');
  const code = m[1];
  if (limited(ip, 1500)) return send(res, 429, 'slow down');
  if (req.method === 'GET') {
    const room = rooms.get(code);
    if (!room) return send(res, 404, 'no room');
    if (room.clients.size >= MAX_CLIENTS) return send(res, 429, 'room busy');
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' }, CORS));
    res.write('retry: 2000\n\n');
    for (const d of room.msgs) res.write('data: ' + d + '\n\n');
    const cl = { res, cid: String(u.searchParams.get('c') || '').slice(0, 20) };
    room.clients.add(cl);
    sendRole(room, cl);
    const ka = setInterval(() => res.write(': ka\n\n'), 20000);
    req.on('close', () => { clearInterval(ka); room.clients.delete(cl); });
    return;
  }
  if (req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > MAX_BODY) req.destroy(); });
    req.on('end', () => {
      let d;
      try { d = JSON.parse(body); } catch (e) { return send(res, 400, 'bad json'); }
      const TYPES = ['j', 'l', 'reveal', 'seen', 'state', 'again', 'ready', 'vote', 'close', 'vjoin', 'vleave', 'sig', 'sigpoll'];
      if (!d || TYPES.indexOf(d.t) < 0 || typeof d.c !== 'string') return send(res, 400, 'bad msg');
      let room = rooms.get(code);
      if (!room) {
        const n = +code[1];
        if (!d.host || d.t !== 'j' || n < 2 || n > 9) return send(res, 404, 'no room');
        if (rooms.size >= MAX_ROOMS || limited('new:' + ip, 20)) return send(res, 429, 'busy');
        const rounds = Math.max(1, Math.min(20, Math.floor(+d.rounds) || 3));
        room = { n, msgs: [], clients: new Set(), roster: [], started: null, t: Date.now(), rounds, round: 1, leader: String(d.c).slice(0, 20), scores: {} };
        rooms.set(code, room);
      }
      delete d.host;
      const cid = String(d.c).slice(0, 20);
      room.t = Date.now();
      const J = { 'Content-Type': 'application/json' };
      const st = room.started;
      if (['reveal', 'seen', 'state', 'again', 'ready', 'vote', 'close', 'vjoin', 'vleave', 'sig', 'sigpoll'].indexOf(d.t) >= 0) {
        if (!st || st.ids.indexOf(cid) < 0) return send(res, 403, 'no');
        const now = Date.now();
        if (d.t === 'vjoin') { st.voice.add(cid); return send(res, 200, JSON.stringify({ vc: [...st.voice] }), J); }
        if (d.t === 'vleave') { st.voice.delete(cid); st.mail.delete(cid); return send(res, 200, JSON.stringify({ vc: [...st.voice] }), J); }
        if (d.t === 'sig') {
          const to = String(d.to || ''), dd = typeof d.d === 'string' ? d.d.slice(0, 4000) : '';
          if (st.ids.indexOf(to) < 0 || to === cid || !dd) return send(res, 400, 'bad sig');
          const q = st.mail.get(to) || []; if (q.length < 200) q.push({ f: cid, d: dd }); st.mail.set(to, q);
          return send(res, 200, 'ok');
        }
        if (d.t === 'sigpoll') {
          const q = st.mail.get(cid) || []; st.mail.set(cid, []);
          return send(res, 200, JSON.stringify({ m: q, vc: [...st.voice] }), J);
        }
        if (d.t === 'reveal') {
          if (!st.result && st.startAt) return send(res, 403, 'later'); // old app versions never send 'ready', so they keep the old reveal flow
          return send(res, 200, JSON.stringify({ imp: st.imp, r: st.r }), J);
        }
        if (d.t === 'ready' && !st.startAt) {
          st.ready.add(cid);
          if (st.ready.size >= st.ids.length) st.startAt = now + 3000;
        }
        if (d.t === 'seen' && st.startAt && now >= st.startAt) {
          st.seen.add(cid);
          if (st.seen.size >= st.ids.length && !st.goAt) st.goAt = now;
        }
        if (d.t === 'vote' && st.goAt && !st.result) {
          const v = String(d.v || '');
          if (v !== cid && st.ids.indexOf(v) >= 0) st.votes.set(cid, v);
          if (st.votes.size >= st.ids.length) resolve(room);
        }
        if (d.t === 'close' && st.goAt && !st.result && cid === room.leader) resolve(room);
        if (d.t === 'again' && st.result && !room.next && (cid === room.leader || now - st.result.at > 120000)) {
          const last = room.round >= room.rounds;
          if (last && !d.ng) return send(res, 400, 'finished');
          const cat = Math.max(1, Math.min(9, +d.cat || +code[0]));
          let nc = '';
          for (let tries = 0; tries < 20; tries++) { const c2 = String(cat) + code[1] + String(1000 + crypto.randomInt(1000)).slice(1); if (!rooms.has(c2)) { nc = c2; break; } }
          if (!nc || rooms.size >= MAX_ROOMS) return send(res, 429, 'busy');
          const ids = st.ids.slice();
          rooms.set(nc, { n: room.n, msgs: room.msgs.slice(), clients: new Set(), roster: room.roster.slice(), started: Object.assign(newRound(ids), { voice: new Set(st.voice) }), t: now, rounds: room.rounds, round: last ? 1 : room.round + 1, leader: room.leader, scores: last ? {} : Object.assign({}, room.scores) });
          room.next = nc;
        }
        return send(res, 200, JSON.stringify(stateOf(room, cid)), J);
      }
      if (room.started) return send(res, 200, 'ok');
      if (d.t === 'l') {
        const i = room.roster.indexOf(cid);
        if (i >= 0) room.roster.splice(i, 1);
      } else {
        if (room.roster.indexOf(cid) >= 0 || room.roster.length >= room.n) return send(res, 200, 'ok');
        room.roster.push(cid);
      }
      const s = JSON.stringify({ t: d.t, v: d.v === 'fam' ? 'fam' : 'full', c: cid, n: String(d.n || '').slice(0, 14), a: String(d.a || '').slice(0, 4000) });
      room.msgs.push(s);
      for (const c of room.clients) c.res.write('data: ' + s + '\n\n');
      if (room.roster.length === room.n) {
        room.started = newRound(room.roster.slice());
        for (const c of room.clients) sendRole(room, c);
      }
      send(res, 200, 'ok');
    });
    return;
  }
  send(res, 405, 'method');
}).listen(PORT, () => console.log('BMF lobby on', PORT));
setInterval(() => {
  const now = Date.now();
  for (const [k, r] of rooms) if (now - r.t > TTL && r.clients.size === 0) rooms.delete(k);
  for (const [k, u2] of users) if (now - u2.t > 7 * 24 * 3600e3 && u2.clients.size === 0) users.delete(k);
  for (const [k, h] of hits) if (now - h.t > 120000) hits.delete(k);
}, 600000);
