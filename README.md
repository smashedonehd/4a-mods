# 4A-Mods

Claude Code mods by 4AM. Mods are plugins that run inside Claude Code: they can draw on screen (a line above the prompt, a footer label, a side pane), add slash commands, and step in before Claude runs a tool.

| Mod | Commands | What it does |
|---|---|---|
| [Cache Keeper](#cache-keeper) | `/cache`, `/keepwarm`, `/board`, `/handoff` | Shows whether a chat's prompt cache is warm or cold and what a cold restart would cost, keeps big chats warm, asks before an expensive cold send, shows every local chat on one board, and hands a chat off to a fresh one |
| [Model Router](#model-router) | `/route` | Gives Claude one agent type per model and effort tier, and routes each delegated task to the tier it needs: Haiku for lookups, Sonnet for standard coding, Opus for hard engineering, and Fable only after `/route fable` |

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

Claude Code runs a subagent on its parent's model unless told otherwise, so a grep can run on Opus and a hard refactor on Haiku. Model Router turns each tier of its table (`model-router/routing.json`) into an agent type with that tier's model and effort, and tells Claude which type fits which task. With auto routing on, which is the default, a routing policy picks the tier of every Agent call instead.

| Agent type | Model, effort | For |
|---|---|---|
| `model-router:quick` | Haiku, low | find, list, grep, read, check a fact |
| `model-router:light` | Haiku, medium | summarize, extract, sweep many files, a small mechanical edit |
| `model-router:standard` | Sonnet, medium | well-specified coding, tests, ordinary bugs, docs |
| `model-router:deep` | Opus, high | architecture, multi-file refactors, tricky bugs, reviews |
| `model-router:long` | Opus, xhigh | long autonomous runs over a whole codebase |
| `model-router:frontier` | Fable, high | only with `/route fable` on, and then only after Opus fell short on the same task |

- **Auto routing:** before each Agent call but a fork, a small router (Sonnet at low effort) reads the call's type, description and prompt (a very long prompt cut to its head and tail) and names the tier and the kind of task. A review, security or architecture task is lifted to at least `model-router:deep`. The call then runs on that tier's model and effort, and a call to one of the tier types moves to the routed tier's type. What Claude asked for explicitly is a floor: a model or effort set on the call, a tier type, or a type named `<model>-<effort>` such as `opus-xhigh`. The router may raise such a call but never lowers it: when the routed tier is below the request, the call keeps what Claude asked for (still under the Opus cap). A general or built-in agent with nothing set asks for nothing, so the router may send it below the safety net's Opus at medium. A custom agent type whose own definition picks a model is routed like a general agent, since the hook cannot see that definition. It never routes to Fable, and under `/route fable` a call naming the Fable type or the Fable model keeps it. If the router fails, is refused, times out (8 seconds) or answers nonsense, the safety net below decides, and a task whose type or description names a review, security or architecture is still lifted to `model-router:deep`. `/route auto off` leaves the choice to Claude again, `/route auto on` turns it back on; the setting stays across chats. The router call costs one small Sonnet request per Agent call.
- **The eval:** the policy was measured against gold tiers for 400 real Agent calls, tuned on 320 and run once on the other 80, and a CI test replays it and fails when the policy changes without a new eval. On the 80 held-out calls the shipped policy (rules, router Sonnet at low effort, with the explicit floor) agreed with gold on 75.0 % of calls, under-routed 2.5 % (none of the critical review, security and architecture calls) and cost 17.3 % more than gold, which misses the 15 % cost threshold. Weighted to how often each kind of task occurs in all recorded calls, it agreed on 74.7 %, under-routed 0.3 % (none critical) and cost 21.2 % more. The thresholds gate the raw numbers. Before the floor the same policy passed: raw 81.3 %, 2.5 %, none critical, 14.1 % over; weighted 82.3 %, 0.3 %, none critical, 17.5 % over ([`model-router/eval/results.json`](model-router/eval/results.json)).
- **Safety net:** with auto routing off, and whenever the router has no answer, a general agent Claude starts with nothing set runs on Opus at medium effort. A general or mapped built-in agent (Explore, Plan) given only a model runs at the effort of that model's first tier (Sonnet at medium, Opus at high) instead of inheriting the main chat's effort. A tier type, a model and effort Claude set, an effort alone, a fork, and a custom agent type with its own model are left as they are. No Agent call is ever refused, and the safety net makes no model calls.
- **The main chat is never switched.** Changing the model there would throw away its prompt cache; pick its model with `/model` yourself.
- **Staying current:** the tiers name aliases, so a new Opus or Sonnet is used without a change. Which tier gets which line and effort changes through a pull request (`model-router/UPDATING.md`), and a plugin update brings it. The status line warns when the table is over 30 days old.
- **`/route`** routes from Haiku up to Opus, which is the default: the Fable type is hidden from Claude. An Agent call that names the Fable type moves to `model-router:long`. A call whose model is Fable runs on Opus instead, at xhigh or at the effort Claude set, and keeps its own type (`{model: 'fable'}` on Explore stays Explore). The Fable type given a model below Fable only moves to `model-router:long` and keeps that model. These calls are not capped and can still run on Fable:
  - a custom agent type named `fable-<effort>`, or whose own definition picks Fable; with auto routing on, the second is routed like a general agent and keeps its definition only when the router has no answer and no rule lifts it;
  - in a Fable main chat, a fork, which inherits the main chat's model;
  - in a Fable main chat, a call left on the main chat's model: a custom type with no model, a general or Plan agent given only an effort, and, after `/route fill off`, a general or Plan agent with nothing set. With auto routing on, that happens only when the router has no answer and no rule lifts the call, or, for a call given only an effort, when the routed tier's effort is below it;
  - any subagent when `CLAUDE_CODE_SUBAGENT_MODEL=fable` is set, since the hook never sees that model;
  - a workflow `agent()` or a mod's `$.agent.spawn` with Fable, since neither passes through the Agent tool call.
- **`/route fable`** routes from Haiku up to Fable. Both stay set across chats and show the agent types, the default, and how many Agent calls went where, so with Fable on, `/route fable` shows them without closing it; the status line shows the range (`router haiku → opus`). `/route fill off` turns the safety net off, `/route stats reset` clears the counts.
- **Updating from 2.0.0** starts at Opus, since 2.0.0 stored no range: run `/route fable` once to keep Fable.

If you installed the earlier Model Router from the `smashedonehd-mods` marketplace, uninstall it first, or both will hook the same Agent calls.

## Where the data lives

Everything stays on your machine, under `~/.claude/mods-data/`: Cache Keeper's session heartbeats and saved handoffs. Model Router keeps only its settings and call counts in the plugin store; with auto routing on, its router sends each Agent call's type, description and prompt to a small model request through Claude Code. Cache Keeper makes no network calls of its own. Cache Keeper's keep-warm pings are small model requests, sent only while `/keepwarm` is on.

## License

MIT. See [LICENSE](LICENSE).
