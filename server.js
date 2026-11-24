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
    if (limited(ip, 600)) return send(res, 429, 'slow down');
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
  if (limited(ip, 600)) return send(res, 429, 'slow down');
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
      if (!d || (d.t !== 'j' && d.t !== 'l' && d.t !== 'reveal' && d.t !== 'seen' && d.t !== 'state' && d.t !== 'again') || typeof d.c !== 'string') return send(res, 400, 'bad msg');
      let room = rooms.get(code);
      if (!room) {
        const n = +code[1];
        if (!d.host || d.t !== 'j' || n < 2 || n > 9) return send(res, 404, 'no room');
        if (rooms.size >= MAX_ROOMS || limited('new:' + ip, 20)) return send(res, 429, 'busy');
        room = { n, msgs: [], clients: new Set(), roster: [], started: null, t: Date.now() };
        rooms.set(code, room);
      }
      delete d.host;
      const cid = String(d.c).slice(0, 20);
      room.t = Date.now();
      if (d.t === 'seen' || d.t === 'state' || d.t === 'again') {
        const st = room.started;
        if (!st || st.ids.indexOf(cid) < 0) return send(res, 403, 'no');
        if (d.t === 'seen') {
          st.seen = st.seen || new Set(); st.seen.add(cid);
          if (st.seen.size >= st.ids.length && !st.goAt) st.goAt = Date.now();
        }
        if (d.t === 'again' && !room.next) {
          const cat = Math.max(1, Math.min(9, +d.cat || +code[0]));
          let nc = '';
          for (let tries = 0; tries < 20; tries++) { const c2 = String(cat) + code[1] + String(1000 + crypto.randomInt(1000)).slice(1); if (!rooms.has(c2)) { nc = c2; break; } }
          if (!nc || rooms.size >= MAX_ROOMS) return send(res, 429, 'busy');
          const ids = st.ids.slice();
          rooms.set(nc, { n: room.n, msgs: room.msgs.slice(), clients: new Set(), roster: room.roster.slice(), started: { ids, imp: ids[crypto.randomInt(ids.length)], r: crypto.randomInt(2147483647) }, t: Date.now() });
          room.next = nc;
        }
        return send(res, 200, JSON.stringify({ k: st.seen ? st.seen.size : 0, n: st.ids.length, el: st.goAt ? Date.now() - st.goAt : null, nx: room.next || null }), { 'Content-Type': 'application/json' });
      }
      if (d.t === 'reveal') {
        if (!room.started || room.started.ids.indexOf(cid) < 0) return send(res, 403, 'no');
        return send(res, 200, JSON.stringify({ imp: room.started.imp, r: room.started.r }), { 'Content-Type': 'application/json' });
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
        const ids = room.roster.slice();
        room.started = { ids, imp: ids[crypto.randomInt(ids.length)], r: crypto.randomInt(2147483647) };
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
