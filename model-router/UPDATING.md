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
- `tiers`: the alias, effort and description of each tier. Move a tier when the docs' guidance moves, for example when a newer Sonnet matches Opus on hard coding. Keep the order from the cheapest line to the dearest (a test checks it). A description is what Claude reads to pick the tier, so keep it about the task, not the model.
- `fill`: the default for a general agent Claude starts with nothing set. Anthropic's guidance today is to start with Opus.
- `builtinTypes`: a built-in agent type that should run on a given tier.
- `sources`: the pages that justified the change.
- `updated`: today's date, whenever anything else changed.
- `model-router/.claude-plugin/plugin.json` `version`: bump the patch number with every table change, or `claude plugin update` will not pick it up.

Never change `schema` without also changing `hooks/route.mjs`: a table with another schema is refused, and the router then leaves every call as it came.

## Checks before a pull request

```bash
node model-router/test/route.test.mjs
claude plugin test model-router
```

A failing check means the table now routes a known call differently: fix the table, or change the check only when the docs say the new routing is right, and say so in the pull request.

## The pull request

Open it into `dev` with the title `model-router: routing table YYYY-MM-DD`, and in the body list each change with the sentence from the docs that justifies it and its link. When nothing moved, open no pull request, but say in the task's own report that the check ran, so a run that stopped is noticed.
