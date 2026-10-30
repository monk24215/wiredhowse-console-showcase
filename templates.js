// Fixed, hard-coded asset templates. Section 3's architecture deliberately does NOT
// let the free-text field drive open-ended code generation per request — every build
// executes one of these pre-reviewed templates, so cost and abuse surface stay bounded
// no matter how many users are queued. The text field's prompt is used to fill in a
// title/description on the page; it is never sent to a live model at build time.

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40) || "asset";
}

function staticLandingFiles(job) {
  const title = escapeHtml(job.prompt).slice(0, 120);
  const indexHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title || "New WiredHowse Asset"}</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 640px; margin: 15vh auto; padding: 0 1.5rem; color: #1a1a1a; text-align: center; }
    h1 { font-size: 1.6rem; }
    p { color: #666; }
  </style>
</head>
<body>
  <h1>${title || "New WiredHowse Asset"}</h1>
  <p>Provisioned by the WiredHowse Co-op console — build request #${job.id}.</p>
</body>
</html>`;

  const serverJs = `import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(\`listening on \${port}\`));
`;

  const packageJson = JSON.stringify(
    {
      name: `wh-asset-${job.id}`,
      version: "1.0.0",
      private: true,
      type: "module",
      scripts: { start: "node server.js" },
      dependencies: { express: "^4.19.2" },
    },
    null,
    2
  );

  const dockerfile = `FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
`;

  return {
    "package.json": packageJson,
    "server.js": serverJs,
    "Dockerfile": dockerfile,
    "public/index.html": indexHtml,
  };
}

export const TEMPLATES = {
  "static-landing": {
    id: "static-landing",
    label: "Static landing page",
    description: "A single-page static HTML site with its own hostname and GitHub repo.",
    repoNamePrefix: "wh-asset",
    seedFiles: staticLandingFiles,
  },
};

export const DEFAULT_TEMPLATE_ID = "static-landing";

export function isValidTemplate(id) {
  return Object.prototype.hasOwnProperty.call(TEMPLATES, id);
}

export function repoNameForJob(job) {
  const template = TEMPLATES[job.template_id];
  const prefix = template?.repoNamePrefix || "wh-asset";
  return `${prefix}-${job.id}-${slugify(job.prompt)}`;
}
