# Beezy Honey: developer runbook

How to run, test, set up and deploy the site and the admin portal, and how to recover when something breaks.
Background: `admin-portal-design.md` and the owner's amendments (A1–A7, kept outside the repo). More detail on the
Worker, middleware and gates: `docs/DEV-NOTES.md`. Server API: `src/server/README.md`. Admin screens: `src/admin/README.md`.

**Never commit personal data.** The repo is public. The two owner emails live only in the Worker secret `ADMIN_EMAILS`
(their login aliases in `ADMIN_ALIASES`) and in your gitignored `.dev.vars`. A unit test fails if any of them appears in
a tracked file.

The design runs without a card on the Cloudflare account: no Zero Trust (own email-code login instead), no R2 (Workers
KV for photos and backups), no staging environment (rehearsal on `next.` + `admin.` before the cutover).

---

## 1. Local development

Requirements: Node 24 (`.node-version`), npm 11. No Cloudflare account is needed locally.

```sh
npm ci
cp .dev.vars.example .dev.vars        # then fill it in (see below)
npm run db:reset:local                # migrate + seed the local D1 in .wrangler/state
npm run dev                           # sync-catalog + astro dev (workerd); http://localhost:4321/
```

`.dev.vars` (gitignored):

| Name | Local value |
|---|---|
| `DEV_ADMIN_EMAIL` | `dev@example.test`: signs you in on `localhost` / `127.0.0.1` in `astro dev` only. Leave it empty to try the real login. |
| `ADMIN_EMAILS` | the two owner emails, comma-separated (or a test address such as `owner@example.test`) |
| `ADMIN_ALIASES` | optional login aliases, comma-separated `alias=target` pairs: each owner's `@beezyhoney.in` address `=` their Gmail from `ADMIN_EMAILS` (test: `owner-alias@example.test=owner@example.test`) |
| `LOGIN_SECRET` | 64 hex characters (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) |
| `IP_HASH_KEY` | any string (required outside `astro dev`: without it the admin answers 503) |
| `PUBLIC_HOSTS` | `beezyhoney.in,next.beezyhoney.in,localhost,127.0.0.1`: lets `localhost` / `127.0.0.1` act as public and admin host on this computer. `wrangler.jsonc` lists only the real hosts, and `predeploy-check` refuses a Worker config with a local name. |
| `DEPLOY_HOOK_URL` | empty: the admin then shows "Publishing is off on this computer" |

- Your own database: set `BEEZY_STATE_DIR=<folder>` for `npm run dev`, `astro preview` and `scripts/db-local.mjs`
  (they share `<folder>/v3`). `node scripts/db-local.mjs status | reset | exec <file.sql> | sql "<SQL>"`.
- Only one `astro dev` per project at a time (Astro project lock; `--ignore-lock` overrides it).
- Admin: `http://localhost:4321/admin/` (dev bypass). Real host routing: `curl -H "Host: admin.beezyhoney.in" -H "Sec-Fetch-Mode: navigate" …`.
- See admin edits on public pages: `CATALOG_URL=http://localhost:4321/api/catalog.json npm run build`.
- Production-like run: `npm run build`, then `npx astro preview --port 4321 --host 127.0.0.1` (workerd, no dev bypass).
  Fire the cron there: `curl "http://127.0.0.1:4321/cdn-cgi/handler/scheduled?cron=*/15+*+*+*+*"`.
- Login emails in preview and dev go to the `send_email` simulation, which writes each message to a local `.eml` file
  and logs its path.

## 2. Tests and gates

| Command | What it does |
|---|---|
| `npm test` | Vitest: `unit` (Node, `test/unit/**`) and `worker` (workerd with D1, KV and `send_email`, `test/worker/**`) |
| `npm run build` | `sync-catalog` → `astro build` → `check-dist` (fails the build on `/_image`, third-party URLs, files under `dist/client/admin|api|media`, fewer WebP, JS over budget, dev bypass / e2e hook / `.dev.vars` values in the Worker) |
| `npm run build:e2e` | the same with `--mode e2e`: keeps the login-code hook `GET /api/e2e/login-code.json` for browser tests. Never deploy it; rebuild with `npm run build` afterwards. |
| `node scripts/zero-diff.mjs <old dist> <new dist> [--allow …]` | byte comparison of two builds (hashed names normalised) |
| `npm run predeploy-check` | the last gate before `wrangler deploy` (section 4) |

CI (`.github/workflows/ci.yml`) runs `npm test` and `npm run build` on pull requests. Nothing is deployed from CI.

## 3. Cloudflare setup (once, with the owner)

The owner owns the account (2FA on, recovery codes on paper). The developer is an invited member. No card is needed
for anything below. Email Routing on `beezyhoney.in` is **already on**, with both owner addresses verified as destination
addresses (the Worker can only mail verified addresses).

1. **Zone settings** (beezyhoney.in): Web Analytics automatic setup OFF, Rocket Loader OFF, Email Address Obfuscation
   OFF, bot "JavaScript detections" OFF. Keep the GitHub Pages A records and `www` DNS-only until the cutover.
2. **Log in from the repo:** `npx wrangler login`.
3. **D1:** `npx wrangler d1 create beezy`. Put the `database_id` into `wrangler.jsonc` (`d1_databases[0]`).
4. **KV (2 namespaces):** `npx wrangler kv namespace create MEDIA` and `npx wrangler kv namespace create BACKUPS`.
   Put both ids into `wrangler.jsonc` (`kv_namespaces`). `predeploy-check` refuses the all-zero placeholder ids.
5. **Schema and seed (remote):**
   ```sh
   npx wrangler d1 migrations apply beezy --remote
   npx wrangler d1 execute beezy --remote --file db/seed.sql
   ```
   Migrations are additive and applied by hand, always **before** deploying code that needs them.
6. **Workers Builds** (the owner connects GitHub personally: Workers & Pages → Create → Import a repository → this
   repository only). Settings for the Worker `beezyhoney`:
   - build command `npm run build`; deploy command `npm run deploy`; build cache on; non-production branch builds off;
   - production branch: the branch that carries the Worker code (`main` after the cutover);
   - build variables for the **first** deploy: `ALLOW_SNAPSHOT_DEPLOY=1` (D1 is not serving the catalog yet).
     After it: `CATALOG_URL=https://next.beezyhoney.in/api/catalog.json` and remove `ALLOW_SNAPSHOT_DEPLOY`.
   - Create a **deploy hook** for the production branch (Settings → Builds → Deploy hooks). The URL is the secret.
7. **Secrets** (`npx wrangler secret put <NAME>`, value typed at the prompt, never in a file in the repo):
   - `ADMIN_EMAILS`: the two owner emails, comma-separated;
   - `ADMIN_ALIASES` (optional): `alias=target` pairs, comma-separated, e.g. `name@beezyhoney.in=<that owner's Gmail>`.
     The owner then types the alias on the login page; the code is still sent to the Gmail (the verified Email Routing
     destination), and the session, roles and Activity use the Gmail. A pair whose target is not in `ADMIN_EMAILS` (or
     an active helper) is ignored. The alias must also be an Email Routing rule forwarding to that Gmail;
   - `LOGIN_SECRET`: 32 random bytes as 64 hex characters (changing it logs everyone out and voids all codes);
   - `IP_HASH_KEY`: 32 random bytes as hex (required: without it every admin page answers 503);
   - `DEPLOY_HOOK_URL`: the deploy hook URL from step 6.
8. **Custom domains** (Worker → Settings → Domains & Routes → Add custom domain): `next.beezyhoney.in` (public, for the
   rehearsal) and `admin.beezyhoney.in` (admin). Cloudflare creates the DNS records and certificates.
9. **Single Redirect for the admin root** (Rules → Redirect Rules): when hostname equals `admin.beezyhoney.in` and the
   URI path does not start with `/admin`, redirect 302 to `https://admin.beezyhoney.in/admin/`. Without it the static
   home page would show on the admin host.
10. **WAF rate limiting rule** (free, one rule): URI Path equals `/api/orders.json`, counted per IP, more than 10 requests
    in 10 seconds → block for 10 seconds.
11. **Check:** `https://next.beezyhoney.in/api/health.json` shows `{"ok":true,…}`; `https://next.beezyhoney.in/admin/`
    is 404; `https://admin.beezyhoney.in/` goes to the login; an owner email receives a code; Help → Self-check is green.

## 4. Deploying

- Normal: push to the production branch. Workers Builds runs `npm ci`, `npm run build` (reads `CATALOG_URL`) and
  `npm run deploy` (`predeploy-check` then `wrangler deploy`). Owner saves call the deploy hook, so the site rebuilds
  from D1 about 2–5 minutes later (up to about 8 on a cold cache).
- `predeploy-check` refuses: an incomplete dist, an e2e or dev build, files that would shadow Worker routes, a snapshot
  build (unless `ALLOW_SNAPSHOT_DEPLOY=1`), placeholder ids, and a lower `siteVersion` than the live `/build.json`
  (unless `ALLOW_DOWNGRADE=1`).
- Database changes: add `db/migrations/000N_*.sql` (additive only), run `npx wrangler d1 migrations apply beezy --remote`,
  then deploy the code.
- Refresh the committed snapshot from production once a month:
  `npm run catalog:pull -- --from https://beezyhoney.in --save-snapshot`.

## 5. Rehearsal and cutover

1. **Rehearsal** on `next.beezyhoney.in` + `admin.beezyhoney.in` with the production Worker. The owner places test
   orders and takes them through Confirm, Paid, Delivered and Cancel. Mark them as test orders. Before go-live,
   Backup → **Clear test data** removes them (only allowed while `go_live_at` is empty).
2. The owner enters missing prices, runs **Stock → Count all** or adds harvests, fills in business details, and,
   after the legal and GST answers, switches on **Show prices**.
3. **Cutover** (about 15 minutes, early morning IST):
   1. Merge the Worker branch into `main` with a commit that deletes `.github/workflows/deploy.yml` and `CNAME`.
   2. Point Workers Builds at `main`, create a new deploy hook for `main`, `wrangler secret put DEPLOY_HOOK_URL`, delete
      the old hook.
   3. DNS: delete the four GitHub A records and the `www` CNAME; add the custom domain `beezyhoney.in` to the Worker
      (expect a few minutes of downtime); add a proxied `www` record with a Single Redirect 301 to the apex; turn on
      Always Use HTTPS.
   4. Set `CATALOG_URL=https://beezyhoney.in/api/catalog.json` and press **Update website now**.
   5. Smoke checks: `/build.json`, home, shop, a product page with prices, `/shop` → `/shop/`, `/sitemap-index.xml`,
      `/admin/` on the apex is 404, `admin.` asks for the login, one real order from a phone (then **Not a real order**).
   6. Set go-live on the Backup screen.
4. After the 14-day rollback window: unpublish GitHub Pages, remove `next.`, add HSTS.

## 6. When something goes wrong

| Problem | What to do |
|---|---|
| A website update failed ("Update didn't finish") | The previous version stays live. Read the build log in Workers Builds. Fix, then **Update website now** or push. |
| A bad deploy is live | Workers → beezyhoney → Deployments → **Rollback** to the previous version. |
| `/api/catalog.json` broken, builds fail | Emergency snapshot build: `npm run catalog:pull -- --from https://beezyhoney.in --save-snapshot` if the API still answers, commit, then deploy with `CATALOG_SOURCE=snapshot` and `ALLOW_SNAPSHOT_DEPLOY=1`. |
| Cutover rollback (first 14 days) | Remove the apex custom domain, re-add the four GitHub A records and the `www` CNAME (DNS-only). GitHub Pages still holds the last deployment; prices and order recording are off until the next attempt. D1 is untouched. If GitHub shows a certificate error, re-save the custom domain in the Pages settings. |
| Bad data or a wrong edit | The Activity screen shows who changed what. Prices: **Undo** in the price history. Otherwise D1 Time Travel (7 days): `npx wrangler d1 time-travel info beezy`, then `npx wrangler d1 time-travel restore beezy --timestamp <ISO>` (destructive; it prints an undo bookmark). |
| Restore from a backup | Download it (Backup screen, or the owner's monthly file). `node scripts/restore-backup.mjs <file-or-folder> --out <file outside the repo>`, check it, then `npx wrangler d1 execute beezy --remote --file <that file>` (locally: `node scripts/db-local.mjs exec <file>`). |
| Owner cannot log in | Check Email Routing still lists the address as verified; check spam; use a recovery code. Check the secrets exist (`npx wrangler secret list`). A missing `ADMIN_EMAILS` or `LOGIN_SECRET` makes every admin route answer 503. If the `@beezyhoney.in` address does not work but the Gmail does, check its `ADMIN_ALIASES` pair (spelling, and the target must be in `ADMIN_EMAILS`). |
| Add or remove an admin | Owners: change the `ADMIN_EMAILS` secret (removing an email logs it out at once; its `ADMIN_ALIASES` pair then stops working too) and verify a new address in Email Routing. Helpers: admin → People (switching one off ends their sessions at once). |
| Leaked deploy hook | Delete it in Workers Builds, create a new one, `wrangler secret put DEPLOY_HOOK_URL`. A leaked hook can only start builds. |
| Strange order traffic | Admin → Website → **Pause order recording**. WhatsApp still opens for customers. |
| Free-plan limits hit (100k requests/day, D1 daily limits) | Pages keep working with baked prices; orders still open WhatsApp and can be pasted later. Limits reset at 05:30 IST. Escalation: Workers Paid (US$5/month). |
| Self-check red: totals | The weekly reconcile found a cache that differs from the ledger. Investigate before repairing (`runReconcile(db, { repair: true })` from a one-off script). |
