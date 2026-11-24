// BMF lobby server: tiny in-memory room relay with Server-Sent Events. No dependencies.
const http = require('http');
const crypto = require('crypto');
const PORT = process.env.PORT || 8080;
const TTL = 3 * 3600 * 1000;
const MAX_ROOMS = 5000, MAX_MSGS = 60, MAX_BODY = 4096, MAX_CLIENTS = 12;
const rooms = new Map(); // code -> {msgs:[], clients:Set, t:number}
const hits = new Map();  // ip -> {n, t}
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
  const m = /^\/r\/(\d{5})$/.exec(u.pathname);
  if (!m) return send(res, 404, 'not found');
  const code = m[1];
  if (limited(ip, 120)) return send(res, 429, 'slow down');
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
      if (!d || (d.t !== 'j' && d.t !== 'l' && d.t !== 'reveal') || typeof d.c !== 'string') return send(res, 400, 'bad msg');
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
  for (const [k, h] of hits) if (now - h.t > 120000) hits.delete(k);
}, 600000);
