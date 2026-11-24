# Voice mode tests

Spec: `docs/TEST-CONTRACT.md`, section "Voice mode contract". Run: `node --test tests/voice.test.js` (about 1 minute, one round start of about 14 s per room, rooms start in parallel).

## Covered
- Host option `vm: 'game'` and `vm: 'ext'`. In `ext` mode `tk` is null and `ask` and `tdone` are 200 with nothing changed.
- 10 s reveal: `rv` counts down, `el` and `tk` are null; after it `rv` is null, `el` is set and `tk` is the first ask phase.
- Microphone turn order, as STATE only: `tk` shows the asker first (phase ask), then the answerer (phase ans, `tk.a` asker and `tk.t` target), then the next asker. Tests read `tk`; they cannot see audio.
- Turn flow in game mode: ask, then ans (asker, then answerer), next asker, skip without a target, discussion after the last asker, everyone done starts cycle 2 with the first asker.
- Message handling: invalid asks (non-asker, self, unknown cid), uninvolved `tdone`, `ask` and asker `tdone` during ans, repeated ask replaces the target, discussion done is idempotent, `dm` is the requester's own flag, and `dn` is 0 and `dm` is false for everyone when the next cycle starts.
- Initial phase budgets via `tk.u` (60 s ask, 60 s ans, 300 s disc, with an 8 s slack), data in `tests/data/voice.json`.
- Game mode returns `dur` but the round does not end; votes finish the round in any phase and `tk` is null after the result.
- The asker is always read from `tk.a`. Roster order is never assumed.

## NOT tested
- Real expiry of the timers: 60 s ask, 60 s answer, 300 s discussion (and the 300 s discussion cap), and the 3600 s hard cap. Tests do not wait for them and do not use a shortened copy of the server.
- A disconnected target (the contract says it is not detected).
- Actual audio and microphone enforcement. The contract says mic gating is client side only, so no server-side mic state exists to test. If the contract defines more server-side mic states, they are missing from this suite and need a contract entry first.
- Contract-defined cases with no test: timer expiry paths (ask with no target at expiry, answer timeout, discussion expiry), the 3600 s cap, a target that left, and the ask-after-result ignore case.
