# Keeping the routing table current

`routing.json` decides which model and effort each tier gets. It ships with the plugin, so a change reaches a machine through a pull request, a merge and `claude plugin update model-router@4a-mods`. Nothing is fetched at run time.

Most model releases need no change at all: the tiers name aliases (`haiku`, `sonnet`, `opus`, `fable`), and Claude Code resolves each alias to the newest model of its line. A refresh is about guidance: which line and which effort fits which kind of task, and when a new line appears.

A weekly scheduled task does the refresh. Run by hand, the steps are the same.

## What to read

Read these every time, and trust only what they say today:

1. Models API, when a key is at hand: `GET https://api.anthropic.com/v1/models` (each model's line, lifecycle, retirement date and supported effort levels).
2. Models overview: https://platform.claude.com/docs/en/about-claude/models/overview
3. Effort: https://platform.claude.com/docs/en/build-with-claude/effort
4. Choosing a model: https://platform.claude.com/docs/en/about-claude/models/choosing-a-model
5. Claude Code subagents and model configuration: https://code.claude.com/docs/en/subagents and https://code.claude.com/docs/en/model-config (the aliases and effort levels an agent definition takes, and the built-in agent types)
6. Release notes (https://platform.claude.com/docs/en/release-notes/feed.xml) and the Claude Code changelog, for anything released since `updated`.

## What may change

- `models`: each alias's current model id and the effort levels it takes. A new line becomes a new alias only once an agent definition accepts it.
- `models.*.price`: the price per MTok, from the docs' price list. It changes no decision, but it changes the eval's cost result (see below).
- Not `tiers`, `order`, `fill`, `builtinTypes`, `categories`, `critical`, `rules` or `router`: they are the routing policy, and only a local eval changes them (see "Eval guards the policy"). When the docs' guidance moves, for example when a newer Sonnet matches Opus on hard coding, propose the tier change in the pull request as a recommendation.
- `sources`: the pages that justified the change.
- `updated`: today's date, whenever anything else changed.
- `model-router/.claude-plugin/plugin.json` `version`: bump the patch number with every table change, or `claude plugin update` will not pick it up.

Never change `schema` without also changing `hooks/route.mjs`: a table with another schema is refused, and the router then leaves every call as it came.

## Eval guards the policy

With auto routing on, the policy in `routing.json` and `hooks/route.mjs` picks every routed call's tier. The eval in `eval/` measured it against gold labels for 400 sampled calls: tuned on the 320 train calls, then run once on the 80 held-out calls. The repo keeps the result: `eval/gold.json` (ids, gold tiers, categories, splits), `eval/decisions.json` (the shipped policy's decision for each call and the policy hash) and `eval/results.json` (the metrics). `test/eval.test.mjs` replays them without calling a model and fails when the policy no longer hashes as recorded, when a fresh score differs from the recorded one, when the thresholds move, or when `router.default` is `"on"` but the held-out result misses a threshold.

- The tiers (alias, effort, description), `order`, `fill`, `builtinTypes`, `categories`, `critical`, `rules` and `router` (all but `default`) change only through a local eval: tune on train (`node model-router/eval/run.mjs --policy <policy> --split train`, recorded with `--final <row>`), run held-out once (`--split heldout --heldout-row <name>`), then `node model-router/eval/run.mjs --record` for `decisions.json` and `--rescore` for `results.json`. The same holds for the policy code the hash covers (`POLICY_CODE` in `hooks/route.mjs`). The eval needs the private sample under `~/.claude/mods-data/model-router/eval/` and calls models, so it never runs in the cloud refresh.
- The cloud refresh may change `models.*.id`, `efforts`, `price`, `sources` and `updated`. One exception: the id of the router's own model (`router.model`) is part of the policy hash, and the hook calls the router on that id, so a new id there needs the local eval too. After a `price` change, run `node model-router/eval/run.mjs --rescore` and commit `results.json`.
- A tier change the docs suggest goes into the pull request as a recommendation, never into the table.

## Checks before a pull request

```bash
node model-router/test/route.test.mjs
node model-router/test/eval-lib.test.mjs
node model-router/test/eval.test.mjs
claude plugin test model-router
```

The three node checks cover the table, the policy functions in `hooks/route.mjs` and the eval. The hook's own behaviour (`hooks/register.mjs`: what reaches the host, the router call, the commands) is covered only by `claude plugin test model-router`, so run it too.

A failing check means the table now routes a known call differently: fix the table, or change the check only when the docs say the new routing is right, and say so in the pull request.

## The pull request

Open it into `dev` with the title `model-router: routing table YYYY-MM-DD`, and in the body list each change with the sentence from the docs that justifies it and its link. When nothing moved, open no pull request, but say in the task's own report that the check ran, so a run that stopped is noticed.
