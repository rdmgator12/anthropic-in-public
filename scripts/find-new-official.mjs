// Repeatable, exhaustive version of the manual "official-channel sweep".
// Enumerates Anthropic's official YouTube uploads via the YouTube Data API v3
// (the uploads playlist — not keyword search, so it can't miss one), dedups
// against the archive, and lists only the videos NOT already catalogued.
//
// It SURFACES candidates; it never writes to the data files. A human decides
// explainer vs event vs skip and writes the description — same standard as the
// rest of the archive (ambiguous items dropped, not guessed).
//
// Needs a Google API key with "YouTube Data API v3" enabled:
//   export YOUTUBE_API_KEY=...
//
// Usage:
//   node scripts/find-new-official.mjs                      # both official channels, newest first
//   node scripts/find-new-official.mjs --since 2026-06-01   # only uploads on/after a date
//   node scripts/find-new-official.mjs --handle anthropic-ai,claude
//   node scripts/find-new-official.mjs --channel-id UCrDwWp7EBBv4NwvScIpBDOA
//   node scripts/find-new-official.mjs --skeleton          # ready-to-paste explainer objects
//   node scripts/find-new-official.mjs --json              # machine-readable
//
// Zero dependencies — Node 18+ (global fetch).

import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = (file, v) =>
  vm.runInNewContext(`${readFileSync(join(root, file), "utf8")}\n;${v};`, {}, { filename: file });

// ---- args ----
const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const val = (name, def = null) => {
  const i = args.indexOf(name);
  if (i < 0) return def;
  const next = args[i + 1];
  return next && !next.startsWith("--") ? next : true;
};

const CHANNEL_ID = val("--channel-id", null);
const HANDLES = String(val("--handle", "anthropic-ai,claude"))
  .split(",").map((h) => h.trim().replace(/^@/, "")).filter(Boolean);
const SINCE = val("--since", null); // YYYY-MM-DD lower bound on upload date
const AS_JSON = has("--json");
const AS_SKELETON = has("--skeleton");

const KEY = process.env.YOUTUBE_API_KEY;
if (!KEY) {
  console.error(
    "find-new-official: FAIL — set YOUTUBE_API_KEY (a Google API key with 'YouTube Data API v3' enabled)."
  );
  process.exit(2);
}

// ---- API helper (fail loud) ----
const API = "https://www.googleapis.com/youtube/v3";
async function api(path, params) {
  const qs = new URLSearchParams({ ...params, key: KEY }).toString();
  const res = await fetch(`${API}/${path}?${qs}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`YouTube API ${path} ${res.status}: ${body?.error?.message || res.statusText}`);
  }
  return body;
}

// ---- resolve a channel's uploads playlist ----
async function uploadsPlaylistFor(target) {
  const params =
    target.id ? { part: "contentDetails", id: target.id }
              : { part: "contentDetails", forHandle: target.handle };
  const data = await api("channels", params);
  const ch = data.items?.[0];
  if (!ch) return null; // handle may not exist — caller notes and moves on
  return { name: ch.snippet?.title, uploads: ch.contentDetails.relatedPlaylists.uploads };
}

// ---- page an uploads playlist (newest-first; early-stop past --since) ----
async function pageUploads(playlistId) {
  const out = [];
  let pageToken;
  do {
    const data = await api("playlistItems", {
      part: "snippet,contentDetails",
      playlistId,
      maxResults: "50",
      ...(pageToken ? { pageToken } : {}),
    });
    for (const it of data.items || []) {
      const id = it.contentDetails?.videoId || it.snippet?.resourceId?.videoId;
      const date = (it.contentDetails?.videoPublishedAt || it.snippet?.publishedAt || "").slice(0, 10);
      out.push({ id, date, title: it.snippet?.title || "", description: (it.snippet?.description || "").split("\n")[0] });
    }
    pageToken = data.nextPageToken;
    // uploads playlist is reverse-chronological, so once we're past --since we can stop.
    if (SINCE && out.length && out[out.length - 1].date && out[out.length - 1].date < SINCE) pageToken = null;
  } while (pageToken);
  return out;
}

// ---- gather across the requested channel(s) ----
const targets = CHANNEL_ID ? [{ id: CHANNEL_ID }] : HANDLES.map((handle) => ({ handle }));
const seenVid = new Map();
for (const t of targets) {
  const ch = await uploadsPlaylistFor(t);
  if (!ch) {
    console.error(`  (no channel for ${t.id ? "id " + t.id : "@" + t.handle} — skipping)`);
    continue;
  }
  for (const v of await pageUploads(ch.uploads)) {
    if (v.id && !seenVid.has(v.id)) seenVid.set(v.id, { ...v, channel: ch.name });
  }
}
let vids = [...seenVid.values()];
if (SINCE) vids = vids.filter((v) => v.date >= SINCE);

// ---- dedup vs archive (by video id) ----
const YT = /(?:v=|youtu\.be\/|\/live\/|\/embed\/|\/shorts\/)([\w-]{6,})/;
const inArchive = new Set(
  [...load("data/talks.js", "TALKS"), ...load("data/extras.js", "EXTRAS")]
    .map((e) => (String(e.url).match(YT) || [])[1])
    .filter(Boolean)
);
const fresh = vids.filter((v) => !inArchive.has(v.id)).sort((a, b) => (a.date < b.date ? 1 : -1));

// ---- output ----
if (AS_JSON) {
  console.log(JSON.stringify(fresh, null, 2));
  process.exit(0);
}
const where = CHANNEL_ID ? CHANNEL_ID : "@" + HANDLES.join(", @");
if (!fresh.length) {
  console.log(`No new official uploads${SINCE ? ` since ${SINCE}` : ""} — archive is current with ${where}.`);
  process.exit(0);
}
console.log(`${fresh.length} official upload(s) not in the archive${SINCE ? ` (since ${SINCE})` : ""} — ${where}:\n`);
for (const v of fresh) {
  if (AS_SKELETON) {
    console.log(
      `  { category: "explainer", type: "explainer", title: ${JSON.stringify(v.title)}, speaker: "Anthropic", role: "", venue: "Anthropic (YouTube)", date: "${v.date}", url: "https://www.youtube.com/watch?v=${v.id}", description: "" },`
    );
  } else {
    console.log(`  ${v.date}  ${v.id}  [${v.channel || "?"}]  ${v.title}`);
    if (v.description) console.log(`              ${v.description.slice(0, 96)}`);
  }
}
console.log(`\nReview each: explainer vs event vs skip, write a description. This tool only surfaces — it never writes to the data files.`);
