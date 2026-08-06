# Stashwise for Obsidian

Your [Stashwise](https://stashwise.co) library and wiki, as notes in your vault.
Search them from anywhere in Obsidian, and send what you write back.

Stashwise saves things you find on the web, on social platforms and in video,
then reads them and builds a wiki of the topics that keep recurring. This plugin
brings that into the vault where you already think, so saved material sits
beside your own writing instead of behind another app.

## What it does

**Syncs your library into the vault.** Every save becomes a note with its
summary, key takeaways and source link. Every published wiki topic becomes its
own note, linked to the topics it relates to, so Obsidian's graph view renders
your actual knowledge graph rather than an empty circle.

**Searches without leaving the note you are writing.** A sidebar panel and two
commands query your whole library and wiki, then drop a link or a quoted callout
straight at the cursor.

**Sends your thinking back.** Anything you write underneath a synced note is
pushed to Stashwise as your note on that item, so it is there in the app and in
chat, not stranded in one vault.

**Runs on your phone.** Save something in the Stashwise app, open Obsidian
mobile, and the note is there.

## Your writing is never overwritten

This is the promise the whole plugin is built around, so it is worth stating
plainly.

Each synced note has a region Stashwise owns, marked by comments that stay
invisible in reading view:

```markdown
---
stashwise_id: 75a369c2-3d84-40dd-8026-373b86ac03e6
stashwise_type: topic
category: tool
mention_count: 1
tags: [tool]
---

%% stashwise:begin %%
# Jukdo

Jukdo is a traditional Korean folding knife, also known as a Korean folding
knife, as showcased in a saved video.

## Related
- [[Korean folding knife]] _(extends)_

## Sources
- [Agnes AI: Free AI Models](https://v.douyin.com/jCm-gDrfGRw/)
%% stashwise:end %%

## My notes

Everything down here is yours. It is never touched.
```

Everything between the markers is regenerated on every sync. Everything below
the end marker belongs to you: the plugin never edits it, and sends it up to
Stashwise instead.

If those markers are missing or duplicated, **the plugin refuses to write to
that file at all** and tells you it skipped it. It will not guess where your
text begins. A note you have to repair is recoverable; overwritten writing is
not.

## Install

Not yet in the community plugin directory, and there is no published release
yet, so build it:

```bash
git clone https://github.com/StashwiseAI/stashwise-obsidian.git
cd stashwise-obsidian
npm install && npm run build
```

Copy `main.js`, `manifest.json` and `styles.css` into
`<your vault>/.obsidian/plugins/stashwise/`, then enable **Stashwise** under
Settings, Community plugins.

Once releases exist, the three files will be attached to each one and this step
becomes a download.

## Connect

Settings, Stashwise, **Connect account**. Approve the pairing in the browser
that opens, or on iOS in the Stashwise app if you have it, and the plugin
connects within a few seconds.

You need a Stashwise account. The free plan works.

## Commands

| Command | What it does |
|---|---|
| Open search panel | Search sidebar, also on the ribbon |
| Search and insert a link | Find something, drop `[Title](url)` at the cursor |
| Search and insert a quote | Same, as a `> [!quote]` callout with the snippet |
| Save current note to Stashwise | Sends the note up as a library item |
| Save URL to Stashwise | Saves a URL from the selection or cursor line |
| Sync now | Pulls changes since the last sync |
| Full resync | Rebuilds everything and reconciles deletions |
| Connect account | Pairs this vault with your account |

Search results are also insertable by mouse from the sidebar panel.

## What lands in the vault

```
Stashwise/
  Saves/    one note per saved item
  Topics/   one note per published wiki topic, cross linked
```

The folder name is configurable. Nothing outside it is ever touched.

Filenames keep letters in any script, so a topic called 松露鳕鱼卷 gets a note
you can actually find.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Vault folder | `Stashwise` | Everything the plugin writes lives here |
| What to sync | Saves and wiki topics | Topics are what make the graph view useful |
| Sync every | 15 minutes | `0` syncs only when you ask |
| Delete notes for removed saves | Off | See below |
| API URL | Stashwise production | Point at a local backend while developing |

**Delete notes for removed saves is off on purpose.** Deleting something in
Stashwise should not silently remove a vault note you may have written your own
thinking underneath. Turn it on and removed items go to the system trash, where
they are still recoverable.

Deletions are reconciled on a full resync rather than every sync, because
detecting them means asking the server for every id you own.

## Your token

Connecting stores an access token in
`<vault>/.obsidian/plugins/stashwise/data.json`, unencrypted. That is how every
Obsidian plugin holding an API key works, but it has a consequence worth
knowing: **if you sync your vault through iCloud, Dropbox or Obsidian Sync, the
token syncs with it.**

**Disconnect** revokes it on the server, not just locally, so a copy that has
travelled elsewhere stops working.

The plugin talks only to Stashwise. It reads nothing outside its own folder
except the note you explicitly ask it to save.

## Development

```bash
npm install
npm run dev     # esbuild watch, emits main.js
npm test        # unit tests
npm run build   # typecheck, bundle, and the mobile safety gate
npm run e2e     # end to end against a real backend, see TESTING.md
```

Use a throwaway vault, never one you care about. Symlink the build output into
`<dev vault>/.obsidian/plugins/stashwise/`.

Two things that will save you time:

**Obsidian caches the plugin at load.** Reloading the app does not re-read a
symlinked `main.js`. Toggle the plugin off and on under Community plugins. Each
build prints a fingerprint and the plugin logs the one it is running, so the
console tells you whether you are testing what you just built.

**The build enforces mobile support.** `manifest.json` sets
`isDesktopOnly: false`, so the build fails on any NodeJS import and a
post-build check rejects `process.env`, `__dirname` or `Buffer` reaching the
bundle. That promise is why the plugin can run on a phone at all.

`TESTING.md` has the full guide, including how to run everything against a local
backend.

## License

MIT
