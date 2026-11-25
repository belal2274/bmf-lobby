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

## Account profile sync
accounts.profile (text, JSON: n name, a avatar id, g gender seed, r frame, f font, t 56px thumb, p 160px photo, all validated server side) follows the account to every device. Actions: login/get return `prof`; `prof` saves it. Account profile wins on a device that logs in; if the account has none, the web client uploads its local one (the Android app only uploads on an explicit profile Save). Column added with: alter table public.accounts add column if not exists profile text not null default '';
Guest points on login: client sends g (guest points) and gid (random id); the server adds them once per gid (stored in rids as g<gid>), max 1000, then the client drops its gid. Signup adopts points (max 1000), owned items and profile.
