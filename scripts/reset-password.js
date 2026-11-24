// Owner-only password reset. Run on your own machine, never from the client.
// Needs SUPA_URL and SUPA_KEY in the environment (same values as on Render).
// Usage: node scripts/reset-password.js <username>
// Prints a random temporary password once. Old password and all logged-in sessions stop working.
const crypto = require('crypto');
const URL_ = (process.env.SUPA_URL || '').replace(/\/+$/, ''), KEY = process.env.SUPA_KEY || '';
const u = String(process.argv[2] || '').trim().toLowerCase();
if (!URL_ || !KEY || !u) { console.error('Set SUPA_URL and SUPA_KEY, then: node scripts/reset-password.js <username>'); process.exit(1); }
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
(async () => {
  const q = URL_ + '/rest/v1/accounts?username=eq.' + encodeURIComponent(u);
  const r = await fetch(q + '&select=username', { headers: H });
  if (!r.ok) throw new Error('lookup failed ' + r.status);
  if (!(await r.json()).length) { console.error('No such account: ' + u); process.exit(2); }
  const A = 'abcdefghjkmnpqrstuvwxyz23456789';
  const tmp = Array.from(crypto.randomBytes(10), b => A[b % A.length]).join('');
  const salt = crypto.randomBytes(16).toString('hex'), hash = crypto.scryptSync(tmp, salt, 32).toString('hex');
  const tok = crypto.createHash('sha256').update(crypto.randomBytes(24)).digest('hex'); // invalidates old sessions
  const p = await fetch(q, { method: 'PATCH', headers: H, body: JSON.stringify({ salt, hash, tok }) });
  if (!p.ok) throw new Error('update failed ' + p.status);
  console.log('Account: ' + u + '\nTemporary password: ' + tmp + '\nTell the user to log in and change it.');
})().catch(e => { console.error(e.message); process.exit(1); });
