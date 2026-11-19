---
name: session-handoff
description: Use when the user says "session handoff", "wrap up session", "hand off", "handoff summary", or wants a structured end-of-session summary before clearing context. Cache Keeper then writes the handoff itself (six steps on a card above the prompt) once your turn ends, saves it, and clears the chat and continues with it.
---

# Session Handoff

Cache Keeper writes the handoff, not you. Calling this skill queues it: when your current turn ends, Cache Keeper reads this conversation, finds the files you used, lists the skills, tools, links and background shells, has a fork of this conversation write the handoff in English, saves it under `~/.claude/mods-data/cache-keeper/handoffs/`, and checks it. The steps show on a card above the prompt.

What follows depends on the args you pass:

- no args: once the handoff is saved, the chat clears and the handoff is sent as the fresh chat's first prompt, with live git state in front of it. A `/goal` still active in the cleared chat is set again there with the same text: do not set it yourself.
- `keep`: the handoff is saved and the chat stays as it is. Pass `keep` whenever the user wants the summary without clearing. The card then offers "Clear and continue" and "Keep chat".
- `continue` (or `go`): no new handoff; the chat clears and continues with the last saved one.

## What to do now

1. Do not write the handoff into the chat yourself; the card shows it, and the saved file holds it.
2. Leave nothing half-written: save or commit work in progress the way this project expects.
3. Tell the user in one short line that the handoff starts when this turn ends, then end your turn. Start no new work.

The user can do the same with `/handoff`, `/handoff keep` and `/handoff continue`, or with the card's "Start handoff" button, which opens on its own once the context passes the threshold set in `/config` (Cache Keeper: "Handoff offer", 300k by default) or with `/cache handoff 300k|off`. Auto handoff is on by default (`/cache handoff auto off` or the offer's "auto" toggle turns it off): a turn that ends past that threshold starts the handoff itself; it clears 5 s after it is in unless the user types or presses Keep chat.
