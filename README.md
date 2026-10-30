# wiredhowse-console

WiredHowse Co-op asset console — single text field to create/edit hosted sites
(each with its own GitHub repo) via Claude, gated behind auth.wiredhowse.app SSO,
with custom-domain support. Runs on the Hetzner app server. See `CLAUDE.md`.

## Deploy (Hetzner app server)

```bash
mkdir -p /opt/wiredhowse-console && cd /opt/wiredhowse-console
git clone https://github.com/monk24215/wiredhowse-console.git app
cp app/deploy/hetzner/docker-compose.yml .
cp app/deploy/hetzner/.env.example .env && chmod 600 .env   # fill in
docker compose up -d --build
```

Then add `deploy/hetzner/Caddyfile.snippet` to the Caddy config and reload Caddy.

Update: `cd /opt/wiredhowse-console && git -C app pull && docker compose up -d --build`

## Local dev

```bash
npm install
npm start   # :8080
```
