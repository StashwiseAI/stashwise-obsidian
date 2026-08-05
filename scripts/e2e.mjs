// End-to-end: real backend over real HTTP, real files on disk, the plugin's
// own sync engine in between.
//
// Bundles the TypeScript harness with esbuild first, because the sync core is
// TS and Node cannot load it directly.

import esbuild from "esbuild";
import { readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const API = process.env.E2E_API_URL;
const TOKEN = process.env.E2E_TOKEN;
const VAULT = process.env.E2E_VAULT;

if (!API || !TOKEN || !VAULT) {
  console.error("E2E_API_URL, E2E_TOKEN and E2E_VAULT must all be set.");
  process.exit(1);
}

const BUNDLE = ".e2e-harness.mjs";
await esbuild.build({
  entryPoints: ["scripts/e2e-harness.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outfile: BUNDLE,
  logLevel: "warning",
});

const { runSync } = await import(pathToFileURL(resolve(BUNDLE)).href);

let failures = 0;
let checks = 0;

function check(label, condition, detail = "") {
  checks += 1;
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
  }
}

const read = (path) => readFile(join(VAULT, path), "utf8");
const has = (path) => existsSync(join(VAULT, path));

// --- 1. First sync, from an empty vault -----------------------------------
console.log("\n[1] First sync into an empty vault");
const first = await runSync({ apiBaseUrl: API, token: TOKEN, vaultRoot: VAULT });
console.log(`      report: ${JSON.stringify(first.report)}`);

check("no errors", first.report.errors.length === 0, first.report.errors.join("; "));
check("wrote 3 saves", first.report.savesWritten === 3);
check("wrote 2 topics", first.report.entitiesWritten === 2);
check("stored a cursor for next time", Boolean(first.state.cursor));

const savePath = "Stashwise/Saves/how-agents-remember-e2e-save.md";
check("save note exists at the slugged path", has(savePath));

const saveText = await read(savePath);
check("frontmatter carries the id", saveText.includes("stashwise_id: e2e-save-1"));
check("summary rendered", saveText.includes("Durable memory is what makes an agent"));
check("takeaway with timestamp rendered", saveText.includes("_(01:23)_"));
check("markers present", saveText.includes("%% stashwise:begin %%") && saveText.includes("%% stashwise:end %%"));

// The awkward title: filename must be safe and YAML must still parse.
const trickyPath = "Stashwise/Saves/re-agents-part-2-hot-e2e-save.md";
check("awkward title produced a safe filename", has(trickyPath));
if (has(trickyPath)) {
  const tricky = await read(trickyPath);
  check("awkward title is quoted in YAML", /title|source_url: "https/.test(tricky));
  check("awkward title did not break the managed block", tricky.includes("%% stashwise:end %%"));
}

// The late-analysis case: created 20 days ago, updated 5 minutes ago.
check("still-processing save was written", has("Stashwise/Saves/still-processing-e2e-save.md"));

const topicPath = "Stashwise/Topics/agent-memory.md";
check("topic note exists", has(topicPath));
if (has(topicPath)) {
  const topic = await read(topicPath);
  check("topic links to its related entity", topic.includes("[[Vector search]]"));
  check("topic lists its sources", topic.includes("## Sources"));
  check("topic is typed as a topic", topic.includes("stashwise_type: topic"));
}

// --- 2. Incremental sync: nothing changed ---------------------------------
console.log("\n[2] Incremental sync with no upstream changes");
const second = await runSync({ apiBaseUrl: API, token: TOKEN, vaultRoot: VAULT });
console.log(`      report: ${JSON.stringify(second.report)}`);
check("nothing rewritten", second.report.savesWritten === 0 && second.report.entitiesWritten === 0);
check("no errors", second.report.errors.length === 0);

// --- 3. The user writes in their zone -------------------------------------
console.log("\n[3] User edits the note, then syncs");
const MY_NOTE = "## My notes\n\nThis paragraph is mine and must survive every sync.";
await writeFile(join(VAULT, savePath), (await read(savePath)) + MY_NOTE, "utf8");

const third = await runSync({ apiBaseUrl: API, token: TOKEN, vaultRoot: VAULT, full: true });
console.log(`      report: ${JSON.stringify(third.report)}`);
check("pushed the user zone up", third.report.notesPushed === 1);

const afterPush = await read(savePath);
check("user text survived the rewrite", afterPush.includes("must survive every sync"));
check("managed content was still regenerated", afterPush.includes("Durable memory"));

// A second sync must not push again: the hash now matches.
const fourth = await runSync({ apiBaseUrl: API, token: TOKEN, vaultRoot: VAULT });
check("does not re-push an unchanged zone", fourth.report.notesPushed === 0);

// And the server must actually have it.
const hydrated = await fetch(`${API}/agent/content/e2e-save-1`, {
  headers: { Authorization: `Bearer ${TOKEN}` },
}).then((r) => r.json());
check(
  "backend stored the note in personal_notes",
  String(hydrated.personal_notes ?? "").includes("must survive every sync"),
  `got: ${JSON.stringify(hydrated.personal_notes)}`,
);

// --- 4. Detached note: a marker is removed --------------------------------
console.log("\n[4] User deletes a marker");
const mangled = (await read(savePath)).replace("%% stashwise:end %%", "");
await writeFile(join(VAULT, savePath), mangled, "utf8");

const fifth = await runSync({ apiBaseUrl: API, token: TOKEN, vaultRoot: VAULT, full: true });
console.log(`      report: ${JSON.stringify(fifth.report)}`);
check("reported the note as detached", fifth.report.detached >= 1);
check(
  "left the mangled file completely untouched",
  (await read(savePath)) === mangled,
  "the plugin must never guess where a missing marker was",
);

// --- 5. Full resync rebuilds from scratch ---------------------------------
console.log("\n[5] Full resync after deleting the vault copy");
await rm(join(VAULT, "Stashwise"), { recursive: true, force: true });
await rm(join(VAULT, ".sync-state.json"), { force: true });
const sixth = await runSync({ apiBaseUrl: API, token: TOKEN, vaultRoot: VAULT, full: true });
console.log(`      report: ${JSON.stringify(sixth.report)}`);
check("rebuilt every save", sixth.report.savesWritten === 3);
check("rebuilt every topic", sixth.report.entitiesWritten === 2);
check(
  "seeded the user zone from personal_notes",
  (await read(savePath)).includes("must survive every sync"),
);

await rm(BUNDLE, { force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
