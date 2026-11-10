# 4A-Mods

Claude Code mods by 4AM. Mods are plugins that run inside Claude Code: they can draw on screen (a line above the prompt, a footer label, a side pane), add slash commands, and step in before Claude runs a tool.

| Mod | Commands | What it does |
|---|---|---|
| [Cache Keeper](#cache-keeper) | `/cache`, `/keepwarm`, `/board`, `/handoff` | Shows whether a chat's prompt cache is warm or cold and what a cold restart would cost, keeps big chats warm, asks before an expensive cold send, shows every local chat on one board, and hands a chat off to a fresh one |
| [Toggles](#toggles) | `/toggles` | Switches plugins, skills, MCP servers and mods on and off from one pane, shows what each costs in context, and saves the set as a profile |
| [Prompt Translate](#prompt-translate) | `/translate` | Translates the draft in the prompt box into English with one button, without sending it |
| [Plan Keeper](#plan-keeper) | none | Ticks a plan file's checkbox items once the task-list step of the same text is done, and tells a fresh or cleared chat which items are still open |

## Requirements

- **Claude Code 2.1.287 or later.** Check with `claude --version`. The mods work in the terminal and in the Desktop app's Code tab.
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
- **Mods** lists every mod on this computer: installed from a marketplace, in `~/.claude/mods`, or named in `CLAUDE_CODE_PLUGIN_DIRS`. A mod whose code reads `~/.claude/mods/switches.json` gets **On/Off** (off in every chat, `"<name>": false`) and, where it reads a `:hidden` key, **Shown/Hidden** (keeps working out of sight, `"<name>:hidden": true`); a mod with a pane gets **Open**. Each mod picks the change up within a few seconds, no reload. A mod without that switch says so: turn an installed one off in the Plugins tab, or remove a local one's folder.
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
- **Ticks** come at the Desktop app's wrap-up, at a turn's end, before a `/clear`, and after a `gh pr merge` that succeeds (not `--auto`, which only queues it). A step that is completed on the task list (the Desktop app's task list, `TodoWrite`, or `TaskCreate` and `TaskUpdate`; a subagent's own list does not count) ticks the item with the same text, ignoring case, spacing, `**bold**`, `` `code` `` and a closing period. A step named like a task's heading (`### Task 2: Matcher`, by its whole text or by `Matcher`) ticks every item under it; other headings tick nothing. A step that matches two items, or none, ticks nothing, so a plan with `Step 1: Write the failing test` in every task is never ticked by that step. The wrap-up checks the running step off, unless it stops on a question. Each completed step is held against a plan once: an item you untick by hand stays unticked, and steps finished before a plan became active tick nothing in it. Only `[ ]` turns into `[x]`: nothing else in the file moves, and a file with nothing to tick is not written.
- **A fresh or cleared chat** gets a note with the plan's open items (one by one when there are up to 8, else one row per heading with its open count) and a toast. The note asks Claude to name task-list steps after the plan's items or task headings, so they tick.

## Where the data lives

Everything stays on your machine, under `~/.claude/mods-data/`: Cache Keeper's session heartbeats and saved handoffs. Toggles writes its switches where Claude Code reads them (`enabledPlugins` and `skillOverrides` in `~/.claude/settings.json`, `disabledMcpServers` in `~/.claude.json`), its profiles to `~/.claude/mods-data/plugin-toggles-profiles.json`, and the Mods tab's switches to `~/.claude/mods/switches.json`. Plan Keeper writes only the `[x]` of the active plan file and keeps nothing else. Prompt Translate keeps nothing; it sends your draft to Haiku through Claude Code's own client, only when you press `🌐 EN` or run `/translate`. None of the others makes network calls of its own. Cache Keeper's keep-warm pings are small model requests, sent only while `/keepwarm` is on.

## License

MIT. See [LICENSE](LICENSE).
