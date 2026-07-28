# Deploying the Pronto Dashboard to Vercel

The app keeps state (saved dashboards, user sessions, the "Sign in with HavasPronto"
pending-login handshake, and the report cache) that used to live on the local
filesystem. Vercel's serverless functions run on a **read-only, ephemeral**
filesystem that isn't shared between requests, so that state now lives in
**Redis** instead. Everything is wired behind `server/kv.js`: set the Redis env
vars and the whole app uses Redis; leave them empty and it behaves exactly as
before on the local filesystem (so local `npm start` is unchanged).

> Vercel's Git integration only supports GitHub / GitLab.com / Bitbucket Cloud.
> This repo's remote is a **self-hosted** GitLab, so deploy with the **CLI**
> (below), not by importing the Git repo.

## One-time setup

```bash
cd pronto-dashboard
npm install                 # pulls in @upstash/redis (+ ioredis)
npm i -g vercel             # if you don't have the CLI
vercel login
vercel link                 # create a NEW project → this gives you the new App URL
```

## 1. Add a persistent Redis store (Upstash, from the Vercel Marketplace)

Vercel sunset its first-party KV/Postgres; Redis is now a Marketplace integration.

- **Dashboard (reliable):** your project → **Storage** tab → **Add** →
  **Upstash for Redis** → pick a plan/region → **Connect** to this project.
- **CLI alternative:** `vercel install upstash` (run
  `vercel integration add --help` if the slug differs).

Either way, Vercel injects `KV_REST_API_URL` + `KV_REST_API_TOKEN` into the
project's environment automatically. Pull them down so the import script (step 4)
can see them:

```bash
vercel env pull .env        # writes the injected KV_* vars into .env (gitignored)
```

## 2. Set the Pronto environment variables

```bash
vercel env add PRONTO_BASE_URL          # https://havaspronto.com
```

Then choose an access model:

- **Team mode (recommended)** — leave `PRONTO_EMAIL` / `PRONTO_PASSWORD` unset.
  Everyone signs in with their own HavasPronto account ("Sign in with
  HavasPronto"), and results respect each person's Pronto permissions. Nothing
  else to set.
- **Single-identity demo** — set `PRONTO_EMAIL` + `PRONTO_PASSWORD` so the app
  runs as one account. By default (`PRONTO_ENV_FALLBACK=local`) that fallback is
  loopback-only, so on Vercel remote visitors would still see a login screen. For
  a genuinely zero-login shared demo set `PRONTO_ENV_FALLBACK=all` — but note
  **every visitor then shares that one identity**, so only use it for a throwaway
  demo, never for real board data.

`CACHE_DIR` does not need setting — on Vercel it defaults to `/tmp` and the real
state lives in Redis.

## 3. Bundle the shared nav package

The SPA loads the shared `pronto-base` nav/template from `/base`. Its canonical
copy is the sibling `../pronto-base` folder, which lives outside this project and
so isn't uploaded. Vendor a copy into the project before every deploy:

```bash
npm run vendor:base         # copies ../pronto-base → ./pronto-base (uploaded with the deploy)
```

## 4. (Optional) Bring your existing saved dashboards along

If you've built dashboards locally and want them on the deployed app, import the
local `data/dashboards/*.json` docs into Redis (needs the KV_* vars from step 1
in `.env`):

```bash
npm run import:redis
```

## 5. Deploy

```bash
vercel --prod               # prints your new https://<project>.vercel.app URL
```

Open the URL, click **Sign in with HavasPronto**, build a dashboard, and use
**Share** to hand out a link. Saved dashboards, logins, and share links now
persist across requests and cold starts.

---

### Notes / future tidy-ups
- With the current `vercel.json`, every request (including static assets) is
  served by the one Node function. That's fine for a board demo; a later
  optimization is to serve `/public` and `/base` as Vercel static/CDN assets.
- `server/kv.js` is the single storage seam. It also accepts a plain
  `REDIS_URL` (via ioredis) if you ever move to a long-lived VM/Fly/Render host
  instead of serverless.
- Sanity check the storage layer any time with `npm run test:kv` (uses the
  filesystem backend unless `REDIS_URL` / `KV_REST_API_*` are set).
