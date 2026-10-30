// Self-hosted asset serving on the Hetzner app server — replaces the per-asset Railway
// project/service/domain that railwayApi.js used to create.
//
// Every asset is a static site (the template's server.js only ever did
// express.static("public")), so instead of running one container per asset, the console
// writes each asset's public/ files to ASSETS_DIR/<buildId>/ and serves them itself,
// routed by Host header:
//   - wh-asset-<id>.<ASSET_BASE_DOMAIN>  -> default URL every asset gets
//   - any custom domain stored on a live build -> same files
// Caddy (already on the app server) terminates TLS for all of these with on-demand
// certificates, asking GET /internal/tls-ask?domain=... before issuing one.
//
// The GitHub repo per asset is unchanged and stays the source of record; these files are
// the deployed copy.

import fs from "node:fs/promises";
import path from "node:path";
import dns from "node:dns/promises";
import express from "express";

export const ASSETS_DIR = process.env.ASSETS_DIR || "/data/assets";
export const ASSET_BASE_DOMAIN = (process.env.ASSET_BASE_DOMAIN || "").toLowerCase();
export const CONSOLE_HOST = (process.env.CONSOLE_HOST || "").toLowerCase();
// Optional — only used to give apex-domain users an A record to add (apex can't CNAME).
export const SERVER_IP = process.env.SERVER_IP || "";

const ASSET_PREFIX = "wh-asset";

export function isHostingConfigured() {
  return Boolean(ASSET_BASE_DOMAIN);
}

export function assetHostForBuild(id) {
  return `${ASSET_PREFIX}-${id}.${ASSET_BASE_DOMAIN}`;
}

function assetDir(id) {
  return path.join(ASSETS_DIR, String(Number(id)));
}

// Returns the build id encoded in a default asset hostname, or null.
export function buildIdFromAssetHost(host) {
  if (!ASSET_BASE_DOMAIN) return null;
  const suffix = `.${ASSET_BASE_DOMAIN}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  const m = label.match(new RegExp(`^${ASSET_PREFIX}-(\\d+)$`));
  return m ? Number(m[1]) : null;
}

export function isUnderAssetBaseDomain(host) {
  return Boolean(ASSET_BASE_DOMAIN) && (host === ASSET_BASE_DOMAIN || host.endsWith(`.${ASSET_BASE_DOMAIN}`));
}

// Writes the template's public/ files for a build. Written to a temp dir first and swapped
// in, so a half-written deploy is never served.
export async function deployAssetFiles(id, files) {
  const dir = assetDir(id);
  const tmp = `${dir}.tmp-${Date.now()}`;
  await fs.mkdir(tmp, { recursive: true });
  let count = 0;
  for (const [filePath, content] of Object.entries(files)) {
    if (!filePath.startsWith("public/")) continue;
    const rel = filePath.slice("public/".length);
    const dest = path.join(tmp, rel);
    if (!dest.startsWith(tmp + path.sep)) continue; // no path escapes
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, content, "utf8");
    count++;
  }
  if (count === 0) {
    await fs.rm(tmp, { recursive: true, force: true });
    throw new Error("Template produced no public/ files to deploy.");
  }
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rename(tmp, dir);
}

// Overwrites a single public/ file of an already-deployed asset ("request changes").
export async function updateAssetFile(id, filePath, content) {
  if (!filePath.startsWith("public/")) throw new Error(`Not a public file: ${filePath}`);
  const dir = assetDir(id);
  const dest = path.join(dir, filePath.slice("public/".length));
  if (!dest.startsWith(dir + path.sep)) throw new Error(`Invalid path: ${filePath}`);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${Date.now()}`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, dest);
}

export async function removeAsset(id) {
  await fs.rm(assetDir(id), { recursive: true, force: true });
}

// Express middleware: serves asset hosts, passes everything else through to the console.
// `lookup(host)` resolves a hostname to a live build ({ id }) or null — injected from db.js
// so this module has no DB dependency of its own.
export function assetHostRouter(lookup) {
  return async (req, res, next) => {
    const host = String(req.hostname || "").toLowerCase();
    if (!host || host === CONSOLE_HOST) return next();
    if (req.path === "/internal/tls-ask" || req.path === "/healthz") return next();

    let build = null;
    try {
      build = await lookup(host);
    } catch (err) {
      console.error(`hosting: lookup failed for ${host}:`, err.message || err);
      return res.status(503).type("text").send("Temporarily unavailable.");
    }

    if (!build) {
      // Anything under the asset base domain belongs to asset space — never fall through
      // to the console login for those.
      if (isUnderAssetBaseDomain(host)) return res.status(404).type("text").send("Not found.");
      return next();
    }

    const serve = express.static(assetDir(build.id), { index: "index.html", fallthrough: true });
    serve(req, res, () => res.status(404).type("text").send("Not found."));
  };
}

// DNS check for a custom domain: does it resolve to the same address(es) as the asset's
// default hostname? Also probes HTTPS once, which makes Caddy issue the certificate on
// first contact if it hasn't already.
export async function checkCustomDomain(domain, id) {
  const target = assetHostForBuild(id);
  const [current, expected] = await Promise.all([
    dns.resolve4(domain).catch(() => []),
    SERVER_IP ? Promise.resolve([SERVER_IP]) : dns.resolve4(target).catch(() => []),
  ]);
  const dnsOk = current.length > 0 && current.some((ip) => expected.includes(ip));

  let certificateStatus = "pending";
  if (dnsOk) {
    try {
      const r = await fetch(`https://${domain}/`, { method: "HEAD", signal: AbortSignal.timeout(8000) });
      certificateStatus = r.status < 500 ? "issued" : "pending";
    } catch {
      certificateStatus = "pending";
    }
  }

  return {
    domain,
    dnsRecords: dnsRecordsFor(domain, id).map((r) => ({
      ...r,
      currentValue: current.join(", ") || null,
      status: dnsOk ? "valid" : "pending",
    })),
    certificateStatus,
  };
}

// The record(s) a user must add at their DNS provider.
export function dnsRecordsFor(domain, id) {
  const records = [{ type: "CNAME", hostlabel: domain, requiredValue: assetHostForBuild(id) }];
  if (SERVER_IP) records.push({ type: "A", hostlabel: `${domain} (apex domains only, instead of CNAME)`, requiredValue: SERVER_IP });
  return records;
}
