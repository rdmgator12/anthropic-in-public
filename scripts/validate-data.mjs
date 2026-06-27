// Validates data/talks.js and data/extras.js before they can ship.
// A malformed entry (stray quote, bad type, missing field) silently breaks
// the live site, so this runs in CI on every push/PR. Zero dependencies.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The data files are plain `const TALKS = [...]` globals, not modules.
// Run each in a fresh VM context and read back the completion value.
function load(file, varName) {
  const code = readFileSync(join(root, file), "utf8");
  return vm.runInNewContext(`${code}\n;${varName};`, {}, { filename: file });
}

const TALK_TYPES  = ["keynote", "podcast", "interview", "panel", "lecture", "testimony", "fireside", "workshop", "essay", "demo"];
const EXTRA_TYPES = ["event", "webinar", "explainer"];
const EXTRA_CATS  = ["event", "webinar", "explainer"];
const DATE_RE     = /^\d{4}(-\d{2}(-\d{2})?)?$/;

const errors = [];
const seenUrls = new Map();

function checkEntry(e, i, file, allowedTypes, requireCategory) {
  const at = `${file}[${i}] "${(e && e.title) || "??"}"`;
  if (!e || typeof e !== "object") { errors.push(`${at}: not an object`); return; }

  for (const f of ["title", "speaker", "venue", "date", "type", "url"]) {
    if (typeof e[f] !== "string" || !e[f].trim()) errors.push(`${at}: missing/empty "${f}"`);
  }
  if (e.type && !allowedTypes.includes(e.type)) errors.push(`${at}: invalid type "${e.type}" (allowed: ${allowedTypes.join(", ")})`);
  if (e.date && !DATE_RE.test(e.date)) errors.push(`${at}: bad date "${e.date}" — want YYYY, YYYY-MM, or YYYY-MM-DD`);
  if (e.date && DATE_RE.test(e.date)) {
    const y = parseInt(e.date.slice(0, 4), 10);
    if (y < 2020 || y > 2031) errors.push(`${at}: year out of range (${y})`);
  }
  if (e.url && !/^https?:\/\/.+/.test(e.url)) errors.push(`${at}: malformed url "${e.url}"`);
  if ("people" in e && !(Array.isArray(e.people) && e.people.every((p) => typeof p === "string"))) {
    errors.push(`${at}: "people" must be an array of strings`);
  }
  if (requireCategory && !EXTRA_CATS.includes(e.category)) {
    errors.push(`${at}: invalid/missing category "${e.category}" (allowed: ${EXTRA_CATS.join(", ")})`);
  }
  if (typeof e.url === "string") {
    if (seenUrls.has(e.url)) console.warn(`  ! duplicate url: ${e.url}\n      ${seenUrls.get(e.url)}\n      ${at}`);
    else seenUrls.set(e.url, at);
  }
}

let TALKS, EXTRAS;
try { TALKS = load("data/talks.js", "TALKS"); } catch (err) { errors.push(`data/talks.js failed to parse: ${err.message}`); }
try { EXTRAS = load("data/extras.js", "EXTRAS"); } catch (err) { errors.push(`data/extras.js failed to parse: ${err.message}`); }

if (Array.isArray(TALKS)) TALKS.forEach((e, i) => checkEntry(e, i, "talks.js", TALK_TYPES, false));
else if (TALKS !== undefined) errors.push("TALKS is not an array");

if (Array.isArray(EXTRAS)) EXTRAS.forEach((e, i) => checkEntry(e, i, "extras.js", EXTRA_TYPES, true));
else if (EXTRAS !== undefined) errors.push("EXTRAS is not an array");

const total = (TALKS?.length ?? 0) + (EXTRAS?.length ?? 0);
console.log(`Validated ${TALKS?.length ?? 0} talks + ${EXTRAS?.length ?? 0} extras = ${total} entries.`);

if (errors.length) {
  console.error(`\n✗ ${errors.length} error(s):`);
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
console.log("✓ data files valid.");
