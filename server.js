// BMF lobby server: tiny in-memory room relay with Server-Sent Events. No dependencies.
process.on('uncaughtException', e => console.log('uncaught', e && e.stack || e));
process.on('unhandledRejection', e => console.log('unhandled', e && e.stack || e));
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
  const others = st.ids.length - 1;
  let picks = 0;
  for (const id of st.ids) {
    if (id === st.imp) continue;
    const tgt = st.votes.get(id);
    if (!tgt) d[id] = -2; else if (tgt === st.imp) { d[id] = 2; picks++; } else d[id] = -1;
  }
  const nonPick = others - picks;
  if (st.ids.length >= 5) d[st.imp] = nonPick - picks;
  else d[st.imp] = (picks === others ? 0 : IMP_MIN) - picks;
  const tot = {};
  for (const id of st.ids) { room.scores[id] = (room.scores[id] || 0) + d[id]; tot[id] = room.scores[id]; }
  const votes = {}; for (const [a, b] of st.votes) votes[a] = b;
  let win = [];
  if (room.round >= room.rounds) { const mx = Math.max.apply(null, st.ids.map(id => tot[id])); win = st.ids.filter(id => tot[id] === mx); }
  st.result = { win, bonus: win.length ? Math.floor(10 / win.length) : 0, imp: st.imp, r: st.r, votes, d, tot, disc, round: room.round, rounds: room.rounds, at: Date.now() };
  room.hist = room.hist || {}; room.hist[room.round] = { d, win: win.slice(), bonus: st.result.bonus, ids: st.ids.slice() };
}
const ABSENT_MS = 45000;
function advance(room) {
  const st = room.started, now = Date.now();
  if (!st || st.result) return;
  if (!st.goAt && st.revealAt && now >= st.revealAt) st.goAt = st.revealAt;
  if (!st.goAt) return;
  if (now - st.goAt > RULES.cap * 1000) { resolve(room); return; }
  // a player who left (no contact for ABSENT_MS) keeps their seat but is not waited for when voting
  if (st.votes.size > 0 && st.ids.every(id => id === st.imp || st.votes.has(id) || now - ((st.pres && st.pres[id]) || st.goAt) > ABSENT_MS)) { resolve(room); return; }
  if (room.vm !== 'game') return;
  const ord = st.ids;
  let tk = st.tk;
  if (!tk) tk = st.tk = { ph: 'ask', i: 0, a: ord[0], t: null, u: st.goAt + RULES.ask * 1000, cyc: 1 };
  const nextTurn = () => {
    tk.i++; tk.t = null;
    if (tk.i >= ord.length) { tk.ph = 'disc'; tk.a = null; tk.dn = new Set(); tk.u = now + RULES.disc * 1000; }
    else { tk.ph = 'ask'; tk.a = ord[tk.i]; tk.u = now + RULES.ask * 1000; }
  };
  for (let g = 0; g < 50 && now >= tk.u; g++) {
    if (tk.ph === 'ask') { if (tk.t) { tk.ph = 'ans'; tk.u = now + RULES.ans * 1000; } else nextTurn(); }
    else if (tk.ph === 'ans') { tk.ph = 'gap'; tk.u = now + RULES.gap * 1000; } // pause between questions: the only time sounds are allowed
    else if (tk.ph === 'gap') nextTurn();
    else { tk.cyc++; tk.i = 0; tk.ph = 'ask'; tk.a = ord[0]; tk.t = null; tk.dn = null; tk.u = now + RULES.ask * 1000; }
  }
}
function talkAct(room, cid, d) {
  advance(room);
  const st = room.started, tk = st && st.tk, now = Date.now();
  if (!tk || st.result || room.vm !== 'game') return;
  if (d.t === 'ask' && tk.ph === 'ask' && tk.a === cid) { const v = String(d.v || ''); if (v !== cid && st.ids.indexOf(v) >= 0) tk.t = v; }
  if (d.t === 'tdone') {
    if (tk.ph === 'ask' && tk.a === cid && tk.t) { tk.ph = 'ans'; tk.u = now + RULES.ans * 1000; }
    else if (tk.ph === 'ans' && tk.t === cid) tk.u = now;
    else if (tk.ph === 'disc') { tk.dn = tk.dn || new Set(); tk.dn.add(cid); if (st.ids.every(x => tk.dn.has(x))) tk.u = now; }
    else if (tk.ph === 'ask' && tk.a === cid && !tk.t) tk.u = now;
    advance(room);
  }
}
function stateOf(room, cid, since) {
  advance(room);
  const st = room.started, now = Date.now();
  return { k: st.seen.size, n: st.ids.length, el: st.goAt ? now - st.goAt : null, nx: room.next || null,
    rd: st.ready.size, rm: st.ready.has(cid), ca: st.startAt ? st.startAt - now : null, sn: st.seen.has(cid),
    vt: st.votes.size, mine: st.votes.get(cid) || null, round: room.round, rounds: room.rounds, dur: room.dur || 180, vm: room.vm || 'ext', rv: st.revealAt && !st.goAt ? Math.max(0, st.revealAt - now) : null, tk: st.tk && !st.result ? { ph: st.tk.ph, a: st.tk.a, t: st.tk.t, u: Math.max(0, st.tk.u - now), cyc: st.tk.cyc, dn: st.tk.ph === 'disc' && st.tk.dn ? st.tk.dn.size : 0, dm: !!(st.tk.ph === 'disc' && st.tk.dn && st.tk.dn.has(cid)) } : null, lead: room.leader, res: st.result, fx: (st.fx || []).filter(e => e.i > (+since || 0) && !(ADULT.has(e.k) && room.fam && room.fam.has(cid))), fxs: st.fxs || 0 };
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

// ---- store catalog: stickers s1..sN cost 10, sounds a1..aM cost 5 ----
const CATALOG = (() => { try { return JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'catalog.json'), 'utf8')); } catch (e) { console.log('catalog.json missing', e.message); return { stickers: [], sounds: [], frames: [] }; } })();
const PRICES = new Map();
for (const k of ['stickers', 'sounds', 'frames']) for (const x of CATALOG[k]) PRICES.set(x.id, x.price | 0);
const RULES = Object.assign({ reveal: 10, ask: 60, ans: 60, gap: 12, sound_cd: 30, sticker_cd: 10, disc: 300, cap: 3600, dur_min: 1, dur_max: 60 }, CATALOG.rules || {});
const itemPrice = id => PRICES.get(String(id)) || 0;
const ADULT = new Set((CATALOG.stickers || []).concat(CATALOG.sounds || []).filter(x => x.adult).map(x => x.id)); // regular edition only
// ---- accounts (Supabase REST when SUPA_URL + SUPA_KEY are set, in-memory otherwise) ----
const SUPA_URL = (process.env.SUPA_URL || '').replace(/\/+$/, ''), SUPA_KEY = process.env.SUPA_KEY || '';
const memAcc = new Map();
let lastDbPing = 0;
async function dbFetch(path, opt) {
  const r = await fetch(SUPA_URL + '/rest/v1/' + path, Object.assign({ headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' } }, opt));
  const tx = await r.text();
  if (!r.ok) throw new Error('db ' + r.status + ' ' + tx.slice(0, 200));
  return tx ? JSON.parse(tx) : [];
}
async function accGet(u) {
  if (!SUPA_URL) return memAcc.get(u) || null;
  const a = await dbFetch('accounts?username=eq.' + encodeURIComponent(u) + '&select=*');
  return a[0] || null;
}
async function accPut(row, create) {
  if (!SUPA_URL) { memAcc.set(row.username, Object.assign({}, row)); return; }
  if (create) await dbFetch('accounts', { method: 'POST', body: JSON.stringify(row) });
  else await dbFetch('accounts?username=eq.' + encodeURIComponent(row.username), { method: 'PATCH', body: JSON.stringify({ salt: row.salt, hash: row.hash, tok: row.tok, pts: row.pts, rids: row.rids, items: row.items || '', profile: row.profile || '' }) });
}
// profile (display name, avatar, photo, frame, font) lives on the account so it follows the user to every device
const PROF_STR = { n: 14, a: 12, g: 12, r: 6, f: 8, t: 6000, p: 40000 };
function cleanProf(raw) {
  let o; try { o = JSON.parse(String(raw || '')); } catch (e) { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const out = {};
  for (const k of Object.keys(PROF_STR)) {
    const v = o[k]; if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' || v.length > PROF_STR[k]) return null;
    if ((k === 't' || k === 'p') && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(v)) return null;
    out[k] = v;
  }
  if (!out.n) return null;
  return JSON.stringify(out);
}
const signups = new Map();
function signupLimited(ip) { if (/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(ip)) return false; const n = Date.now(), h = signups.get(ip); if (!h || n - h.t > 3600e3) { signups.set(ip, { n: 1, t: n }); return false; } return ++h.n > 6; }
setInterval(() => { const n = Date.now(); for (const [k, v] of signups) if (n - v.t > 3600e3) signups.delete(k); }, 600000).unref();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const loginFails = new Map();
setInterval(() => { const n = Date.now(); for (const [k, v] of loginFails) if (n - v.t > 600000) loginFails.delete(k); }, 300000).unref();
const soloTix = new Map(); // one-time tickets for the owner's solo test rooms
const accQ = new Map(); // serialize per user so two phones cannot race
function accLock(u, fn) {
  const prev = accQ.get(u) || Promise.resolve();
  const next = prev.then(fn, fn);
  accQ.set(u, next.catch(() => {}));
  return next;
}
async function accHandle(d) {
  const t = d.t, u = String(d.u || '').trim().toLowerCase();
  if (!/^[a-z0-9_\u0600-\u06ff]{3,20}$/.test(u)) return [400, 'اسم المستخدم 3 لـ 20 حرف أو رقم'];
  return accLock(u, async () => {
    if (t === 'signup') {
      if (d._ip && signupLimited(d._ip)) return [429, 'محاولات تسجيل كتير، جرب بعدين'];
      const p = String(d.p || '');
      if (p.length < 6 || p.length > 64) return [400, 'كلمة السر 6 حروف على الأقل'];
      if (await accGet(u)) return [409, 'الاسم ده مأخوذ'];
      const salt = crypto.randomBytes(16).toString('hex'), hash = crypto.scryptSync(p, salt, 32).toString('hex');
      const tok = crypto.randomBytes(24).toString('hex');
      const its = String(d.items || '').split(',').filter((x, i, a) => itemPrice(x) > 0 && a.indexOf(x) === i).join(',');
      let pts = Math.floor(+d.init) || 0; pts = Math.max(0, Math.min(1000, pts));
      await accPut({ username: u, salt, hash, tok: sha(tok), pts, rids: [], items: its, profile: cleanProf(d.prof) || '' }, true);
      return [200, { tok, pts, items: its, prof: cleanProf(d.prof) || '' }];
    }
    const a = await accGet(u);
    if (t === 'login') {
      const f = loginFails.get(u) || { n: 0, t: 0 };
      if (f.n >= 8 && Date.now() - f.t < 600000) return [429, 'محاولات كتير، استنى 10 دقايق'];
      if (!a) { loginFails.set(u, { n: f.n + 1, t: Date.now() }); return [403, 'الاسم أو كلمة السر غلط']; }
      const h = crypto.scryptSync(String(d.p || ''), a.salt, 32).toString('hex');
      if (!crypto.timingSafeEqual(Buffer.from(h), Buffer.from(a.hash))) { loginFails.set(u, { n: (f.n >= 8 && Date.now() - f.t >= 600000 ? 0 : f.n) + 1, t: Date.now() }); return [403, 'الاسم أو كلمة السر غلط']; }
      loginFails.delete(u);
      const tok = crypto.randomBytes(24).toString('hex');
      // guest points carried from the device: added once per guest id, never twice
      const gid = String(d.gid || ''), gp = Math.floor(+d.g) || 0;
      if (gp > 0 && /^[A-Za-z0-9]{6,40}$/.test(gid)) {
        const key = 'g' + gid; if (!Array.isArray(a.rids)) a.rids = [];
        if (a.rids.indexOf(key) < 0) { a.pts += Math.min(gp, 1000); a.rids.push(key); }
      }
      a.tok = sha(tok); await accPut(a, false);
      return [200, { tok, pts: a.pts, items: a.items || '', prof: a.profile || '' }];
    }
    if (!a || a.tok !== sha(String(d.tok || ''))) return [403, 'سجل دخول تاني'];
    if (t === 'solo') { // only the account 'belal', proven by its login token, gets a ticket
      if (u !== 'belal') return [403, 'no'];
      const tk = crypto.randomBytes(12).toString('hex'); soloTix.set(tk, Date.now() + 120000);
      for (const [k, v] of soloTix) if (v < Date.now()) soloTix.delete(k);
      return [200, { tk }];
    }
    if (t === 'chpw') {
      const f = loginFails.get(u) || { n: 0, t: 0 };
      if (f.n >= 8 && Date.now() - f.t < 600000) return [429, 'محاولات كتير، استنى 10 دقايق'];
      const np = String(d.n || '');
      if (np.length < 6 || np.length > 64) return [400, 'كلمة السر 6 حروف على الأقل'];
      const h0 = crypto.scryptSync(String(d.p || ''), a.salt, 32).toString('hex');
      if (!crypto.timingSafeEqual(Buffer.from(h0), Buffer.from(a.hash))) { loginFails.set(u, { n: (f.n >= 8 && Date.now() - f.t >= 600000 ? 0 : f.n) + 1, t: Date.now() }); return [403, 'كلمة السر الحالية غلط']; }
      loginFails.delete(u);
      a.salt = crypto.randomBytes(16).toString('hex'); a.hash = crypto.scryptSync(np, a.salt, 32).toString('hex');
      await accPut(a, false);
      return [200, { ok: 1 }];
    }
    if (t === 'get') return [200, { pts: a.pts, items: a.items || '', prof: a.profile || '' }];
    if (t === 'prof') {
      const pr = cleanProf(d.prof);
      if (!pr) return [400, 'بروفايل غير صالح'];
      a.profile = pr; await accPut(a, false);
      return [200, { ok: 1, prof: pr }];
    }
    if (t === 'buy') {
      const id = String(d.item || ''), price = itemPrice(id), own = String(a.items || '').split(',').filter(Boolean);
      if (!price) return [400, 'الحاجة دي مش موجودة'];
      if (own.indexOf(id) >= 0) return [200, { pts: a.pts, items: own.join(','), dup: true }];
      if (a.pts < price) return [402, 'نقطك مش كفاية'];
      a.pts -= price; own.push(id); a.items = own.join(',');
      await accPut(a, false);
      return [200, { pts: a.pts, items: a.items }];
    }
    if (t === 'add') {
      // points are computed from the server's own round result; the client only names the room, round and itself
      const rid = String(d.rid || '').slice(0, 40), cid = String(d.c || ''), round = Math.floor(+d.round);
      const room = rooms.get(String(d.code || '')), h = room && room.hist && room.hist[round];
      if (!h || h.ids.indexOf(cid) < 0) return [404, 'no such round'];
      if (!room.acct || room.acct[cid] !== u) return [403, 'not your player'];
      const rids = Array.isArray(a.rids) ? a.rids : [];
      if (rid && rids.indexOf(rid) >= 0) return [200, { pts: a.pts, dup: true }];
      room.claimed = room.claimed || new Set();
      const ck = round + ':' + cid;
      if (room.claimed.has(ck)) return [409, 'already claimed'];
      room.claimed.add(ck);
      const dd = h.d[cid] || 0, bb = h.win.indexOf(cid) >= 0 ? h.bonus : 0;
      let bal = a.pts + dd; if (bal < 0) bal = 0; bal += bb;
      a.pts = bal; rids.push(rid || ck); a.rids = rids.slice(-60);
      await accPut(a, false);
      return [200, { pts: bal }];
    }
    return [400, 'bad type'];
  });
}

http.createServer((req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const u = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (u.pathname === '/' || u.pathname === '/health') {
    if (SUPA_URL && Date.now() - lastDbPing > 3600e3) { lastDbPing = Date.now(); dbFetch('accounts?select=username&limit=1').catch(e => console.log('db ping', e.message)); }
    return send(res, 200, 'ok');
  }
  if (u.pathname === '/keepalive') {
    // tiny read of the accounts table so Supabase counts it as activity; fails loudly so the scheduled job turns red
    if (!SUPA_URL) return send(res, 200, 'ok (memory mode)');
    lastDbPing = Date.now();
    return dbFetch('accounts?select=username&limit=1').then(() => send(res, 200, 'ok db')).catch(e => { console.log('keepalive db', e.message); send(res, 502, 'db down'); });
  }
  if (u.pathname === '/acc') {
    if (req.method !== 'POST') return send(res, 405, 'method');
    if (limited('acc:' + ip, 60)) return send(res, 429, 'slow down');
    let body = '';
    req.on('data', c => { body += c; if (body.length > 60000) req.destroy(); });
    req.on('end', () => {
      let d; try { d = JSON.parse(body); } catch (e) { return send(res, 400, 'bad json'); }
      if (!d || ['signup', 'login', 'get', 'add', 'buy', 'chpw', 'prof', 'solo'].indexOf(d.t) < 0) return send(res, 400, 'bad msg');
      d._ip = ip; accHandle(d).then(r => send(res, r[0], typeof r[1] === 'string' ? r[1] : JSON.stringify(r[1]), typeof r[1] === 'string' ? {} : { 'Content-Type': 'application/json' }))
        .catch(e => { console.log('acc error', e.message); send(res, 500, 'خطأ في السيرفر'); });
    });
    return;
  }


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
    const cl = { res, cid: /^[A-Za-z0-9_-]{1,20}$/.test(u.searchParams.get('c') || '') ? u.searchParams.get('c') : '' };
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
      const TYPES = ['j', 'l', 'reveal', 'seen', 'state', 'again', 'ready', 'vote', 'close', 'vjoin', 'vleave', 'sig', 'sigpoll', 'fx', 'ask', 'tdone'];
      if (!d || TYPES.indexOf(d.t) < 0 || typeof d.c !== 'string' || !/^[A-Za-z0-9_-]{1,20}$/.test(d.c)) return send(res, 400, 'bad msg');
      let room = rooms.get(code);
      if (!room) {
        const n = +code[1];
        if (!d.host || d.t !== 'j' || n < 1 || n > 9) return send(res, 404, 'no room');
        if (n === 1) { const ex = soloTix.get(String(d.solo || '')); soloTix.delete(String(d.solo || '')); if (!ex || ex < Date.now()) return send(res, 403, 'no solo'); }
        if (rooms.size >= MAX_ROOMS || limited('new:' + ip, 20)) return send(res, 429, 'busy');
        const rr = Math.floor(+d.rounds), rounds = Number.isFinite(rr) ? Math.max(1, Math.min(20, rr)) : 3;
        const dd0 = Math.floor(+d.dur), dur0 = Number.isFinite(dd0) ? Math.max(RULES.dur_min * 60, Math.min(RULES.dur_max * 60, dd0)) : 180;
        room = { n, msgs: [], clients: new Set(), roster: [], started: null, t: Date.now(), rounds, dur: dur0, vm: d.vm === 'game' ? 'game' : 'ext', round: 1, leader: String(d.c).slice(0, 20), scores: {} };
        rooms.set(code, room);
      }
      delete d.host;
      const cid = String(d.c).slice(0, 20);
      room.t = Date.now();
      const J = { 'Content-Type': 'application/json' };
      const st = room.started;
      if (st && st.ids.indexOf(cid) >= 0) { st.pres = st.pres || {}; st.pres[cid] = Date.now(); }
      if (['reveal', 'seen', 'state', 'again', 'ready', 'vote', 'close', 'vjoin', 'vleave', 'sig', 'sigpoll', 'fx', 'ask', 'tdone'].indexOf(d.t) >= 0) {
        if (!st || st.ids.indexOf(cid) < 0) return send(res, 403, 'no');
        const now = Date.now();
        advance(room);
        if (d.t === 'ask' || d.t === 'tdone') { talkAct(room, cid, d); return send(res, 200, JSON.stringify(stateOf(room, cid, d.s)), J); }
        if (d.t === 'fx') {
          const id = String(d.k || '');
          if (!st.goAt || !/^[sa]/.test(id) || !itemPrice(id)) return send(res, 400, 'bad fx');
          if (ADULT.has(id) && room.fam && room.fam.has(cid)) return send(res, 400, 'bad fx');
          st.fx = st.fx || []; st.fxs = st.fxs || 0;
          const snd = id.charAt(0) === 'a';
          if (snd && room.vm === 'game' && !(st.tk && st.tk.ph === 'gap')) return send(res, 409, 'no sound now'); // sounds only in the pause between questions
          room.fxT = room.fxT || {}; const fk = cid + (snd ? ':a' : ':s');
          if (now - (room.fxT[fk] || 0) < (snd ? RULES.sound_cd : RULES.sticker_cd) * 1000) return send(res, 429, 'wait');
          room.fxT[fk] = now; st.fxs++;
          st.fx.push({ i: st.fxs, f: cid, k: id, t: now });
          st.fx = st.fx.filter(e => now - e.t < 30000).slice(-30);
          return send(res, 200, JSON.stringify(stateOf(room, cid, d.s)), J);
        }
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
          if (st.ready.size >= st.ids.length) { st.startAt = now + 3000; st.revealAt = st.startAt + RULES.reveal * 1000; }
        }
        if (d.t === 'seen' && st.startAt && now >= st.startAt) {
          st.seen.add(cid);
          
        }
        if (d.t === 'vote' && st.goAt && !st.result) {
          const v = String(d.v || '');
          if (v !== cid && st.ids.indexOf(v) >= 0) st.votes.set(cid, v);
          advance(room);
          if (!st.result && st.ids.every(id => id === st.imp || st.votes.has(id))) resolve(room);
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
          rooms.set(nc, { fam: new Set(room.fam || []), acct: Object.assign({}, room.acct || {}), n: room.n, msgs: room.msgs.slice(), clients: new Set(), roster: room.roster.slice(), started: Object.assign(newRound(ids), { voice: new Set(st.voice) }), t: now, rounds: room.rounds, dur: room.dur, vm: room.vm, round: last ? 1 : room.round + 1, leader: room.leader, scores: last ? {} : Object.assign({}, room.scores) });
          room.next = nc;
        }
        return send(res, 200, JSON.stringify(stateOf(room, cid, d.s)), J);
      }
      if (room.started) return send(res, 200, 'ok');
      if (d.t === 'l') {
        const i = room.roster.indexOf(cid);
        if (i >= 0) room.roster.splice(i, 1);
      } else {
        if (room.roster.indexOf(cid) >= 0 || room.roster.length >= room.n) return send(res, 200, 'ok');
        room.roster.push(cid);
        if (d.v === 'fam') { room.fam = room.fam || new Set(); room.fam.add(cid); }
        { const un = String(d.u || '').trim().toLowerCase(); if (/^[a-z0-9_\u0600-\u06ff]{3,20}$/.test(un)) { room.acct = room.acct || {}; room.acct[cid] = un; } }
      }
      const s = JSON.stringify({ t: d.t, v: d.v === 'fam' ? 'fam' : 'full', c: cid, n: String(d.n || '').slice(0, 14), f: /^f\d{1,2}$/.test(String(d.f || '')) ? String(d.f) : '', a: String(d.a || '').slice(0, 4000) });
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
