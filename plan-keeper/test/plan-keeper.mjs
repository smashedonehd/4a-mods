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

async function boot(disk, { cwd = CWD, state = new Map(), refuse = [], options, sid } = {}) {
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
    session: { cwd: async () => cwd, ...(sid !== undefined && { id: async () => sid }) },
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
      resolve: () => ({ Box: el('Box'), Text: el('Text'), Button: el('Button'), Svg: el('Svg') }),
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
    promptFrom: (text, origin) => fire('prompt.submit', { text, origin }, { text }),
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
    ui: $.ui,
    render: (e, below) => fire('ui.render', e, below),
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
  assert.match(flat(await s.band()), /3\/3· plan complete/)
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
  assert.match(flat(await s.band()), /1\/1· plan complete/)
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

test('a new plan starts with no unmatched steps; a reload keeps them', async () => {
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

// ---- 0.2: what the review found

const done = (...steps) => ({ todos: steps.map((content) => ({ content, status: 'completed' })) })

test('the closing note comes once per finished list: not again for a tick by hand or a reload, again for a new list', async () => {
  const state = new Map()
  const disk = small()
  const s = await boot(disk, { state })
  await s.start()
  await s.call('TodoWrite', done('Fix the lint'))
  assert.match(await s.batch(), /3 of 3 checkbox items open/)
  // Claude ticks an item in the file, as the note asked
  await disk.fs.write(PLANS + '/s.md', SMALL.replace('- [ ] Write the parser', '- [x] Write the parser'))
  await s.call('Edit', { file_path: PLANS + '/s.md' })
  assert.equal(await s.batch(), undefined, 'the same list: no second note')
  assert.match(flat(await s.band()), /1\/3/)
  const again = await boot(disk, { state })
  assert.equal(await again.batch(), undefined, 'nor after a reload')
  await again.call('TodoWrite', done('Fix the lint', 'Fix the types'))
  assert.match(await again.batch(), /2 of 3 checkbox items open/, 'another list that ends short is put again')
  assert.equal(await again.batch(), undefined)
})

test('a new plan and a cleared chat are noted afresh, with no unmatched steps', async () => {
  const disk = makeFs({ [PLANS + '/s.md']: SMALL, [CWD + '/docs/plans/n.md']: '- [ ] z\n', [CWD + '/src/x.js']: '' })
  const s = await boot(disk)
  await s.start()
  await s.call('TodoWrite', done('Fix the lint'))
  assert.match(await s.batch(), /named no single plan item: "Fix the lint"/)
  await s.call('Write', { file_path: CWD + '/docs/plans/n.md' })
  assert.match(await s.batch(), /n\.md, 1 of 1 checkbox items open/, 'the same list against another plan')
  assert.doesNotMatch(flat(await s.pane()), /Fix the lint/)

  await s.cmd(PLANS + '/s.md')
  await s.call('TodoWrite', done('Fix the lint', 'More lint'))
  // "Fix the lint" was done before s.md became the plan again: held, not unmatched
  assert.match(await s.batch(), /named no single plan item: "More lint"\./)
  await s.start('clear')
  assert.doesNotMatch(flat(await s.pane()), /lint/, 'a cleared chat has no unmatched steps')
  await s.call('TodoWrite', done('Fix the lint', 'More lint'))
  assert.match(await s.batch(), /3 of 3 checkbox items open/, 'and its list is put to Claude again')
})

test('/plan-keeper on keeps a plan that is tracked, and shows the band again', async () => {
  const disk = makeFs({ [PLANS + '/s.md']: SMALL, [CWD + '/notes/todo.md']: '- [ ] one\n', [CWD + '/src/x.js']: '' })
  const s = await boot(disk)
  await s.start()
  await s.cmd('notes/todo.md')
  await s.cmd('hide')
  assert.equal(await s.cmd('on'), 'Plan Keeper tracks D:/work/app/notes/todo.md.')
  assert.match(flat(await s.band()), /▣ todo/, 'not swapped for the folder\'s newest, and no longer hidden')
  assert.equal(await s.cmd('..\\app\\notes\\missing.md'), 'Plan Keeper could not read D:/work/app/../app/notes/missing.md.')
})

test('a finished plan unticked by hand before the next prompt is kept; a slash command lets none go', async () => {
  const disk = makeFs({ [PLANS + '/one.md']: 'Work in D:\\work\\app.\n- [ ] Ship it\n', [CWD + '/src/x.js']: '' })
  const s = await boot(disk)
  await s.start()
  await s.call('TodoWrite', done('Ship it'))
  await s.turnEnd()
  assert.match(flat(await s.band()), /plan complete/)
  await s.prompt('/plan-keeper')
  assert.match(flat(await s.band()), /plan complete/, 'a command is no next prompt')
  await disk.fs.write(PLANS + '/one.md', 'Work in D:\\work\\app.\n- [ ] Ship it\n') // the ship failed
  await s.prompt('try again')
  assert.match(flat(await s.band()), /0\/1/)
  assert.match(flat(await s.band()), /task list done, 1 open/)
})

test('a plan let go as finished does not stop tracking: the next plan of the folder is picked', async () => {
  const disk = makeFs({ [PLANS + '/one.md']: 'Work in D:\\work\\app.\n- [ ] Ship it\n', [CWD + '/src/x.js']: '' })
  const s = await boot(disk)
  await s.start()
  await s.call('TodoWrite', done('Ship it'))
  await s.turnEnd()
  // A path at the start of a prompt is no slash command
  await s.prompt('/home/u/notes.txt has the logs')
  assert.match(flat(await s.pane()), /No plan is active in this chat/)
  await disk.fs.write(PLANS + '/two.md', 'Work in D:\\work\\app.\n- [ ] More\n')
  assert.match(await s.start('clear'), /two\.md/)
})

test('a plan file that is gone: no band, the pane says so, and a draw asks for no other draw', async () => {
  const disk = makeFs({ [CWD + '/docs/plans/p.md']: '- [ ] a\n' })
  const state = new Map()
  const s = await boot(disk, { state })
  await s.start()
  state.set('plan', { path: CWD + '/docs/plans/gone.md', why: 'written' })
  let reads = 0
  const read = disk.fs.read
  disk.fs.read = (p) => (/gone\.md$/.test(p) && reads++, read(p))
  const again = await boot(disk, { state })
  const before = again.draws()
  assert.equal(await again.band(), null)
  assert.equal(await again.band(), null)
  const pane = flat(await again.pane())
  assert.match(pane, /The plan file cannot be read \(moved or deleted\):D:\/work\/app\/docs\/plans\/gone\.md/)
  assert.doesNotMatch(pane, /No plan is active/)
  assert.equal(again.draws(), before, 'a draw that reads the file does not invalidate')
  assert.equal(reads, 1, 'and the file that is gone is read once, not at every draw')
  // The pane drawn first reads it too, and asks for no draw either
  const third = await boot(disk, { state })
  const start = third.draws()
  assert.match(flat(await third.pane()), /cannot be read/)
  assert.equal(third.draws(), start)
})

test('a draw that throws falls back to what lies below; another pane is not ours', async () => {
  const s = await boot(small())
  await s.start()
  const pane = { component: 'Pane', requestId: 'plan-keeper', surface: 'terminal', props: {} }
  assert.equal(await s.render({ ...pane, requestId: 'other' }, 'theirs'), 'theirs')
  s.ui.resolve = () => {
    throw new Error('no elements')
  }
  assert.equal(await s.render(pane, 'below'), 'below')
  assert.equal(await s.render({ component: 'AbovePrompt', surface: 'terminal', props: {} }, 'below'), 'below')
})

test('the last tick belongs to its plan: another plan starts without one', async () => {
  const disk = makeFs({ [PLANS + '/s.md']: SMALL, [CWD + '/docs/plans/n.md']: '- [ ] z\n', [CWD + '/src/x.js']: '' })
  const s = await boot(disk)
  await s.start()
  await s.call('TodoWrite', done('Write the parser'))
  await s.turnEnd()
  assert.match(flat(await s.pane()), /last tick/)
  await s.call('Write', { file_path: CWD + '/docs/plans/n.md' })
  assert.doesNotMatch(flat(await s.pane()), /last tick/)
})

test('/resume starts another chat: the band is shown and tracking is on again', async () => {
  const s = await boot(small())
  await s.start()
  await s.call('TodoWrite', done('Fix the lint'))
  await s.cmd('hide')
  await s.cmd('off')
  await s.start('resume')
  assert.deepEqual(s.state.get('tasks'), [], 'the other chat has its own task list')
  assert.match(flat(await s.pane()), /No plan is active in this chat/)
  assert.match(await s.start('clear'), /s\.md/, 'the resumed chat picks the folder\'s plan when it clears')
  assert.match(flat(await s.band()), /0\/3/)
})

test('tracking stopped by hand starts again with a plan this chat writes, and with track again', async () => {
  const disk = makeFs({ [PLANS + '/s.md']: SMALL, [CWD + '/docs/plans/n.md']: '- [ ] z\n', [CWD + '/src/x.js']: '' })
  const s = await boot(disk)
  await s.start()
  await s.cmd('off')
  await s.call('Write', { file_path: CWD + '/docs/plans/n.md' })
  assert.match(flat(await s.band()), /▣ n/)
  assert.equal(s.state.get('prefs').off, false, 'a plan written turns tracking on')
  assert.match(await s.start('clear'), /n\.md/, 'tracking is on: the cleared chat is told')

  await s.cmd('off')
  await button(await s.pane(), 'start').props.onPress()
  await disk.fs.write(CWD + '/docs/plans/n.md', '- [x] z\n')
  await s.turnEnd()
  await s.prompt('next')
  assert.match(await s.start('clear'), /s\.md/, 'track again turned it on for later chats too')
})

test('/plan-keeper on with no plan of the folder still turns tracking on', async () => {
  const s = await boot(makeFs({ [CWD + '/notes/todo.md']: '- [ ] a\n' }))
  await s.start()
  await s.cmd('notes/todo.md')
  await s.cmd('off')
  assert.match(flat(await s.pane()), /Tracking is stopped for this chat/)
  assert.match(await s.cmd('on'), /No plan of this folder has open items/)
  assert.match(flat(await s.pane()), /No plan is active in this chat/)
})

test('a plan written with no checkbox yet is kept at the next prompt', async () => {
  const disk = makeFs({ [CWD + '/docs/plans/n.md']: '# Plan\n\nto be filled\n' })
  const s = await boot(disk)
  await s.start()
  await s.call('Write', { file_path: CWD + '/docs/plans/n.md' })
  await s.prompt('go on')
  assert.equal(s.state.get('plan').path, CWD + '/docs/plans/n.md')
})

test('a plan picked for a cleared chat in place of one that is gone starts without the old last tick', async () => {
  const state = new Map()
  const disk = small()
  const s = await boot(disk, { state })
  await s.start()
  await s.call('TodoWrite', done('Write the README'))
  await s.turnEnd()
  assert.match(flat(await s.pane()), /last tick/)
  // The tracked plan was another file, deleted since
  state.set('plan', { path: PLANS + '/gone.md', why: 'written' })
  const again = await boot(disk, { state })
  assert.match(await again.start('clear'), /s\.md/)
  assert.doesNotMatch(flat(await again.pane()), /last tick/)

  // Gone, and the folder has no other plan: none is active
  const bare = new Map([['plan', { path: PLANS + '/gone.md', why: 'written' }]])
  const none = await boot(makeFs({ [CWD + '/src/x.js']: '' }), { state: bare })
  assert.equal(await none.start('clear'), undefined)
  assert.match(flat(await none.pane()), /No plan is active in this chat/)
})

test('stopping tracking ticks what the list completed first', async () => {
  const disk = small()
  const s = await boot(disk)
  await s.start()
  await s.call('TodoWrite', done('Write the README'))
  assert.deepEqual(disk.writes, [])
  await s.cmd('off')
  assert.match(disk.text(PLANS + '/s.md'), /- \[x\] Write the README/)
})

test('the band is asked to draw when the task list changes and when a wrap-up ticks nothing', async () => {
  const s = await boot(small())
  await s.start()
  let n = s.draws()
  await s.call('TodoWrite', { todos: [{ content: 'Fix the lint', status: 'in_progress' }] })
  assert.ok(s.draws() > n, 'a task-list change')
  await s.call('mcp__ccd_turn__update_plan', list('Fix the lint'))
  n = s.draws()
  await s.call('mcp__ccd_turn__wrap_up', { recap: 'r' })
  assert.ok(s.draws() > n, 'the list ended: the band turns to "task list done"')
  assert.match(flat(await s.band()), /task list done, 3 open/)
})

test('an edit of a tracked plan outside a plans folder is drawn; a plan left with no items draws no band', async () => {
  const disk = makeFs({ [CWD + '/notes/todo.md']: '- [ ] a\n- [ ] b\n- [ ] c\n- [ ] d\n' })
  const s = await boot(disk)
  await s.start()
  await s.cmd('notes/todo.md')
  await disk.fs.write(CWD + '/notes/todo.md', '- [x] a\n- [ ] b\n- [ ] c\n- [ ] d\n')
  await s.call('Edit', { file_path: 'D:\\work\\app\\notes\\todo.md' })
  const tree = await s.band()
  assert.match(flat(tree), /1\/4/)
  assert.equal(JSON.stringify(tree).match(/"color":"green","children":\["(━*)"\]/)[1].length, 5, '4.5 of 18 cells rounds up')
  await disk.fs.write(CWD + '/notes/todo.md', 'nothing left\n')
  await s.turnEnd()
  assert.equal(await s.band(), null)
})

test('only the newest 20 unmatched steps are kept, and switch plan offers at most 8 plans', async () => {
  const seed = { [PLANS + '/s.md']: [SMALL, T], [CWD + '/src/x.js']: '' }
  for (let k = 1; k <= 10; k++) seed[PLANS + `/old${k}.md`] = ['Work in D:\\work\\app.\n- [ ] x\n', T - k * 1000]
  const s = await boot(makeFs(seed))
  await s.start()
  await s.call('TodoWrite', done(...Array.from({ length: 25 }, (_, k) => 'Chore ' + (k + 1))))
  await s.turnEnd()
  const pane = flat(await s.pane())
  assert.doesNotMatch(pane, /· Chore 5 /)
  assert.match(pane, /item {4}· Chore 6 {4}· Chore 7 /, 'the list starts at the sixth')
  assert.match(pane, /· Chore 25/)
  await button(await s.pane(), 'switch').props.onPress()
  assert.equal(flat(await s.pane()).match(/old\d+\.md \(1 open\)/g).length, 7, '8 newest, the active one left out')
})

test('a plugin\'s slash command (/name:sub) lets no finished plan go', async () => {
  const s = await boot(makeFs({ [PLANS + '/one.md']: 'Work in D:\\work\\app.\n- [ ] Ship it\n', [CWD + '/src/x.js']: '' }))
  await s.start()
  await s.call('TodoWrite', done('Ship it'))
  await s.turnEnd()
  await s.prompt('/caveman:caveman-stats')
  assert.match(flat(await s.band()), /plan complete/)
})

test('the note\'s rows: 8 open items one by one, more by heading without the finished ones, 15 rows at most', async () => {
  const { openItems } = await import('../hooks/register.mjs')
  const open = (n, from = 1) => Array.from({ length: n }, (_, k) => `- [ ] item ${from + k}\n`).join('')
  assert.deepEqual(openItems(open(8)).rows, Array.from({ length: 8 }, (_, k) => `- [ ] item ${k + 1}`))
  const grouped = openItems(open(2) + '## Done\n- [x] a\n- [x] b\n## Big\n' + open(7, 3))
  assert.deepEqual(grouped.rows, ['- (before the first heading): 2 of 2 open', '- Big: 7 of 7 open'])
  assert.deepEqual([grouped.open, grouped.total], [9, 11])
  const sections = (n) => Array.from({ length: n }, (_, k) => `## S${k + 1}\n- [ ] x${k + 1}\n`).join('')
  const fifteen = openItems(sections(15)).rows
  assert.equal(fifteen.length, 15)
  assert.equal(fifteen[14], '- S15: 1 of 1 open')
  const sixteen = openItems(sections(16)).rows
  assert.equal(sixteen.length, 15)
  assert.equal(sixteen[14], '- and 2 more')
})

test('the same plan named again keeps its last tick', async () => {
  const s = await boot(small())
  await s.start()
  await s.call('TodoWrite', done('Write the README'))
  await s.turnEnd()
  await s.cmd(PLANS + '/s.md')
  assert.match(flat(await s.pane()), /last tick/)
})

test('tracking stopped and started with the same plan and list brings no second note; a reload still brings the first', async () => {
  const state = new Map()
  const disk = small()
  const s = await boot(disk, { state })
  await s.start()
  await s.call('TodoWrite', done('Fix the lint'))
  await s.turnEnd()
  // Reloaded with the step already held and no note yet: the plan is read for it
  const again = await boot(disk, { state })
  assert.match(await again.batch(), /3 of 3 checkbox items open/)
  await again.cmd('off')
  assert.match(await again.cmd('on'), /s\.md/)
  assert.equal(await again.batch(), undefined)
})

test('/resume with a plan tracked ticks nothing: the list of the chat left is gone first', async () => {
  const disk = small()
  const s = await boot(disk)
  await s.start()
  await s.call('TodoWrite', done('Write the README'))
  await s.start('resume')
  assert.deepEqual(disk.writes, [])
  assert.equal(s.state.get('plan'), null)
})

// ---- plans written from the task list

const { djb2, slugOf, planRowSvg } = await import('../hooks/register.mjs?helpers')
const GEN = `${HOME}/.claude/mods-data/plan-keeper/plans/app-${djb2('d:/work/app')}`
const UP = 'mcp__ccd_turn__update_plan'
const items = (...texts) => texts.map((content, k) => ({ content, status: k ? 'pending' : 'in_progress' }))
const genPath = (disk) => disk.writes.find((p) => k(p).startsWith(k(GEN) + '/'))

test('a task list of three steps gets a plan written for it; two steps get none', async () => {
  const two = makeFs({})
  const s2 = await boot(two, { sid: 'abcdef1234' })
  await s2.call(UP, { items: items('Look around', 'Fix it') })
  assert.deepEqual(two.writes, [])
  assert.ok(!s2.state.get('plan'))

  const disk = makeFs({})
  const s = await boot(disk, { sid: 'abcdef1234' })
  await s.call(UP, { items: items('Read the code', 'Write the fix', 'Run the tests'), scope: 'first_task' })
  const path = genPath(disk)
  assert.ok(path, 'a plan file is written under the generated plans folder')
  assert.match(path, /\/2026-11-01-\d{4}-read-the-code-abcdef12\.md$/)
  const text = disk.text(path)
  assert.match(text, /^<!-- plan-keeper \{"v":1,"cwd":"D:\/work\/app","session":"abcdef1234","source":"task-list"\} -->\n# Read the code\n\n- \[ \] Read the code\n- \[ \] Write the fix\n- \[ \] Run the tests\n$/)
  assert.deepEqual(s.state.get('plan'), { path, why: 'generated' })
  assert.match(flat(await s.band()), /0\/3/)
})

test('the generated plan ticks as its steps complete', async () => {
  const disk = makeFs({})
  const s = await boot(disk, { sid: 's1' })
  await s.call(UP, { items: items('Read the code', 'Write the fix', 'Run the tests') })
  const path = genPath(disk)
  await s.call(UP, { advance: true })
  await s.call(UP, { done: [2] })
  await s.turnEnd()
  assert.match(disk.text(path), /- \[x\] Read the code\n- \[x\] Write the fix\n- \[ \] Run the tests/)
  await s.call(UP, { start: 3 })
  await s.call('mcp__ccd_turn__wrap_up', { recap: 'done' })
  assert.match(disk.text(path), /- \[x\] Run the tests/)
})

test('steps already completed are written ticked; a continuation adds new steps; a new task starts a new plan', async () => {
  const disk = makeFs({})
  const s = await boot(disk, { sid: 's1' })
  await s.call(UP, { items: [{ content: 'Look around', status: 'completed' }, ...items('Fix A', 'Test A')] })
  const first = genPath(disk)
  assert.match(disk.text(first), /- \[x\] Look around\n- \[ \] Fix A/)
  // The band names a generated plan by its title, not its dated file name
  const band = flat(await s.band())
  assert.match(band, /▣ Look around/)
  assert.doesNotMatch(band, /\d{4}-\d\d-\d\d/)
  await s.call(UP, { items: [{ content: 'Look around', status: 'completed' }, ...items('Fix A', 'Test A', 'Ship A')], scope: 'continuation' })
  assert.match(disk.text(first), /- \[ \] Test A\n- \[ \] Ship A\n$/)
  assert.equal((disk.text(first).match(/Fix A/g) || []).length, 1)
  await s.call(UP, { items: items('Plan B', 'Build B', 'Check B'), scope: 'new_task' })
  const plan = s.state.get('plan')
  assert.notEqual(k(plan.path), k(first))
  assert.match(disk.text(plan.path), /# Plan B/)
  // A new task of two steps lets the plan go and writes none; its completed step ticks nothing in the old plan
  const before = disk.writes.length
  await s.call(UP, { items: [{ content: 'Build B', status: 'completed' }, ...items('Done')], scope: 'new_task' })
  assert.equal(s.state.get('plan'), null)
  assert.equal(disk.writes.length, before)
  assert.match(disk.text(plan.path), /- \[ \] Build B/)
})

test('a plan with items stays the plan; a plan mode plan in prose is replaced and named as the source', async () => {
  const disk = makeFs(folderSeed())
  const s = await boot(disk, { sid: 's1' })
  await s.start()
  await s.call(UP, { items: items('Write tests', 'Fix', 'Ship') })
  assert.match(s.state.get('plan').path, /plans\/a\.md$/)
  assert.equal(genPath(disk), undefined)

  const prose = PLANS + '/prose.md'
  const d2 = makeFs({ [prose]: '# Plan\n\nJust prose, no boxes.\n' })
  const s2 = await boot(d2, { sid: 's1' })
  await s2.call('ExitPlanMode', {}, { result: { filePath: prose } })
  await s2.call(UP, { items: items('One', 'Two', 'Three') })
  const path = genPath(d2)
  assert.ok(path)
  assert.match(d2.text(path), new RegExp('Source: ' + prose.replace(/[.]/g, '\\.')))
  assert.equal(s2.state.get('plan').why, 'generated')
})

test('a subagent\'s task list and a chat with tracking off write no plan', async () => {
  const disk = makeFs({})
  const s = await boot(disk)
  await s.call(UP, { items: items('A', 'B', 'C') }, { agentId: 'sub1' })
  assert.deepEqual(disk.writes, [])
  await s.cmd('off')
  await s.call(UP, { items: items('A', 'B', 'C') })
  assert.deepEqual(disk.writes, [])
})

test('after a reload or a restart the generated plan with open items is picked again, from the home folder too', async () => {
  const disk = makeFs({})
  const s = await boot(disk)
  await s.call(UP, { items: items('A one', 'B two', 'C three') })
  const path = genPath(disk)
  assert.ok(!/-\.md$/.test(path), 'no id: no trailing dash')
  const fresh = await boot(disk)
  assert.match(await fresh.start(), new RegExp('the active plan is ' + path.replace(/[.]/g, '\\.') + ' \\(the newest plan for this folder'))

  const home = makeFs({})
  const h = await boot(home, { cwd: HOME })
  await h.call(UP, { items: items('A one', 'B two', 'C three') })
  assert.ok(home.writes.length === 1)
  const again = await boot(home, { cwd: HOME })
  assert.match(await again.start(), /mods-data\/plan-keeper\/plans\/u-/)
})

test('cache keeper\'s continuation reattaches the plan of its "Plan:" line, and no other path in it', async () => {
  const disk = makeFs({ ...folderSeed(), [PLANS + '/other-plan.md']: '- [ ] Other\n' })
  const s = await boot(disk)
  const text = `Handoff from my previous session. Plan: ${PLANS}/a.md\nKey files: ${PLANS}/other-plan.md`
  await s.promptFrom(text, { kind: 'plugin', name: 'cache-keeper' })
  assert.equal(s.state.get('plan'), undefined, 'a "Plan:" that is not its own line names nothing')
  await s.promptFrom(`Handoff from my previous session.\nPlan: ${PLANS}/a.md\n\nKey files: ${PLANS}/other-plan.md`, { kind: 'plugin', name: 'cache-keeper' })
  assert.match(s.state.get('plan').path, /plans\/a\.md$/)
  // Another plugin's prompt names nothing
  const t = await boot(disk)
  await t.promptFrom(`Plan: ${PLANS}/a.md`, { kind: 'plugin', name: 'other' })
  assert.equal(t.state.get('plan'), undefined)
})

test('under a busy savvy-progress band the plan row is compact, with no bar of its own', async () => {
  const disk = makeFs({})
  const state = new Map()
  const s = await boot(disk, { state })
  await s.call(UP, { items: items('Read the code', 'Write the fix', 'Run the tests') })
  const full = await s.band()
  assert.ok(flat(full).includes('━'))
  state.set('flow', { title: 'x', total: 2, done: 0, isFinished: false })
  const compact = flat(await s.band())
  assert.ok(!compact.includes('━'))
  assert.match(compact, /plan .*0\/3/)
  state.set('flow', { title: 'x', total: 2, done: 2, isFinished: true })
  assert.ok(flat(await s.band()).includes('━'))
  state.set('agents', [{ status: 'running' }])
  assert.ok(!flat(await s.band()).includes('━'))
})

test('a generated plan in its own folder is reattached by cache keeper\'s "Plan:" line', async () => {
  const disk = makeFs({})
  const s = await boot(disk, { sid: 's1' })
  await s.call(UP, { items: items('A one', 'B two', 'C three') })
  const path = genPath(disk)
  const fresh = await boot(disk, { cwd: 'D:/elsewhere' })
  await fresh.promptFrom(`Handoff from my previous session.\nPlan: ${path}\n\nbody`, { kind: 'plugin', name: 'cache-keeper' })
  assert.deepEqual(fresh.state.get('plan'), { path, why: 'handoff' })
  // The fresh chat's first list goes on with the plan it was handed
  await fresh.call(UP, { items: items('B two', 'D four', 'E five'), scope: 'first_task' })
  assert.equal(fresh.state.get('plan').path, path)
  assert.match(disk.text(path), /- \[ \] C three\n- \[ \] D four\n- \[ \] E five\n$/)
  // A "Plan:" file with no checkbox item is not attached
  const prose = PLANS + '/prose.md'
  const d2 = makeFs({ [prose]: '# Just prose\n' })
  const t = await boot(d2)
  await t.promptFrom(`Handoff.\nPlan: ${prose}\n`, { kind: 'plugin', name: 'cache-keeper' })
  assert.ok(!t.state.get('plan'))
})

test('the chat that wrote a plan grows it by a first_task or unscoped list, also after a /clear; a restarted chat\'s unscoped list starts a new one', async () => {
  const disk = makeFs({})
  const s = await boot(disk, { sid: 's1' })
  await s.call(UP, { items: items('A one', 'B two', 'C three'), scope: 'first_task' })
  const path = genPath(disk)
  await s.call(UP, { items: items('A one', 'B two', 'C three', 'D four'), scope: 'first_task' })
  await s.start('clear')
  await s.call(UP, { items: items('E five', 'F six', 'G seven') })
  assert.equal(s.state.get('plan').path, path)
  assert.match(disk.text(path), /- \[ \] D four\n- \[ \] E five\n- \[ \] F six\n- \[ \] G seven\n$/)
  const fresh = await boot(disk, { sid: 's2' })
  await fresh.start()
  assert.equal(fresh.state.get('plan').why, 'folder')
  await fresh.call(UP, { items: items('X one', 'Y two', 'Z three') })
  assert.notEqual(fresh.state.get('plan').path, path)
  assert.ok(!disk.text(path).includes('X one'))
})

test('a new task\'s list: the old list\'s completions tick the old plan, the new list\'s tick nothing there', async () => {
  const disk = makeFs({})
  const s = await boot(disk, { sid: 's1' })
  await s.call(UP, { items: items('Alpha', 'Beta', 'Gamma') })
  const old = genPath(disk)
  await s.call(UP, { done: [1, 2, 3] })
  await s.call(UP, { items: [{ content: 'Zeta', status: 'completed' }, { content: 'Beta', status: 'completed' }, ...items('Delta', 'Eps')], scope: 'new_task' })
  assert.match(disk.text(old), /- \[x\] Alpha\n- \[x\] Beta\n- \[x\] Gamma/)
  const d2 = makeFs({})
  const t = await boot(d2, { sid: 's1' })
  await t.call(UP, { items: items('Alpha', 'Beta', 'Gamma') })
  const o2 = genPath(d2)
  await t.call(UP, { items: [{ content: 'Beta', status: 'completed' }, ...items('Delta', 'Eps')], scope: 'new_task' })
  assert.match(d2.text(o2), /- \[ \] Beta/)
})

test('a fresh chat\'s first task does not grow a plan picked from an earlier chat; a continuation does', async () => {
  const disk = makeFs({})
  const s = await boot(disk, { sid: 'old1' })
  await s.call(UP, { items: items('Old A', 'Old B', 'Old C') })
  const old = genPath(disk)
  const fresh = await boot(disk, { sid: 'new1' })
  await fresh.start()
  assert.equal(fresh.state.get('plan').path, old)
  await fresh.call(UP, { items: items('New X', 'New Y', 'New Z'), scope: 'first_task' })
  assert.ok(!disk.text(old).includes('New X'))
  assert.match(disk.text(fresh.state.get('plan').path), /# New X/)
  const back = await boot(disk, { sid: 'new3' })
  await back.cmd(old)
  await back.call(UP, { items: items('Old A', 'Old D', 'Old E'), scope: 'continuation' })
  assert.match(disk.text(old), /- \[ \] Old C\n- \[ \] Old D\n- \[ \] Old E\n$/)
})

test('a step listed twice is written once; a name taken in the same minute gets a number; a failed write toasts', async () => {
  const disk = makeFs({})
  const s = await boot(disk, { sid: 's1' })
  await s.call(UP, { items: [...items('Run tests', 'Fix', 'Ship'), { content: 'run tests', status: 'completed' }] })
  const first = genPath(disk)
  assert.equal((disk.text(first).match(/run tests/gi) || []).length, 2, 'the title and one item')
  assert.match(disk.text(first), /- \[x\] Run tests\n- \[ \] Fix\n- \[ \] Ship\n$/)
  await s.call(UP, { items: items('Run tests', 'Fix', 'Ship'), scope: 'new_task' })
  assert.match(s.state.get('plan').path, /-s1-2\.md$/)

  const bad = makeFs({})
  bad.fs.write = async () => {
    throw new Error('EACCES')
  }
  const b = await boot(bad, { sid: 's1' })
  await b.call(UP, { items: items('A', 'B', 'C') })
  assert.ok(!b.state.get('plan'))
  assert.match(b.toasts.join('\n'), /could not write .*: EACCES/)
})

test('a TodoWrite list that replaces one ticks what the old list completed first', async () => {
  const disk = makeFs(folderSeed())
  const s = await boot(disk)
  await s.start()
  await s.call('TodoWrite', { todos: [{ content: 'Ship it', status: 'completed' }] })
  await s.call('TodoWrite', { todos: [{ content: 'Other', status: 'pending' }] })
  assert.match(disk.text(PLANS + '/a.md'), /- \[x\] Ship it/)
})

test('on the desktop the band is one drawn row: name, count pill, next item, percent', async () => {
  const disk = makeFs({})
  const s = await boot(disk, { sid: 's1' })
  await s.call(UP, { items: [{ content: 'Look around', status: 'completed' }, ...items('Fix A & B', 'Test A')] })
  const tree = await s.render({ component: 'AbovePrompt', surface: 'desktop', props: { bodyColumns: 100 } }, null)
  const svg = tree.props.children.find((c) => c.type === 'Svg')
  assert.ok(svg, 'an Svg row')
  assert.match(svg.props.source, />Look around</)
  assert.match(svg.props.source, />1\/3</)
  assert.match(svg.props.source, />Fix A &amp; B</, 'the next item, escaped')
  assert.match(svg.props.source, />33%</)
  assert.ok(button(tree, 'pane') && button(tree, 'hide'))
  // The terminal keeps its text row
  assert.match(flat(await s.band()), /1\/3/)
})

test('the drawn row says done and open as the text row does', () => {
  const done = planRowSvg({ name: 'P', done: 3, total: 3, next: '', state: 'done' }, 400)
  assert.match(done, />done</)
  assert.match(done, />100%</)
  const open = planRowSvg({ name: 'P', done: 1, total: 3, next: 'Two', state: 'stuck' }, 400)
  assert.match(open, />2 open</)
  assert.doesNotMatch(open, />Two</, 'no next item once the list ended')
  // Dimmed under savvy-progress's band
  assert.match(planRowSvg({ name: 'P', done: 1, total: 3, next: 'Two', state: 'run' }, 400, true), /opacity="0\.6"/)
  assert.doesNotMatch(planRowSvg({ name: 'P', done: 1, total: 3, next: 'Two', state: 'run' }, 400), /opacity="0\.6"/)
  // A tick under the next item's text is left out
  const ticks = (svg) => (svg.match(/height="8" rx="0\.75"/g) || []).length
  assert.equal(ticks(planRowSvg({ name: 'P', done: 1, total: 4, next: '', state: 'run' }, 600)), 2)
  assert.equal(ticks(planRowSvg({ name: 'P', done: 1, total: 4, next: 'Fix the parser and the matcher', state: 'run' }, 600)), 1)
})

test('slugs and hashes are stable and plain', () => {
  assert.equal(slugOf('Přidat **ověření** do API: krok 1.'), 'pridat-overeni-do-api-krok-1')
  assert.equal(slugOf('***'), 'plan')
  assert.equal(djb2('d:/work/app'), djb2('d:/work/app'))
  assert.match(djb2('x'), /^[0-9a-f]{8}$/)
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
