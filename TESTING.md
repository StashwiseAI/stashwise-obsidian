# Testing guide: Stashwise for Obsidian

Everything below is uncommitted work sitting in two worktrees. Nothing has been
pushed, no PR exists, and nothing has been deployed.

| | Path | Branch |
|---|---|---|
| Plugin | `.wt-stashwise-obsidian-scaffold` | `scaffold` (new repo `stashwise-obsidian`) |
| Backend | `.wt-flow-app-obsidian-sync` | `feat/agent-sync-endpoint` |

## Read this first: which parts work against which backend

The plugin talks to four endpoints. Three already exist in production. **One is
new and lives only in the backend worktree.**

| Feature | Endpoint | Works against prod? |
|---|---|---|
| Search and insert | `POST /agent/search` | Yes |
| Save current note | `POST /agent/notes` | Yes |
| Save URL | `POST /content` | Yes |
| **Sync** | `GET /agent/sync` | **No. Not deployed.** |

So: connect, search, and capture can all be tested against the real
`stashwise-api.fly.dev`. **Sync needs the local backend running from the
worktree.** If you try to sync against prod you will get a visible
`Stashwise sync failed: ...` notice, which is the correct behaviour, not a bug.

Your existing agent tokens already carry `library:read library:write`, which is
what the plugin needs. A token with only `library:read` will 403 on capture.

---

## 1. Automated checks (about a minute, no setup)

```bash
cd ~/Developer/stashwise/.wt-stashwise-obsidian-scaffold
npm install          # first time only
npm run build        # typecheck, bundle, and the mobile safety gate
npm test             # 134 unit tests
```

`npm run build` ends with `Mobile safety check passed: ... external requires =
[obsidian]`. That line is the `isDesktopOnly: false` promise being enforced: the
build fails if a NodeJS builtin is imported, and the post-build script fails if
`process.env`, `__dirname`, `Buffer` or a non-`obsidian` require reaches the
bundle.

Backend:

```bash
cd ~/Developer/stashwise/.wt-flow-app-obsidian-sync/backend
uv sync
uv run ruff check app
uv run pytest tests/test_agent_sync.py -q            # 18 tests
uv run pytest tests/test_agent_search.py tests/test_agent_save_cap.py \
              tests/test_agent_token_auth.py tests/test_auth_cli_device_code.py -q
```

Run targeted files only. The full suite hangs: `test_raw_saves.py` and
`test_oauth_mcp.py` deadlock when collected together, which predates this work.

## 2. End to end (one command)

```bash
cd ~/Developer/stashwise/.wt-stashwise-obsidian-scaffold
npm run e2e
```

This seeds a throwaway SQLite database, starts the backend on port 8078, runs
the plugin's **real** sync engine over **real** HTTP into a **real** folder at
`/tmp/stashwise-obsidian-e2e-vault`, then tears everything down. It touches no
account of yours and no real vault.

Expect `29/29 checks passed`. It covers:

1. First sync into an empty vault: 3 saves, 2 cross-linked topics
2. Incremental sync with no changes: writes nothing
3. You edit your zone: pushed to `personal_notes`, survives the rewrite, is not
   re-pushed on the next run
4. You delete a marker: the file is reported and **left completely untouched**
5. Full resync after deleting the vault: rebuilds, reseeds your notes

Afterwards, read what it produced:

```bash
cat /tmp/stashwise-obsidian-e2e-vault/Stashwise/Saves/how-agents-remember-e2e-save.md
cat /tmp/stashwise-obsidian-e2e-vault/Stashwise/Topics/agent-memory.md
```

## 3. Obsidian on desktop

A throwaway dev vault is already wired up, with the plugin symlinked in and
pre-enabled. Never point this at `Stashwise/` or `Stashwise Local/`.

```bash
open -a Obsidian ~/Developer/stashwise/.wt-stashwise-obsidian-scaffold/dev-vault
```

If Obsidian asks to trust the vault, say yes. Settings, Community plugins,
Stashwise should already be on.

### 3a. Connect (works against prod)

1. Settings, Stashwise, **Connect account**.
2. A modal shows a link and a code. Your browser should open; if not, tap the
   link. Authorize.
3. The modal closes and a notice names your account and plan.
4. Settings now says *Connected*, with your email and tier.

Check the warning text under the account section is visible: the token is
stored unencrypted in `dev-vault/.obsidian/plugins/stashwise/data.json`.

### 3b. Search and cite (works against prod)

1. Click the search icon in the left ribbon. A Stashwise panel opens on the right.
2. Type a query. Results appear after you pause typing.
3. Switch the scope dropdown between Everything, Saves and Wiki topics.
4. Open `Scratch.md`, put the cursor in it, then in the panel click:
   - the **link** icon: inserts `[Title](url)`
   - the **quote** icon: inserts a `> [!quote]` callout with the snippet
   - the **external link** icon: opens the source
5. Command palette, **Stashwise: Search and insert a link**. Type, press Enter.
   Text lands at the cursor without touching the mouse.

Worth trying deliberately: type fast and then delete back. Results should never
flicker to a stale set. That is the out-of-order guard.

### 3c. Capture (works against prod)

1. Write a note in `Scratch.md` with a `# Heading` and a paragraph.
2. Command palette, **Stashwise: Save current note to Stashwise**.
3. A notice confirms. The note gains `stashwise_id:` in its frontmatter.
4. Run the same command again. It should say **Updated**, not create a second
   Library item. Check stashwise.co: there should be exactly one.
5. Paste a URL on a line, put the cursor on it, run **Stashwise: Save URL to
   Stashwise**.

If you are on a free plan and past the cap, you should see the backend's own
wording about the limit, not invented copy.

### 3d. Sync (needs the local backend)

Start the backend from the worktree:

```bash
cd ~/Developer/stashwise/.wt-flow-app-obsidian-sync/backend
cp ~/Developer/stashwise/flow-app/backend/.env .        # if not already there
uv sync && uv run alembic upgrade head
make dev                                                 # 127.0.0.1:8000
```

**Connect account cannot reach a local backend.** `/auth/cli/start` builds its
verification_uri from `webapp_base_url`, which is the hosted web app, so
authorizing there pairs the code with the hosted backend. Local polling then
waits forever. Mint a token directly instead:

```bash
DATABASE_URL="sqlite+aiosqlite:///./data/flowvault.db" \
TOKEN_USER_EMAIL="scottqlai@gmail.com" \
  uv run python scripts/mint_local_token.py
```

Then in Obsidian: Settings, Stashwise, Advanced. Set **API URL** first
(`http://127.0.0.1:8000/api/v1`), click out of the field, then paste the token
into **Paste an access token** and press **Use token**. Order matters: the token
is validated against whatever API URL is currently saved.

Two things that will waste your time otherwise:

- **Opening the dev vault.** `open -a Obsidian <path>` only focuses the running
  app, and `obsidian://open` fails for a vault Obsidian has never seen. Use the
  vault switcher, **Open folder as vault**, then `Cmd+Shift+G` in the picker to
  type the path (the parent starts with a dot, so it is hidden by default).
- **A stale dev database.** If the backend 500s with `no such column`, the dev
  DB is behind the code. See [[orphaned-alembic-revision-dev-db]] in memory:
  plain `alembic stamp head` fails the same way `upgrade` does, and only
  `stamp head --purge` clears it.

Now:

1. Command palette, **Stashwise: Sync now**. A notice reports what was written.
2. A `Stashwise/` folder appears with `Saves/` and `Topics/`.
3. Open a save note. Confirm: frontmatter with `stashwise_id`, a source callout,
   the summary, key takeaways, and the two `%% stashwise:begin %%` /
   `%% stashwise:end %%` markers (invisible in reading view, visible in source
   view).
4. **Open graph view.** Topic notes should link to each other. This is the whole
   point of syncing entities.

**The test that matters most.** Under the end marker, type something of your
own. Run **Sync now** again. Your text must still be there, and it should now
appear as the note in the Stashwise web app.

**The other test that matters.** Delete the `%% stashwise:end %%` line from a
note. Sync. You should get a notice saying a note was skipped because its
markers were edited, and **the file must be byte-identical to how you left it**.
The plugin never guesses where your text starts.

Also try:
- **Stashwise: Full resync** rebuilds everything from scratch.
- Delete a save in the web app, then Full resync. With *Delete notes for removed
  saves* off (the default) nothing is deleted. Turn it on and the note goes to
  the system trash, recoverable from Finder.
- Change the sync interval to `0`. Automatic syncing stops; only manual works.

## 4. Obsidian on mobile

The point of this is that the plugin runs at all, since `isDesktopOnly: false`
means no NodeJS anywhere in the bundle.

Easiest route: put the dev vault somewhere Obsidian Sync or iCloud can see it,
or copy `main.js`, `manifest.json` and `styles.css` into
`<vault>/.obsidian/plugins/stashwise/` on the phone.

1. Enable the plugin. It should load without error.
2. **Connect account.** The modal must show a tappable link and a code you can
   select and copy. `window.open` is unreliable in the mobile webview, so the
   link is the real path and the popup is only a convenience.
3. Search from the panel. This exercises `requestUrl`, which is what gets past
   the mobile webview's CORS enforcement.
4. **The mobile loop:** save something in the Stashwise app, wait for analysis,
   then switch to Obsidian. Returning to the foreground triggers a sync if the
   interval has elapsed, so the note should appear without you doing anything.

Note that sync on mobile also needs a reachable backend. Pointing a phone at
`127.0.0.1` will not work; you would need `make dev-lan` and your machine's LAN
address, or wait until the endpoint is deployed.

## 5. Known limits and deliberate choices

- **`GET /agent/sync` is not in production.** Merging the flow-app PR deploys
  it, and that needs your explicit authorization.
- **Deletion detection costs a full manifest**, so it runs about daily or on
  Full resync, not on every tick.
- **A detached note stays detached** until you delete the file (it gets rebuilt)
  or restore the markers. This is intentional.
- **The token is plaintext** in the vault, as with every Obsidian plugin holding
  an API key. Disconnect revokes it server side by matching `token_prefix`.
- **Not built:** community plugin submission, and chat in a side pane.

## 6. Cleanup

```bash
rm -rf /tmp/stashwise-obsidian-e2e-vault /tmp/stashwise-obsidian-e2e.db
pkill -f "uvicorn app.main:app --host 127.0.0.1 --port 8078"
```

To reset the dev vault, delete `dev-vault/Stashwise/` and
`dev-vault/.obsidian/plugins/stashwise/sync-state.json`, then sync again.
