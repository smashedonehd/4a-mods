# filetree

A Claude Code mod: an IDE-style file tree in a pane beside the chat. It shows which files Claude reads, writes and commits, with git status, diffs, search and file previews.

**Origin:** by [Kurt Buhler](https://github.com/data-goblin), MIT (see [LICENSE](LICENSE)), with the contributors named in [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md). Copied unchanged from [data-goblin/claude-code-filetree](https://github.com/data-goblin/claude-code-filetree/tree/a3d36b1a56c0d982b307a58ef88fd3e857c977e6) at commit `a3d36b1`, version 0.8.2. Only this README differs. Upstream changes reach 4A-Mods only after someone reads them and copies them here.

**Copied:** `hooks/`, `types/`, `tests/`, `scripts/`, `tsconfig.json`, `.claude-plugin/plugin.json`, `LICENSE` and `ACKNOWLEDGEMENTS.md`. **Left out:** the recordings and screenshots (`media/`, `docs/media/`, 15 MB), the feature pages in `docs/` that show them, the upstream README, `AGENTS.md`, and the upstream repository's own CI and git hooks. The feature pages are in the [upstream docs](https://github.com/data-goblin/claude-code-filetree/tree/a3d36b1a56c0d982b307a58ef88fd3e857c977e6/docs).

**Needs Claude Code 2.1.306 or later**, newer than the other 4A-Mods need.

## What it does

- **Tree** (`/filetree` shows or hides it; `/filetree open` opens it without hiding): the files of the chat's folder or a pinned folder, with git status per file and folder, the branch with ahead and behind counts, and a right column of date, age, size, line count or file count.
- **Activity**: the files Claude reads, writes and commits shimmer in the tree, and folders open to show them. File references with a line in Claude's replies become links to that line.
- **Search**: by name, inside files (`git grep` or `grep -r`), and a jump to any folder with `z`.
- **Diff**: `d` shows a changed file, or every changed file in a folder, against `HEAD`.
- **Preview**: code, Markdown, images, video frames, PDF and Word pages, and a treemap of a folder by bytes or lines. On Windows the treemap draws one level, and folder sizes come from file listings.
- **Context**: the selected row, or up to 100 marked rows, go to Claude as context.
- **Guards**: files and folders Claude may not edit, and a list of files written outside the repository. A guard refuses Claude's Edit, Write and NotebookEdit on a guarded path. For a Bash or PowerShell command it only asks, and only when the command text names the path, so `cd dir && rm file` or a wildcard gets past it. Tools from MCP servers are not covered. Treat guards as a reminder, not a lock.

## Settings worth knowing before you install

All settings are in `/config` under filetree, each with its own description.

- **Open at start** is `on`: the pane opens with every chat. Set it to `off` to open it only with `/filetree`.
- **Jump moves Claude** is `tree and Claude`: picking a folder with `z` also moves the chat there with `/cd`. Set it to `tree` to move only the tree.
- **Follow work** is `on`: when Claude or its subagents keep working in another git repository for a few minutes, the chat moves there with `/cd`. Set it to `off` if you run chats in worktrees and want each to stay where you put it.
- **Open with**, **Edit with** and **Diff with** run the command you type there on the file you pick.
- **Open with** is empty, so Enter or a double-click opens the file in its default app. On Windows that is the same as a double-click in Explorer: a `.bat`, `.cmd`, `.exe`, `.js`, `.vbs` or `.lnk` runs. In a repository you do not trust, set Open with to `preview`.

To install with the three defaults above turned off:

```bash
claude plugin install filetree@4a-mods --config start=off --config jump=tree --config work=off
```

## Data and network

Read from the code at commit `a3d36b1` on 2026-11-10, not from the author's description.

- **Network:** none. No requests and no telemetry.
- **Files it writes:** its pane state, recent folders and guard list, in Claude Code's own plugin state and store. On Linux and macOS also a preview cache in the temp folder, removed when the session ends. It writes `keybindings.json` in the Claude config folder only when you run `/filetree keys` and confirm. It never writes or deletes files in your repository.
- **Programs it runs:** `git` in the tree's folder (on a timer, for status), `zoxide` for the folder jump if you have it, and on Windows `powershell` to open a file in its default app. Commands are passed as argument lists, without a shell, and file names never become part of a command line.
- **What reaches Claude:** each prompt you send gets one line naming the rows you have selected or marked in the tree.
- **Git config of a foreign folder:** like any tool that runs `git status`, it runs whatever a folder's `.git/config` tells git to run (`core.fsmonitor`). A cloned repository cannot carry that config; an unpacked archive can. With Follow work on, the tree can reach such a folder without you opening it.

## Known limits on Windows

- PDF and Word previews stay empty: the mod calls `timeout`, which on Windows is a different program.
- Search inside files works in a git repository (`git grep`). Outside one it needs `grep` on `PATH`.
- **Open with: editor**, **Edit with** in a terminal pane and **Diff with** as a command need tmux, herdr or Linux; on Windows they show a notice.

## Checked here

`claude plugin validate` passes and `claude plugin test filetree` gives 309 pass, 0 fail on Claude Code 2.1.322 (Windows 11). On 2.1.282 the hooks module does not load.

Install instructions for the marketplace are in the [repository README](../README.md).
