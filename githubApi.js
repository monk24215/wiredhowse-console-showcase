const GITHUB_API = "https://api.github.com";

async function ghFetch(token, path, options = {}) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    // GitHub's real reason (e.g. "name already exists on this account") almost always
    // lives in the nested `errors[].message` array, not the generic top-level `message`
    // ("Repository creation failed."). Dropping that detail broke the idempotency checks
    // below, which specifically look for "already exists" in the thrown message — a retry
    // after a repo was already created on a prior attempt was hard-failing instead of
    // being recognized as safe, because the one word that mattered was being discarded.
    const detail = Array.isArray(data?.errors) ? data.errors.map((e) => e.message || e.code).filter(Boolean).join("; ") : "";
    const summary = [data?.message, detail].filter(Boolean).join(" | ") || text;
    throw new Error(`GitHub API ${path} -> ${res.status}: ${summary}`);
  }
  return data;
}

export async function getAuthenticatedUser(token) {
  return ghFetch(token, "/user");
}

// `owner` is the account/org the repo should live under; `isOrg` picks the create endpoint
// (GitHub has no single "create repo for X" call — orgs and the token's own personal
// account use different endpoints). Kristian's asset repos live under the wirehouseworkers
// GitHub org, not his personal monk24215 account, so isOrg is true for the normal path.
export async function createRepo(token, name, owner, isOrg) {
  const createPath = isOrg ? `/orgs/${owner}/repos` : "/user/repos";
  try {
    return await ghFetch(token, createPath, {
      method: "POST",
      body: JSON.stringify({ name, private: true, auto_init: true, description: "Created by the WiredHowse Co-op console." }),
    });
  } catch (err) {
    // A build request can be requeued after its GitHub repo was already created on a
    // prior attempt (e.g. it succeeded here but then failed/rate-limited on the later
    // Railway step). GitHub's create-repo returns 422 "name already exists on this
    // account" in that case — treat that specific failure as success and hand back the
    // existing repo rather than hard-failing the retry.
    const message = err.message || String(err);
    const isNameConflict = /422/.test(message) && /already exists/i.test(message);
    if (isNameConflict && owner) {
      return ghFetch(token, `/repos/${owner}/${name}`);
    }
    throw err;
  }
}

// Creates or updates a single file. Repo must already exist (auto_init: true gives it
// an initial commit/branch, which create-or-update-file's "no sha" path handles for new files).
export async function putFile(token, owner, repo, filePath, content, message) {
  const contentsPath = `/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`;
  const encoded = Buffer.from(content, "utf8").toString("base64");
  try {
    return await ghFetch(token, contentsPath, {
      method: "PUT",
      body: JSON.stringify({ message, content: encoded }),
    });
  } catch (err) {
    // Same requeue-after-partial-progress scenario as createRepo: this file may already
    // have been written on a prior attempt, in which case GitHub requires the existing
    // file's sha to overwrite it (422 "is not a valid... sha" / "sha" wasn't supplied).
    // Fetch the current sha and retry once as an update rather than hard-failing.
    const message2 = err.message || String(err);
    if (/422/.test(message2) && /sha/i.test(message2)) {
      const existing = await ghFetch(token, contentsPath);
      return ghFetch(token, contentsPath, {
        method: "PUT",
        body: JSON.stringify({ message, content: encoded, sha: existing.sha }),
      });
    }
    throw err;
  }
}

export async function pushFiles(token, owner, repo, files) {
  for (const [filePath, content] of Object.entries(files)) {
    await putFile(token, owner, repo, filePath, content, `Add ${filePath}`);
  }
}

// Reads and decodes a single file's current content — used by the "request changes" edit
// flow to hand the model the real current page instead of regenerating from scratch (which
// would throw away anything a prior edit changed). Returns null on 404 (file doesn't
// exist) rather than throwing, since "nothing to edit from" is a normal, checkable case
// for the caller rather than an error.
export async function getFileContent(token, owner, repo, path) {
  try {
    const data = await ghFetch(token, `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`);
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch (err) {
    const message = err.message || String(err);
    if (/-> 404/.test(message)) return null;
    throw err;
  }
}

// Full repository deletion for the "delete this asset" teardown flow. Verified against
// GitHub's own REST API reference (docs.github.com/en/rest/repos/repos — Delete a
// repository) before writing this: DELETE /repos/{owner}/{repo}, requires the classic PAT
// `delete_repo` scope (or Administration:write on a fine-grained token) — a plain `repo`
// scope alone is NOT enough, so if GITHUB_TOKEN lacks `delete_repo` this will fail with a
// 403 that the caller should surface plainly rather than swallow.
// A 404 means the repo is already gone (e.g. a retried teardown, or someone deleted it by
// hand) — treated as success so teardown stays safely retryable.
export async function deleteRepo(token, owner, repo) {
  try {
    await ghFetch(token, `/repos/${owner}/${repo}`, { method: "DELETE" });
  } catch (err) {
    const message = err.message || String(err);
    if (/-> 404/.test(message)) return;
    throw err;
  }
}

// Grants a GitHub account real, independent access to an asset's repo. This is the
// working equivalent of "give them a token for their repo": GitHub's REST API has no way
// to mint a personal access token on another account's behalf, so a collaborator invite
// (accepted under their own GitHub login) is the actual mechanism that hands over push
// access without ever exposing Kristian's own GITHUB_TOKEN. Verified against
// docs.github.com/en/rest/collaborators/collaborators — PUT
// /repos/{owner}/{repo}/collaborators/{username}: 201 = invitation created, 204 = already
// a collaborator (no body — ghFetch treats that as a normal success, nothing to catch).
// Default permission is "push" (read/write/commit) rather than "admin" — enough for them
// to do what they want with their own code without also handing over repo settings/delete
// rights on Kristian's org.
export async function addCollaborator(token, owner, repo, username, permission = "push") {
  const path = `/repos/${owner}/${repo}/collaborators/${encodeURIComponent(username)}`;
  try {
    return await ghFetch(token, path, {
      method: "PUT",
      body: JSON.stringify({ permission }),
    });
  } catch (err) {
    const message = err.message || String(err);
    if (/-> 404/.test(message)) {
      throw new Error(`GitHub user "${username}" not found — check the username (not email address).`);
    }
    throw err;
  }
}
