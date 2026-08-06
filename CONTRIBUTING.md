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

The lint run is expected to be completely clean, no errors and no warnings. If
you add a warning, fix it rather than leaving it; there is nothing in this repo
that is expected to be noisy.

### manifest.json needs its own config block

`eslint.config.mjs` lints `manifest.json` explicitly. Do not remove that block.

`validate-manifest` returns early unless the file being linted *is*
`manifest.json`, yet the plugin's recommended config only registers it for `.js`
and `.ts` files. So out of the box the rule never runs, and eslint skips the
manifest entirely with "no matching configuration was supplied". A clean lint
then tells you nothing at all about the manifest. That is how a description
containing the word "Obsidian" reached a published release and came back as a
rejection.

The rule wants a plain ESTree `ObjectExpression`, so the TypeScript parser is
the one that works. `jsonc-eslint-parser` produces `JSONObjectExpression` and
the rule rejects the file as not being an object.

The description constraints are stricter than they look, and the checks
short-circuit so you may only see one violation at a time:

- 10 to 250 characters, starts with a capital, ends with a period
- must not contain the words "Obsidian" or "plugin", in any casing
- characters limited to `A-Za-z0-9`, whitespace, and `. , ! ? ' " -`, which
  means **no colon**, no parentheses and no slash

## The settings tab renders two ways, and Obsidian picks one

This is the thing to understand before touching `src/settings.ts`.

Obsidian 1.13.0 added a declarative settings API. 1.13.4 dispatches like this:

```js
renderTab = function () { this.settingItems.length > 0 ? V2(this) : this.display() }
```

`settingItems` is whatever `getSettingDefinitions()` returned. So on 1.13 and
later our declarative definitions render and **`display()` is never called**;
below 1.13 there is no declarative API at all and `display()` is the only path.
The two are never merged, and Obsidian never renders both.

Writing the rows out once per renderer would therefore fail silently. A row
present in one list and missing from the other disappears only for the versions
that use that renderer, and looks perfectly fine when you test on the other.

So the rows are not written in either renderer. `sections()` describes them
once, and both `getSettingDefinitions()` and `display()` read it:

```
sections()  ->  getSettingDefinitions()   Obsidian >= 1.13, and settings search
            ->  renderImperatively()      Obsidian <  1.13, via display()
```

Add a row to `sections()` and it appears on both. There is no second list.

Three related traps:

- **Redrawing.** `update()` is how 1.13 re-reads the definitions and
  re-evaluates every `visible()` predicate, but it does not exist at our
  minAppVersion, so it cannot be called directly. `refresh()` detects it at
  runtime and falls back to re-running the imperative render.
- **`display()` is deprecated but still required.** Overriding it is fine and
  draws no warning; only *calling* it does.
- **`setWarning()` is deprecated in favour of `setDestructive()`, which needs
  1.13.0.** The Disconnect button adds the `mod-warning` class directly. That
  is the class `setWarning()` applied before 1.13, it is still styled there
  (`button.mod-warning`, solid error background, with its own mobile rule), and
  it renders the same as what `setWarning()` now produces, which is
  `setDestructive().setCta()`.

`src/settings.ts` imports `obsidian` at runtime, so the unit tests cannot load
it. Changes there need checking in a real vault, and on 1.13 or later the
declarative path is the one you are looking at.

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
