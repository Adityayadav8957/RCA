# 08 · Deploying for free, and keeping it safe

← [Back to README](../README.md)

## Two ways to run this project

| | **Real mode** (`npm start`) | **Simulation mode** (the hosted demo) |
|---|---|---|
| Services, Postgres, Redis | Real processes and real databases (Docker) | A simulator inside your browser tab |
| Analysis engine | The real engine | **The same engine code**, bundled for the browser |
| Dashboard | `dashboard/index.html` | The same file, plus a `Simulated` badge |
| Needs a server? | Yes: 6 processes + 2 databases | **No**: static files only |
| Cost to host | Not free-friendly (always-on processes) | **Free** on any static host |

The simulation produces the same *shape* of telemetry as the real services (spans with parent/child links, `db.system`
attributes, access logs with trace ids), and the real `analyze.ts` runs on it unchanged. The dashboard's calls to `/api/...`
are answered in the browser by the same API code the Node engine uses ([src/rca/api.ts](../src/rca/api.ts)).

What it proves and what it doesn't: it demonstrates the **detection and ranking logic and the UI**. The accuracy numbers in
[04](04-chaos-and-evaluation.md) come from real mode, not from the simulator.

## Build and preview the demo

```bash
npm run build:demo        # writes ./demo  (index.html, sim.js, _headers)
npm run demo              # builds, then serves http://127.0.0.1:8080
```

## Deploy to Cloudflare Pages (free)

Static hosting is free on Cloudflare. Two ways:

**A. Connect the GitHub repo (recommended; auto-deploys on every push).** In the Cloudflare dashboard: *Workers & Pages → Create → Pages →
Connect to Git*, pick the repo, then set **Build command** `npm ci && npm run build:demo` and **Build output directory** `demo`.

**B. From your terminal.**

```bash
npm run build:demo
export CLOUDFLARE_ACCOUNT_ID=...   # from the Cloudflare dashboard
export CLOUDFLARE_API_TOKEN=...    # an API token with "Cloudflare Pages: Edit"
npx wrangler pages deploy demo --project-name microservice-rca
```

Never commit the token or put it in a file in the repo. Create a token limited to Pages, and delete it when you are done.

Other free static hosts work the same way: GitHub Pages, Netlify, Vercel (output folder `demo`).

## Why a visitor to the hosted demo cannot exploit anything

The hosted demo is **only static files**. Everything a visitor does happens inside their own browser tab:

* **No backend.** There is no server, database, API or secret to attack. `/api/...` does not exist on the host; the browser answers those calls itself.
* **Fault injection only affects the visitor's own tab.** Breaking "Payments" changes a variable in that visitor's page. It cannot affect you or any other visitor.
* **No data goes anywhere.** Nothing is sent to a server; refreshing the page resets everything.
* **No credentials in the bundle.** The build contains only the dashboard and the simulator.
* **Hardening headers** ([scripts/headers.txt](../scripts/headers.txt), published as `_headers`): a Content-Security-Policy that only allows the page's own
  scripts, styles and requests (`default-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and a locked-down `Permissions-Policy`. The page keeps inline scripts and styles
  (`'unsafe-inline'`), because it is a single file; the CSP still blocks loading anything from other origins.
* **Output is escaped.** Log text, service names and search input are HTML-escaped before they are drawn, so text in a log line can't inject markup.

## If you run real mode where other people can reach it

Real mode is a **local demo**, and it is safe by default:

| Protection | Default |
|---|---|
| The engine and all 5 services listen on `127.0.0.1` only | on (set `HOST` to change the engine's bind address) |
| Postgres and Redis are published on `127.0.0.1` only | on (`docker-compose.yml`). Their demo passwords are weak and Redis has `DEBUG` enabled, so **never expose them** |
| `READ_ONLY=1` | optional: the dashboard can look but not change anything (no faults, traffic, sampling or reset) |
| `INGEST_TOKEN=secret` | optional: telemetry pushes (`/v1/*`, `/ingest/*`) must send `Authorization: Bearer secret` |

If you ever share real mode through a tunnel, **start it with `READ_ONLY=1`**, otherwise anyone with the link can break your
services and rewrite your database's fault setting. For a link to show people, prefer the hosted simulation.
