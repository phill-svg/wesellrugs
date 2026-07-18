# We Sell Rugs — Messenger

A real-time chat app running entirely on Cloudflare: **Workers** (API + routing),
**Durable Objects** (live WebSocket delivery), and **D1** (SQLite storage).

## Features
- Account sign-up / log in / log out (PBKDF2-hashed passwords, HttpOnly session cookies)
- Browse other users and start a 1:1 direct message
- Live message delivery over WebSockets
- Message history persisted in D1

## Run locally
```bash
npm install
npm run db:init        # create tables in the local D1
npm run dev            # http://localhost:8787
```
Open two browser profiles (or a normal + private window), register two accounts,
and message between them.

## Deploy to Cloudflare
1. **Create the D1 database** (once):
   ```bash
   npx wrangler d1 create wesellrugs-db
   ```
   Copy the `database_id` it prints into `wrangler.jsonc` (replace `local-dev-placeholder`).
2. **Create the tables in the remote DB:**
   ```bash
   npm run db:init:remote
   ```
3. **Deploy:**
   ```bash
   npx wrangler deploy
   ```

### Connect the domain (wesellrugs.com.au)
Because the domain is already on Cloudflare, add a custom domain to the Worker:
- Cloudflare dashboard → **Workers & Pages** → `wesellrugs-messenger` → **Settings → Domains & Routes → Add custom domain** → `wesellrugs.com.au`.

### Deploy from GitHub (CI)
Push this repo to GitHub, then in the Cloudflare dashboard connect the repo under
**Workers & Pages → Create → Connect to Git**, or add a GitHub Action using
`cloudflare/wrangler-action` with a `CLOUDFLARE_API_TOKEN` secret.

## Project layout
```
wrangler.jsonc     Cloudflare config (Worker, assets, D1, Durable Object)
schema.sql         D1 tables
src/index.js       Worker: REST API + WebSocket routing
src/auth.js        Password hashing + sessions
src/chat-room.js   ChatRoom Durable Object (live delivery)
public/            Frontend (index.html, styles.css, app.js)
```
