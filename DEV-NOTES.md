# dev branch (work in progress, NOT deployed)
Lobby server with scoring v2, accounts (/acc), store (buy) and sticker/sound events (fx). Render deploys only from main and Auto-Deploy is off.
Open PRs against `dev` only. Never push to main. No secrets in the repo (Supabase env vars live in Render).

## Forgotten password (owner-only reset)
Passwords are stored only as salted scrypt hashes, so they cannot be read back. A reset sets a new random temporary password.
Run on your own machine (not in chat, not in the repo):
  read -rs SUPA_KEY; export SUPA_KEY; export SUPA_URL=https://<project>.supabase.co
  node scripts/reset-password.js <username>
`read -rs` hides the key as you type it. The script prints the temporary password once; give it to the user. Old sessions are logged out.
Never commit the key. There is deliberately no public reset endpoint.

## Voice mode, reveal and round rules (rules file)

All timings live in `items.json` -> `rules` (run `python3 scripts/make_catalog.py`, copy `catalog.json` to the server repo):
`reveal` 10 s (role shown to everyone, then play starts, both modes), `ask` 60, `ans` 60, `disc` 300 (all mics, ends early when every player presses done), `cap` 3600 (round auto-closes), `dur_min`/`dur_max` (host round length, minutes, external mode).

Host picks `vm` at room creation: `ext` (external call: no in-game voice UI, no mic flow, host round length) or `game` (in-game voice, turn flow, no fixed round length, 60 min hard cap in both modes).

Server state (`stateOf`): `vm`, `rv` (ms left of reveal, else null), `tk` = `{ph:'ask'|'ans'|'disc', a:asker, t:target, u:ms left, cyc, dn, dm}` (null in ext mode or before play).
Messages: `{t:'ask', c, v:target}` (asker only, target must be another player), `{t:'tdone', c}`: asker with a target -> answer phase; asker without target -> skip; target during `ans` -> next turn; any player in `disc` marks done (all done -> next cycle). Ask with no target at timeout or target gone -> skipped. After the last asker, `disc`, then a new cycle. Votes are open at any time.
Mic gating is enforced by the app only (the server only owns the turn state).
Tests: tests/vm.js (http state machine), tests/vmui.js (3 browsers, fake mic).
