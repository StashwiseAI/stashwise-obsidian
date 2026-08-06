# Contributing

```bash
git clone https://github.com/StashwiseAI/stashwise-obsidian.git
cd stashwise-obsidian
npm install
npm run dev      # esbuild watch, writes main.js
npm test         # unit tests
npm run lint     # the Obsidian directory's own ruleset
npm run build    # typecheck, bundle, mobile safety gate
```

Develop against a **throwaway vault**, never one you care about. This plugin
writes files. Symlink the build output in so a rebuild lands immediately:

```bash
mkdir -p <dev-vault>/.obsidian/plugins/stashwise
ln -sf "$PWD/main.js"       <dev-vault>/.obsidian/plugins/stashwise/main.js
ln -sf "$PWD/manifest.json" <dev-vault>/.obsidian/plugins/stashwise/manifest.json
ln -sf "$PWD/styles.css"    <dev-vault>/.obsidian/plugins/stashwise/styles.css
```

## minAppVersion is a promise TypeScript cannot check

`npm run lint` runs `eslint-plugin-obsidianmd`, the same ruleset the community
directory runs against a submitted release. Run it before tagging. Its
`no-unsupported-api` rule is the reason it is here: the `obsidian` package
resolves to the newest typings, so `tsc` happily accepts an API that did not
exist at the `minAppVersion` in `manifest.json`. TypeScript has no concept of
`@since`, so nothing else catches it. Twice this shipped to review and came back
as a blocking error, once for `revealLeaf` and once for `setDestructive`.

The lint run is expected to be clean of errors and to carry a handful of
warnings, all one decision:

> `display` is deprecated, use `getSettingDefinitions`
> `setWarning` is deprecated, use `setDestructive`

Both replacements arrived in Obsidian **1.13.0** (2026-05-28). Adopting them
means raising `minAppVersion` to 1.13.0 and dropping every user who has not
updated. Mobile is where update lag is worst, and mobile capture is the reason
this plugin exists, so the floor stays at 1.7.2 and the deprecated spellings
stay. Revisit when 1.13 is unremarkable; the change is mechanical.

Do not silence those warnings. They are the reminder.

## Two things that will waste your time

**Obsidian caches the plugin at load.** Reloading the app does **not** re-read a
symlinked `main.js`. Toggle the plugin off and on under Settings, Community
plugins. This cost two rounds of debugging a fix that was already correct.

To make that answerable rather than guessable, every build prints a fingerprint:

```
Mobile safety check passed: 31.7kb bundle, ..., build 9b947821
```

Dev builds log the same id on load, so the console tells you whether you are
running what you just built. Release builds stay silent, since Obsidian asks
that the console show only errors.

**The build refuses NodeJS.** `manifest.json` sets `isDesktopOnly: false`, which
is a promise that nothing here touches a NodeJS or Electron API. That promise is
enforced twice: esbuild fails on any builtin import, and `scripts/verify-mobile.mjs`
rejects `process.env`, `__dirname`, `Buffer` or a non-`obsidian` require reaching
the bundle. Marking builtins `external`, as the official sample plugin does,
would let such an import build cleanly and then crash on a phone.

## Layout

```
src/
  main.ts              plugin entry, the only file that wires the Obsidian API
  api/                 typed backend client, transport injected
  auth/                device code flow; policy.ts is pure and tested
  capture/             noteText.ts pure, commands.ts touches Obsidian
  search/              insert formatting, out-of-order response guard
  sync/                engine, managed block, renderers, state
  views/               sidebar panel and suggest modal
```

The split repeats throughout: anything importing `obsidian` cannot be unit
tested, because Obsidian supplies that module at runtime. So pure logic lives in
its own file and the Obsidian-facing wrapper stays thin. `auth/policy.ts` beside
`auth/deviceAuth.ts` is the clearest example.

`sync/engine.ts` takes a `VaultIO` interface rather than the vault itself, which
is what lets the whole sync algorithm run against an in-memory fake, and against
a real backend over real HTTP with the filesystem standing in for a vault.

## The invariant that matters

`sync/managedBlock.ts` is the only code that can destroy something a user wrote.
Its rules are not negotiable:

- Only the span between `%% stashwise:begin %%` and `%% stashwise:end %%` is
  ever rewritten
- Everything after the end marker is preserved byte for byte
- **If a marker is missing or duplicated, do not write at all.** Report the file
  as detached instead. Guessing where the user's text begins is how people lose
  work

Its tests were written before the implementation, and should stay that way. If
you change this file, add the failing test first.

## Tests

```bash
npm test         # unit tests, no Obsidian required
npm run e2e      # end to end against a real backend
```

`npm run e2e` seeds a throwaway database, starts a backend, and runs the real
sync engine over real HTTP into a temporary folder, checking that user text
survives a rewrite, that edits push back, that a missing marker leaves a file
byte-identical, and that a full resync rebuilds correctly. It needs a checkout
of the Stashwise backend; pass its path as the first argument.

Some things only real use finds. The bugs that unit tests missed here were
offset pagination silently skipping rows, two topics claiming one filename, and
a broken note never being reported on an incremental sync. When you change sync,
run it against a real library.

## Releasing

Maintainers only.

1. `npm run lint` and fix every **error**. Warnings are expected; see
   minAppVersion above. An error here becomes a rejected directory review
2. Bump the version in `manifest.json`, `package.json` and `versions.json`; all
   three must agree
3. Tag it exactly, with no `v` prefix: `git tag -a 1.0.2 -m "1.0.2" && git push origin 1.0.2`
4. `.github/workflows/release.yml` tests, lints, builds, attests and drafts a
   release with `main.js`, `manifest.json` and `styles.css` attached
5. Add notes and publish the draft

Obsidian's directory reads `manifest.json` from the default branch, and installs
the assets from the release, so the tag and the manifest version must match.

## Style

Named exports, except the single default export in `main.ts` that Obsidian's
loader requires. Comments explain why, not what. UI text is sentence case, per
Obsidian's guidelines.
