// Weekly link-rot check over every source URL in the archive.
// YouTube links are validated via the oEmbed API (confirms the video exists
// without bot-blocking); everything else via a normal request with a browser
// UA. Paywall/anti-bot responses (401/403/429/999/503) are treated as ALIVE.
// Only high-confidence rot (404/410) is reported; transient 5xx/timeouts are
// "unknown" and never flagged, to keep the auto-issue clean. Zero dependencies.
import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = (file, v) => vm.runInNewContext(`${readFileSync(join(root, file), "utf8")}\n;${v};`, {}, { filename: file });

const urls = [...new Set([...load("data/talks.js", "TALKS"), ...load("data/extras.js", "EXTRAS")].map((e) => e.url))];

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const BLOCKED = new Set([401, 403, 429, 999, 503]); // alive, just bot/paywall-blocked
const ytId = (u) => (u.match(/(?:watch\?v=|youtu\.be\/|\/live\/|\/embed\/)([A-Za-z0-9_-]{6,})/) || [])[1];

async function check(u) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const yid = ytId(u);
    const target = yid
      ? "https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent("https://www.youtube.com/watch?v=" + yid)
      : u;
    const res = await fetch(target, { redirect: "follow", signal: ctrl.signal, headers: { "User-Agent": UA } });
    const code = res.status;
    if (code >= 200 && code < 400) return { u, code, state: "ok" };
    if (BLOCKED.has(code)) return { u, code, state: "blocked" };
    if (yid && code === 401) return { u, code, state: "blocked" }; // embedding disabled, video still exists
    if (code === 404 || code === 410) return { u, code, state: "dead" };
    return { u, code, state: "unknown" }; // 5xx etc — transient, don't flag
  } catch (err) {
    return { u, code: null, state: "unknown", err: err.name }; // timeout / network — don't flag
  } finally {
    clearTimeout(t);
  }
}

const results = [];
const BATCH = 8;
for (let i = 0; i < urls.length; i += BATCH) {
  results.push(...(await Promise.all(urls.slice(i, i + BATCH).map(check))));
}

const by = (s) => results.filter((r) => r.state === s);
const dead = by("dead");
console.log(`Checked ${urls.length} links — ok ${by("ok").length}, blocked ${by("blocked").length}, unknown ${by("unknown").length}, dead ${dead.length}`);

if (dead.length) {
  const body =
    `## 🔗 Link-rot detected — ${dead.length} dead link(s)\n\n` +
    `_Automated weekly check. Paywall/bot-blocked links (NYT, WSJ, WEF, etc.) and transient errors are treated as alive and not listed — only \`404\`/\`410\` appear here._\n\n` +
    dead.map((d) => `- \`[${d.code ?? d.err}]\` ${d.u}`).join("\n") +
    `\n\nFix the URL in \`data/talks.js\` or \`data/extras.js\`, then push.\n`;
  writeFileSync(join(root, "link-report.md"), body);
  console.error("\nDead:\n" + dead.map((d) => `  [${d.code ?? d.err}] ${d.u}`).join("\n"));
  process.exit(1);
}
console.log("✓ no dead links.");
