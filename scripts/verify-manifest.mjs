// The description rules the community directory enforces and the linter does
// not.
//
// eslint-plugin-obsidianmd's validate-manifest already covers length, leading
// capital, trailing period, the allowed character set, and the forbidden words
// "obsidian" and "plugin". Those live there and are deliberately not repeated
// here: a second copy of a check can drift from the real one and give false
// confidence.
//
// What it does not cover is the rule below, which the directory applies anyway.
// Finding that out by being rejected costs a release each time, so it is
// checked here instead.

import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { description, name } = manifest;
const failures = [];

// 1. The directory rejects a description that opens with the plugin's own
//    name. The listing already shows the name directly above it, so repeating
//    it spends the first and most valuable words saying nothing.
if (description.toLowerCase().startsWith(name.toLowerCase())) {
  failures.push(
    `description must not start with the plugin name "${name}". ` +
      `Lead with what it does for the reader instead.`,
  );
}

// 2. Ours, not the directory's: no dash used as punctuation anywhere in
//    shipped copy. The allowed character set permits "-", so nothing else
//    catches this.
if (/[—–]|(?<=\w)-(?=\w)/.test(description)) {
  failures.push("description contains a dash. Reword rather than hyphenate.");
}

// 3. The directory listing's short description field caps at 200, below the
//    250 the manifest allows. Keeping the manifest inside 200 means the two
//    can hold identical text.
if (description.length > 200) {
  failures.push(
    `description is ${description.length} characters. The directory listing ` +
      `field stops at 200, so keep them able to match.`,
  );
}

if (failures.length) {
  console.error("Manifest description check failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `Manifest description check passed: ${description.length} chars, ` +
    `does not lead with "${name}".`,
);
