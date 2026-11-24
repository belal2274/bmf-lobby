# BMF lobby server
Tiny room relay for BMF امبوستر. No database, no dependencies. Rooms live in memory for 3 hours.
Run: `node server.js` (PORT env). Endpoints: `GET /health`, `GET /r/<5 digits>?c=<clientId>` (SSE), `POST /r/<5 digits>`.
The impostor and the word seed are chosen on the server with crypto.randomInt and sent privately to each player.
