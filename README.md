# 4A-Mods

Claude Code mods by 4AM. Mods are plugins that run inside Claude Code: they can draw on screen (a line above the prompt, a footer label, a side pane), add slash commands, and step in before Claude runs a tool.

| Mod | Commands | What it does |
|---|---|---|
| [Cache Keeper](#cache-keeper) | `/cache`, `/keepwarm`, `/board`, `/handoff` | Shows whether a chat's prompt cache is warm or cold and what a cold restart would cost, keeps big chats warm, asks before an expensive cold send, shows every local chat on one board, and hands a chat off to a fresh one |
| [Model Router](#model-router) | `/route` | Gives Claude one agent type per model and effort tier, so each delegated task runs on the model it needs: Haiku for lookups, Sonnet for standard coding, Opus for hard engineering, and Fable only after `/route fable` |

## Requirements

- **Claude Code 2.1.287 or later.** Check with `claude --version`. The mods work in the terminal and in the Desktop app's Code tab.
- **Mods turned on for your account.** Run `claude plugin test` in any folder: "no hooks module to load" means mods can load, and "served off" means they can't yet.

## Install

```bash
claude plugin marketplace add smashedonehd/4a-mods
```

```bash
claude plugin install cache-keeper@4a-mods
claude plugin install model-router@4a-mods
```

Then open a new chat. A mod loads when a chat starts, and `/reload-plugins` does not reload it.

**Update:** run `claude plugin marketplace update 4a-mods`, then `claude plugin update cache-keeper@4a-mods` (and `model-router@4a-mods`), then open a new chat.

**Remove:** `claude plugin uninstall cache-keeper@4a-mods` (or `model-router@4a-mods`).

## Cache Keeper

Every request re-reads the whole chat. From the prompt cache that costs a tenth of the normal input price. Once the cache expires (after 5 minutes or 1 hour idle, depending on your setup), the next message writes the whole chat into the cache again at up to 2x the input price. On a 400k-token chat that one message can cost a few dollars, while keeping the cache warm costs cents.

- **Line above the prompt:** `● cache warm 42m │ ctx 412k │ rewrite ≈ $3.30 │ session $5.12`. It turns yellow 5 minutes before the cache expires and shows a `keep warm` button. Your 5-hour and weekly plan limits show there too, yellow at 80% and red at 95%. Click the cache status (or press `w` while the line has the focus) for a menu: keep warm for 1, 4 or 8 hours, or stop it.
- **In the Desktop app** the line is a band of two rows without key hints. The first row has the cache, a `keep warm` dropdown (off, 1, 4 or 8 hours) and the context and limit gauges; the session cost is left out. The second has the rewrite cost and the handoff: `handoff` with a dropdown beside it, `then clear` or `keep chat`, and `clear and continue` in its place once this chat's handoff is in. Tags `caveman`, `jev` and `lsp` show which of those clear and continue turns on again in the fresh chat, green when on; a click flips that without running anything, and a plain `/clear` resets them. In a narrow window the labels get shorter.
- **`/keepwarm [hours|off]`:** keeps this chat's cache warm, 4 hours by default, with a small ping shortly before it would expire. If a ping writes to the cache instead of reading it, keep warm turns itself off and tells you.
- **Cold-send guard:** if you send a message into a chat over 150k tokens after its cache expired, it asks first: Send anyway, Compact first, or Cancel.
- **`/board`:** every local chat in one pane, with chats waiting on you first, then working ones, then the ones whose cache cools soonest. Each row shows state, context size, cache, cost, and running agents, with a keep-warm button.
- **Handoff:** the `handoff` button (or `/handoff`) runs the bundled `/session-handoff` skill, saves the handoff, then clears the chat and sends the handoff as the fresh chat's first prompt. The handoff is the last answer with the `# Session Handoff` heading, also when a Stop hook makes Claude answer again after it. A short fresh chat is far cheaper than a huge one. The handoff is also kept per folder for 12 hours, so after a restart `/handoff continue` (or `/session-handoff continue`, or `go`) clears the chat and sends it, once. A new message in the chat that made the handoff discards it; the first message in a fresh chat does not.
- **`/cache`** shows status and settings: `ttl 5|60|auto`, `guard on|off`, `big 150k`, `alerts on|off`.

Prices come from the Claude API price list. On a subscription plan they show up as usage against your limits, not a bill.

## Model Router

Claude Code runs a subagent on its parent's model unless told otherwise, so a grep can run on Opus and a hard refactor on Haiku. Model Router turns each tier of its table (`model-router/routing.json`) into an agent type with that tier's model and effort, and tells Claude which type fits which task. Claude picks, because it sees the whole conversation and judges a task better than keywords or a small model reading one prompt.

| Agent type | Model, effort | For |
|---|---|---|
| `model-router:quick` | Haiku, low | find, list, grep, read, check a fact |
| `model-router:light` | Haiku, medium | summarize, extract, sweep many files, a small mechanical edit |
| `model-router:standard` | Sonnet, medium | well-specified coding, tests, ordinary bugs, docs |
| `model-router:deep` | Opus, high | architecture, multi-file refactors, tricky bugs, reviews |
| `model-router:long` | Opus, xhigh | long autonomous runs over a whole codebase |
| `model-router:frontier` | Fable, high | only with `/route fable` on, and then only after Opus fell short on the same task |

- **Safety net:** a general agent Claude starts with nothing set runs on Opus at medium effort. A general or mapped built-in agent (Explore, Plan) given only a model runs at the effort of that model's first tier (Haiku at low, Sonnet at medium), or at medium for Opus like the default, instead of inheriting the main chat's effort. A tier type, a model and effort Claude set, an effort alone, a fork, and a custom agent type with its own model are left as they are. No Agent call is ever refused or delayed, and the hook makes no model calls.
- **The main chat is never switched.** Changing the model there would throw away its prompt cache; pick its model with `/model` yourself.
- **Staying current:** the tiers name aliases, so a new Opus or Sonnet is used without a change. Which tier gets which line and effort changes through a pull request (`model-router/UPDATING.md`), and a plugin update brings it. The status line warns when the table is over 30 days old.
- **`/route`** routes from Haiku up to Opus, which is the default: the Fable type is hidden from Claude. An Agent call that names the Fable type moves to `model-router:long`. A call whose model is Fable runs on Opus instead, at xhigh or at the effort Claude set, and keeps its own type (`{model: 'fable'}` on Explore stays Explore). The Fable type given a model below Fable only moves to `model-router:long` and keeps that model. These calls are not capped and can still run on Fable:
  - a custom agent type whose own definition picks Fable;
  - in a Fable main chat, a call that inherits the main chat's model: a fork, a custom type with no model, a general or Plan agent given only an effort, and, after `/route fill off`, a general or Plan agent with nothing set;
  - any subagent when `CLAUDE_CODE_SUBAGENT_MODEL=fable` is set, since the hook never sees that model;
  - a workflow `agent()` or a mod's `$.agent.spawn` with Fable, since neither passes through the Agent tool call.
- **`/route fable`** routes from Haiku up to Fable. Both stay set across chats and show the agent types, the default, and how many Agent calls went where, so with Fable on, `/route fable` shows them without closing it; the status line shows the range (`router haiku → opus`). `/route fill off` turns the safety net off, `/route stats reset` clears the counts.
- **Updating from 2.0.0** starts at Opus, since 2.0.0 stored no range: run `/route fable` once to keep Fable.

If you installed the earlier Model Router from the `smashedonehd-mods` marketplace, uninstall it first, or both will hook the same Agent calls.

## Where the data lives

Everything stays on your machine, under `~/.claude/mods-data/`: Cache Keeper's session heartbeats and saved handoffs. Model Router keeps only its settings and call counts in the plugin store. Neither makes network calls of its own. Cache Keeper's keep-warm pings are small model requests, sent only while `/keepwarm` is on.

## License

MIT. See [LICENSE](LICENSE).
