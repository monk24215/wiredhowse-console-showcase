import express from "express";
import cookieSession from "cookie-session";
import crypto from "node:crypto";
import {
  isConfigured,
  runMigrations,
  resetStaleRunningRequests,
  reserveQuotaSlot,
  createBuildRequest,
  listBuildRequestsForUser,
  getBuildRequestForUser,
  markBuildTornDown,
  setCustomDomain,
  clearCustomDomain,
  getUserAnthropicKey,
  setUserAnthropicKey,
  clearUserAnthropicKey,
  incrementEditCount,
  MAX_EDITS_PER_BUILD,
  getLiveBuildById,
  getLiveBuildByCustomDomain,
  isCustomDomainTaken,
} from "./db.js";
import { TEMPLATES, DEFAULT_TEMPLATE_ID, isValidTemplate } from "./templates.js";
import { startWorker, GITHUB_TOKEN, ANTHROPIC_API_KEY, ANTHROPIC_MODEL } from "./worker.js";
import {
  isHostingConfigured,
  assetHostRouter,
  buildIdFromAssetHost,
  isUnderAssetBaseDomain,
  removeAsset,
  updateAssetFile,
  checkCustomDomain,
  dnsRecordsFor,
  CONSOLE_HOST,
} from "./hosting.js";
import { deleteRepo, putFile, getFileContent, addCollaborator } from "./githubApi.js";
import { generateSiteEdit } from "./contentGenerator.js";

const AUTH_SECRET = process.env.AUTH_SECRET || "";
const AUTH_SERVER = process.env.AUTH_SERVER || "https://auth.wiredhowse.app";
const SESSION_SECRET = process.env.SESSION_SECRET || AUTH_SECRET;
// "For now" fallback for anything not yet a first-class feature in the console — a plain
// mailto link rather than a real form + backend send, since wiring transactional email
// (Resend/SMTP, domain verification) is disproportionate to a suggestions box. Easy to
// upgrade later without changing the UX contract (still "tell us what you need").
const COOKIE_SECURE = process.env.COOKIE_SECURE !== "false";
const DEV_LOGIN_EMAIL = process.env.DEV_LOGIN_EMAIL || "";
const SUGGESTIONS_EMAIL = process.env.SUGGESTIONS_EMAIL || "suggestions@wiredhowse.app";

const app = express();
app.set("trust proxy", 1); // Caddy sits in front; needed for req.protocol/secure cookies

// Resolves a Host header to a live build: default wh-asset-<id> hostname first, then any
// custom domain attached to a build.
async function lookupAssetHost(host) {
  if (!isConfigured()) return null;
  const id = buildIdFromAssetHost(host);
  if (id !== null) return getLiveBuildById(id);
  if (isUnderAssetBaseDomain(host)) return null;
  return getLiveBuildByCustomDomain(host);
}

// Asset sites are served before any console session/auth handling — they're public pages.
app.use(assetHostRouter(lookupAssetHost));

// Caddy on-demand TLS gate: Caddy calls this (over the internal docker network) before
// issuing a certificate for a hostname. 200 = ours, anything else = refuse.
app.get("/internal/tls-ask", async (req, res) => {
  const domain = String(req.query.domain || "").toLowerCase();
  if (!domain) return res.status(400).end();
  if (CONSOLE_HOST && domain === CONSOLE_HOST) return res.status(200).end();
  try {
    const build = await lookupAssetHost(domain);
    return res.status(build ? 200 : 404).end();
  } catch (err) {
    console.error("tls-ask lookup failed:", err.message || err);
    return res.status(503).end();
  }
});

app.use(express.json());

app.use(
  cookieSession({
    name: "wh_console_sess",
    secret: SESSION_SECRET || "dev-only-insecure-secret-do-not-use-in-prod",
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days — matches SESSION_TTL on auth server
  })
);

// Health check stays open — monitoring needs it unauthenticated.
app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    service: "wiredhowse-console",
    section: 3,
    authConfigured: Boolean(AUTH_SECRET),
    dbConfigured: isConfigured(),
    hostingConfigured: isHostingConfigured(),
  });
});

function base64urlToBuffer(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

// Verifies a `_auth_token` issued by auth-wirehowse-app's index.php (jwt_issue in
// _lib.php). Same contract as that repo's _auth/check.php: HMAC-SHA256 over
// "<header>.<body>", base64url-encoded, compared with constant-time equality.
function verifyAuthToken(token) {
  if (!AUTH_SECRET) return null;
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;

  const expectedSig = crypto
    .createHmac("sha256", AUTH_SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(base64urlToBuffer(body).toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return payload;
}

// Auth gate — everything except /healthz requires a session or a valid _auth_token.
app.use((req, res, next) => {
  if (req.path === "/healthz" || req.path === "/internal/tls-ask") return next();

  if (req.session && req.session.auth_user) return next();

  if (req.query._auth_token) {
    const payload = verifyAuthToken(req.query._auth_token);
    if (payload) {
      req.session.auth_user = { email: payload.email, role: payload.role || "user" };
      const clean = new URL(req.originalUrl, `${req.protocol}://${req.get("host")}`);
      clean.searchParams.delete("_auth_token");
      return res.redirect(clean.pathname + clean.search);
    }
    // Bad or expired token — fall through to a fresh login redirect below.
  }

  if (DEV_LOGIN_EMAIL && ["localhost", "127.0.0.1"].includes(req.hostname)) {
    req.session.auth_user = { email: DEV_LOGIN_EMAIL, role: "admin" };
    return next();
  }

  const returnUrl = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
  return res.redirect(`${AUTH_SERVER}/?return=${encodeURIComponent(returnUrl)}`);
});

app.get("/", async (req, res) => {
  const user = req.session.auth_user;
  const dbReady = isConfigured();
  let anthropicKeyConfigured = false;
  if (dbReady) {
    try {
      anthropicKeyConfigured = Boolean(await getUserAnthropicKey(user.email));
    } catch (err) {
      console.error("GET / — could not check user Anthropic key:", err.message || err);
    }
  }

  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WiredHowse Console</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 640px; margin: 10vh auto; padding: 0 1.5rem; color: #1a1a1a; }
    h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
    .status { color: #666; font-size: 0.9rem; margin-bottom: 1rem; }
    input, select, button { font-size: 1rem; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; }
    input, select { width: 100%; padding: 0.75rem; }
    button { padding: 0.6rem 1rem; margin-top: 0.5rem; background: #1a1a1a; color: white; border: none; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .note { color: #888; font-size: 0.8rem; margin-top: 0.5rem; }
    .msg { font-size: 0.85rem; margin-top: 0.75rem; min-height: 1.2em; }
    ul { list-style: none; padding: 0; margin-top: 1.5rem; }
    li { padding: 0.6rem 0; border-bottom: 1px solid #eee; font-size: 0.85rem; }
    .st-queued { color: #b8860b; } .st-running { color: #2a6ef5; } .st-complete { color: #1a7f37; } .st-failed { color: #c22; } .st-deleted { color: #999; }
    a { color: #2a6ef5; }
    .row-actions a { font-size: 0.8rem; margin-left: 0.4rem; }
    .keybox { border: 1px solid #eee; border-radius: 8px; padding: 0.75rem; margin-top: 0.5rem; }
    .footer-note { margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid #eee; font-size: 0.75rem; color: #999; }
  </style>
</head>
<body>
  <h1>WiredHowse Console</h1>
  <div class="status">Signed in as ${user.email} · Section 3 (asset builder) — one template available: ${TEMPLATES[DEFAULT_TEMPLATE_ID].label}.</div>

  <div class="note">
    ${
      anthropicKeyConfigured
        ? 'Generation uses your own Anthropic API key. <a href="#" id="clearKeyLink">Remove it</a> to fall back to the shared key + monthly limits.'
        : 'Generation uses the shared WiredHowse key (subject to monthly limits). <a href="#" id="setKeyLink">Use your own Anthropic API key instead</a>.'
    }
  </div>
  <div class="keybox" id="keyBox" style="display:none;">
    <label for="anthropicKeyInput" style="font-size:0.85rem; font-weight:600;">Anthropic API key</label>
    <input id="anthropicKeyInput" type="password" placeholder="sk-ant-..." autocomplete="off" />
    <button id="saveKeyBtn">Save key</button>
    <div class="note">Stored server-side, never shown again once saved. Get one at console.anthropic.com.</div>
  </div>

  <input id="prompt" type="text" placeholder="Describe the asset you want to build…" ${dbReady ? "" : "disabled"} style="margin-top:1rem;" />
  <button id="submit" ${dbReady ? "" : "disabled"}>Queue build</button>
  <div class="msg" id="msg"></div>
  <div class="note">${dbReady ? "Requests are queued and built one at a time against a fixed template set (quota applies)." : "Database not configured — builder disabled."} <a href="/logout">Sign out</a></div>
  <ul id="jobs"></ul>

  <div class="footer-note">
    Need something that's not here yet? <a href="mailto:${SUGGESTIONS_EMAIL}">Email ${SUGGESTIONS_EMAIL}</a>.
  </div>

  <script>
    const MAX_EDITS = ${MAX_EDITS_PER_BUILD};
    const msgEl = document.getElementById('msg');
    const jobsEl = document.getElementById('jobs');
    const promptEl = document.getElementById('prompt');
    const submitEl = document.getElementById('submit');

    document.getElementById('setKeyLink')?.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById('keyBox').style.display = 'block';
    });
    document.getElementById('saveKeyBtn')?.addEventListener('click', async () => {
      const key = document.getElementById('anthropicKeyInput').value.trim();
      if (!key) return;
      try {
        const res = await fetch('/api/settings/anthropic-key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key }),
        });
        const data = await res.json();
        if (!res.ok) { alert(data.error || 'Could not save key.'); return; }
        location.reload();
      } catch {
        alert('Network error while saving key.');
      }
    });
    document.getElementById('clearKeyLink')?.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!confirm('Remove your Anthropic API key? Future builds will use the shared key and count against monthly limits.')) return;
      try {
        await fetch('/api/settings/anthropic-key', { method: 'DELETE' });
      } catch {}
      location.reload();
    });

    function renderJob(j) {
      const canManage = j.status === 'complete' || j.status === 'failed';
      let actions = '';
      if (canManage) {
        const domainAction = j.status !== 'complete' ? '' : j.custom_domain
          ? '<a href="#" data-domain-status="' + j.id + '">domain status</a> · <a href="#" data-domain-remove="' + j.id + '">remove domain</a>'
          : '<a href="#" data-domain-add="' + j.id + '">+ domain</a>';
        const editCount = j.edit_count || 0;
        const editAction = j.status === 'complete'
          ? ' · <a href="#" data-edit="' + j.id + '">' + (editCount > 0 ? 'more changes (' + editCount + '/' + MAX_EDITS + ')' : 'request changes') + '</a>'
          : '';
        const accessAction = j.status === 'complete' ? ' · <a href="#" data-access="' + j.id + '">repo access</a>' : '';
        actions = '<span class="row-actions">' + domainAction + editAction + accessAction +
          (domainAction ? ' · ' : '') + '<a href="#" data-delete="' + j.id + '">delete</a></span>';
      }
      return '<li><span class="st-' + j.status + '">' + j.status + '</span> — ' + j.prompt +
        (j.live_url ? ' — <a href="' + j.live_url + '" target="_blank">' + j.live_url + '</a>' : '') +
        (j.custom_domain ? ' — custom: ' + j.custom_domain : '') +
        (j.error ? ' — ' + j.error : '') + actions + '</li>';
    }

    async function refresh() {
      try {
        const res = await fetch('/api/builds');
        if (!res.ok) return;
        const jobs = await res.json();
        jobsEl.innerHTML = jobs.map(renderJob).join('');
      } catch {}
    }

    jobsEl?.addEventListener('click', async (e) => {
      const delId = e.target.getAttribute('data-delete');
      const domAddId = e.target.getAttribute('data-domain-add');
      const domStatusId = e.target.getAttribute('data-domain-status');
      const domRemoveId = e.target.getAttribute('data-domain-remove');
      const editId = e.target.getAttribute('data-edit');
      const accessId = e.target.getAttribute('data-access');

      if (delId) {
        e.preventDefault();
        if (!confirm('Delete this asset? This permanently removes the GitHub repo and the hosted site — it cannot be undone.')) return;
        try {
          const res = await fetch('/api/builds/' + delId, { method: 'DELETE' });
          const data = await res.json();
          if (!res.ok) {
            alert((data.error || 'Delete failed.') + (data.notes ? '\\n\\n' + data.notes.join('\\n') : ''));
          } else if (data.notes && data.notes.length) {
            alert('Deleted, with notes:\\n' + data.notes.join('\\n'));
          }
        } catch {
          alert('Network error while deleting.');
        }
        refresh();
      } else if (domAddId) {
        e.preventDefault();
        const domain = prompt('Custom domain to point at this asset (e.g. sub.yourdomain.com):');
        if (!domain) return;
        try {
          const res = await fetch('/api/builds/' + domAddId + '/domain', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domain }),
          });
          const data = await res.json();
          if (!res.ok) {
            alert(data.error || 'Could not add domain.');
          } else {
            const recs = (data.dnsRecords || [])
              .map((r) => r.hostlabel + '  ' + (r.type || 'CNAME') + '  ->  ' + r.requiredValue)
              .join('\\n');
            alert(
              'Domain added: ' + data.domain + '\\n\\nAdd this DNS record with your DNS provider:\\n' + recs +
              '\\n\\nIf the domain is on Cloudflare, set the record to DNS only (grey cloud).' +
              '\\nDNS changes can take up to 72 hours to propagate. HTTPS is issued automatically once DNS resolves.'
            );
          }
        } catch {
          alert('Network error while adding domain.');
        }
        refresh();
      } else if (domStatusId) {
        e.preventDefault();
        try {
          const res = await fetch('/api/builds/' + domStatusId + '/domain');
          const data = await res.json();
          if (!res.ok) { alert(data.error || 'Could not check domain status.'); return; }
          const recs = (data.dnsRecords || [])
            .map((r) => r.hostlabel + '  ' + (r.type || 'CNAME') + '  ->  ' + (r.requiredValue || '') + '  [' + (r.status || 'pending') + ']' +
              (r.currentValue ? '  (currently ' + r.currentValue + ')' : ''))
            .join('\\n');
          alert(
            'Domain: ' + data.domain + '\\nCertificate: ' + (data.certificateStatus || 'pending') +
            '\\n\\nDNS records:\\n' + (recs || '(none)')
          );
        } catch {
          alert('Network error while checking domain status.');
        }
      } else if (domRemoveId) {
        e.preventDefault();
        if (!confirm('Remove this custom domain? The asset stays live on its default URL.')) return;
        try {
          const res = await fetch('/api/builds/' + domRemoveId + '/domain', { method: 'DELETE' });
          const data = await res.json();
          if (!res.ok) alert(data.error || 'Could not remove domain.');
        } catch {
          alert('Network error while removing domain.');
        }
        refresh();
      } else if (editId) {
        e.preventDefault();
        const instructions = prompt('What should change about this site?');
        if (!instructions) return;
        const original = e.target.textContent;
        e.target.textContent = 'Applying…';
        try {
          const res = await fetch('/api/builds/' + editId + '/edit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instructions }),
          });
          const data = await res.json();
          if (!res.ok) {
            alert(data.error || 'Could not apply changes.');
            e.target.textContent = original;
          } else {
            alert('Changes applied — the live site is redeploying now, give it a minute.');
          }
        } catch {
          alert('Network error while requesting changes.');
          e.target.textContent = original;
        }
        refresh();
      } else if (accessId) {
        e.preventDefault();
        const username = prompt('Your GitHub username (not email) — you\\'ll be invited as a collaborator on this asset\\'s repo:');
        if (!username) return;
        try {
          const res = await fetch('/api/builds/' + accessId + '/github-access', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ githubUsername: username }),
          });
          const data = await res.json();
          if (!res.ok) {
            alert(data.error || 'Could not send the invite.');
          } else {
            alert('Invited — check GitHub (or your email) for an invite to ' + data.repo + '.');
          }
        } catch {
          alert('Network error while requesting repo access.');
        }
      }
    });

    submitEl?.addEventListener('click', async () => {
      const prompt = promptEl.value.trim();
      if (!prompt) return;
      submitEl.disabled = true;
      msgEl.textContent = 'Queuing…';
      try {
        const res = await fetch('/api/builds', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt }),
        });
        const data = await res.json();
        if (!res.ok) {
          msgEl.textContent = data.error || 'Could not queue build.';
        } else {
          msgEl.textContent = 'Queued (build ' + data.used + ' of ' + data.limit + ' this month).';
          promptEl.value = '';
          refresh();
        }
      } catch {
        msgEl.textContent = 'Network error.';
      } finally {
        submitEl.disabled = false;
      }
    });

    if (${dbReady ? "true" : "false"}) {
      refresh();
      setInterval(refresh, 5000);
    }
  </script>
</body>
</html>`);
});

app.get("/api/builds", async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: "Database not configured." });
  const jobs = await listBuildRequestsForUser(req.session.auth_user.email);
  res.json(jobs);
});

app.post("/api/builds", async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: "Database not configured." });
  const prompt = String(req.body?.prompt || "").trim().slice(0, 500);
  if (!prompt) return res.status(400).json({ error: "Prompt is required." });

  const templateId = isValidTemplate(req.body?.templateId) ? req.body.templateId : DEFAULT_TEMPLATE_ID;
  const userEmail = req.session.auth_user.email;

  try {
    const quota = await reserveQuotaSlot(userEmail);
    if (!quota.allowed) {
      return res.status(429).json({
        error: `Monthly build limit reached (${quota.used}/${quota.limit}). Try again next month.`,
      });
    }
    const job = await createBuildRequest({ userEmail, prompt, templateId });
    res.status(201).json({ ...job, used: quota.used, limit: quota.limit });
  } catch (err) {
    console.error("POST /api/builds failed:", err);
    res.status(500).json({ error: "Could not queue build." });
  }
});

// Teardown: deletes the GitHub repo + hosted files behind a completed (or failed, in
// case it left partial infra behind) build. Scoped to the requesting user's own builds via
// getBuildRequestForUser. Best-effort per side (hosted files / GitHub) so a failure on one
// doesn't block cleanup of the other or hide which one needs manual attention — only
// marks the row 'deleted' once both sides have either succeeded or had nothing to do.
app.delete("/api/builds/:id", async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: "Database not configured." });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid build id." });

  const job = await getBuildRequestForUser(id, req.session.auth_user.email);
  if (!job) return res.status(404).json({ error: "Build not found." });
  if (job.status === "queued" || job.status === "running") {
    return res.status(409).json({ error: "This build is still in progress — wait for it to finish before deleting." });
  }
  if (job.status === "deleted") {
    return res.status(409).json({ error: "This asset has already been deleted." });
  }

  const notes = [];
  let hostingFailed = false;
  let githubFailed = false;

  try {
    await removeAsset(id);
  } catch (err) {
    hostingFailed = true;
    notes.push(`Hosting: ${err.message || err}`);
  }

  if (job.github_owner && job.github_repo) {
    if (!GITHUB_TOKEN) {
      githubFailed = true;
      notes.push("GitHub: GITHUB_TOKEN not configured — could not delete the repo.");
    } else {
      try {
        await deleteRepo(GITHUB_TOKEN, job.github_owner, job.github_repo);
      } catch (err) {
        githubFailed = true;
        notes.push(`GitHub: ${err.message || err}`);
      }
    }
  } else {
    notes.push("GitHub: no repo recorded for this build (it predates infra tracking) — remove it manually.");
  }

  if (hostingFailed || githubFailed) {
    // Leave status as-is so this stays safely retryable rather than claiming "deleted"
    // while something real still exists.
    return res.status(502).json({ error: "Teardown incomplete — see notes.", notes });
  }

  await markBuildTornDown(id, notes.length ? notes.join(" | ") : null);
  res.json({ ok: true, notes });
});

// Attaches a custom domain to a completed build. Hosting is on this server behind Caddy,
// so "attaching" is just recording the domain: once the user's DNS points here, the host
// router serves it and Caddy's on-demand TLS issues the certificate on first request.
app.post("/api/builds/:id/domain", async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: "Database not configured." });
  if (!isHostingConfigured()) return res.status(503).json({ error: "Hosting not configured." });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid build id." });
  const domain = String(req.body?.domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (!domain) return res.status(400).json({ error: "Domain is required." });
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
    return res.status(400).json({ error: "That doesn't look like a valid domain name." });
  }
  if (domain === CONSOLE_HOST || isUnderAssetBaseDomain(domain)) {
    return res.status(400).json({ error: "That domain is reserved." });
  }

  const job = await getBuildRequestForUser(id, req.session.auth_user.email);
  if (!job) return res.status(404).json({ error: "Build not found." });
  if (job.status !== "complete") return res.status(409).json({ error: "Only live builds can have a domain." });

  try {
    if (await isCustomDomainTaken(domain, id)) {
      return res.status(409).json({ error: "That domain is already attached to another asset." });
    }
    await setCustomDomain(id, { domain, customDomainId: null });
    res.status(201).json({ ok: true, domain, dnsRecords: dnsRecordsFor(domain, id) });
  } catch (err) {
    res.status(502).json({ error: err.message || String(err) });
  }
});

// Live DNS/certificate status for a build's custom domain.
app.get("/api/builds/:id/domain", async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: "Database not configured." });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid build id." });

  const job = await getBuildRequestForUser(id, req.session.auth_user.email);
  if (!job) return res.status(404).json({ error: "Build not found." });
  if (!job.custom_domain) return res.status(404).json({ error: "No custom domain set for this build." });

  try {
    res.json(await checkCustomDomain(job.custom_domain, id));
  } catch (err) {
    res.status(502).json({ error: err.message || String(err) });
  }
});

app.delete("/api/builds/:id/domain", async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: "Database not configured." });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid build id." });

  const job = await getBuildRequestForUser(id, req.session.auth_user.email);
  if (!job) return res.status(404).json({ error: "Build not found." });
  if (!job.custom_domain) return res.status(404).json({ error: "No custom domain set for this build." });

  await clearCustomDomain(id);
  res.json({ ok: true });
});

// "Request changes" — regenerates a completed build's page from its original prompt +
// its current live HTML + new instructions, pushes it to the asset's repo, and writes it
// to the hosted copy (no new repo, no new hostname — this edits the SAME asset in place). Runs synchronously rather than through the build
// queue since there's no infra to provision, just one model call + one file push.
// Capped at MAX_EDITS_PER_BUILD so this can't become an unbounded free-generation loop
// on the shared Anthropic key.
app.post("/api/builds/:id/edit", async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: "Database not configured." });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid build id." });
  const instructions = String(req.body?.instructions || "").trim().slice(0, 500);
  if (!instructions) return res.status(400).json({ error: "Describe what should change." });

  const job = await getBuildRequestForUser(id, req.session.auth_user.email);
  if (!job) return res.status(404).json({ error: "Build not found." });
  if (job.status !== "complete") return res.status(409).json({ error: "Only completed builds can be edited." });
  if (!job.github_owner || !job.github_repo) {
    return res.status(409).json({ error: "This build predates edit support and can't be edited automatically." });
  }
  if ((job.edit_count || 0) >= MAX_EDITS_PER_BUILD) {
    return res.status(429).json({
      error: `This asset has reached its edit limit (${MAX_EDITS_PER_BUILD}). Delete and rebuild for further changes.`,
    });
  }
  if (!GITHUB_TOKEN) return res.status(503).json({ error: "GitHub credentials not configured." });

  let effectiveKey;
  try {
    const userKey = await getUserAnthropicKey(req.session.auth_user.email);
    effectiveKey = userKey || ANTHROPIC_API_KEY;
  } catch (err) {
    console.error(`POST /api/builds/${id}/edit — could not resolve Anthropic key:`, err.message || err);
  }
  if (!effectiveKey) return res.status(503).json({ error: "No Anthropic API key configured (shared or your own)." });

  try {
    const currentHtml = await getFileContent(GITHUB_TOKEN, job.github_owner, job.github_repo, "public/index.html");
    if (!currentHtml) {
      return res.status(409).json({ error: "Could not read the current live page — nothing to edit from." });
    }
    const revised = await generateSiteEdit(effectiveKey, ANTHROPIC_MODEL, job.prompt, currentHtml, instructions);
    await putFile(GITHUB_TOKEN, job.github_owner, job.github_repo, "public/index.html", revised, `Edit: ${instructions.slice(0, 72)}`);
    await updateAssetFile(id, "public/index.html", revised);
    const editCount = await incrementEditCount(id);
    res.json({ ok: true, editCount });
  } catch (err) {
    res.status(502).json({ error: err.message || String(err) });
  }
});

// Invites the requesting user's own GitHub account as a collaborator on their asset's
// repo — the real, working equivalent of "give them a token to their repo" (GitHub's API
// has no way to mint a PAT on another account's behalf; a collaborator invite accepted
// under their own login is the actual mechanism that hands over independent access).
app.post("/api/builds/:id/github-access", async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: "Database not configured." });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid build id." });
  const githubUsername = String(req.body?.githubUsername || "").trim();
  if (!githubUsername) return res.status(400).json({ error: "GitHub username is required." });

  const job = await getBuildRequestForUser(id, req.session.auth_user.email);
  if (!job) return res.status(404).json({ error: "Build not found." });
  if (!job.github_owner || !job.github_repo) {
    return res.status(409).json({ error: "No repo recorded for this build." });
  }
  if (!GITHUB_TOKEN) return res.status(503).json({ error: "GitHub credentials not configured." });

  try {
    await addCollaborator(GITHUB_TOKEN, job.github_owner, job.github_repo, githubUsername);
    res.json({ ok: true, repo: `${job.github_owner}/${job.github_repo}` });
  } catch (err) {
    res.status(502).json({ error: err.message || String(err) });
  }
});

// --- Bring-your-own Anthropic key ---

app.post("/api/settings/anthropic-key", async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: "Database not configured." });
  const key = String(req.body?.key || "").trim();
  if (!key || !key.startsWith("sk-ant-")) {
    return res.status(400).json({ error: "That doesn't look like an Anthropic API key (should start with sk-ant-)." });
  }
  try {
    await setUserAnthropicKey(req.session.auth_user.email, key);
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/settings/anthropic-key failed:", err.message || err);
    res.status(500).json({ error: "Could not save key." });
  }
});

app.delete("/api/settings/anthropic-key", async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: "Database not configured." });
  try {
    await clearUserAnthropicKey(req.session.auth_user.email);
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/settings/anthropic-key failed:", err.message || err);
    res.status(500).json({ error: "Could not remove key." });
  }
});

app.get("/logout", (req, res) => {
  req.session = null;
  res.redirect(`${AUTH_SERVER}/logout.php`);
});

const port = process.env.PORT || 8080;

runMigrations()
  .then(() => resetStaleRunningRequests())
  .catch((err) => console.error("Migration/startup error:", err))
  .finally(() => {
    startWorker();
    app.listen(port, () => {
      console.log(`wiredhowse-console listening on ${port}`);
    });
  });
