# filetree

A Claude Code mod: an IDE-style file tree in a pane beside the chat. It shows which files Claude reads, writes and commits, with git status, diffs, search and file previews.

**Origin:** by [Kurt Buhler](https://github.com/data-goblin), MIT (see [LICENSE](LICENSE)), with the contributors named in [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md). Copied unchanged from [data-goblin/claude-code-filetree](https://github.com/data-goblin/claude-code-filetree/tree/a3d36b1a56c0d982b307a58ef88fd3e857c977e6) at commit `a3d36b1`, version 0.8.2. Only this README differs. Upstream changes reach 4A-Mods only after someone reads them and copies them here.

**Copied:** `hooks/`, `types/`, `tests/`, `scripts/`, `.claude-plugin/plugin.json`, `LICENSE` and `ACKNOWLEDGEMENTS.md`. **Left out:** the recordings and screenshots (`media/`, `docs/media/`, 15 MB), the feature pages in `docs/` that show them, the upstream README, `AGENTS.md`, `tsconfig.json` (this repository ignores it; Claude Code writes one when a mod loads from a folder), and the upstream repository's own CI and git hooks. The feature pages are in the [upstream docs](https://github.com/data-goblin/claude-code-filetree/tree/a3d36b1a56c0d982b307a58ef88fd3e857c977e6/docs).

**Needs Claude Code 2.1.306 or later**, newer than the other 4A-Mods need.

## What it does

- **Tree** (`/filetree` shows or hides it; `/filetree open` opens it without hiding): the files of the chat's folder or a pinned folder, with git status per file and folder, the branch with ahead and behind counts, and a right column of date, age, size, line count or file count.
- **Activity**: the files Claude reads, writes and commits shimmer in the tree, and folders open to show them. File references with a line in Claude's replies become links to that line.
- **Search**: by name, inside files (`git grep` or `grep -r`), and a jump to any folder with `z`.
- **Diff**: `d` shows a changed file, or every changed file in a folder, against `HEAD`.
- **Preview**: code, Markdown, images, video frames, PDF and Word pages, and a treemap of a folder by bytes or lines. Much of this is Linux and macOS only, see [Known limits on Windows](#known-limits-on-windows).
- **Context**: the selected row, or up to 100 marked rows, go to Claude as context with each prompt you send.
- **Guards**: files and folders Claude may not edit, and a list of files written outside the repository. A guard refuses Claude's Edit, Write and NotebookEdit on a guarded path. For a Bash or PowerShell command it only asks, and only when the command text names the path, so `cd dir && rm file` or a wildcard gets past it. Tools from MCP servers are not covered. Treat guards as a reminder, not a lock.

## Settings worth knowing before you install

All settings are in `/config` under filetree, each with its own description.

- **Open at start** is `on`: the pane opens with every chat. Set it to `off` to open it only with `/filetree`.
- **Jump moves Claude** is `tree and Claude`: picking a folder with `z` also moves the chat there with `/cd`. Set it to `tree` to move only the tree.
- **Follow work** is `on`: when Claude or its subagents work in another git repository, the chat moves there with `/cd` at the end of a turn or while idle. Two writes there, or four reads with no write, inside three minutes are enough, so one turn can do it; it moves at most once every two minutes. Set it to `off` if you run chats in worktrees and want each to stay where you put it.
- **Open with**, **Edit with** and **Diff with** run the command you type there on the file you pick.
- **Open with** is empty, so Enter or a double-click opens the file in its default app. On Windows that is the same as a double-click in Explorer: a `.bat`, `.cmd`, `.exe`, `.js`, `.vbs` or `.lnk` runs. In a repository you do not trust, set Open with to `preview`.

To install with the three defaults above turned off:

```bash
claude plugin install filetree@4a-mods --config start=off --config jump=tree --config work=off
```

## Data and network

From a code audit at commit `a3d36b1` on 2026-11-10: `hooks/open.ts`, `guard.ts`, `work.ts`, `keybind.ts` and `peek.ts` read whole, about a third of `hooks/register.tsx` read and the rest searched for network, process and file-write calls.

- **Network:** none found. No requests and no telemetry.
- **Files it writes:** its pane state, recent folders and guard list, in Claude Code's own plugin state and store, and its own `shimmer` setting when you press the shimmer button. On Linux and macOS also a preview cache in the temp folder, removed when the session ends, and on macOS marker files there. It writes `keybindings.json` in the Claude config folder only when you run `/filetree keys` and confirm. The search found no call that writes or deletes a file in your repository.
- **Programs it runs:** mainly `git`. It asks for status when a chat starts, when the tree moves to another folder, after Claude's tool calls and when `.git/index` or `.git/HEAD` change (it looks at those two files every 2 seconds). For Follow work it also runs `git rev-parse` in the folder of each path Claude touches. Others: `zoxide` for the folder jump if you have it, `grep` for a search outside a git repository, the command you put in Open with, Edit with or Diff with, and on Windows `powershell` with a fixed script to open a file in its default app. Linux and macOS run more (`sh` with fixed scripts, `find`, `du`, image and document converters).
- **File names in commands:** a file name is always passed as its own argument and no shell parses it, so a name with `&` or `;` in it cannot add a command.
- **What reaches Claude:** each prompt you send names the row you have selected, or lists the rows you have marked, one path per line.
- **Git config of a foreign folder:** the mod does not turn `core.fsmonitor` off when it calls git, so a folder whose `.git/config` sets it may get a program run by `git status`, as with other tools that show git status. Whether Claude Code blocks this itself was not tested. A cloned repository cannot carry that config; an unpacked archive can. With Follow work on, the tree can reach such a folder without you opening it.

## Known limits on Windows

Read from the code, not tried on Windows, except where it says so.

- Image, video-frame, PDF and Word previews do not draw: the code answers "image preview needs Linux or macOS". Text previews of PDF and Word call `timeout`, which on Windows is a different program, so they most likely stay empty.
- The treemap by bytes draws one level, with folder sizes from file listings. The treemap by lines needs `find` and fails.
- Search inside files works in a git repository (`git grep`). Outside one it needs `grep` on `PATH`.
- **Open with: editor** and **Diff with** as a command need tmux, herdr or Linux; on Windows they show a notice. With **Edit with** empty, `e` in the preview does nothing; a command you type there does run.

## Checked here

Run on Windows 11 on 2026-11-10: with Claude Code 2.1.322, `claude plugin validate` passes and `claude plugin test filetree` gives 309 pass, 0 fail. With 2.1.282 the hooks module does not load and the same tests give 31 pass, 278 fail. The 45 copied files have the same git blob hashes as upstream. The pane itself was not opened in the Desktop app.

Install instructions for the marketplace are in the [repository README](../README.md).
