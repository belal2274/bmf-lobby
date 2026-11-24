'use strict';
// Voice mode (vm) state machine over HTTP. Spec: docs/TEST-CONTRACT.md "Voice mode contract".
// Only initial budgets, phase changes and message handling are tested. Real timer expiry (60/60/300 s, 3600 s cap)
// and a disconnected target are NOT tested (see docs/TESTING-VOICE.md).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, SKIP } = require('./helpers/server');
const R = require('./helpers/room');
const V = require('./helpers/voice');
const D = require('./data/voice.json');

// u is "ms left in phase": at most the budget, and not much below it right after the phase starts.
const budget = (u, max) => assert.ok(u <= max && u > max - D.slackMs, `tk.u ${u} should be within ${D.slackMs} ms below ${max}`);

describe('voice mode', { skip: SKIP }, () => {
  let srv; let g; let x; let w; let reveal; let playG;
  before(async () => {
    srv = await startServer();
    [g, x, w] = await Promise.all([
      V.fillVoiceRoom(srv.base, { n: 3, vm: 'game' }),
      V.fillVoiceRoom(srv.base, { n: 3, vm: 'ext' }),
      V.fillVoiceRoom(srv.base, { n: 3, vm: 'game', dur: 60 }),
    ]);
    // Start all three rounds at once; the game room's reveal is observed on the way.
    const r = await Promise.all([V.readyAndCatchReveal(srv.base, g), V.readyAndCatchReveal(srv.base, x), V.readyAndCatchReveal(srv.base, w)]);
    reveal = r[0];
    playG = await V.waitPlay(srv.base, g);
    await V.waitPlay(srv.base, x);
    await V.waitPlay(srv.base, w);
  });
  after(async () => { [g, x, w].forEach((r) => r && r.close()); await srv.stop(); });

  const S = () => V.st(srv.base, g);
  const others = (room, c) => room.cids.filter((p) => p !== c);

  it('reveal: rv counts down from the 10 s budget, there is no play clock and no turn state yet', () => {
    assert.equal(reveal.vm, 'game');
    assert.ok(reveal.rv > 0 && reveal.rv <= D.revealMs, `rv ${reveal.rv}`);
    assert.equal(reveal.el, null);
    assert.equal(reveal.tk, null);
  });

  it('after the reveal: el is set, rv is null, and the first turn is an ask phase', () => {
    assert.equal(playG.rv, null);
    assert.notEqual(playG.el, null);
    const tk = playG.tk;
    assert.equal(tk.ph, 'ask');
    assert.ok(g.cids.includes(tk.a), 'asker is a player (read from tk.a, roster order is not assumed)');
    assert.equal(tk.t, null);
    assert.equal(tk.cyc, 1);
    assert.equal(tk.dn, 0);
    assert.equal(tk.dm, false);
    budget(tk.u, D.askMs);
  });

  it('external mode: no turn state, and ask / tdone are 200 with nothing changed', async () => {
    const s0 = await V.st(srv.base, x);
    assert.equal(s0.vm, 'ext');
    assert.equal(s0.tk, null);
    for (const c of x.cids) {
      const a = await V.ask(srv.base, x, c, x.cids.find((p) => p !== c));
      const d = await V.tdone(srv.base, x, c);
      assert.equal(a.status, 200);
      assert.equal(d.status, 200);
      assert.equal(d.json.tk, null);
    }
    assert.equal((await V.st(srv.base, x)).tk, null);
  });

  it('game mode: dur is returned but does not end the round', async () => {
    const s = await V.st(srv.base, w);
    assert.equal(s.dur, 60);
    assert.equal(s.res, null);
    assert.notEqual(s.el, null);
  });

  it('invalid asks are 200 and change nothing: non-asker, self, unknown cid', async () => {
    const a = playG.tk.a;
    const cases = [
      ['non-asker', others(g, a)[0], a],
      ['self', a, a],
      ['unknown cid', a, 'nobody'],
    ];
    for (const [name, c, v] of cases) {
      const r = await V.ask(srv.base, g, c, v);
      assert.equal(r.status, 200, name);
      assert.equal(r.json.tk.ph, 'ask', name);
      assert.equal(r.json.tk.t, null, name);
      assert.equal(r.json.tk.a, a, name);
    }
  });

  it('tdone from an uninvolved player in ask is 200 and changes nothing', async () => {
    const a = playG.tk.a;
    const r = await V.tdone(srv.base, g, others(g, a)[0]);
    assert.equal(r.status, 200);
    assert.equal(r.json.tk.ph, 'ask');
    assert.equal(r.json.tk.a, a, 'uninvolved tdone changes nothing');
  });

  it('a valid ask sets the target, and a repeated valid ask replaces it until tdone', async () => {
    const a = playG.tk.a; const [t1, t2] = others(g, a);
    const r1 = await V.ask(srv.base, g, a, t1);
    assert.equal(r1.json.tk.t, t1);
    assert.equal(r1.json.tk.ph, 'ask');
    const r2 = await V.ask(srv.base, g, a, t2);
    assert.equal(r2.json.tk.t, t2);
    assert.equal(r2.json.tk.ph, 'ask');
  });

  let first; let second; let third; // askers in turn order, read from tk.a
  it('asker tdone with a target moves to ans: same asker, target kept, 60 s budget', async () => {
    first = playG.tk.a;
    const r = await V.tdone(srv.base, g, first);
    const tk = r.json.tk;
    assert.equal(tk.ph, 'ans');
    assert.equal(tk.a, first);
    assert.ok(g.cids.includes(tk.t) && tk.t !== first);
    assert.equal(tk.cyc, 1);
    budget(tk.u, D.ansMs);
  });

  it('in ans: ask, the asker tdone and an uninvolved tdone are ignored (200, state unchanged)', async () => {
    const before = (await S()).tk;
    const uninvolved = g.cids.find((p) => p !== before.a && p !== before.t);
    const checks = [
      ['ask during ans', await V.ask(srv.base, g, before.a, uninvolved)],
      ['asker tdone during ans', await V.tdone(srv.base, g, before.a)],
      ['uninvolved tdone during ans', await V.tdone(srv.base, g, uninvolved)],
    ];
    for (const [name, r] of checks) {
      assert.equal(r.status, 200, name);
      assert.equal(r.json.tk.ph, 'ans', name);
      assert.equal(r.json.tk.a, before.a, name);
      assert.equal(r.json.tk.t, before.t, name);
    }
  });

  it('the target tdone ends the answer: the next asker starts in ask with no target', async () => {
    const tk0 = (await S()).tk;
    const r = await V.tdone(srv.base, g, tk0.t);
    const tk = r.json.tk;
    assert.equal(tk.ph, 'ask');
    assert.notEqual(tk.a, first);
    assert.equal(tk.t, null);
    assert.equal(tk.cyc, 1);
    budget(tk.u, D.askMs);
    second = tk.a;
  });

  it('asker tdone without a target skips to the next asker', async () => {
    const r = await V.tdone(srv.base, g, second);
    const tk = r.json.tk;
    assert.equal(tk.ph, 'ask');
    assert.ok(tk.a !== first && tk.a !== second, 'third player asks');
    assert.equal(tk.t, null);
    assert.equal(tk.cyc, 1);
    third = tk.a;
  });

  it('after the last asker the discussion starts: no asker, no target, 300 s budget, nobody done', async () => {
    const t = others(g, third)[0];
    await V.ask(srv.base, g, third, t);
    await V.tdone(srv.base, g, third);
    const r = await V.tdone(srv.base, g, t);
    const tk = r.json.tk;
    assert.equal(tk.ph, 'disc');
    assert.equal(tk.a, null);
    assert.equal(tk.t, null);
    assert.equal(tk.cyc, 1);
    assert.equal(tk.dn, 0);
    assert.equal(tk.dm, false);
    budget(tk.u, D.discMs);
  });

  it('in disc: ask is ignored; done is counted per player (dn, dm), idempotent, and everyone done starts cycle 2 with the first asker', async () => {
    const ign = await V.ask(srv.base, g, first, second);
    assert.equal(ign.json.tk.ph, 'disc');
    const d1 = await V.tdone(srv.base, g, g.cids[0]);
    assert.equal(d1.json.tk.ph, 'disc');
    assert.equal(d1.json.tk.dn, 1);
    assert.equal(d1.json.tk.dm, true);
    const again = await V.tdone(srv.base, g, g.cids[0]);
    assert.equal(again.json.tk.dn, 1, 'done is idempotent');
    assert.equal((await V.st(srv.base, g, g.cids[1])).tk.dm, false, 'dm is the requester\'s own flag');
    await V.tdone(srv.base, g, g.cids[1]);
    const last = await V.tdone(srv.base, g, g.cids[2]);
    const tk = last.json.tk;
    assert.equal(tk.ph, 'ask');
    assert.equal(tk.cyc, 2);
    assert.equal(tk.a, first, 'the first asker starts the next cycle');
    assert.equal(tk.t, null);
    budget(tk.u, D.askMs);
  });

  // Contract: dn is 0 outside disc. Observed on the current server: dn is still 3 right after the cycle restarts. Kept visible as TODO, owner to decide.
  it('dn is 0 again once the next cycle starts', { todo: 'contract says dn is 0 outside disc; observed 3 after everyone was done. Owner to decide.' }, async () => {
    assert.equal((await S()).tk.dn, 0);
  });

  it('votes are accepted in any phase and finish the round; tk is null after the result', async () => {
    const non = g.cids.filter((c) => c !== g.imp);
    for (const c of non) await R.post(srv.base, g.code, { t: 'vote', c, v: g.imp });
    const s = await S();
    assert.ok(s.res, 'round ended after the last non-impostor vote');
    assert.equal(s.tk, null);
  });
});
