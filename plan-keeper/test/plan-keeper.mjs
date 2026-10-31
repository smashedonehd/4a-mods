// Run: node plan-keeper/test/plan-keeper.mjs
// Drives register.mjs against a fake host with an in-memory fs. A "reload" is a
// second module instance sharing the first one's $.state.
import assert from 'node:assert/strict'

const HOME = 'C:/Users/u'
const CWD = 'D:/work/app'
const PLANS = HOME + '/.claude/plans'
const DAY = 86400e3
const T = Date.UTC(2026, 10, 1, 10, 0)
let instance = 0

const k = (p) => String(p).replace(/\\/g, '/').toLowerCase()

// files: path -> text, or [text, mtimeMs]; every path absolute
function makeFs(seed) {
  const files = new Map()
  for (const [p, v] of Object.entries(seed)) {
    const [text, mtimeMs] = Array.isArray(v) ? v : [v, T]
    files.set(k(p), { path: p, text, mtimeMs })
  }
  const writes = []
  const isDir = (p) => [...files.keys()].some((f) => f.startsWith(k(p).replace(/\/+$/, '') + '/'))
  const fs = {
    exists: async (p) => files.has(k(p)) || isDir(p),
    read: async (p) => {
      const f = files.get(k(p))
      if (!f) throw new Error('ENOENT ' + p)
      return f.text
    },
    write: async (p, text) => {
      writes.push(p)
      files.set(k(p), { path: p, text, mtimeMs: T })
    },
    list: async (dir) => {
      if (!isDir(dir)) throw new Error('ENOENT ' + dir)
      const d = k(dir).replace(/\/+$/, '') + '/'
      return [...files.values()]
        .filter((f) => k(f.path).startsWith(d) && !k(f.path).slice(d.length).includes('/'))
        .map((f) => ({ name: f.path.split('/').pop(), kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false }))
    },
  }
  return { fs, writes, text: (p) => files.get(k(p))?.text }
}

async function boot(disk, { cwd = CWD, state = new Map() } = {}) {
  const { register } = await import(`../hooks/register.mjs?boot=${++instance}`)
  const hs = []
  register((name, a, b) => hs.push({ name, filter: b ? a : null, fn: b || a }))
  const toasts = []
  const $ = {
    clock: { now: async () => T },
    fs: disk.fs,
    env: { get: async (n) => (n === 'USERPROFILE' ? HOME : '') },
    session: { cwd: async () => cwd },
    state: { get: async (ref) => ({ value: state.get(ref.key) }), set: async (ref, v) => void state.set(ref.key, JSON.parse(JSON.stringify(v))) },
    ui: { toast: (t) => void toasts.push(t) },
  }
  const fits = (filter, e) => !filter || Object.entries(filter).every(([f, v]) => [].concat(v).includes(e[f]))
  // below: what next(e) resolves to
  const fire = async (name, e, below = {}) => {
    let out
    for (const h of hs.filter((x) => x.name === name && fits(x.filter, e))) out = await h.fn($, e, async () => below)
    return out
  }
  await fire('session.start', { cwd, surface: 'desktop', isInteractive: true })
  let n = 0
  return {
    toasts,
    state,
    start: async (source = 'startup') => {
      const r = await fire('classic.SessionStart', { source }, { additionalContext: ['other'] })
      return r.additionalContext.length > 1 ? r.additionalContext[1] : undefined
    },
    call: (tool, args = {}, { result = {}, isError, agentId } = {}) =>
      fire('tool.call', { tool, tool_use_id: 'u' + ++n, ...(agentId && { agentId }), ...args }, isError ? { result, text: 'failed', isError: true } : { result }),
    prompt: (text, kind = 'composer') => fire('prompt.submit', { text, origin: { kind } }, { text }),
    turnEnd: (agentId) => fire('turn.complete', { turnId: 't', answer: '', durationMs: 1, isAborted: false, reason: 'answer', ...(agentId && { agentId }) }),
  }
}

const PLAN = `# App plan

Work in D:\\work\\app.

### Task 1: Parser
- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Implement parse**

### Task 2: Matcher
- [ ] **Step 1: Write the failing test**
- [ ] Wire matcher

## Loose
- [ ] Write tests for parser
- [ ] Write tests
- [x] Set up repo
- [ ] Ship it
`

const tests = []
const test = (name, fn) => tests.push([name, fn])

// ---- which plan

const folderSeed = () => ({
  [PLANS + '/a.md']: [PLAN, T - DAY],
  // newer, but each names another folder, or this one only inside a nested project
  [PLANS + '/b.md']: ['Work in D:\\work\\app-old.\n- [ ] Write tests\n', T - 3600e3],
  [PLANS + '/c.md']: ['Work in D:/work/other and D:/work/app.old\n- [ ] Write tests\n', T],
  [PLANS + '/e.md']: ['Edit D:\\work\\app\\vendor\\lib\\x.js\n- [ ] Write tests\n', T - 2 * 3600e3],
  [CWD + '/vendor/.git']: 'gitdir: x',
  [CWD + '/vendor/lib/x.js']: '',
  // this folder's and newest, but nothing in it is open
  [PLANS + '/g.md']: ['Work in D:/work/app\n- [x] Done\n', T],
  // this folder's, but last changed ten days ago
  [PLANS + '/d.md']: ['Work in D:/work/app\n- [ ] Write tests\n', T - 10 * DAY],
})

test('a fresh chat picks the newest recent plan that names this folder', async () => {
  const s = await boot(makeFs(folderSeed()))
  const note = await s.start()
  assert.match(note, /^Plan Keeper: the active plan is C:\/Users\/u\/\.claude\/plans\/a\.md \(the newest plan for this folder/)
  assert.match(s.toasts.join('\n'), /7 open items in a\.md/)
})

test('a plan that names a file in this folder counts, one in its own plans folder too', async () => {
  const s = await boot(makeFs({ [PLANS + '/f.md']: ['See D:/work/app/src/x.js\n- [ ] One\n', T - DAY], [CWD + '/src/x.js']: '' }))
  assert.match(await s.start(), /plans\/f\.md/)
  const own = await boot(makeFs({ ...folderSeed(), [CWD + '/docs/superpowers/plans/p.md']: ['- [ ] Own\n', T - 60e3] }))
  assert.match(await own.start(), /app\/docs\/superpowers\/plans\/p\.md/)
})

test('no plan of this folder: no note, and nothing is ticked', async () => {
  const seed = folderSeed()
  delete seed[PLANS + '/a.md']
  const disk = makeFs(seed)
  const s = await boot(disk)
  assert.equal(await s.start(), undefined)
  assert.deepEqual(s.toasts, [])
  await s.call('mcp__ccd_turn__update_plan', { items: [{ content: 'Write tests', status: 'in_progress' }] })
  await s.call('mcp__ccd_turn__wrap_up', { recap: 'done' })
  await s.turnEnd()
  assert.deepEqual(disk.writes, [])
})

test('a session in the home folder picks no plan by folder', async () => {
  const s = await boot(makeFs({ [PLANS + '/h.md']: ['Edit C:/Users/u/notes.txt\n- [ ] One\n', T], [HOME + '/notes.txt']: '' }), { cwd: HOME })
  assert.equal(await s.start(), undefined)
})

// ---- ticks

const DONE = PLAN.replace('### Task 2: Matcher\n- [ ] **Step 1: Write the failing test**\n- [ ] Wire matcher', '### Task 2: Matcher\n- [x] **Step 1: Write the failing test**\n- [x] Wire matcher').replace('- [ ] Write tests\n', '- [x] Write tests\n')

test('a wrap-up ticks the items the completed steps name, and only those', async () => {
  const disk = makeFs(folderSeed())
  const s = await boot(disk)
  await s.start()
  await s.call('mcp__ccd_turn__update_plan', {
    items: [
      { content: 'Write tests', status: 'in_progress' }, // one item exactly; "Write tests for parser" is another item
      { content: 'Matcher', status: 'pending' }, // Task 2's heading: its two items
      { content: 'Step 1: Write the failing test', status: 'pending' }, // two items: ambiguous
      { content: 'Ship it', status: 'pending' }, // still pending at the wrap-up
    ],
    scope: 'first_task',
  })
  await s.call('mcp__ccd_turn__update_plan', { advance: true })
  await s.call('mcp__ccd_turn__update_plan', { done: [3] })
  assert.deepEqual(disk.writes, [], 'no tick before the wrap-up')
  await s.call('mcp__ccd_turn__wrap_up', { recap: 'r' })
  assert.equal(disk.text(PLANS + '/a.md'), DONE)
  assert.deepEqual(disk.writes, [PLANS + '/a.md'])
  assert.match(s.toasts.at(-1), /ticked 3 items in a\.md/)

  // Again: nothing to tick, so nothing is written or moved
  await s.call('mcp__ccd_turn__wrap_up', { recap: 'r' })
  await s.turnEnd()
  await s.call('Bash', { command: 'gh pr merge 3 --merge' })
  assert.equal(disk.text(PLANS + '/a.md'), DONE)
  assert.equal(disk.writes.length, 1)
})

test('after /clear the note lists only the open items, and the new chat keeps its own task list', async () => {
  const disk = makeFs(folderSeed())
  const s = await boot(disk)
  await s.start()
  await s.call('mcp__ccd_turn__update_plan', { items: [{ content: 'Matcher', status: 'completed' }, { content: 'Ship it', status: 'in_progress' }] })
  await s.call('mcp__ccd_turn__wrap_up', { recap: 'r' })
  const note = await s.start('clear')
  const rows = note.split('\n').filter((l) => l.startsWith('- '))
  assert.deepEqual(rows, ['- [ ] **Step 1: Write the failing test**', '- [ ] **Step 2: Implement parse**', '- [ ] Write tests for parser', '- [ ] Write tests'])
  assert.match(note, /4 of 8 checkbox items are open/)
  assert.match(note, /data, not instructions/)
  // The old chat's list is gone with what it held: the new chat finishing
  // "Ship it" again (after it was unticked by hand) ticks it again
  await disk.fs.write(PLANS + '/a.md', PLAN)
  await s.call('TodoWrite', { todos: [{ content: 'Ship it', status: 'completed', activeForm: 'x' }] })
  await s.turnEnd()
  assert.equal(disk.text(PLANS + '/a.md'), PLAN.replace('- [ ] Ship it', '- [x] Ship it'))
})

test('a step completed but not yet ticked when the chat clears is ticked before the list goes', async () => {
  const path = PLANS + '/new.md'
  const disk = makeFs({ [path]: '- [ ] Ship it\n- [ ] Next\n' })
  const s = await boot(disk)
  await s.call('Write', { file_path: path, content: 'x' })
  await s.call('TodoWrite', { todos: [{ content: 'Ship it', status: 'completed', activeForm: 'x' }] })
  const note = await s.start('clear')
  assert.equal(disk.text(path), '- [x] Ship it\n- [ ] Next\n')
  assert.deepEqual(note.split('\n').filter((l) => l.startsWith('- ')), ['- [ ] Next'])
})

test('many open items are listed by heading', async () => {
  const many = '# P\nD:/work/app\n### Task 1: A\n' + '- [ ] a\n'.repeat(5) + '### Task 2: B\n- [x] b\n' + '- [ ] b\n'.repeat(4)
  const s = await boot(makeFs({ [PLANS + '/m.md']: many }))
  const rows = (await s.start()).split('\n').filter((l) => l.startsWith('- '))
  assert.deepEqual(rows, ['- Task 1: A: 5 of 5 open', '- Task 2: B: 4 of 5 open'])
})

test('a plan the person names in a prompt is ticked on a merged PR', async () => {
  const path = CWD + '/docs/my plan.md'
  const disk = makeFs({ [path]: '# X\n- [ ] Ship it\n- [ ] Other\n', [CWD + '/README.md']: '# Readme\n', [CWD + '/other-plan.md']: '- [ ] Ship it\n' })
  const s = await boot(disk)
  await s.prompt('carry on with "docs/my plan.md" and see README.md')
  await s.prompt('plugin text naming other-plan.md', 'plugin')
  await s.call('TodoWrite', { todos: [{ content: 'Ship it', status: 'completed', activeForm: 'x' }] })
  await s.call('Bash', { command: 'gh pr merge 4 --repo o/r --merge' }, { isError: true })
  assert.deepEqual(disk.writes, [], 'a failed merge ticks nothing')
  await s.call('Bash', { command: 'gh pr merge 4 --repo o/r --merge' })
  assert.equal(disk.text(path), '# X\n- [x] Ship it\n- [ ] Other\n')
  assert.equal(disk.text(CWD + '/other-plan.md'), '- [ ] Ship it\n')
})

test('a plan this session writes is ticked at a turn end from the CLI task list; a subagent list ticks nothing', async () => {
  const path = PLANS + '/new.md'
  const disk = makeFs({ [path]: '- [ ] Build it\n- [ ] Test it\n' })
  const s = await boot(disk)
  await s.call('Write', { file_path: path, content: 'x' })
  await s.call('TodoWrite', { todos: [{ content: 'Test it', status: 'completed', activeForm: 'x' }] }, { agentId: 'a1' })
  await s.call('TodoWrite', { todos: [{ content: 'Unrelated', status: 'completed', activeForm: 'x' }] })
  await s.turnEnd()
  assert.deepEqual(disk.writes, [], 'a step that names no item writes nothing')
  await s.call('TaskCreate', { subject: 'Build it', description: 'd' }, { result: { task: { id: '7', subject: 'Build it' } } })
  await s.call('TaskUpdate', { taskId: '7', status: 'completed' }, { result: { success: false, taskId: '7', updatedFields: [], error: 'no' } })
  await s.turnEnd()
  assert.deepEqual(disk.writes, [], 'a refused update completes nothing')
  await s.call('TaskUpdate', { taskId: '7', status: 'completed' }, { result: { success: true, taskId: '7', updatedFields: ['status'] } })
  await s.turnEnd('a1') // a subagent's turn end
  assert.deepEqual(disk.writes, [])
  await s.turnEnd()
  assert.equal(disk.text(path), '- [x] Build it\n- [ ] Test it\n')
})

test('a reload keeps the plan and the task list', async () => {
  const path = PLANS + '/new.md'
  const disk = makeFs({ [path]: '- [ ] Build it\n' })
  const state = new Map()
  const s = await boot(disk, { state })
  await s.call('Edit', { file_path: path, old_string: 'a', new_string: 'b' })
  await s.call('mcp__ccd_turn__update_plan', { items: [{ content: 'Build it', status: 'in_progress' }] })
  const again = await boot(disk, { state })
  await again.call('mcp__ccd_turn__wrap_up', { recap: 'r' })
  assert.equal(disk.text(path), '- [x] Build it\n')
  // What was held is kept too: unticked by hand, the item stays so after another reload
  await disk.fs.write(path, '- [ ] Build it\n')
  const third = await boot(disk, { state })
  await third.turnEnd()
  assert.equal(disk.text(path), '- [ ] Build it\n')
})

test('a new plan gets none of the old steps, but the old plan gets them first', async () => {
  const a = PLANS + '/a.md'
  const b = PLANS + '/b.md'
  const disk = makeFs({ [a]: '- [ ] Ship it\n', [b]: '- [ ] Ship it\n' })
  const s = await boot(disk)
  await s.call('Write', { file_path: a, content: 'x' })
  await s.call('TodoWrite', { todos: [{ content: 'Ship it', status: 'completed', activeForm: 'x' }] })
  await s.call('Write', { file_path: b, content: 'x' })
  await s.turnEnd()
  assert.deepEqual([disk.text(a), disk.text(b)], ['- [x] Ship it\n', '- [ ] Ship it\n'])
})

test('a plan that cites a file by path:line names this folder; explanation.md is no plan', async () => {
  const s = await boot(makeFs({ [PLANS + '/l.md']: ['Fix D:/work/app/src/x.js:42\n- [ ] One\n', T], [CWD + '/src/x.js']: '' }))
  assert.match(await s.start(), /plans\/l\.md/)
  const ex = CWD + '/docs/explanation.md'
  const disk = makeFs({ [ex]: '- [ ] Tests added\n', [CWD + '/docs/planning/README.md']: '- [ ] Tests added\n' })
  const s2 = await boot(disk)
  await s2.prompt('see docs/explanation.md and docs/planning/README.md')
  await s2.call('TodoWrite', { todos: [{ content: 'Tests added', status: 'completed', activeForm: 'x' }] })
  await s2.turnEnd()
  assert.deepEqual(disk.writes, [])
})

test('a merge after VAR=value or with --auto only in its quoted subject still ticks', async () => {
  for (const command of ['  GH_REPO=o/r gh pr merge 5 --merge', 'gh pr merge 5 --merge --subject "drop --auto flag"']) {
    const path = PLANS + '/new.md'
    const disk = makeFs({ [path]: '- [ ] Ship it\n' })
    const s = await boot(disk)
    await s.call('Write', { file_path: path, content: 'x' })
    await s.call('TodoWrite', { todos: [{ content: 'Ship it', status: 'completed', activeForm: 'x' }] })
    await s.call('Bash', { command })
    assert.equal(disk.text(path), '- [x] Ship it\n', command)
  }
})

// ---- the matcher

test('the matcher: exact text only, code blocks skipped, line endings kept', async () => {
  const { tickPlan } = await import('../hooks/register.mjs')
  const crlf = '# P\r\n```md\r\n- [ ] Write tests\r\n# not a heading\r\n```\r\n- [ ] Write tests\r\n- [ ] Write tests later\r\n'
  const r = tickPlan(crlf, ['write  `tests`.'])
  assert.equal(r.text, crlf.replace('```\r\n- [ ] Write tests\r\n', '```\r\n- [x] Write tests\r\n'))
  assert.equal(r.count, 1)
  assert.equal(tickPlan('- [ ] Write tests for parser\n', ['Write tests']).count, 0, 'a step names no longer item')
  assert.equal(tickPlan('- [ ] Write tests\n', ['Write tests for parser']).count, 0, 'nor a shorter one')
  assert.equal(tickPlan('- [ ] Write\n- [ ] write\n', ['Write']).count, 0, 'two items: ambiguous')
  assert.equal(tickPlan('### Task 1: Parser\n- [ ] a\n### Task 2: Parser v2\n- [ ] b\n', ['Parser']).text, '### Task 1: Parser\n- [x] a\n### Task 2: Parser v2\n- [ ] b\n')
  assert.equal(tickPlan('### Task 1: Parser\n- [ ] a\n', ['Task 2: Parser']).count, 0, 'another task number names nothing')
})

test('a plan naming only a nested project, a worktree, or a path that is not there is not this folder\'s', async () => {
  const s = await boot(
    makeFs({
      [PLANS + '/sp.md']: ['Edit D:\\work\\app\\My Proj\\notes.txt\n- [ ] One\n', T],
      [CWD + '/My Proj/.git']: 'x',
      [CWD + '/My Proj/notes.txt']: '',
      [PLANS + '/wt.md']: ['Edit D:\\work\\app\\.claude\\worktrees\\feat-x\\src\\a.js\n- [ ] One\n', T],
      [CWD + '/.claude/worktrees/feat-x/.git']: 'gitdir: x',
      [CWD + '/.claude/worktrees/feat-x/src/a.js']: '',
      [PLANS + '/cl.md']: ['Edit D:/work/app/sub/deep/x.js\n- [ ] One\n', T],
      [CWD + '/sub/CLAUDE.md']: '# sub',
      [CWD + '/sub/deep/x.js']: '',
      [PLANS + '/gone.md']: ['Edit D:/work/app/nothing/here.js\n- [ ] One\n', T],
    })
  )
  assert.equal(await s.start(), undefined)
})

test('POSIX paths: /backup/opt/app does not name /opt/app', async () => {
  const seed = { [PLANS + '/x.md']: ['Copy /backup/opt/app/data\n- [ ] One\n', T], '/opt/app/data': '' }
  assert.equal(await (await boot(makeFs(seed), { cwd: '/opt/app' })).start(), undefined)
  seed[PLANS + '/y.md'] = ['Work in /opt/app.\n- [ ] Two\n', T - 60e3]
  assert.match(await (await boot(makeFs(seed), { cwd: '/opt/app' })).start(), /plans\/y\.md/)
})

test('a completed step ticks once: unticked by hand it stays, and a later plan is not ticked by it', async () => {
  const path = PLANS + '/new.md'
  const disk = makeFs({ [path]: '- [ ] Ship it\n' })
  const s = await boot(disk)
  await s.call('Write', { file_path: path, content: 'x' })
  await s.call('TodoWrite', { todos: [{ content: 'Ship it', status: 'completed', activeForm: 'x' }] })
  await s.turnEnd()
  assert.equal(disk.text(path), '- [x] Ship it\n')
  await disk.fs.write(path, '- [ ] Ship it\n') // the ship failed: unticked by hand
  await s.call('TodoWrite', { todos: [{ content: 'Ship it', status: 'completed', activeForm: 'x' }] })
  await s.turnEnd()
  assert.equal(disk.text(path), '- [ ] Ship it\n')

  const other = PLANS + '/later.md'
  const d2 = makeFs({ [other]: '# New\n- [ ] Refactor x\n- [ ] Run tests\n' })
  const s2 = await boot(d2)
  await s2.call('TaskCreate', { subject: 'Run tests', description: 'd' }, { result: { task: { id: '1', subject: 'Run tests' } } })
  await s2.call('TaskUpdate', { taskId: '1', status: 'completed' })
  await s2.call('Write', { file_path: other, content: 'x' })
  await s2.turnEnd()
  assert.deepEqual(d2.writes, [])
})

test('only completed steps tick: not a running one at a turn end or a merge, not one started', async () => {
  const path = PLANS + '/new.md'
  const disk = makeFs({ [path]: '- [ ] A\n- [ ] B\n- [ ] C\n' })
  const s = await boot(disk)
  await s.call('Write', { file_path: path, content: 'x' })
  await s.call('mcp__ccd_turn__update_plan', { items: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }, { content: 'C', status: 'pending' }] })
  await s.turnEnd()
  await s.call('Bash', { command: 'gh pr merge 1 --merge' })
  assert.deepEqual(disk.writes, [])
  await s.call('mcp__ccd_turn__update_plan', { advance: true }) // A done, B running
  await s.call('mcp__ccd_turn__update_plan', { start: 3 }) // C running too
  await s.turnEnd()
  assert.equal(disk.text(path), '- [x] A\n- [ ] B\n- [ ] C\n')
})

test('a wrap-up that stops on a question leaves the running step open', async () => {
  const path = PLANS + '/new.md'
  const disk = makeFs({ [path]: '- [ ] Deploy to prod\n' })
  const s = await boot(disk)
  await s.call('Write', { file_path: path, content: 'x' })
  await s.call('mcp__ccd_turn__update_plan', { items: [{ content: 'Deploy to prod', status: 'in_progress' }] })
  await s.call('mcp__ccd_turn__wrap_up', { recap: 'r', ask: 'Deploy now?', blocked: true })
  await s.call('mcp__ccd_turn__wrap_up', { recap: 'r', ask: 'Deploy now?' })
  assert.deepEqual(disk.writes, [])
})

test('a subagent writing a plan does not make it the active one', async () => {
  const main = PLANS + '/main.md'
  const sub = 'D:/other/docs/plans/sub.md'
  const disk = makeFs({ [main]: '- [ ] Ship it\n', [sub]: '- [ ] Ship it\n' })
  const s = await boot(disk)
  await s.call('Write', { file_path: main, content: 'x' })
  await s.call('Write', { file_path: sub, content: 'x' }, { agentId: 'a1' })
  await s.call('TodoWrite', { todos: [{ content: 'Ship it', status: 'completed', activeForm: 'x' }] })
  await s.turnEnd()
  assert.equal(disk.text(main), '- [x] Ship it\n')
  assert.equal(disk.text(sub), '- [ ] Ship it\n')
})

test('only a plan file becomes active: not a named template, not a .md written outside a plans folder', async () => {
  const tpl = CWD + '/.github/pull_request_template.md'
  const notes = CWD + '/notes.md'
  const disk = makeFs({ [tpl]: '- [ ] Tests added\n', [notes]: '- [ ] Tests added\n' })
  const s = await boot(disk)
  await s.prompt('fill in the PR body like .github/pull_request_template.md says')
  await s.call('Write', { file_path: notes, content: 'x' })
  await s.call('TodoWrite', { todos: [{ content: 'Tests added', status: 'completed', activeForm: 'x' }] })
  await s.turnEnd()
  assert.deepEqual(disk.writes, [])
})

test('of several plans a prompt names, the last one wins; plan.md.bak names none', async () => {
  const a = CWD + '/docs/plans/a.md'
  const b = CWD + '/docs/plans/b.md'
  const disk = makeFs({ [a]: '- [ ] Go\n', [b]: '- [ ] Go\n', [CWD + '/plan.md']: '- [ ] Go\n', [CWD + '/docs/plans/none.md']: '# No boxes\n' })
  const s = await boot(disk)
  await s.prompt('first docs/plans/a.md, then docs/plans/b.md, and docs/plans/none.md (no checkboxes)')
  await s.prompt('and the old plan.md.bak too')
  await s.call('TodoWrite', { todos: [{ content: 'Go', status: 'completed', activeForm: 'x' }] })
  await s.turnEnd()
  assert.deepEqual([disk.text(a), disk.text(b), disk.text(CWD + '/plan.md')], ['- [ ] Go\n', '- [x] Go\n', '- [ ] Go\n'])
})

test('a Bash call that merges nothing ticks nothing', async () => {
  const path = PLANS + '/new.md'
  const disk = makeFs({ [path]: '- [ ] Ship it\n' })
  const s = await boot(disk)
  await s.call('Write', { file_path: path, content: 'x' })
  await s.call('TodoWrite', { todos: [{ content: 'Ship it', status: 'completed', activeForm: 'x' }] })
  await s.call('Bash', { command: 'ls' })
  await s.call('Bash', { command: 'gh pr merge 5 --auto --merge' })
  await s.call('Bash', { command: 'echo gh pr merge' })
  assert.deepEqual(disk.writes, [])
  await s.call('Bash', { command: 'cd x && gh pr merge 5 --merge' })
  assert.equal(disk.text(path), '- [x] Ship it\n')
})

test('/resume leaves no plan active', async () => {
  const disk = makeFs(folderSeed())
  const s = await boot(disk)
  await s.start()
  await s.start('resume')
  await s.call('TodoWrite', { todos: [{ content: 'Ship it', status: 'completed', activeForm: 'x' }] })
  await s.turnEnd()
  assert.deepEqual(disk.writes, [])
})

test('the matcher: headings only of tasks, item text whole', async () => {
  const { tickPlan } = await import('../hooks/register.mjs')
  const n = (text, step) => tickPlan(text, [step]).count
  assert.equal(n('# Plan Keeper\n- [ ] a\n- [ ] b\n', 'Plan Keeper'), 0, 'a title is no task')
  assert.equal(n('# Task 1: Everything\n- [ ] a\n', 'Everything'), 0, 'not even a labelled one')
  assert.equal(n('## Verification\n- [ ] Run tests\n- [ ] Ask Filip\n', 'Verification'), 0, 'nor an unlabelled heading')
  assert.equal(n('### Release 2: X\n- [ ] a\n', 'X'), 0, 'nor another word with a number')
  assert.equal(n('### Task 1: Parser\n- [ ] Parser\n', 'Parser'), 0, 'a heading and an item: ambiguous')
  assert.equal(n('### Task 1: P\n- [ ] **Step 1: Write the test**\n', 'Write the test'), 0, 'an item keeps its label')
  assert.equal(n('- [ ] Ship it?\n', 'Ship it'), 0, 'only a period or colon is dropped')
  assert.equal(n('- [ ]Ship it\n', 'Ship it'), 0, 'no checkbox without a space')
  assert.equal(tickPlan('### Task 1: C#\n- [ ] a\n', ['C#']).text, '### Task 1: C#\n- [x] a\n')
  assert.equal(n('````md\n```\n- [ ] Ship it\n````\n', 'Ship it'), 0, 'a longer fence holds a shorter one')
})

let failed = 0
for (const [name, fn] of tests) {
  try {
    await fn()
    console.log('ok   ' + name)
  } catch (err) {
    failed++
    console.log('FAIL ' + name + '\n     ' + String(err.stack || err).split('\n').slice(0, 6).join('\n     '))
  }
}
console.log(`${tests.length - failed} of ${tests.length} passed`)
process.exit(failed ? 1 : 0)
