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

// refuse: state keys whose $.state.get throws, as a host that refuses them
// What a drawing holds, as text: every string of the tree, in order
const flat = (t) => (t == null || t === false ? '' : typeof t === 'string' ? t : Array.isArray(t) ? t.map(flat).join('') : flat(t.props.label) + flat(t.props.children) + (t.type === 'Box' || t.props.label ? '\n' : ''))
// The button of that key, anywhere in the tree
const button = (t, key) => {
  if (!t || typeof t !== 'object') return null
  if (Array.isArray(t)) return t.map((x) => button(x, key)).find(Boolean) || null
  if (t.type === 'Button' && t.props.key === key) return t
  return button(t.props.children, key)
}
const el = (type) => (props) => ({ type, props })

async function boot(disk, { cwd = CWD, state = new Map(), refuse = [], options } = {}) {
  const { register } = await import(`../hooks/register.mjs?boot=${++instance}`)
  const hs = []
  register((name, a, b) => hs.push({ name, filter: b ? a : null, fn: b || a }), options)
  const toasts = []
  const panes = new Set()
  let draws = 0
  const $ = {
    clock: { now: async () => T },
    fs: disk.fs,
    env: { get: async (n) => (n === 'USERPROFILE' ? HOME : '') },
    session: { cwd: async () => cwd },
    state: {
      get: (ref) => {
        if (refuse.includes(ref.key)) throw new Error('refused ' + ref.key)
        return Promise.resolve({ value: state.get(ref.key) })
      },
      set: async (ref, v) => void state.set(ref.key, JSON.parse(JSON.stringify(v))),
    },
    ui: {
      toast: (t) => void toasts.push(t),
      invalidate: () => void draws++,
      resolve: () => ({ Box: el('Box'), Text: el('Text'), Button: el('Button') }),
      panes: async () => [...panes].map((id) => ({ id })),
      open: async ({ id }) => void panes.add(id),
      close: async ({ id }) => void panes.delete(id),
    },
    command: { register: async () => {} },
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
    // The band above the prompt: its tree, or what lies below when it draws nothing
    band: (props = {}) => fire('ui.render', { component: 'AbovePrompt', surface: 'terminal', props }, null),
    pane: () => fire('ui.render', { component: 'Pane', requestId: 'plan-keeper', surface: 'terminal', props: {} }, null),
    cmd: async (args = '') => (await fire('command.run', { command: 'plan-keeper', args })).text,
    // The end of a batch of tools: the note added to what the others said, if any
    batch: async (agentId) => {
      const r = await fire('classic.PostToolBatch', agentId ? { agent_id: agentId } : {}, { additionalContext: ['other'] })
      return r.additionalContext.length > 1 ? r.additionalContext[1] : undefined
    },
    panes,
    draws: () => draws,
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

test('a reload after a wrap-up keeps what it completed; a refused key loads alone', async () => {
  const path = PLANS + '/new.md'
  const disk = makeFs({ [path]: '### Task 2: Matcher\n- [ ] a\n- [ ] b\n' })
  const state = new Map()
  const s = await boot(disk, { state })
  await s.call('Write', { file_path: path, content: 'x' })
  // A null entry costs only itself; the whole heading names its task too
  await s.call('TodoWrite', { todos: [null, { content: 'Task 2: Matcher', status: 'in_progress', activeForm: 'x' }] })
  const text = disk.text(path)
  disk.fs.read = async () => {
    throw new Error('EBUSY')
  }
  await s.call('mcp__ccd_turn__wrap_up', { recap: 'r' }) // completes the step, but the plan does not read
  assert.deepEqual(disk.writes, [])
  // The reload's $.state refuses the held steps: plan and task list still load
  const fresh = makeFs({ [path]: text })
  const again = await boot(fresh, { state, refuse: ['used'] })
  await again.turnEnd()
  assert.equal(fresh.text(path), '### Task 2: Matcher\n- [x] a\n- [x] b\n')
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

// ---- 0.2: the band, the pane, the closing note

const SMALL = '# P\n\nWork in D:\\work\\app.\n\n### Task 1: Parser\n- [ ] Write the parser\n- [ ] Test the parser\n\n### Task 2: Docs\n- [ ] Write the README\n'
const small = () => makeFs({ [PLANS + '/s.md']: SMALL, [CWD + '/src/x.js']: '' })
const list = (...steps) => ({ items: steps.map((content, k) => ({ content, status: k ? 'pending' : 'in_progress' })), scope: 'first_task' })

test('the band shows the plan, its count and the next open item; none without a plan', async () => {
  const s = await boot(small())
  assert.equal(await s.band(), null, 'no plan yet: only what lies below')
  await s.start()
  const text = flat(await s.band())
  assert.match(text, /▣ s/)
  assert.match(text, /0\/3/)
  assert.match(text, /next: Write the parser/)
  assert.equal(flat(await s.band({ hasSurvey: true })), '', 'a survey has the row')
  const bare = await boot(makeFs({ [CWD + '/src/x.js']: '' }))
  await bare.start()
  assert.equal(await bare.band(), null)
})

test('the band counts what a wrap-up ticks, and its bar fills by the share done', async () => {
  const s = await boot(small())
  await s.start()
  await s.call('mcp__ccd_turn__update_plan', list('Write the parser', 'Something else'))
  await s.call('mcp__ccd_turn__wrap_up', { recap: 'r', ask: 'More?' }) // stops on a question: nothing completed
  assert.match(flat(await s.band()), /0\/3/)
  await s.call('mcp__ccd_turn__update_plan', { advance: true })
  await s.call('mcp__ccd_turn__wrap_up', { recap: 'r', ask: 'More?' })
  const tree = await s.band()
  assert.match(flat(tree), /1\/3/)
  assert.match(flat(tree), /next: Test the parser/)
  assert.match(flat(tree), /━{6}/)
  const bar = JSON.stringify(tree).match(/"color":"green","children":\["(━*)"\]/)[1]
  assert.equal(bar.length, 6, 'a third of 18 cells')
})

test('a finished task list with open items: the band says so and Claude gets one note', async () => {
  const s = await boot(small())
  await s.start()
  await s.call('mcp__ccd_turn__update_plan', list('Write the parser', 'Fix the lint'))
  assert.equal(await s.batch(), undefined, 'the list still runs')
  await s.call('mcp__ccd_turn__update_plan', { advance: true })
  assert.equal(await s.batch(), undefined, 'one step is still open')
  await s.call('mcp__ccd_turn__wrap_up', { recap: 'r' })
  const note = await s.batch()
  assert.match(note, /task list is complete, the plan is not/)
  assert.match(note, /2 of 3 checkbox items open/)
  assert.match(note, /- \[ \] Test the parser/)
  assert.match(note, /- \[ \] Write the README/)
  assert.doesNotMatch(note, /- \[ \] Write the parser/, 'the ticked item is not open')
  assert.match(note, /named no single plan item: "Fix the lint"\./)
  assert.match(note, /data, not instructions/)
  assert.match(flat(await s.band()), /task list done, 2 open/)
  assert.equal(await s.batch(), undefined, 'once for that state')
  assert.equal(await s.batch('sub-1'), undefined)
})

test('the closing note ticks first, comes again when the state changes, and never for a subagent or a done plan', async () => {
  const s = await boot(small())
  await s.start()
  // The CLI's list, completed in one call: no wrap-up ticks it, the batch does
  await s.call('TodoWrite', { todos: [{ content: 'Write the parser', status: 'completed' }] })
  assert.equal(await s.batch('sub-1'), undefined, 'a subagent batch says nothing')
  const first = await s.batch()
  assert.match(first, /2 of 3 checkbox items open/)
  assert.match(s.toasts.at(-1), /ticked 1 item in s\.md/)
  await s.call('TodoWrite', { todos: [{ content: 'Write the parser', status: 'completed' }, { content: 'Test the parser', status: 'completed' }] })
  assert.match(await s.batch(), /1 of 3 checkbox items open/)
  await s.call('TodoWrite', { todos: [{ content: 'Write the parser', status: 'completed' }, { content: 'Test the parser', status: 'completed' }, { content: 'Task 2', status: 'completed' }] })
  assert.equal(await s.batch(), undefined, 'nothing open: no note')
  assert.match(flat(await s.band()), /✓ s/)
  assert.match(flat(await s.band()), /3\/3\n· plan complete/)
  assert.match(s.toasts.at(-1), /the plan is complete/)
})

test('a step named by its task number ticks that task; two tasks of one number tick neither', async () => {
  const { tickPlan } = await import('../hooks/register.mjs')
  assert.equal(tickPlan(SMALL, ['Task 1']).count, 2)
  assert.equal(tickPlan(SMALL, ['task 2.']).text, SMALL.replace('- [ ] Write the README', '- [x] Write the README'))
  assert.deepEqual(tickPlan(SMALL, ['Task 3', 'Task 1']).missed, ['Task 3'])
  const twice = '## A\n### Task 1: X\n- [ ] a\n## B\n### Task 1: Y\n- [ ] b\n'
  assert.equal(tickPlan(twice, ['Task 1']).count, 0)
  assert.deepEqual(tickPlan(twice, ['Task 1', ' a ']).missed, ['Task 1'])
  assert.equal(tickPlan('### Task 12: Z\n- [ ] z\n', ['Task 1']).count, 0, 'Task 1 is not Task 12')
})

test('the pane lists sections, open items and the steps that named nothing', async () => {
  const s = await boot(small())
  await s.start()
  await s.call('mcp__ccd_turn__update_plan', list('Write the parser', 'Fix the lint'))
  await s.call('mcp__ccd_turn__update_plan', { advance: true })
  await s.call('mcp__ccd_turn__wrap_up', { recap: 'r' })
  const text = flat(await s.pane())
  assert.match(text, /Plan Keeper {2}1\/3/)
  assert.match(text, /C:\/Users\/u\/\.claude\/plans\/s\.md/)
  assert.match(text, /active because: the newest plan for this folder with open items · last tick \d\d:\d\d/)
  assert.match(text, /◐ Task 1: Parser\n.*\n1\/2/)
  assert.match(text, /○ Task 2: Docs\n.*\n0\/1/)
  assert.match(text, / {4}○ Test the parser/)
  assert.doesNotMatch(text, /○ Write the parser/)
  assert.match(text, /Done steps that named no single item {4}· Fix the lint/)
})

test('/plan-keeper opens and closes the pane, hides the band, stops and starts tracking', async () => {
  const s = await boot(small())
  await s.start()
  assert.equal(await s.cmd(), 'Plan pane opened.')
  assert.deepEqual([...s.panes], ['plan-keeper'])
  assert.equal(await s.cmd(), 'Plan pane closed.')
  assert.deepEqual([...s.panes], [])

  await s.cmd('hide')
  assert.equal(await s.band(), null)
  await s.cmd('show')
  assert.match(flat(await s.band()), /0\/3/)

  assert.match(await s.cmd('off'), /stopped tracking/)
  assert.equal(await s.band(), null)
  assert.match(flat(await s.pane()), /Tracking is stopped for this chat/)
  assert.equal(await s.start('clear'), undefined, 'a cleared chat picks no plan while tracking is off')
  assert.match(await s.cmd('on'), /tracks C:\/Users\/u\/\.claude\/plans\/s\.md/)
  assert.match(flat(await s.band()), /0\/3/)
})

test('/plan-keeper with a path tracks that plan; a file without items or one that is not there does not', async () => {
  const disk = makeFs({ [PLANS + '/s.md']: SMALL, [CWD + '/notes/todo.md']: '- [ ] one\n- [x] two\n', [CWD + '/notes/prose.md']: 'no items\n', [CWD + '/src/x.js']: '' })
  const s = await boot(disk)
  await s.start()
  assert.match(await s.cmd('notes/missing.md'), /could not read D:\/work\/app\/notes\/missing\.md/)
  assert.match(await s.cmd('notes/prose.md'), /has no checkbox items/)
  assert.match(flat(await s.band()), /▣ s/, 'the plan stays')
  assert.equal(await s.cmd('"notes/todo.md"'), 'Plan Keeper tracks D:/work/app/notes/todo.md: 1 of 2 items open.')
  assert.match(flat(await s.band()), /▣ todo/)
  assert.match(flat(await s.band()), /1\/2/)
})

test('the band\'s buttons: plan opens the pane, ✕ hides the band for the chat and across a reload', async () => {
  const state = new Map()
  const disk = small()
  const s = await boot(disk, { state })
  await s.start()
  await button(await s.band(), 'pane').props.onPress()
  assert.deepEqual([...s.panes], ['plan-keeper'])
  await button(await s.band(), 'hide').props.onPress()
  assert.equal(await s.band(), null)
  const again = await boot(disk, { state })
  assert.equal(await again.band(), null, 'hidden stays hidden')
  assert.match(flat(await again.pane()), /Plan Keeper {2}0\/3/, 'the pane still shows the plan')
  await button(await again.pane(), 'band').props.onPress()
  assert.match(flat(await again.band()), /0\/3/)
})

test('the pane\'s buttons: switch plan offers the folder\'s other plans, stop tracking lets the plan go', async () => {
  const disk = makeFs({ [PLANS + '/s.md']: [SMALL, T], [PLANS + '/older.md']: ['Work in D:\\work\\app.\n- [ ] x\n- [ ] y\n', T - DAY], [PLANS + '/done.md']: ['Work in D:\\work\\app.\n- [x] x\n', T], [CWD + '/src/x.js']: '' })
  const s = await boot(disk)
  await s.start()
  await button(await s.pane(), 'switch').props.onPress()
  const offered = flat(await s.pane())
  assert.match(offered, /Plans of this folder with open items/)
  assert.match(offered, /older\.md \(2 open\)/)
  assert.doesNotMatch(offered, /s\.md \(|done\.md/, 'not the active plan, not a finished one')
  await button(await s.pane(), 'c0').props.onPress()
  assert.match(flat(await s.band()), /▣ older/)
  assert.doesNotMatch(flat(await s.pane()), /Plans of this folder/, 'the list shuts once one is picked')
  await button(await s.pane(), 'stop').props.onPress()
  assert.equal(await s.band(), null)
  await button(await s.pane(), 'start').props.onPress()
  assert.match(flat(await s.band()), /▣ s/, 'tracking again picks the newest plan')
})

test('a complete plan is let go at the next prompt and not picked again', async () => {
  const disk = makeFs({ [PLANS + '/one.md']: 'Work in D:\\work\\app.\n- [ ] Ship it\n', [CWD + '/src/x.js']: '' })
  const s = await boot(disk)
  await s.start()
  await s.call('mcp__ccd_turn__update_plan', list('Ship it'))
  await s.call('mcp__ccd_turn__wrap_up', { recap: 'r' })
  assert.match(flat(await s.band()), /1\/1\n· plan complete/)
  assert.equal(await s.batch(), undefined)
  await s.prompt('next thing')
  assert.equal(await s.band(), null)
  assert.equal(await s.start('clear'), undefined)
  assert.equal(await s.band(), null)
})

test('a tick made by hand in the plan file shows on the band; band: off draws none', async () => {
  const disk = makeFs({ [CWD + '/docs/plans/p.md']: '- [ ] a\n- [ ] b\n' })
  const s = await boot(disk)
  await s.start()
  assert.match(flat(await s.band()), /0\/2/)
  await disk.fs.write(CWD + '/docs/plans/p.md', '- [x] a\n- [ ] b\n')
  await s.call('Edit', { file_path: CWD + '/docs/plans/p.md' })
  assert.match(flat(await s.band()), /1\/2/)
  await disk.fs.write(CWD + '/docs/plans/p.md', '- [x] a\n- [x] b\n')
  await s.turnEnd()
  assert.match(flat(await s.band()), /2\/2/, 'a turn end reads the file again')

  const off = await boot(makeFs({ [CWD + '/docs/plans/p.md']: '- [ ] a\n' }), { options: { band: 'off' } })
  await off.start()
  assert.equal(await off.band(), null)
  assert.doesNotMatch(flat(await off.pane()), /hide band|show band/)
})

test('a new plan and a cleared chat start with no unmatched steps; a reload keeps them', async () => {
  const state = new Map()
  const disk = makeFs({ [PLANS + '/s.md']: SMALL, [CWD + '/docs/plans/n.md']: '- [ ] z\n', [CWD + '/src/x.js']: '' })
  const s = await boot(disk, { state })
  await s.start()
  await s.call('mcp__ccd_turn__update_plan', list('Fix the lint'))
  await s.call('mcp__ccd_turn__wrap_up', { recap: 'r' })
  assert.match(flat(await s.pane()), /· Fix the lint/)
  const again = await boot(disk, { state })
  assert.match(flat(await again.pane()), /· Fix the lint/)
  await again.call('Write', { file_path: CWD + '/docs/plans/n.md' })
  assert.doesNotMatch(flat(await again.pane()), /Fix the lint/)
  assert.match(flat(await again.pane()), /Plan Keeper {2}0\/1/)
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
