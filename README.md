# 4A-Mods

Claude Code mods by 4AM. Mods are plugins that run inside Claude Code: they can draw on screen (a line above the prompt, a footer label, a side pane), add slash commands, and step in before Claude runs a tool.

| Mod | Commands | What it does |
|---|---|---|
| [Cache Keeper](#cache-keeper) | `/cache`, `/keepwarm`, `/board`, `/handoff` | Shows whether a chat's prompt cache is warm or cold and what a cold restart would cost, keeps big chats warm, asks before an expensive cold send, shows every local chat on one board, and hands a chat off to a fresh one |
| [Toggles](#toggles) | `/toggles` | Switches plugins, skills, MCP servers and mods on and off from one pane, shows what each costs in context, and saves the set as a profile |
| [Prompt Translate](#prompt-translate) | `/translate` | Translates the draft in the prompt box into English with one button, without sending it |
| [Plan Keeper](#plan-keeper) | `/plan-keeper` | Ticks a plan file's checkbox items once the task-list step of the same text is done, shows the plan's progress above the prompt and in a pane, and tells Claude when a task list ends with plan items open |
| [Savvy Progress](#savvy-progress) | `/agents-info` | A live panel of every subagent: model, effort, progress, context, estimated cost and time. By johnnyvizz |
| [Filetree](#filetree) | `/filetree` | An IDE-style file tree pane: the files Claude reads, writes and commits, with git status, diffs, search, previews and guarded paths. By Kurt Buhler |

## Requirements

- **Claude Code 2.1.287 or later.** Check with `claude --version`. The mods work in the terminal and in the Desktop app's Code tab. Filetree needs 2.1.306 or later.
- **Mods turned on for your account.** Run `claude plugin test` in any folder: "no hooks module to load" means mods can load, and "served off" means they can't yet.

## Install

```bash
claude plugin marketplace add smashedonehd/4a-mods
```

```bash
claude plugin install cache-keeper@4a-mods
claude plugin install plugin-toggles@4a-mods
claude plugin install plan-keeper@4a-mods
claude plugin install prompt-translate@4a-mods
claude plugin install savvy-progress@4a-mods
claude plugin install filetree@4a-mods
```

Then open a new chat. A mod loads when a chat starts, and `/reload-plugins` does not reload it.

**Update:** run `claude plugin marketplace update 4a-mods`, then `claude plugin update cache-keeper@4a-mods` (and `plugin-toggles@4a-mods`), then open a new chat.

**Remove:** `claude plugin uninstall cache-keeper@4a-mods` (or `plugin-toggles@4a-mods`).

## Cache Keeper

Every request re-reads the whole chat. From the prompt cache that costs a tenth of the normal input price. Once the cache expires (after 5 minutes or 1 hour idle, depending on your setup), the next message writes the whole chat into the cache again at up to 2x the input price. On a 400k-token chat that one message can cost a few dollars, while keeping the cache warm costs cents.

- **Line above the prompt:** `● cache warm 42m │ ctx 412k │ rewrite ≈ $3.30 │ session $5.12`. It turns yellow 5 minutes before the cache expires and shows a `keep warm` button. Your 5-hour and weekly plan limits show there too, yellow at 80% and red at 95%. Click the cache status (or press `w` while the line has the focus) for a menu: keep warm for 1, 4 or 8 hours, or stop it.
- **In the Desktop app** the line is a band of two rows without key hints. The first row has the cache, a `keep warm` dropdown (off, 1, 4 or 8 hours) and the context and limit gauges; the session cost is left out. The second has the rewrite cost and the handoff: `handoff` with a dropdown beside it, `then clear` or `keep chat`, and `clear and continue` in its place once this chat's handoff is in. Tags `caveman`, `jev` and `lsp` show which of those clear and continue turns on again in the fresh chat, green when on; a click flips that without running anything, and a plain `/clear` resets them. In a narrow window the labels get shorter.
- **`/keepwarm [hours|off]`:** keeps this chat's cache warm, 4 hours by default, with a small ping shortly before it would expire. If a ping writes to the cache instead of reading it, keep warm turns itself off and tells you.
- **Cold-send guard:** if you send a message into a chat over 150k tokens after its cache expired, it asks first: Send anyway, Compact first, or Cancel.
- **`/board`:** every local chat in one pane, with chats waiting on you first, then working ones, then the ones whose cache cools soonest. Each row shows state, context size, cache, cost, and running agents, with a keep-warm button.
- **Handoff:** the `handoff` button (or `/handoff`) runs the bundled `/session-handoff` skill, saves the handoff, then clears the chat and sends the handoff as the fresh chat's first prompt. The handoff is the last answer with the `# Session Handoff` heading, also when a Stop hook makes Claude answer again after it. A short fresh chat is far cheaper than a huge one. The prompt opens with the handoff's age and, read from git while the chat clears, the folder's live state (branch, `git status --short`, last 3 commits, stashes, worktrees), so the fresh chat starts from the folder as it is, not as the handoff remembers it; outside a git repository, or when git gives no answer, the handoff goes alone. Open items in the handoff say who wants them: `User asked`, `My own idea` (the prompt tells the fresh chat to confirm those with you first) or `Deferred by rule`. `/handoff keep` saves the handoff and leaves the chat as it is. The handoff is also kept per folder for 12 hours, so after a restart `/handoff continue` (or `/session-handoff continue`, or `go`) clears the chat and sends it, once. A new message in the chat that made the handoff discards it; the first message in a fresh chat does not.
- **`/cache`** shows status and settings: `ttl 5|60|auto`, `guard on|off`, `big 150k`, `alerts on|off`.

Prices come from the Claude API price list. On a subscription plan they show up as usage against your limits, not a bill.

## Toggles

Every skill, plugin and MCP server that is on takes context in every turn, whether Claude uses it or not. Toggles shows what each one costs and switches it from one pane.

- **`/toggles`**, or the `⚙ Toggles` button beside the mode hint, opens the pane. It has five tabs: Profiles, Plugins, Skills, MCP and Mods.
- **The bar** at the top shows how many tokens of the tab are in every turn, one coloured segment per source, counted the way `/context` counts this chat. A `~` marks an estimate from the files where the chat has no count yet.
- **Your own skills** get a four-way switch: On lists the skill with its description, Name lists it by name alone, User hides it from Claude but keeps `/name` for you, and Off hides it from both. A plugin's skills switch with their plugin, and their row leads to it. A warning shows when skills don't fit the listing budget.
- **Plugins and MCP servers** switch On or Off. Point at a row to see what it adds. MCP switches apply to the current project; reconnect with `/mcp`.
- **Mods** lists every mod on this computer: installed from a marketplace, in `~/.claude/mods`, or named in `CLAUDE_CODE_PLUGIN_DIRS`. A mod whose code reads `~/.claude/mods/switches.json` gets **On/Off** (off in every chat, `"<name>": false`) and, where it reads a `:hidden` key, **Shown/Hidden** (keeps working out of sight, `"<name>:hidden": true`); a mod with a pane gets **Open**. In the Desktop app On/Off is a green switch and Shown/Hidden an eye; the terminal shows the words. Each mod picks the change up within a few seconds, no reload. A mod without that switch says so: turn an installed one off in the Plugins tab, or remove a local one's folder.
- **Profiles** save which plugins are on and where each skill's switch stands, and apply all of it in one click.
- **Changes** are written to settings at once. Plugin and skill changes reach the current chat after **Apply now** (`/reload-plugins`), or in a new chat. Apply now waits up to three seconds for Claude Code to read the new settings in, and reloads only once it has. A mod you switch, Toggles itself included, takes effect only in a new chat.
- **A switch set higher up** (the project's `.claude/settings.json` or `.claude/settings.local.json`, `--settings`, managed settings) is not written over: the press says where it is set.

## Prompt Translate

Write a prompt in any language, press one button, and send it in English.

- **`🌐 EN`** above the prompt reads the draft in the prompt box, has Haiku translate it into English, and puts the translation in its place. Nothing is sent: you press Enter.
- **`/translate <text>`** translates the text after the command and puts it in the prompt box. Sending the command takes the draft with it, so the text goes after the name.
- **Kept verbatim:** code blocks, inline code, file paths, @-mentions, slash commands, URLs, identifiers and placeholders such as `[Image #1]`. Text already in English comes back unchanged.
- **The draft is left as it is** when it is empty, when the call fails or the reply is cut short (a toast says why), or when you typed on while the translation ran.

## Plan Keeper

A plan is written once and then left. Ticking its checkboxes is Claude's job, and Claude forgets, so minutes after it is written the plan no longer says what is done. Plan Keeper ticks the plan from what the task list recorded, not from what Claude remembers.

- **The active plan** is the last plan file this chat wrote (a `.md` inside a folder named `plans`: `~/.claude/plans`, `docs/plans`, `docs/superpowers/plans`) or the last plan you named in a prompt (a `.md` with a checkbox, in a `plans` folder or with "plan" in its name). A subagent's writes don't count. A chat that starts or clears with neither picks the newest plan changed in the last 7 days that has an open item and is this folder's. That is a plan in `~/.claude/plans` that names the folder, or names a file in it that exists and lies outside any nested project (a folder on the way with its own `.git` or `CLAUDE.md`: another repository, a worktree), or a plan in the folder's own `docs/superpowers/plans`, `docs/plans` or `plans`. `D:\app` does not name `D:\app-old`. A chat in the home folder or a drive root picks none by folder, and after `/resume` or `/branch` no plan is active until the chat writes or names one. No match, no plan: Plan Keeper does nothing.
- **Ticks** come at the Desktop app's wrap-up, at a turn's end, before a `/clear`, after a `gh pr merge` that succeeds (not `--auto`, which only queues it), at the end of the batch of tool calls that completes the last step of the task list, and before the plan changes or is let go (another plan written, named or picked, `/plan-keeper off`, `stop tracking`). A step that is completed on the task list (the Desktop app's task list, `TodoWrite`, or `TaskCreate` and `TaskUpdate`; a subagent's own list does not count) ticks the item with the same text, ignoring case, spacing, `**bold**`, `` `code` `` and a closing period. A step named like a task's heading (`### Task 2: Matcher`, by its whole text or by `Matcher`) ticks every item under it; other headings tick nothing. A step that matches two items, or none, ticks nothing, so a plan with `Step 1: Write the failing test` in every task is never ticked by that step. The wrap-up checks the running step off, unless it stops on a question. Each completed step is held against a plan once: an item you untick by hand stays unticked, and steps finished before a plan became active tick nothing in it. Only `[ ]` turns into `[x]`: nothing else in the file moves, and a file with nothing to tick is not written.
- **A fresh or cleared chat** gets a note with the plan's open items (one by one when there are up to 8, else one row per heading with its open count) and a toast. The note asks Claude to name task-list steps after the plan's items or task headings, so they tick.
- **The band** above the prompt is one row: the plan's name, a bar, done out of all items, and the next open item. When the task list is finished and items are still open it says `task list done, N open`; with nothing open it says `plan complete`, and the plan is let go at your next prompt (a slash command does not count). A finished plan you untick by hand before that prompt is kept. `plan` opens the pane, `✕` hides the band in this chat, also after `/clear`, until `/plan-keeper show` or `on`, or `show band` in the pane; after `/resume` or `/branch` it is shown again. The setting `band: off` removes it everywhere.
- **The pane** (`/plan-keeper` opens and closes it) lists the plan by heading with a bar and count each, the open items under each heading (up to 6), and the completed steps that named no single item, so a plan that stays unticked shows why. `switch plan` offers up to 8 of the folder's other recent plans with open items, `stop tracking` lets the plan go for this chat. A plan file that was moved or deleted is named there as unreadable, and draws no band.
- **`/plan-keeper off`** stops tracking in this chat, also across `/clear`, until `/plan-keeper on` or `track again`, a plan file in a `plans` folder this chat writes or edits, one you name, or one picked under `switch plan`; `/resume` and `/branch` start with tracking on. **`/plan-keeper on`** picks the folder's newest plan when none is tracked, keeps the tracked one otherwise, and shows the band. **`/plan-keeper <path>`** tracks that file, if it has a checkbox item. **`/plan-keeper hide`** and **`show`** switch the band.
- **A task list that ends with plan items open** is put to Claude once per finished list, with the results of the tool call that ended it: the open items, the completed steps that named none, and the request to tick what is done in the file or to say what is left. Ticking items afterwards brings no second note; a list that completes further steps and again ends short does, so tasks created and completed one at a time (`TaskCreate`, `TaskUpdate`) are put after each. That same moment ticks first. A step named by its task number alone (`Task 2`) ticks that task's items; two tasks with the same number tick neither.

Not checked in a running app: the tests drive the module against a fake host, and the engine's own validator draws the band and the pane on its four surfaces, so how they look, and that the closing note reaches Claude after the Desktop app's wrap-up, were not seen there.

## Savvy Progress

By [johnnyvizz](https://github.com/johnnyvizz), MIT, copied unchanged from [johnnyvizz/claude-kit](https://github.com/johnnyvizz/claude-kit/tree/main/plugins/savvy-progress) (version 1.2.1). Details in [savvy-progress/README.md](savvy-progress/README.md).

- **Agents panel** (`/agents-info`): running, finished and planned subagents with model, effort, task progress, context fill, estimated cost and time.
- **Progress bar** above the prompt, for the [savvy-flow](https://github.com/johnnyvizz/claude-kit/tree/main/plugins/savvy-flow) skill. That skill and its `savvy-*` agents are not part of 4A-Mods.
- Without savvy-flow, set `autoOpen` to `any` so the panel opens by itself, once per session, when the first subagent starts: `claude plugin install savvy-progress@4a-mods --config autoOpen=any`.
- The cost is an estimate from token counts and a built-in price table, not your bill.

## Filetree

By [Kurt Buhler](https://github.com/data-goblin), MIT, copied unchanged from [data-goblin/claude-code-filetree](https://github.com/data-goblin/claude-code-filetree) (version 0.8.2). Details in [filetree/README.md](filetree/README.md).

- **Tree pane** (`/filetree`): the chat's folder with git status, the branch, and a column of date, size or line count. The files Claude reads, writes and commits shimmer.
- **Search, diff and preview**: by name or inside files, a diff of a changed file or folder against `HEAD`, and previews of code, Markdown, images and PDF.
- **Guards**: files and folders Claude may not edit. They refuse Edit and Write, but for a shell command they only ask, and only when the command names the path.
- It needs Claude Code 2.1.306 or later (upstream's requirement; on 2.1.282 it does not load).
- On Windows the image, PDF and Word previews do not draw.
- Three defaults change where a chat works or what opens: the pane opens with every chat, and the chat moves with `/cd` when you jump to a folder or when Claude works in another repository (two writes there are enough). To install with them off: `claude plugin install filetree@4a-mods --config start=off --config jump=tree --config work=off`.

## Where the data lives

Everything stays on your machine, under `~/.claude/mods-data/`: Cache Keeper's session heartbeats and saved handoffs. Toggles writes its switches where Claude Code reads them (`enabledPlugins` and `skillOverrides` in `~/.claude/settings.json`, `disabledMcpServers` in `~/.claude.json`), its profiles to `~/.claude/mods-data/plugin-toggles-profiles.json`, and the Mods tab's switches to `~/.claude/mods/switches.json`. Plan Keeper writes only the `[x]` of the active plan file and keeps nothing else. Prompt Translate keeps nothing; it sends your draft to Haiku through Claude Code's own client, only when you press `🌐 EN` or run `/translate`. Savvy Progress writes no files of its own; it reads only Claude Code's settings and environment variables. Filetree keeps its pane state, recent folders, guard list and its own `shimmer` setting in Claude Code's plugin state, store and settings, writes `keybindings.json` only on `/filetree keys` after you confirm, and a code audit found no network calls; it runs `git` and other local programs, listed in [filetree/README.md](filetree/README.md#data-and-network). None of the others makes network calls of its own. Cache Keeper's keep-warm pings are small model requests, sent only while `/keepwarm` is on.

## License

MIT. See [LICENSE](LICENSE). Savvy Progress is MIT by johnnyvizz, with its own [LICENSE](savvy-progress/LICENSE). Filetree is MIT by Kurt Buhler, with its own [LICENSE](filetree/LICENSE).
