import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const prod = process.argv[2] === "production";

// Fingerprint the sources so the running plugin can say which build it is.
// Obsidian caches the module it read at enable time, and an app reload does not
// re-read a symlinked main.js, so a stale bundle looks exactly like a fix that
// did not work. This turns that into a one-line comparison.
function hashSources(dir) {
  const hash = createHash("sha256");
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) {
        hash.update(full).update(readFileSync(full));
      }
    }
  };
  walk(dir);
  return hash.digest("hex").slice(0, 8);
}
const BUILD_ID = hashSources("src");

// The id lives in the banner, not in code. A production build strips the dev
// console.log that used to carry it, and the mobile check still needs a way to
// report which build it inspected.
const banner = `/*
Generated bundle. Source: https://github.com/StashwiseAI/stashwise-obsidian
build: ${BUILD_ID}
*/
`;

// manifest.json declares isDesktopOnly:false, which is a promise that nothing
// in this bundle touches a NodeJS or Electron API. The sample plugin config
// marks builtins `external`, which would let `import { hostname } from
// "node:os"` build cleanly and then crash on a phone. Failing the build
// instead is the only way the promise stays true as the plugin grows.
const forbidNodeBuiltins = {
  name: "forbid-node-builtins",
  setup(build) {
    const forbidden = new Set([...builtins, ...builtins.map((m) => `node:${m}`)]);
    build.onResolve({ filter: /.*/ }, (args) => {
      if (!forbidden.has(args.path)) return null;
      return {
        errors: [
          {
            text:
              `"${args.path}" is a NodeJS builtin and cannot be used: ` +
              `manifest.json sets isDesktopOnly:false, so this plugin must run ` +
              `on Obsidian mobile. Use the Obsidian API instead ` +
              `(requestUrl for HTTP, vault.adapter for files).`,
          },
        ],
      };
    });
  },
};

const options = {
  banner: { js: banner },
  entryPoints: ["src/main.ts"],
  bundle: true,
  // Provided by the host at runtime, so never bundled. Everything else must
  // either be our own source or fail the builtin check above.
  external: ["obsidian", "electron"],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
  define: {
    STASHWISE_BUILD_ID: JSON.stringify(BUILD_ID),
    // Literal `false` in a production build, so esbuild removes the branch and
    // the released bundle logs nothing. Obsidian asks that the console show
    // only errors by default.
    STASHWISE_DEV: JSON.stringify(!prod),
  },
  plugins: [forbidNodeBuiltins],
};

if (prod) {
  await esbuild.build(options);
} else {
  const context = await esbuild.context(options);
  await context.watch();
}
