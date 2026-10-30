import pg from "pg";

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL || "";

// Pool is created lazily/tolerantly — if DATABASE_URL isn't set (e.g. a future
// preview environment without the DB wired up yet), the app should still boot;
// every query call site checks isConfigured() first.
export const pool = connectionString
  ? new Pool({ connectionString, max: 5, idleTimeoutMillis: 30000 })
  : null;

export function isConfigured() {
  return Boolean(pool);
}

const MONTHLY_BUILD_LIMIT = Number(process.env.MONTHLY_BUILD_LIMIT || 3);
// Caps the "request changes" loop per asset so bring-your-own-prompt iteration can't
// become an unbounded free-generation channel on the shared Anthropic key. Separate from
// the monthly build quota since an edit doesn't provision any new infra — it's cheap
// compared to a full build, but still a real API call and still needs a ceiling.
export const MAX_EDITS_PER_BUILD = Number(process.env.MAX_EDITS_PER_BUILD || 5);

export async function runMigrations() {
  if (!pool) {
    console.warn("DATABASE_URL not set — skipping migrations, DB features disabled.");
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS build_requests (
      id SERIAL PRIMARY KEY,
      user_email TEXT NOT NULL,
      prompt TEXT NOT NULL,
      template_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      live_url TEXT,
      repo_url TEXT,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_build_requests_status ON build_requests(status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_build_requests_user ON build_requests(user_email);`);

  // Teardown (delete-asset) and custom-domain support both need to find the actual
  // Railway/GitHub objects a build produced — which up to now were only ever encoded
  // inside the human-readable live_url/repo_url strings, never stored as IDs. Added
  // via ALTER ... IF NOT EXISTS so this stays safe to run against rows created before
  // this migration existed; those older rows simply keep these columns NULL (teardown
  // handles that case explicitly — see markBuildTornDown callers in server.js).
  await pool.query(`ALTER TABLE build_requests ADD COLUMN IF NOT EXISTS railway_project_id TEXT;`);
  await pool.query(`ALTER TABLE build_requests ADD COLUMN IF NOT EXISTS railway_service_id TEXT;`);
  await pool.query(`ALTER TABLE build_requests ADD COLUMN IF NOT EXISTS railway_environment_id TEXT;`);
  await pool.query(`ALTER TABLE build_requests ADD COLUMN IF NOT EXISTS github_owner TEXT;`);
  await pool.query(`ALTER TABLE build_requests ADD COLUMN IF NOT EXISTS github_repo TEXT;`);
  await pool.query(`ALTER TABLE build_requests ADD COLUMN IF NOT EXISTS custom_domain TEXT;`);
  await pool.query(`ALTER TABLE build_requests ADD COLUMN IF NOT EXISTS custom_domain_id TEXT;`);
  // Tracks how many "request changes" edits have been applied to this asset, so the cap
  // in MAX_EDITS_PER_BUILD can actually be enforced instead of trusted client-side.
  await pool.query(`ALTER TABLE build_requests ADD COLUMN IF NOT EXISTS edit_count INTEGER NOT NULL DEFAULT 0;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_quota (
      user_email TEXT NOT NULL,
      month TEXT NOT NULL,
      builds_used INTEGER NOT NULL DEFAULT 0,
      builds_limit INTEGER NOT NULL DEFAULT ${MONTHLY_BUILD_LIMIT},
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_email, month)
    );
  `);

  // Bring-your-own-key support: a user can supply their own Anthropic API key so their
  // generation usage bills to them instead of the shared key, and isn't bounded by
  // MONTHLY_BUILD_LIMIT. Stored as plaintext — there's no app-level encryption-at-rest
  // infra here yet, only Railway's underlying disk encryption — so this trades a little
  // security posture for shipping the feature now; the key is never echoed back to the
  // browser once saved (the UI only ever learns whether one is configured, not its value).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_email TEXT PRIMARY KEY,
      anthropic_api_key TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Host-header routing (hosting.js) looks builds up by custom domain on every asset
  // request; also keeps one domain from being attached to two builds.
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_build_requests_custom_domain ON build_requests(lower(custom_domain)) WHERE custom_domain IS NOT NULL;`
  );

  console.log("DB migrations applied (build_requests, user_quota, user_settings).");
}

function currentMonth() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Atomically checks + reserves one build slot for this user this month.
// Returns { allowed: true, used, limit } or { allowed: false, used, limit }.
export async function reserveQuotaSlot(userEmail) {
  const month = currentMonth();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO user_quota (user_email, month, builds_used, builds_limit)
       VALUES ($1, $2, 0, ${MONTHLY_BUILD_LIMIT})
       ON CONFLICT (user_email, month) DO UPDATE SET updated_at = now(), builds_limit = ${MONTHLY_BUILD_LIMIT}
       RETURNING builds_used, builds_limit;`,
      [userEmail, month]
    );
    const { builds_used, builds_limit } = rows[0];
    if (builds_used >= builds_limit) {
      await client.query("ROLLBACK");
      return { allowed: false, used: builds_used, limit: builds_limit };
    }
    await client.query(
      `UPDATE user_quota SET builds_used = builds_used + 1, updated_at = now()
       WHERE user_email = $1 AND month = $2;`,
      [userEmail, month]
    );
    await client.query("COMMIT");
    return { allowed: true, used: builds_used + 1, limit: builds_limit };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function createBuildRequest({ userEmail, prompt, templateId }) {
  const { rows } = await pool.query(
    `INSERT INTO build_requests (user_email, prompt, template_id, status)
     VALUES ($1, $2, $3, 'queued')
     RETURNING id, user_email, prompt, template_id, status, live_url, repo_url, error, created_at, updated_at;`,
    [userEmail, prompt, templateId]
  );
  return rows[0];
}

export async function listBuildRequestsForUser(userEmail, limit = 20) {
  const { rows } = await pool.query(
    `SELECT id, prompt, template_id, status, live_url, repo_url, error,
            railway_project_id, railway_service_id, railway_environment_id,
            github_owner, github_repo, custom_domain, custom_domain_id, edit_count,
            created_at, updated_at
     FROM build_requests WHERE user_email = $1
     ORDER BY id DESC LIMIT $2;`,
    [userEmail, limit]
  );
  return rows;
}

// Scoped to the requesting user's own email so one user can never look up or act on
// another user's build by guessing an id — every teardown/domain/edit/access route below
// calls this instead of a bare "SELECT ... WHERE id = $1".
export async function getBuildRequestForUser(id, userEmail) {
  const { rows } = await pool.query(
    `SELECT id, user_email, prompt, template_id, status, live_url, repo_url, error,
            railway_project_id, railway_service_id, railway_environment_id,
            github_owner, github_repo, custom_domain, custom_domain_id, edit_count,
            created_at, updated_at
     FROM build_requests WHERE id = $1 AND user_email = $2;`,
    [id, userEmail]
  );
  return rows[0] || null;
}

// Concurrency cap of 1 means the worker refuses to claim anything new while a row is
// 'running' — but a row can only legitimately be 'running' while THIS process's worker
// loop is mid-execution on it. Every redeploy kills the container and any in-flight job
// with it, leaving that row stuck at 'running' forever with nothing left alive to finish
// or fail it — which permanently jams the entire queue for every user, silently, since
// claimNextQueuedRequest just returns null and looks like "no work to do". Call this once
// at boot, before the worker loop starts: any 'running' row at that point is definitionally
// orphaned (this fresh process has done nothing yet), so put it back in the queue.
export async function resetStaleRunningRequests() {
  const { rows } = await pool.query(
    `UPDATE build_requests SET status = 'queued', error = 'Requeued after service restart interrupted this build.', updated_at = now()
     WHERE status = 'running'
     RETURNING id;`
  );
  if (rows.length > 0) {
    console.warn(`db: requeued ${rows.length} stale 'running' build request(s) after restart: ${rows.map((r) => r.id).join(", ")}`);
  }
  return rows.length;
}

export async function claimNextQueuedRequest() {
  // Concurrency cap of 1: never claim a new job while one is already running.
  const { rows: runningRows } = await pool.query(
    `SELECT id FROM build_requests WHERE status = 'running' LIMIT 1;`
  );
  if (runningRows.length > 0) return null;

  const { rows } = await pool.query(
    `UPDATE build_requests SET status = 'running', updated_at = now()
     WHERE id = (
       SELECT id FROM build_requests WHERE status = 'queued' ORDER BY id ASC LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     RETURNING id, user_email, prompt, template_id, status, created_at;`
  );
  return rows[0] || null;
}

// Now also records the actual Railway/GitHub object IDs behind live_url/repo_url —
// needed so a later "delete this asset" or "add a custom domain" request can act on
// the right project/service/repo instead of trying to reparse them out of URL strings.
export async function completeBuildRequest(
  id,
  { liveUrl, repoUrl, railwayProjectId, railwayServiceId, railwayEnvironmentId, githubOwner, githubRepo }
) {
  await pool.query(
    `UPDATE build_requests
     SET status = 'complete', live_url = $2, repo_url = $3,
         railway_project_id = $4, railway_service_id = $5, railway_environment_id = $6,
         github_owner = $7, github_repo = $8, updated_at = now()
     WHERE id = $1;`,
    [
      id,
      liveUrl,
      repoUrl,
      railwayProjectId || null,
      railwayServiceId || null,
      railwayEnvironmentId || null,
      githubOwner || null,
      githubRepo || null,
    ]
  );
}

export async function failBuildRequest(id, errorMessage) {
  await pool.query(
    `UPDATE build_requests SET status = 'failed', error = $2, updated_at = now() WHERE id = $1;`,
    [id, String(errorMessage).slice(0, 2000)]
  );
}

// For transient, retryable failures (e.g. Railway's project-creation rate limit) — sends
// the job back to the queue instead of burning the user's quota slot on a permanent fail.
export async function requeueBuildRequest(id, note) {
  await pool.query(
    `UPDATE build_requests SET status = 'queued', error = $2, updated_at = now() WHERE id = $1;`,
    [id, String(note).slice(0, 2000)]
  );
}

// Marks a build as torn down after its GitHub repo / Railway project have been deleted
// (or a best-effort attempt was made — `note` records anything that couldn't be cleaned
// up automatically, e.g. a pre-migration row with no stored infra IDs). Clears live_url
// and any custom domain since neither points at anything real anymore.
export async function markBuildTornDown(id, note) {
  await pool.query(
    `UPDATE build_requests
     SET status = 'deleted', live_url = NULL, custom_domain = NULL, custom_domain_id = NULL,
         error = $2, updated_at = now()
     WHERE id = $1;`,
    [id, note ? String(note).slice(0, 2000) : null]
  );
}

export async function setCustomDomain(id, { domain, customDomainId }) {
  await pool.query(
    `UPDATE build_requests SET custom_domain = $2, custom_domain_id = $3, updated_at = now() WHERE id = $1;`,
    [id, domain, customDomainId]
  );
}

export async function clearCustomDomain(id) {
  await pool.query(
    `UPDATE build_requests SET custom_domain = NULL, custom_domain_id = NULL, updated_at = now() WHERE id = $1;`,
    [id]
  );
}

// Bumps and returns the new edit_count for a build. Called only after a "request
// changes" edit has actually been pushed successfully — a failed generation/push never
// consumes part of the cap.
export async function incrementEditCount(id) {
  const { rows } = await pool.query(
    `UPDATE build_requests SET edit_count = edit_count + 1, updated_at = now() WHERE id = $1 RETURNING edit_count;`,
    [id]
  );
  return rows[0]?.edit_count ?? null;
}

// --- Bring-your-own Anthropic key ---

export async function getUserAnthropicKey(userEmail) {
  const { rows } = await pool.query(
    `SELECT anthropic_api_key FROM user_settings WHERE user_email = $1;`,
    [userEmail]
  );
  return rows[0]?.anthropic_api_key || null;
}

export async function setUserAnthropicKey(userEmail, key) {
  await pool.query(
    `INSERT INTO user_settings (user_email, anthropic_api_key, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_email) DO UPDATE SET anthropic_api_key = $2, updated_at = now();`,
    [userEmail, key]
  );
}

export async function clearUserAnthropicKey(userEmail) {
  await pool.query(
    `UPDATE user_settings SET anthropic_api_key = NULL, updated_at = now() WHERE user_email = $1;`,
    [userEmail]
  );
}

// --- Hetzner self-hosting (hosting.js) ---

// Resolves a live (status 'complete') build from either its numeric id (default
// wh-asset-<id> hostname) or a custom domain. Returns { id } or null.
export async function getLiveBuildById(id) {
  const { rows } = await pool.query(
    `SELECT id FROM build_requests WHERE id = $1 AND status = 'complete';`,
    [id]
  );
  return rows[0] || null;
}

export async function getLiveBuildByCustomDomain(domain) {
  const { rows } = await pool.query(
    `SELECT id FROM build_requests WHERE lower(custom_domain) = lower($1) AND status = 'complete';`,
    [domain]
  );
  return rows[0] || null;
}

// True when another (non-deleted) build already holds this custom domain.
export async function isCustomDomainTaken(domain, exceptId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM build_requests WHERE lower(custom_domain) = lower($1) AND id <> $2 AND status <> 'deleted' LIMIT 1;`,
    [domain, exceptId]
  );
  return rows.length > 0;
}
