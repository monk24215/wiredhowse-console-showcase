import { claimNextQueuedRequest, completeBuildRequest, failBuildRequest, isConfigured, getUserAnthropicKey } from "./db.js";
import { TEMPLATES, repoNameForJob } from "./templates.js";
import { getAuthenticatedUser, createRepo, pushFiles } from "./githubApi.js";
import { isHostingConfigured, deployAssetFiles, assetHostForBuild } from "./hosting.js";
import { generateSiteHtml } from "./contentGenerator.js";

// Hosting is now local to the Hetzner app server (hosting.js) — no external provisioning
// rate limit to stay under anymore.
const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_MS || 15000);

// This app's own GitHub credential — Kristian's token, used on his behalf until end users
// bring their own. Exported so server.js's delete/edit/repo-access routes reuse it.
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
// Asset repos live under the wirehouseworkers GitHub org, not Kristian's personal
// monk24215 account. Overridable via env in case that ever needs to change.
const GITHUB_ORG = process.env.GITHUB_ORG || "wirehouseworkers";
// When set, the placeholder title-only page gets replaced with a real, prompt-generated
// site (see contentGenerator.js) before it's pushed. Left unset, builds keep working
// exactly as before — this degrades gracefully rather than gating on it.
// Exported (same pattern as GITHUB_TOKEN above) so server.js's
// "request changes" edit route can reuse the same shared key/model without a second
// copy of this env-var reading living in two places.
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
export const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

export async function executeTemplate(job) {
  const template = TEMPLATES[job.template_id];
  if (!template) {
    throw new Error(`Unknown template_id "${job.template_id}"`);
  }
  if (!GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN not configured — cannot create the asset repo.");
  }
  if (!isHostingConfigured()) {
    throw new Error("ASSET_BASE_DOMAIN not configured — nowhere to serve the asset from.");
  }

  // getAuthenticatedUser still identifies which account the GITHUB_TOKEN itself belongs
  // to (needed for permission checks / logging) — but the repo is created under the org,
  // not that personal account, whenever GITHUB_ORG is set.
  const { login: tokenOwner } = await getAuthenticatedUser(GITHUB_TOKEN);
  const owner = GITHUB_ORG || tokenOwner;
  const repoName = repoNameForJob(job);

  await createRepo(GITHUB_TOKEN, repoName, owner, Boolean(GITHUB_ORG));
  const files = template.seedFiles(job);

  // Upgrade the deterministic title-only placeholder to a real site built from the user's
  // actual prompt. Only the front-end page is model-generated — server.js/Dockerfile/
  // package.json stay the fixed, reviewed scaffold, so a generation only ever changes what
  // gets served, never what code runs. Any failure here (no key, API error, malformed
  // output) falls back to the placeholder rather than failing the whole build.
  //
  // Prefers the requesting user's own Anthropic key when they've set one (bring-your-own
  // key support) — their usage then bills to them, not the shared account, and isn't
  // bounded by MONTHLY_BUILD_LIMIT. Falls back to the shared ANTHROPIC_API_KEY otherwise.
  const userAnthropicKey = await getUserAnthropicKey(job.user_email).catch(() => null);
  const effectiveAnthropicKey = userAnthropicKey || ANTHROPIC_API_KEY;
  if (effectiveAnthropicKey) {
    try {
      files["public/index.html"] = await generateSiteHtml(effectiveAnthropicKey, ANTHROPIC_MODEL, job.prompt);
      console.log(
        `worker: generated real site content for build #${job.id} via ${ANTHROPIC_MODEL} (${userAnthropicKey ? "user-supplied key" : "shared key"})`
      );
    } catch (err) {
      console.error(`worker: content generation failed for build #${job.id}, using placeholder page:`, err.message || err);
    }
  }

  await pushFiles(GITHUB_TOKEN, owner, repoName, files);

  // Deploy: write the public/ files to this server's asset store. Served immediately by
  // hosting.js under wh-asset-<id>.<ASSET_BASE_DOMAIN>; Caddy issues TLS on first request.
  await deployAssetFiles(job.id, files);
  const host = assetHostForBuild(job.id);
  console.log(`worker: build #${job.id} deployed -> ${host}`);

  return {
    liveUrl: process.env.ASSET_BASE_DOMAIN === "localhost" ? `http://${host}:${process.env.PORT || 8080}` : `https://${host}`,
    repoUrl: `https://github.com/${owner}/${repoName}`,
    githubOwner: owner,
    githubRepo: repoName,
  };
}

async function tick() {
  if (!isConfigured()) return;
  let job;
  try {
    job = await claimNextQueuedRequest();
  } catch (err) {
    console.error("worker: failed to claim next job", err);
    return;
  }
  if (!job) return;

  console.log(`worker: claimed build request #${job.id} (template=${job.template_id})`);
  try {
    const result = await executeTemplate(job);
    await completeBuildRequest(job.id, result);
    console.log(`worker: build request #${job.id} complete -> ${result.liveUrl}`);
  } catch (err) {
    const message = err.message || String(err);
    await failBuildRequest(job.id, message);
    console.error(`worker: build request #${job.id} failed:`, message);
  }
}

export function startWorker() {
  if (!isConfigured()) {
    console.warn("worker: DATABASE_URL not set — worker loop disabled.");
    return;
  }
  setInterval(() => {
    tick().catch((err) => console.error("worker: tick error", err));
  }, POLL_INTERVAL_MS);
  console.log(`worker: polling every ${POLL_INTERVAL_MS}ms (concurrency cap: 1)`);
}
