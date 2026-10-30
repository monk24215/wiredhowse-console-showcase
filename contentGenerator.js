// Turns a user's one-line prompt into a real, self-contained HTML site via the Anthropic
// Messages API. Scoped deliberately narrow: only the front-end page (public/index.html) is
// model-generated — server.js/Dockerfile/package.json stay the fixed, reviewed scaffold
// from templates.js. Generating arbitrary server-side code per build would be a much
// larger risk surface (whatever it wrote would execute on Kristian's Railway account) for
// no real benefit at this stage — a single polished HTML/CSS/JS page is what "build what I
// ask" needs for a static-landing asset.

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

const SYSTEM_PROMPT = `You write a single, complete, self-contained HTML document for a small website.

Rules:
- Output ONLY the HTML document — no explanation, no markdown fences, no commentary before or after.
- Start with <!doctype html> and include a real <title>.
- Put all CSS in a <style> tag and all JS in a <script> tag in the same file — no external files.
- External resources are fine (Google Fonts, a CDN-hosted icon set, etc.) but the page must render correctly even if they fail to load.
- Make it mobile-responsive (a working viewport meta tag, layout that doesn't break under ~400px width).
- Match the user's request as literally and completely as possible — the actual content, structure, and functionality they described, not a generic placeholder page about the topic.
- If the request implies interactivity (a form, a calculator, a game, a toggle), implement it for real with vanilla JS — don't fake it with static markup.
- Design it well: real typography, spacing, and color choices — not unstyled default HTML.`;

async function anthropicMessages(apiKey, model, userContent, maxTokens) {
  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    }),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Anthropic API non-JSON response (HTTP ${res.status}): ${text.slice(0, 500)}`);
  }
  if (!res.ok) {
    throw new Error(`Anthropic API HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const block = Array.isArray(data.content) ? data.content.find((c) => c.type === "text") : null;
  if (!block?.text) {
    throw new Error(`Anthropic API returned no text content: ${text.slice(0, 500)}`);
  }
  // Confirmed live (build #24, 2026-09-12): a real generation call succeeded — no HTTP
  // error, real content came back — but still fell back to the placeholder, because the
  // response was cut off mid-document before </html> and extractHtml() correctly rejected
  // it. Root cause was max_tokens: 8000 was set arbitrarily and never checked against the
  // model's actual limit. Verified against platform.claude.com/docs: claude-sonnet-5
  // supports up to 128K output tokens with no beta header required, so 8000 was starving a
  // "well-designed, real interactivity" page of room to finish. Surfacing stop_reason here
  // makes a future truncation immediately diagnosable in the logs instead of just
  // "doesn't look complete".
  if (data.stop_reason === "max_tokens") {
    throw new Error(`Anthropic response was truncated (stop_reason=max_tokens) at ${block.text.length} chars — raise max_tokens.`);
  }
  return block.text;
}

function extractHtml(raw) {
  // The system prompt says "no fences," but models sometimes wrap output in ```html
  // anyway — strip that defensively rather than shipping the fence markers to production.
  const fenced = raw.match(/```(?:html)?\s*([\s\S]*?)```/i);
  const html = (fenced ? fenced[1] : raw).trim();
  if (!/<html[\s>]/i.test(html) || !/<\/html>/i.test(html)) {
    throw new Error("Generated content doesn't look like a complete HTML document");
  }
  return html;
}

// Throws on any failure — the caller (worker.js) is responsible for catching this and
// falling back to the deterministic placeholder page, so a bad generation never fails the
// whole build.
export async function generateSiteHtml(apiKey, model, prompt) {
  // 8000 was an arbitrary guess and truncated real generations before </html> (confirmed
  // live on build #24 — see the stop_reason check above). claude-sonnet-5 supports up to
  // 128K output tokens with no beta header, so 16000 is a generous budget for a single
  // self-contained HTML/CSS/JS page without paying for far more than any page needs.
  const raw = await anthropicMessages(
    apiKey,
    model,
    `Build a website for this request: "${prompt}"`,
    16000
  );
  return extractHtml(raw);
}

const EDIT_SYSTEM_PROMPT = `You are revising an existing single-file HTML website based on the owner's follow-up request.

Rules:
- Output ONLY the complete, revised HTML document — no explanation, no markdown fences, no commentary before or after.
- Start with <!doctype html> and keep a real <title>.
- Preserve everything about the existing page that the requested change doesn't touch — this is an edit, not a rewrite from scratch.
- Apply the requested change literally and completely.
- Keep it a single self-contained file: all CSS in a <style> tag, all JS in a <script> tag, no external files (other than optional CDN/font links that still degrade gracefully).
- Keep it mobile-responsive.`;

// "Request changes" support — regenerates the page from its ORIGINAL brief plus its
// current live content plus new instructions, rather than starting over from the prompt
// alone (which would silently discard any prior edit). Uses its own system prompt (edit
// framing, not "build from scratch") since the generic SYSTEM_PROMPT above assumes there
// is no existing page yet.
export async function generateSiteEdit(apiKey, model, originalPrompt, currentHtml, instructions) {
  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      system: EDIT_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content:
            `The site was originally built for this request: "${originalPrompt}"\n\n` +
            `Here is the current HTML:\n\n${currentHtml}\n\n` +
            `Apply this requested change:\n"${instructions}"\n\n` +
            `Return the complete revised HTML document.`,
        },
      ],
    }),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Anthropic API non-JSON response (HTTP ${res.status}): ${text.slice(0, 500)}`);
  }
  if (!res.ok) {
    throw new Error(`Anthropic API HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const block = Array.isArray(data.content) ? data.content.find((c) => c.type === "text") : null;
  if (!block?.text) {
    throw new Error(`Anthropic API returned no text content: ${text.slice(0, 500)}`);
  }
  if (data.stop_reason === "max_tokens") {
    throw new Error(`Anthropic response was truncated (stop_reason=max_tokens) at ${block.text.length} chars — raise max_tokens.`);
  }
  return extractHtml(block.text);
}
