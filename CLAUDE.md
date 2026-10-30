# CLAUDE.md

Context file for Claude sessions on this repo. Read this first, every session.

## What this is

`wiredhowse-console` — the WiredHowse Co-op asset console. A web interface
where users create/edit hosted + GitHub assets from a single text field
(Claude-driven), gated behind login, and manage DNS/domains for what they
build. Full spec lives in the "Service Integration" Claude project (docs:
"Project WiredHowse Co-op.md", "Repo and Project Links"; Operations Log.md
tracks session-by-session status — read it first).

## Hosting — Hetzner (Railway retired 2026-10)

Railway is no longer used. Do not use any Railway connector/tool for this project.

- Runs on the Hetzner app server `services.defendsurviveprepare.com` (<SERVER_IP>)
  at `/opt/wiredhowse-console` via `deploy/hetzner/docker-compose.yml`: the console
  container + its own bundled Postgres (same pattern as `/opt/listmonk`).
- The existing Caddy (`/opt/claude-railway-showcase/Caddyfile`, network
  `claude-railway-showcase_default`) proxies to `wiredhowse-console:8080`. See
  `deploy/hetzner/Caddyfile.snippet`.
- Assets are no longer separate deployments. `hosting.js` writes each build's
  `public/` files to `ASSETS_DIR/<id>/` and the console serves them by Host header:
  `wh-asset-<id>.<ASSET_BASE_DOMAIN>` (wildcard DNS) plus any custom domain on the
  build. Caddy on-demand TLS issues certs, gated by `GET /internal/tls-ask`.
- GitHub repo per asset (org `wirehouseworkers`) is unchanged — source of record;
  edits are pushed to the repo AND written to the hosted copy.
- The Railway-era `railway_*` / `custom_domain_id` DB columns are left in place
  but no longer written.
- `combined/` is the old Railway+GitHub MCP server — not part of the console runtime.

## Strategy (from the project brief — follow this)

Work is cut into small, gated sections. Each section ends with a
verification step and a summary note logged to the project's
Operations Log. Every session starts by checking that log for what
was last verified and what's next before doing anything else.

## Section status

- [x] Section 1 — scaffold: minimal Express app, publicly reachable,
      `/healthz` responding. (Originally on Railway; now Hetzner.)
- [x] Section 2 — auth (pivoted from the original plan): NOT
      wiredhowse-magic-link. That product is for third-party Site
      Owners and its signup is a manual web-dashboard flow — Claude
      doesn't create accounts or enter passwords, so it was a dead
      end for an unattended build. Instead this app is gated behind
      the existing internal SSO, `auth-wirehowse-app`
      (auth.wiredhowse.app), the same JWT-redirect flow used by the
      rest of the WiredHowse app suite (see that repo's README and
      `_auth/check.php`). Implemented in `server.js`: unauthenticated
      requests redirect to `${AUTH_SERVER}/?return=<url>`; on return,
      `_auth_token` is HMAC-SHA256 verified (same algorithm as
      `_auth/check.php`) and a local session cookie is set via
      `cookie-session`.
  - `auth-wirehowse-app`'s `config.php` `ALLOWED_DOMAINS` had
    `up.railway.app` added for the Railway era — remove it now that the
    console runs on `CONSOLE_HOST` (a `*.wiredhowse.app` hostname).
- [x] Section 3 — asset builder: queue + monthly quota, worker (concurrency 1),
      Anthropic-generated `public/index.html`, GitHub repo per asset, hosted on
      this server (see Hosting above). Request-changes edits, bring-your-own
      Anthropic key, collaborator repo access, teardown.
- [x] Section 4 — custom domains: user adds CNAME (or A for apex) to the asset
      host; `GET /api/builds/:id/domain` checks DNS + HTTPS.
- [ ] Section 5 — cost estimation (per app / per user / owner total).

## Stack

Node 20, Express, `cookie-session` for the session cookie, `pg` for
Postgres (pool in `db.js`), single Dockerfile. `db.js` / `templates.js`
/ `worker.js` / `hosting.js` / `contentGenerator.js` / `githubApi.js`.
