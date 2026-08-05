// Post-build gate on the isDesktopOnly:false promise.
//
// The esbuild plugin already fails on a NodeJS *import*, but a desktop-only
// API can also reach the bundle through a global: `process.platform`,
// `require("electron")`, `__dirname`. Those build fine and then throw on a
// phone, where nobody is watching a console. This inspects the shipped artefact
// rather than the source, so it catches whatever actually made it in.

import { readFileSync, existsSync } from "node:fs";

const BUNDLE = "main.js";

if (!existsSync(BUNDLE)) {
  console.error(`${BUNDLE} not found. Run \`npm run build\` first.`);
  process.exit(1);
}

const source = readFileSync(BUNDLE, "utf8");
const failures = [];

// 1. `obsidian` is the only module the host provides. Anything else external
//    means the bundle expects a runtime that mobile does not have.
const requires = [...source.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
const unexpected = [...new Set(requires)].filter((name) => name !== "obsidian");
if (unexpected.length) {
  failures.push(`Unexpected external require(s): ${unexpected.join(", ")}`);
}

// 2. Desktop-only globals. Each of these exists in Electron and not in the
//    mobile webview.
const forbiddenGlobals = [
  ["process.platform", /\bprocess\s*\.\s*platform\b/],
  ["process.env", /\bprocess\s*\.\s*env\b/],
  ["__dirname", /\b__dirname\b/],
  ["__filename", /\b__filename\b/],
  ["Buffer", /\bBuffer\s*\.\s*from\b/],
  ["electron", /\brequire\(["']electron["']\)/],
];
for (const [label, pattern] of forbiddenGlobals) {
  if (pattern.test(source)) failures.push(`Desktop-only global in bundle: ${label}`);
}

// 3. The manifest must actually claim mobile support, or none of the above
//    matters and the checks are theatre.
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
if (manifest.isDesktopOnly !== false) {
  failures.push("manifest.json isDesktopOnly is not false");
}

if (failures.length) {
  console.error("Mobile safety check FAILED:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

// Read the id esbuild baked in, rather than computing a second one here. An
// earlier version hashed the bundle bytes while esbuild hashed the sources, so
// the two ids never matched and the check reported a stale plugin every time.
// A diagnostic that can produce a false alarm is worse than none.
const stamped = source.match(/loaded, bundle ([a-f0-9]{8})/);
if (!stamped) {
  console.error(
    "Build id missing from the bundle. esbuild.config.mjs should define " +
      "STASHWISE_BUILD_ID and main.ts should log it.",
  );
  process.exit(1);
}

console.log(
  `Mobile safety check passed: ${(source.length / 1024).toFixed(1)}kb bundle, ` +
    `external requires = [${[...new Set(requires)].join(", ")}], build ${stamped[1]}`,
);
