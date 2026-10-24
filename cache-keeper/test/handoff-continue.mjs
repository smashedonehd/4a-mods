// Run: node cache-keeper/test/handoff-continue.mjs
// Drives register.mjs against a fake host with a shared in-memory fs. A
// "restart" is a second module instance: its module state (H.text, S) is empty.
import assert from 'node:assert/strict'

const files = new Map() // path -> text, shared by every boot
const states = new Map() // session id -> what $.state kept: a second boot of an id is a reload
let T = Date.UTC(2026, 9, 11, 10, 0)
const HOUR = 3600e3
let instance = 0
let failWrites = [] // substrings of paths whose write rejects
let failNow = false // $.clock.now rejects
// Lets what the module scheduled with queueMicrotask, or a test with its timers, run
const settle = () => new Promise((r) => setTimeout(r, 20))

// timers: an array to collect $.clock.after callbacks in, run by the test, so
// it can start a turn before the scheduled clear; absent, they run at once
// onRun: called with each command the module runs, before it is logged
// select: the host has Select, as the desktop app and the terminal do
async function boot(cwd, id, { working = false, answer = 'Keep this chat', surfaces = ['terminal'], timers, onRun, select = false } = {}) {
  const { register } = await import(`../hooks/register.mjs?boot=${++instance}`)
  const hs = []
  register((name, a, b) => hs.push({ name, filter: b ? a : null, fn: b || a }))
  const log = []
  const sent = [] // full texts of the prompts submitted
  const submits = [] // what $.prompt.submit got
  const marks = { invalidated: 0 } // $.ui.invalidate calls
  const $ = {
    clock: { now: async () => { if (failNow) throw new Error('clock gone'); return T }, after: (_ms, f) => void (timers ? timers.push(f) : queueMicrotask(f)), every: () => {} },
    fs: {
      exists: async (p) => files.has(p),
      read: async (p) => files.get(p),
      write: async (p, t) => {
        if (failWrites.some((x) => p.includes(x))) throw new Error('EACCES')
        files.delete(p) // most recently written last
        files.set(p, t)
      },
      list: async () => [],
    },
    env: { get: async (k) => (k === 'USERPROFILE' ? '/home' : '') },
    session: { id: async () => id, cwd: async () => cwd, model: async () => 'claude-opus-5-5', usage: async () => ({}), surfaces: async () => surfaces },
    state: { get: async () => ({ value: states.get(id) }), set: async (_ref, v) => void states.set(id, v) },
    store: { get: async () => null, set: async () => {}, delete: async () => {}, list: async () => [] },
    command: { register: async () => {}, list: async () => [{ name: 'cache-keeper:session-handoff' }, { name: 'handoff' }, { name: 'caveman:caveman' }, { name: 'jev:on' }, { name: 'navigating-code-with-lsp' }], run: async (c) => void (onRun && (await onRun(c)), log.push('run:' + c.command)) },
    turn: { abort: async (x) => void log.push('abort:' + x.turnId) },
    prompt: { submit: async (p) => void (log.push('submit:' + p.text.slice(0, 20)), sent.push(p.text), submits.push(p)), fill: async () => ({}) },
    ui: {
      toast: (t) => void log.push('toast:' + t),
      invalidate: () => void marks.invalidated++,
      ask: async (q) => (log.push('ask:' + q.slice(0, 14)), answer),
      log: () => {},
      resolve: (e) => ({ Box: (p) => p, Text: (p) => p, Svg: e.surface === 'terminal' ? undefined : (p) => (svgs.push(p), p), Button: (p) => (buttons.set(p.key, p), p), ...(select && { Select: (p) => (selects.set(p.key, p), p) }) }),
    },
  }
  const buttons = new Map() // key -> props of the band's buttons at the last render
  const selects = new Map() // key -> props of the band's Selects at the last render
  const svgs = [] // props of every Svg drawn
  // below: what next(e) resolves to, as the hooks under the module answered
  const fire = async (name, e, pred = () => true, below = {}) => {
    let out
    for (const h of hs.filter((x) => x.name === name && pred(x))) out = await h.fn($, e, async () => below)
    return out
  }
  await fire('session.start', {})
  if (working) await fire('turn.start', { turnId: 'busy' })
  // Fires the command hooks that handle `command`: the filtered hook that lists
  // it (/handoff) or, for the skill, the unfiltered ones
  const run = async (command, args = '') => {
    log.length = 0
    const named = (h) => h.filter && [].concat(h.filter.command).includes(command)
    const r = await fire('command.run', { command, args }, (h) => named(h) || (!h.filter && command.includes('session-handoff')))
    await settle()
    return { log: [...log], text: r && r.text }
  }
  // One main-loop response of a turn, as the engine streamed it; read null: no usage
  const step = async (turnId = 't0', answer = '', stopReason = 'end_turn', agentId, read = 1000) => {
    for (const h of hs.filter((x) => x.name === 'turn.step')) {
      const it = h.fn($, { turnId, agentId }, function* () {
        return { turnId, answer, stopReason, usage: read === null ? undefined : { input_tokens: 10, cache_read_input_tokens: read } }
      })
      while (!(await it.next()).done);
    }
  }
  // One main-loop request first (the band stays hidden until there was one),
  // then renders the band and presses one of its buttons
  // columns: the window's width, for the desktop band's narrow labels
  const render = async (surface = 'terminal', columns) => {
    buttons.clear()
    selects.clear()
    return fire('ui.render', { component: 'AbovePrompt', surface, ...(columns && { viewport: { columns } }) }, (h) => !h.filter || h.filter.component === 'AbovePrompt')
  }
  const press = async (key, surface = 'terminal') => {
    await step()
    await render(surface)
    assert.ok(buttons.has(key), `no ${key} button on the band`)
    await buttons.get(key).onPress()
    await settle()
  }
  // Ends a turn with a fresh log and lets what it scheduled run
  const end = async (e) => {
    log.length = 0
    await fire('turn.complete', e)
    await settle()
  }
  return { fire, run, step, press, render, end, log, sent, submits, buttons, selects, svgs, marks }
}

const body = '# Session Handoff\n' + 'x'.repeat(300)
const SKILL = 'cache-keeper:session-handoff'
const cleared = (res) => res.log.includes('run:clear')
const asked = (s) => s.log.some((l) => l.startsWith('ask:Handoff saved'))
const latestKey = () => [...files.keys()].filter((k) => k.includes('/latest-')).pop()
// The text of the latest handoff written last, if session `id` wrote it
const latestText = (id) => {
  const f = JSON.parse(files.get(latestKey()))
  return String(f.fid || '').startsWith(id + ':') ? f.text : undefined
}
// The dated handoff file of session `id`
const dated = (id) => files.get([...files.keys()].find((k) => k.endsWith(`-${id}.md`)))

async function makeHandoff(cwd, id, opts) {
  const s = await boot(cwd, id, opts)
  await s.run(SKILL)
  s.log.length = 0
  await s.fire('turn.complete', { reason: 'answer', answer: body, turnId: 't1' })
  // a normal save does not warn
  assert.ok(!s.log.some((l) => l.includes('will not survive a restart')))
  return s
}

// restart: continue clears and sends the handoff, the skill does not run again
await makeHandoff('/w/proj', 'a1')
T += HOUR
let s = await boot('/w/proj', 'b1')
let res = await s.run(SKILL, 'continue')
assert.match(res.text, /Clearing/)
assert.deepEqual(res.log.map((l) => l.split(':')[0]), ['run', 'submit'])
assert.equal(res.log[0], 'run:clear')

// used once: the next restart finds it consumed
res = await (await boot('/w/proj', 'b2')).run(SKILL, 'go')
assert.match(res.text, /already used/)
assert.ok(!cleared(res))

// the /handoff command (filtered hook) behaves the same
await makeHandoff('/w/cmd', 'c1')
res = await (await boot('/w/cmd', 'c2')).run('handoff', 'continue')
assert.match(res.text, /Clearing/)
assert.ok(cleared(res))
res = await (await boot('/w/cmd', 'c3')).run('handoff', 'continue')
assert.ok(!cleared(res))
res = await (await boot('/w/cmd', 'c4')).run('handoff', '')
assert.match(res.text, /Running the session handoff/)
assert.ok(!cleared(res))

// same instance: the in-memory handoff wins even if the file vanished
s = await makeHandoff('/w/inst', 'd1')
files.delete(latestKey())
res = await s.run(SKILL, 'continue')
assert.ok(cleared(res))

// older than the window
await makeHandoff('/w/old', 'e1')
T += 13 * HOUR
res = await (await boot('/w/old', 'e2')).run(SKILL, 'continue')
assert.match(res.text, /older than 12 hours/)
assert.ok(!cleared(res))

// a long-lived chat that hydrated a handoff sees it expire (now is refreshed)
await makeHandoff('/w/aging', 'f1')
s = await boot('/w/aging', 'f2')
T += 13 * HOUR
res = await s.run(SKILL, 'continue')
assert.match(res.text, /older than 12 hours/)
assert.ok(!cleared(res))

// two chats hydrate the same entry; the second finds it used
await makeHandoff('/w/pair', 'q1')
const qa = await boot('/w/pair', 'q2')
const qb = await boot('/w/pair', 'q3')
assert.ok(cleared(await qa.run('handoff', 'continue')))
res = await qb.run('handoff', 'continue')
assert.match(res.text, /already used/)
assert.ok(!cleared(res))

// two continue requests at once send the handoff once
s = await makeHandoff('/w/dbl', 'r1')
s.log.length = 0
await Promise.all([s.run(SKILL, 'continue'), s.run(SKILL, 'continue')])
await new Promise((r) => setTimeout(r, 40))
assert.equal(s.log.filter((l) => l === 'run:clear').length, 1)
assert.equal(s.log.filter((l) => l.startsWith('submit:')).length, 1)

// another folder with the same basename
await makeHandoff('/w/same', 'g1')
res = await (await boot('/other/same', 'g2')).run(SKILL, 'continue')
assert.match(res.text, /No handoff is saved/)
assert.ok(!cleared(res))

// Windows spelling of the same folder
await makeHandoff('C:\\Work\\Proj\\', 'h1')
res = await (await boot('c:/work/proj', 'h2')).run(SKILL, 'continue')
assert.ok(cleared(res))

// the chat that made the handoff went on: it is out of date
s = await makeHandoff('/w/e', 'i1')
await s.fire('prompt.submit', { text: 'do more work', origin: { kind: 'composer' } })
res = await (await boot('/w/e', 'i2')).run(SKILL, 'continue')
assert.ok(!cleared(res))

// a handoff from a previous chat survives the first message of the new chat
await makeHandoff('/w/h', 'j1')
s = await boot('/w/h', 'j2')
await s.fire('prompt.submit', { text: 'a question', origin: { kind: 'composer' } })
res = await s.run(SKILL, 'continue')
assert.ok(cleared(res))

// a newer handoff of another chat is not marked used by this chat's message
s = await makeHandoff('/w/two', 'k1')
await makeHandoff('/w/two', 'k2')
await s.fire('prompt.submit', { text: 'more', origin: { kind: 'composer' } })
res = await (await boot('/w/two', 'k3')).run(SKILL, 'continue')
assert.ok(cleared(res))

// truncated or corrupt latest file: told why, nothing cleared
await makeHandoff('/w/short', 'l1')
files.set(latestKey(), JSON.stringify({ at: T, fid: 'x', text: 'short' }))
res = await (await boot('/w/short', 'l2')).run(SKILL, 'continue')
assert.match(res.text, /incomplete/)
assert.ok(!cleared(res))
await makeHandoff('/w/corrupt', 'm1')
files.set(latestKey(), '{')
res = await (await boot('/w/corrupt', 'm2')).run(SKILL, 'continue')
assert.match(res.text, /could not be read/)
assert.ok(!cleared(res))

// the dated file cannot be written: the latest copy still survives a restart
failWrites = ['.md']
await makeHandoff('/w/nomd', 'n1')
failWrites = []
res = await (await boot('/w/nomd', 'n2')).run(SKILL, 'continue')
assert.ok(cleared(res))

// the latest copy cannot be written: the toast says it will not survive
failWrites = ['latest-']
s = await boot('/w/nolatest', 'o1')
await s.run(SKILL)
s.log.length = 0
await s.fire('turn.complete', { reason: 'answer', answer: body, turnId: 't1' })
failWrites = []
assert.ok(s.log.some((l) => l.includes('will not survive a restart')))

// Claude is still working: the reply says so and nothing is cleared
await makeHandoff('/w/busy', 'p1')
res = await (await boot('/w/busy', 'p2', { working: true })).run(SKILL, 'continue')
assert.match(res.text, /still working/)
assert.ok(!cleared(res))

// the band's handoff button: once the handoff is in, it clears and continues
s = await boot('/w/band', 's1')
await s.press('handoff')
assert.ok(s.log.includes('run:cache-keeper:session-handoff'))
await s.end({ reason: 'answer', answer: body, turnId: 't1' })
assert.deepEqual(s.log.filter((l) => !l.startsWith('toast:')).map((l) => l.split(':')[0]), ['run', 'submit'])
assert.ok(cleared(s))
res = await (await boot('/w/band', 's2')).run(SKILL, 'continue')
assert.match(res.text, /already used/)

// the button's handoff turn ended without a handoff: nothing is cleared, not
// even with an older handoff of this folder still on disk
await makeHandoff('/w/band-empty', 'u0')
s = await boot('/w/band-empty', 'u1')
await s.press('handoff')
await s.end({ reason: 'aborted', turnId: 't1' })
assert.ok(!cleared(s))

// pressed while Claude works, the queued handoff never runs: the next ordinary
// answer is captured by the leftover arm, but it has no handoff heading, so
// the chat is not cleared
const plain = 'An ordinary answer. ' + 'y'.repeat(300)
s = await boot('/w/band-stale', 'w1', { working: true })
await s.press('handoff')
await s.fire('turn.complete', { reason: 'aborted', turnId: 'busy' })
await s.fire('turn.start', { turnId: 't2' })
// meanwhile, a press while Claude works still starts no second handoff
s.log.length = 0
await s.press('handoff')
assert.ok(!s.log.includes('run:cache-keeper:session-handoff'))
await s.end({ reason: 'answer', answer: plain, turnId: 't2' })
assert.ok(!cleared(s))

// the leftover arm does not block the button once Claude is idle
s = await boot('/w/band-idle', 'w2', { working: true })
await s.press('handoff')
await s.fire('turn.complete', { reason: 'aborted', turnId: 'busy' })
s.log.length = 0
await s.press('handoff')
assert.ok(s.log.includes('run:cache-keeper:session-handoff'))

// a second press while the handoff runs starts no second one
s = await boot('/w/band-twice', 'x1')
await s.press('handoff')
await s.fire('turn.start', { turnId: 't1' })
s.log.length = 0
await s.press('handoff')
assert.ok(!s.log.includes('run:cache-keeper:session-handoff'))
assert.ok(s.log.some((l) => l.includes('already running')))
await s.end({ reason: 'answer', answer: body, turnId: 't1' })
assert.equal(s.log.filter((l) => l === 'run:clear').length, 1)

// /handoff typed after the button: the last one wins, no clear
s = await boot('/w/band-then-typed', 'y1')
await s.press('handoff')
await s.fire('turn.start', { turnId: 't1' })
await s.run('handoff', '')
assert.ok(!s.log.includes('run:cache-keeper:session-handoff'))
await s.end({ reason: 'answer', answer: body, turnId: 't1' })
assert.ok(!cleared(s))

// /session-handoff typed after the button (re-arms through the command hook): no clear
s = await boot('/w/band-then-skill', 'z1')
await s.press('handoff')
await s.run(SKILL)
await s.end({ reason: 'answer', answer: body, turnId: 't1' })
assert.ok(!cleared(s))

// /handoff (typed) still only offers it, it does not clear on its own
s = await boot('/w/typed', 'v1')
await s.run('handoff', '')
await s.end({ reason: 'answer', answer: body, turnId: 't1' })
assert.ok(asked(s))
assert.ok(!cleared(s))

// /handoff typed, the dialog answered "Clear and continue": clears and sends it
s = await boot('/w/typed-yes', 'v2', { answer: 'Clear and continue' })
await s.run('handoff', '')
await s.end({ reason: 'answer', answer: body, turnId: 't1' })
assert.ok(asked(s))
assert.deepEqual(s.log.filter((l) => /^(run|submit):/.test(l)).map((l) => l.split(':')[0]), ['run', 'submit'])
assert.ok(cleared(s))

// /handoff typed in the Desktop app: no dialog between turns, nothing cleared
s = await boot('/w/typed-app', 'v3', { answer: 'Clear and continue', surfaces: ['desktop'] })
await s.run('handoff', '')
await s.end({ reason: 'answer', answer: body, turnId: 't1' })
assert.ok(!asked(s))
assert.ok(!cleared(s))

// the band's button and the skill run on its own ask nothing
s = await boot('/w/band-noask', 'v4', { answer: 'Clear and continue' })
await s.press('handoff')
await s.end({ reason: 'answer', answer: body, turnId: 't1' })
assert.ok(!asked(s))
s = await boot('/w/skill-noask', 'v5', { answer: 'Clear and continue' })
await s.run(SKILL)
await s.end({ reason: 'answer', answer: body, turnId: 't1' })
assert.ok(!asked(s))
assert.ok(!cleared(s))

// the button's turn ended with an answer without the handoff heading: no dialog, no clear
s = await boot('/w/band-noask-plain', 'v6', { answer: 'Clear and continue' })
await s.press('handoff')
await s.end({ reason: 'answer', answer: plain, turnId: 't1' })
assert.ok(!asked(s))
assert.ok(!cleared(s))

// A Stop hook blocks the handoff turn: Claude answers again in the same turn,
// and turn.complete carries only that last answer. The handoff is what is
// saved and sent, not the reply after it.
const reply = 'The handoff stands as written: both files are in the other repo. ' + 'z'.repeat(200)
s = await boot('/w/stop', 'sh1')
await s.press('handoff')
await s.step('t1', body)
await s.step('t1', '', 'tool_use') // the hook's feedback made Claude check something
await s.step('t1', reply)
await s.end({ reason: 'answer', answer: reply, turnId: 't1' })
assert.equal(dated('sh1'), body + '\n')
assert.ok(cleared(s))
assert.ok(s.sent.at(-1).endsWith('\n\n' + body))

// the same with the skill typed: the latest copy is the handoff, and continue sends it
s = await boot('/w/stop-typed', 'sh2')
await s.run(SKILL)
await s.step('t1', body)
await s.step('t1', reply)
await s.end({ reason: 'answer', answer: reply, turnId: 't1' })
assert.equal(latestText('sh2'), body)
assert.ok(cleared(await s.run(SKILL, 'continue')))
assert.ok(s.sent.at(-1).endsWith('\n\n' + body))

// an answer without the heading never replaces a saved handoff
s = await makeHandoff('/w/stop-keep', 'sh3')
await s.run(SKILL)
await s.end({ reason: 'answer', answer: plain, turnId: 't2' })
assert.equal(latestText('sh3'), body)
assert.ok(cleared(await s.run(SKILL, 'continue')))
assert.ok(s.sent.at(-1).endsWith('\n\n' + body))

// interrupted once the handoff was in (during the hook's extra work, say): it
// is saved, but the button does not clear the chat on its own
s = await boot('/w/stop-abort', 'sh4')
await s.press('handoff')
await s.step('t1', body)
await s.end({ reason: 'aborted', answer: '', turnId: 't1' })
assert.equal(latestText('sh4'), body)
assert.ok(!cleared(s))
// and /handoff typed asks nothing after an interrupt
s = await boot('/w/stop-abort-typed', 'sh4b', { answer: 'Clear and continue' })
await s.run('handoff', '')
await s.step('t1', body)
await s.end({ reason: 'aborted', answer: '', turnId: 't1' })
assert.equal(latestText('sh4b'), body)
assert.ok(!asked(s))

// the reply after the hook quotes the heading inside a sentence: the handoff stays
const quoting = 'Nothing to fix: the `# Session Handoff` above stands as written. ' + 'q'.repeat(200)
s = await boot('/w/stop-quote', 'sh7')
await s.run(SKILL)
await s.step('t1', body)
await s.step('t1', quoting)
await s.end({ reason: 'answer', answer: quoting, turnId: 't1' })
assert.equal(dated('sh7'), body + '\n')

// the hook's feedback made Claude rewrite the handoff: the rewrite wins
const corrected = '# Session Handoff: corrected\n' + 'c'.repeat(300)
s = await boot('/w/stop-rewrite', 'sh7b')
await s.press('handoff')
await s.step('t1', body)
await s.step('t1', corrected)
await s.end({ reason: 'answer', answer: corrected, turnId: 't1' })
assert.equal(dated('sh7b'), corrected + '\n')
assert.ok(s.sent.at(-1).endsWith('\n\n' + corrected))

// a short reply that repeats the heading line does not replace the handoff
const repeat = 'Fixed the path.\n\n# Session Handoff: same as above, one path fixed'
s = await boot('/w/stop-repeat', 'sh7d')
await s.press('handoff')
await s.step('t1', body)
await s.step('t1', repeat)
await s.end({ reason: 'answer', answer: repeat, turnId: 't1' })
assert.equal(dated('sh7d'), body + '\n')
assert.ok(cleared(s))

// a turn that ended with the heading line alone saved nothing
s = await boot('/w/heading-only', 'sh7f')
await s.run(SKILL)
await s.end({ reason: 'answer', answer: '# Session Handoff: nothing yet', turnId: 't1' })
assert.equal(dated('sh7f'), undefined)

// a preamble before the heading is left out of the handoff
s = await boot('/w/preamble', 'sh7e')
await s.run(SKILL)
await s.step('t1', 'Here is the handoff.\n\n' + body)
await s.end({ reason: 'answer', answer: 'Here is the handoff.\n\n' + body, turnId: 't1' })
assert.equal(dated('sh7e'), body + '\n')

// the turn's first answer had no heading, the hook made Claude write the handoff
s = await boot('/w/stop-late', 'sh7c')
await s.press('handoff')
await s.step('t1', plain)
await s.step('t1', body)
await s.end({ reason: 'answer', answer: body, turnId: 't1' })
assert.equal(dated('sh7c'), body + '\n')
assert.ok(cleared(s))

// a second handoff in the same chat starts with no draft: a turn that wrote
// none saves nothing, not the first one again
s = await boot('/w/stop-twice', 'sh9')
await s.run(SKILL)
await s.step('t1', body)
await s.end({ reason: 'answer', answer: body, turnId: 't1' })
await s.run(SKILL)
await s.step('t2', plain)
await s.end({ reason: 'answer', answer: plain, turnId: 't2' })
assert.ok(s.log.some((l) => l.includes('nothing was saved')))

// a subagent's answer with the heading is not the main loop's handoff
s = await boot('/w/stop-agent', 'sh8')
await s.run(SKILL)
await s.step('a-t1', body, 'end_turn', 'agent-1')
await s.end({ reason: 'answer', answer: plain, turnId: 't1' })
assert.equal(dated('sh8'), undefined)

// an interrupted turn's own answer may be cut off: it is no handoff
s = await boot('/w/stop-cut-final', 'sh5b')
await s.run(SKILL)
await s.end({ reason: 'aborted', answer: body, turnId: 't1' })
assert.equal(dated('sh5b'), undefined)

// a response that did not end the turn (cut off at max_tokens) is no handoff
s = await boot('/w/stop-cut', 'sh5')
await s.run(SKILL)
await s.step('t1', body, 'max_tokens')
await s.end({ reason: 'aborted', answer: '', turnId: 't1' })
assert.equal(dated('sh5'), undefined)

// the turn already running when the handoff was queued is not the handoff's,
// even if it answered with the heading
s = await boot('/w/stop-busy', 'sh6', { working: true })
await s.press('handoff')
await s.step('busy', body)
await s.fire('turn.complete', { reason: 'answer', answer: body, turnId: 'busy' })
await s.fire('turn.start', { turnId: 't2' })
await s.step('t2', plain)
await s.end({ reason: 'answer', answer: plain, turnId: 't2' })
assert.equal(dated('sh6'), undefined)
assert.ok(!cleared(s))

// Runs the callbacks the module scheduled so far, then lets them settle
const runTimers = async (timers) => {
  for (const f of timers.splice(0)) f()
  await settle()
}

// the band's button: a message typed while the handoff runs would start a turn
// before the clear; it is held, the chat clears, and it is sent after the handoff
s = await boot('/w/race-typed', 'ra1')
await s.press('handoff')
await s.fire('turn.start', { turnId: 't1' })
res = await s.fire('prompt.submit', { text: 'and then fix the tests', origin: { kind: 'composer' }, turnId: 't1', wait: false })
assert.ok(res && res.drop)
await s.end({ reason: 'answer', answer: body, turnId: 't1' })
assert.ok(cleared(s))
assert.ok(s.sent.at(-2).endsWith('\n\n' + body))
assert.equal(s.sent.at(-1), 'and then fix the tests')
// typed by the person: sent back as their own words
assert.equal(s.submits.at(-1).asUser, true)

// a notification that arrives between the handoff and the clear is held too
let timers = []
s = await boot('/w/race-note', 'ra2', { timers })
await s.press('handoff')
await s.end({ reason: 'answer', answer: body, turnId: 't1' })
res = await s.fire('prompt.submit', { text: 'task finished', origin: { kind: 'task-notification' }, wait: false })
assert.ok(res && res.drop)
await runTimers(timers)
assert.ok(cleared(s))
assert.equal(s.sent.at(-1), 'task finished')
assert.ok(!s.submits.at(-1).asUser)

// a turn begins anyway before the clear (a command passes the hold): the clear
// waits for it to end instead of giving up
timers = []
s = await boot('/w/race-turn', 'ra3', { timers })
await s.press('handoff')
await s.end({ reason: 'answer', answer: body, turnId: 't1' })
await s.fire('turn.start', { turnId: 't2' })
await runTimers(timers)
assert.ok(!cleared(s))
assert.ok(s.log.some((l) => l.includes('waits for this turn to end')))
await s.end({ reason: 'answer', answer: plain, turnId: 't2' })
await runTimers(timers)
assert.ok(cleared(s))
assert.ok(s.sent.at(-1).endsWith('\n\n' + body))

// the handoff turn wrote no handoff: nothing clears, the held message goes on here
s = await boot('/w/race-none', 'ra4')
await s.press('handoff')
await s.fire('turn.start', { turnId: 't1' })
await s.fire('prompt.submit', { text: 'next question', origin: { kind: 'composer' }, turnId: 't1', wait: false })
await s.end({ reason: 'answer', answer: plain, turnId: 't1' })
assert.ok(!cleared(s))
assert.equal(s.sent.at(-1), 'next question')

// /handoff typed (it only asks): a message typed meanwhile is not held
s = await boot('/w/race-ask', 'ra5')
await s.run('handoff', '')
res = await s.fire('prompt.submit', { text: 'go on', origin: { kind: 'composer' }, turnId: 't1', wait: false })
assert.ok(!(res && res.drop))

// pressed while Claude works, the queued handoff never runs: the leftover arm
// holds nothing once Claude is idle, and the band does not say it runs
s = await boot('/w/race-stale', 'ra6', { working: true })
await s.press('handoff')
await s.fire('turn.complete', { reason: 'aborted', turnId: 'busy' })
res = await s.fire('prompt.submit', { text: 'hello again', origin: { kind: 'composer' }, wait: false })
assert.ok(!(res && res.drop))
await s.render()
assert.equal(s.buttons.get('handoff').label, 'handoff')

// a /handoff typed while the clear waited only asks: once its handoff is in,
// nothing is held any more
timers = []
s = await boot('/w/race-ask-later', 'ra7', { timers })
await s.press('handoff')
await s.end({ reason: 'answer', answer: body, turnId: 't1' })
await s.fire('turn.start', { turnId: 't2' })
res = await s.fire('prompt.submit', { text: 'held in t2', origin: { kind: 'composer' }, wait: false })
assert.ok(res && res.drop)
await s.run('handoff', '')
await runTimers(timers) // the clear waits for t2, /handoff queues its skill
await s.end({ reason: 'answer', answer: plain, turnId: 't2' })
await s.fire('turn.start', { turnId: 't3' })
await runTimers(timers)
await s.end({ reason: 'answer', answer: body, turnId: 't3' })
await runTimers(timers)
assert.ok(!cleared(s))
assert.equal(s.sent.at(-1), 'held in t2')
res = await s.fire('prompt.submit', { text: 'carry on', origin: { kind: 'composer' }, wait: false })
assert.ok(!(res && res.drop))

// what cannot be sent again as it came passes the hold, and does not make the
// handoff out of date: the clear still happens
timers = []
s = await boot('/w/race-pass', 'ra8', { timers })
await s.press('handoff')
await s.end({ reason: 'answer', answer: body, turnId: 't1' })
for (const p of [{ text: 'look at this', attachments: [{ kind: 'image' }] }, { text: 'see @src/x.ts' }, { text: 'idle notice', isMeta: true }]) {
  res = await s.fire('prompt.submit', { ...p, origin: { kind: 'composer' }, wait: false })
  assert.ok(!(res && res.drop))
}
await runTimers(timers)
assert.ok(cleared(s))

// a turn that starts and ends before the scheduled clear: the chat clears once,
// and the second scheduled run finds nothing left to do
timers = []
s = await boot('/w/race-twice', 'ra9', { timers })
await s.press('handoff')
await s.end({ reason: 'answer', answer: body, turnId: 't1' })
await s.fire('turn.start', { turnId: 't2' })
await s.end({ reason: 'answer', answer: plain, turnId: 't2' })
assert.equal(timers.length, 2)
// One at a time, unlike runTimers: the second must find the first done
for (const f of timers.splice(0)) {
  f()
  await settle()
}
assert.equal(s.log.filter((l) => l === 'run:clear').length, 1)
assert.ok(!s.log.some((l) => /already used|No handoff/.test(l)))

// a second handoff, pressed while the clear waited, is interrupted: the chat
// still clears with the first one, and the held message follows it
timers = []
s = await boot('/w/race-second', 'rb1', { timers })
await s.press('handoff')
await s.end({ reason: 'answer', answer: body, turnId: 't1' })
await s.fire('turn.start', { turnId: 't2' })
await s.press('handoff')
await s.fire('prompt.submit', { text: 'held meanwhile', origin: { kind: 'composer' }, wait: false })
await s.end({ reason: 'answer', answer: plain, turnId: 't2' })
await s.fire('turn.start', { turnId: 't3' })
await runTimers(timers)
await s.end({ reason: 'aborted', turnId: 't3' })
await runTimers(timers)
assert.ok(cleared(s))
assert.ok(s.sent.at(-2).endsWith('\n\n' + body))
assert.equal(s.sent.at(-1), 'held meanwhile')

// cleared another way while prompts were held: they go to the new chat, and
// nothing is held after it
timers = []
s = await boot('/w/race-cleared', 'rb2', { timers })
await s.press('handoff')
await s.end({ reason: 'answer', answer: body, turnId: 't1' })
await s.fire('prompt.submit', { text: 'held then cleared', origin: { kind: 'composer' }, wait: false })
timers.length = 0
await s.fire('classic.SessionStart', { source: 'clear' })
await runTimers(timers)
assert.equal(s.sent.at(-1), 'held then cleared')
res = await s.fire('prompt.submit', { text: 'fresh start', origin: { kind: 'composer' }, wait: false })
assert.ok(!(res && res.drop))

// c pressed while the band's handoff runs: it is not ready yet, and what is held
// stays held for the clear that handoff brings, not sent into this chat
s = await boot('/w/race-c', 'rb5')
await s.run('handoff', '')
await s.end({ reason: 'answer', answer: body, turnId: 't1' })
await s.press('handoff')
await s.fire('turn.start', { turnId: 't2' })
await s.fire('prompt.submit', { text: 'held during t2', origin: { kind: 'composer' }, wait: false })
await s.press('continue')
assert.ok(!s.sent.includes('held during t2'))
await s.end({ reason: 'answer', answer: body, turnId: 't2' })
assert.ok(cleared(s))
assert.ok(s.sent.at(-2).endsWith('\n\n' + body))
assert.equal(s.sent.at(-1), 'held during t2')

// the handoff skill could not be started: what was held while it was queued goes on here
s = await boot('/w/race-start-fails', 'rb4', {
  onRun: async (c) => {
    if (!c.command.includes('session-handoff')) return
    await s.fire('prompt.submit', { text: 'held while queued', origin: { kind: 'composer' }, wait: false })
    throw new Error('engine busy')
  },
})
await s.press('handoff')
assert.ok(s.log.some((l) => l.startsWith('toast:Held until')))
assert.equal(s.sent.at(-1), 'held while queued')

// the scheduled clear fails outright: the hold ends and held prompts go on here
timers = []
s = await boot('/w/race-throw', 'rb3', { timers })
await s.press('handoff')
await s.end({ reason: 'answer', answer: body, turnId: 't1' })
await s.fire('prompt.submit', { text: 'held then failed', origin: { kind: 'composer' }, wait: false })
failNow = true
await runTimers(timers)
failNow = false
assert.ok(!cleared(s))
assert.equal(s.sent.at(-1), 'held then failed')
res = await s.fire('prompt.submit', { text: 'after the failure', origin: { kind: 'composer' }, wait: false })
assert.ok(!(res && res.drop))

// handoff pressed while Claude works: what arrives inside that running turn
// (not the handoff's) goes in at once, it starts no turn that could block the clear
s = await boot('/w/race-busy-inside', 'rc1', { working: true })
await s.press('handoff')
// a subagent's turn inside busy is not the main loop's
await s.fire('turn.start', { turnId: 'sub', agentId: 'ag1' })
res = await s.fire('prompt.submit', { text: 'inside busy', origin: { kind: 'task-notification' }, turnId: 'busy', wait: false })
assert.ok(!(res && res.drop))
// one that would start a turn of its own is still held, and so is one for another turn
for (const p of [{}, { turnId: 'old' }]) {
  res = await s.fire('prompt.submit', { text: 'a new turn', origin: { kind: 'task-notification' }, wait: false, ...p })
  assert.ok(res && res.drop)
}
// typed over busy, the person's words may still wait for a turn of their own: held
for (const wait of [false, true]) {
  res = await s.fire('prompt.submit', { text: 'typed over busy', origin: { kind: 'composer' }, turnId: 'busy', wait })
  assert.ok(res && res.drop)
}

// the clear waits for a turn that began before it: a notification into that
// turn goes in, it does not push the clear back
timers = []
s = await boot('/w/race-due-inside', 'rc4', { timers })
await s.press('handoff')
await s.end({ reason: 'answer', answer: body, turnId: 't1' })
await s.fire('turn.start', { turnId: 't2' })
res = await s.fire('prompt.submit', { text: 'into t2', origin: { kind: 'task-notification' }, turnId: 't2', wait: false })
assert.ok(!(res && res.drop))

// a background agent's turn after the handoff does not stall the clear
timers = []
s = await boot('/w/skill-agent', 'rc5', { working: true, timers })
await s.fire('tool.call', { tool: 'Skill', skill: SKILL, args: 'clear', turnId: 'busy' })
await s.end({ reason: 'answer', answer: body, turnId: 'busy' })
await s.fire('turn.start', { turnId: 'bg', agentId: 'ag2' })
await s.fire('turn.complete', { reason: 'answer', answer: 'done', turnId: 'bg', agentId: 'ag2' })
await runTimers(timers)
assert.ok(cleared(s))
res = await s.fire('prompt.submit', { text: 'after the clear', origin: { kind: 'composer' }, wait: false })
assert.ok(!(res && res.drop))

// the skill called again in the same turn (another Stop hook blocked) keeps the
// clear and the handoff the turn already wrote
s = await boot('/w/skill-twice', 'rc6', { working: true })
await s.fire('tool.call', { tool: 'Skill', skill: SKILL, args: 'clear', turnId: 'busy' })
await s.step('busy', body)
await s.fire('tool.call', { tool: 'Skill', skill: SKILL, turnId: 'busy' })
await s.end({ reason: 'answer', answer: 'ok', turnId: 'busy' })
assert.ok(cleared(s))
assert.ok(s.sent.at(-1).endsWith('\n\n' + body))

// a band handoff that never ran leaves its arm: the skill Claude calls in a
// later turn without args does not inherit its clear
s = await boot('/w/stale-clear', 'rc8', { working: true })
await s.press('handoff')
await s.fire('turn.complete', { reason: 'aborted', turnId: 'busy' })
await s.fire('turn.start', { turnId: 't2' })
await s.fire('tool.call', { tool: 'Skill', skill: SKILL, turnId: 't2' })
await s.end({ reason: 'answer', answer: body, turnId: 't2' })
assert.ok(!cleared(s))
assert.equal(latestText('rc8'), body)

// the band's handoff is queued behind busy, and Claude calls the skill in busy:
// that turn's handoff is the one, and the band's clear still follows it
s = await boot('/w/band-then-skill', 'rc7', { working: true })
await s.press('handoff')
await s.fire('tool.call', { tool: 'Skill', skill: SKILL, turnId: 'busy' })
await s.end({ reason: 'answer', answer: body, turnId: 'busy' })
assert.ok(cleared(s))

// Claude calls the skill with args "clear" (the 250k Stop hook asks for it):
// the chat clears and continues with the handoff, as the band's button does
s = await boot('/w/skill-clear', 'rc2', { working: true })
await s.fire('tool.call', { tool: 'Skill', skill: SKILL, args: ' Clear\n', turnId: 'busy' })
res = await s.fire('prompt.submit', { text: 'held for the new chat', origin: { kind: 'composer' }, wait: false })
assert.ok(res && res.drop)
// busy is the handoff's own turn now: a notification into it is held too
res = await s.fire('prompt.submit', { text: 'note into the handoff', origin: { kind: 'task-notification' }, turnId: 'busy', wait: false })
assert.ok(res && res.drop)
await s.end({ reason: 'answer', answer: body, turnId: 'busy' })
assert.ok(cleared(s))
assert.ok(s.sent.at(-3).endsWith('\n\n' + body))
assert.deepEqual(s.sent.slice(-2), ['held for the new chat', 'note into the handoff'])

// called without args, the skill leaves the chat as it is
s = await boot('/w/skill-plain', 'rc3', { working: true })
await s.fire('tool.call', { tool: 'Skill', skill: SKILL, turnId: 'busy' })
await s.end({ reason: 'answer', answer: body, turnId: 'busy' })
assert.ok(!cleared(s))
assert.equal(latestText('rc3'), body)

// Soft landing. What the module answers to a batch of tools, the hooks under
// it having answered `below`
const batchResult = (s, extra = {}, below) => s.fire('classic.PostToolBatch', { hook_event_name: 'PostToolBatch', tool_calls: [], ...extra }, undefined, below)
// The note Claude reads after a batch of tools, if any
const batch = async (s, extra) => {
  const r = await batchResult(s, extra)
  return ((r && r.additionalContext) || []).join('\n')
}
// Whether `act` made the band redraw
const redraws = async (s, act) => {
  const before = s.marks.invalidated
  await act()
  return s.marks.invalidated > before
}

// handoff pressed while Claude works: the running turn is asked once, after
// its next batch of tools, to wind down at a safe point; a subagent is not asked
s = await boot('/w/land-note', 'sl1', { working: true })
await s.press('handoff')
assert.equal(await batch(s, { agent_id: 'ag1' }), '')
assert.match(await batch(s), /handoff/i)
assert.equal(await batch(s), '')
// nothing is stopped on its own
assert.ok(!s.log.some((l) => l.startsWith('abort:')))

// pressed while idle, the handoff's own turn is not asked to wind down
s = await boot('/w/land-idle', 'sl2')
await s.press('handoff')
await s.fire('turn.start', { turnId: 't1' })
assert.equal(await batch(s), '')
// and with no landing a request does not redraw the band
assert.ok(!(await redraws(s, () => s.step('t1'))))

// the band shows the landing; once it runs long it offers to stop the turn,
// which only a press does
s = await boot('/w/land-band', 'sl3', { working: true })
await s.press('handoff')
await s.render()
assert.match(s.buttons.get('handoff').label, /landing/)
assert.ok(!s.buttons.has('stop'))
// requests before the note do not count
await s.step('busy')
await s.step('busy')
await s.step('busy')
// the band redraws when the note goes out
assert.ok(await redraws(s, () => batch(s)))
await s.step('busy')
await s.step('busy')
await s.render()
assert.ok(!s.buttons.has('stop'))
// and after each request that follows, also one that came back without usage
assert.ok(await redraws(s, () => s.step('busy', '', 'end_turn', undefined, null)))
assert.ok(await redraws(s, () => s.step('busy')))
await s.render()
assert.ok(s.buttons.has('stop'))
assert.ok(!s.log.some((l) => l.startsWith('abort:')))
await s.buttons.get('stop').onPress()
await settle()
assert.ok(s.log.includes('abort:busy'))
// the stopped turn ends: no landing and no stop on the band any more
await s.end({ reason: 'aborted', answer: '', turnId: 'busy' })
await s.render()
assert.ok(!/landing/.test(s.buttons.get('handoff').label))
assert.ok(!s.buttons.has('stop'))

// a turn that grows its context fast offers the stop sooner, but only once it
// had the note
s = await boot('/w/land-ctx', 'sl4', { working: true })
await s.press('handoff')
await s.step('busy', '', 'end_turn', undefined, 60000)
await s.render()
assert.ok(!s.buttons.has('stop'))
await batch(s)
await s.render()
assert.ok(s.buttons.has('stop'))

// the landing ends with its turn: the handoff's turn that follows is not asked
s = await boot('/w/land-end', 'sl5', { working: true })
await s.press('handoff')
await s.fire('turn.complete', { reason: 'answer', answer: 'paused here', turnId: 'busy' })
await s.fire('turn.start', { turnId: 't2' })
assert.equal(await batch(s), '')
await s.render()
assert.ok(!/landing/.test(s.buttons.get('handoff').label))
assert.ok(!s.buttons.has('stop'))

// no landing for a handoff that could not be started
s = await boot('/w/land-fail', 'sl6', { working: true, onRun: async (c) => { if (c.command.includes('session-handoff')) throw new Error('engine busy') } })
await s.press('handoff')
assert.equal(await batch(s), '')

// Claude calls the skill in the landing turn: that turn writes the handoff now
// and is not told to wind down any more
s = await boot('/w/land-skill', 'sl7', { working: true })
await s.press('handoff')
await s.fire('tool.call', { tool: 'Skill', skill: SKILL, turnId: 'busy' })
assert.equal(await batch(s), '')

// a second handoff pressed during a later turn of the same session lands anew:
// its turn gets the note, and the band counts from the second press
s = await boot('/w/land-twice', 'sl8', { working: true })
await s.press('handoff')
await batch(s)
for (let i = 0; i < 3; i++) await s.step('busy', '', 'end_turn', undefined, 60000)
await s.end({ reason: 'answer', answer: 'paused here', turnId: 'busy' })
await s.fire('turn.start', { turnId: 't1' })
await s.end({ reason: 'answer', answer: body, turnId: 't1' })
assert.equal(dated('sl8').trim(), body)
T += 10 * 60e3
await s.fire('turn.start', { turnId: 't2' })
await s.step('t2', '', 'end_turn', undefined, 100000)
await s.render()
await s.buttons.get('handoff').onPress()
await settle()
await s.render()
assert.match(s.buttons.get('handoff').label, /landing · 0m · \+0\b/)
assert.ok(!s.buttons.has('stop'))
assert.match(await batch(s), /handoff/i)
await s.render()
assert.ok(!s.buttons.has('stop'))

// the note joins what the hooks under the module answered
s = await boot('/w/land-chain', 'sl9', { working: true })
await s.press('handoff')
const below = { additionalContext: ['from below'], continue: true }
const chained = await batchResult(s, {}, below)
assert.equal(chained.continue, true)
assert.equal(chained.additionalContext.length, 2)
assert.equal(chained.additionalContext[0], 'from below')
assert.match(chained.additionalContext[1], /handoff/i)

// The cache chip opens the keep-warm menu; a pick turns keep warm on and shuts it
for (const surface of ['terminal', 'desktop']) {
  s = await boot('/w/menu-' + surface, 'mn-' + surface)
  await s.press('cache', surface)
  await s.press('kw-4', surface)
  assert.ok(s.log.some((l) => l.startsWith('toast:Keeping this cache warm')))
  await s.render(surface)
  assert.ok(!s.buttons.has('kw-1'))
  // kept warm: the menu offers to stop it
  await s.press('cache', surface)
  await s.render(surface)
  assert.ok(s.buttons.has('kw-off'))
  s.log.length = 0
  await s.press('kw-off', surface)
  assert.ok(s.log.some((l) => l.startsWith('toast:Keep warm off')))
  await s.press('cache', surface)
  await s.render(surface)
  assert.ok(!s.buttons.has('kw-off'))
  await s.press('cache-close', surface)
  await s.render(surface)
  assert.ok(!s.buttons.has('kw-1'))
  // a typed message shuts the menu, so its digits do not catch what comes next
  await s.press('cache', surface)
  await s.fire('prompt.submit', { text: 'a question', origin: { kind: 'composer' } })
  await s.render(surface)
  assert.ok(!s.buttons.has('kw-1'))
}

// The desktop band is native text with small gauges, never one shrinking strip
s = await boot('/w/desktop', 'dk1')
await s.press('cache', 'desktop')
assert.ok(s.svgs.length > 0 && s.svgs.every((g) => g.width <= 64 && !g.source.includes('<text')))
// a narrow window wraps the figures onto more lines
const band = await s.fire('ui.render', { component: 'AbovePrompt', surface: 'desktop' }, (h) => h.filter && h.filter.component === 'AbovePrompt')
assert.equal(band.children[0].children[0].flexWrap, 'wrap')

// The band on a surface with Select (the desktop app): no hotkeys, two Selects,
// and tags for what the fresh chat turns on again
s = await boot('/w/desk', 'ds1', { select: true })
await s.step()
await s.render('desktop')
assert.deepEqual([...s.selects.keys()], ['keep-warm', 'handoff-after'])
assert.deepEqual([...s.buttons.keys()], ['tag-caveman', 'tag-jev', 'tag-lsp', 'handoff'])
assert.ok([...s.buttons.values()].every((b) => !b.hotkey))
// the terminal keeps its hotkeys and its cache chip, Select or not
await s.render('terminal')
assert.equal(s.selects.size, 0)
assert.equal(s.buttons.get('handoff').hotkey, 'h')
assert.ok(s.buttons.has('cache'))

// keep warm picked from its Select, and turned off again
await s.render('desktop')
assert.equal(s.selects.get('keep-warm').value, 'off')
s.selects.get('keep-warm').onSelect('4')
await settle()
assert.ok(s.log.some((l) => l.startsWith('toast:Keeping this cache warm')))
await s.render('desktop')
assert.equal(s.selects.get('keep-warm').value, '4')
s.log.length = 0
s.selects.get('keep-warm').onSelect('off')
await settle()
assert.ok(s.log.some((l) => l.startsWith('toast:Keep warm off')))
await s.render('desktop')
assert.equal(s.selects.get('keep-warm').value, 'off')

// a tag starts as the chat left it: caveman turned on here shows its level
await s.fire('command.run', { command: 'caveman:caveman', args: 'lite' }, (h) => !h.filter)
await s.render('desktop')
assert.equal(s.buttons.get('tag-caveman').label, 'caveman lite')
assert.ok(!s.buttons.get('tag-caveman').dimColor)
assert.ok(s.buttons.get('tag-jev').dimColor)
// a narrow window shortens it
await s.render('desktop', 80)
assert.equal(s.buttons.get('tag-caveman').label, 'cave')
// off, then on again: the level comes back, not the default
await s.buttons.get('tag-caveman').onPress()
await s.render('desktop')
assert.equal(s.buttons.get('tag-caveman').label, 'caveman')
assert.ok(s.buttons.get('tag-caveman').dimColor)
await s.buttons.get('tag-caveman').onPress()
await s.render('desktop')
assert.equal(s.buttons.get('tag-caveman').label, 'caveman lite')
// a click only marks it: nothing runs now
s.log.length = 0
await s.buttons.get('tag-jev').onPress()
assert.ok(!s.log.some((l) => l.startsWith('run:')))
await s.render('desktop')
assert.ok(!s.buttons.get('tag-jev').dimColor)

// the handoff clears, and the fresh chat turns on what the tags mark, before the handoff
await s.press('handoff', 'desktop')
await s.end({ reason: 'answer', answer: body, turnId: 't1' })
assert.ok(cleared(s))
const runs = s.log.filter((l) => /^(run|submit):/.test(l))
assert.deepEqual(runs.slice(0, 3), ['run:clear', 'run:caveman:caveman', 'run:jev:on'])
assert.ok(runs[3].startsWith('submit:'))
assert.ok(!runs.includes('run:navigating-code-with-lsp'))

// an untouched tag turns on the default: caveman ultra
s = await boot('/w/desk-default', 'ds2', { select: true })
await s.step()
await s.render('desktop')
await s.buttons.get('tag-caveman').onPress()
await s.render('desktop')
assert.equal(s.buttons.get('tag-caveman').label, 'caveman ultra')

// "keep chat" picked: the handoff is saved but the chat stays, and the band then
// offers "clear and continue" in the place of the handoff and its Select
s = await boot('/w/desk-keep', 'ds3', { select: true })
await s.step()
await s.render('desktop')
s.selects.get('handoff-after').onSelect('none')
await s.render('desktop')
assert.equal(s.selects.get('handoff-after').value, 'none')
await s.press('handoff', 'desktop')
await s.end({ reason: 'answer', answer: body, turnId: 't1' })
assert.ok(!cleared(s))
assert.ok(!asked(s))
await s.render('desktop')
assert.ok(s.buttons.has('continue'))
assert.ok(!s.buttons.has('handoff'))
assert.ok(!s.selects.has('handoff-after'))
await s.press('continue', 'desktop')
assert.ok(cleared(s))
await s.render('desktop')
assert.ok(s.buttons.has('handoff'))
assert.ok(!s.buttons.has('continue'))

// The keys of the elements in a drawn tree: what the band shows, not every
// element the module built
const drawn = (t, out = new Set()) => {
  if (t && typeof t === 'object') {
    if (t.key) out.add(t.key)
    for (const c of [].concat(t.children || [])) drawn(c, out)
  }
  return out
}

// a tag survives a reload, a new chat starts every tag from its default
s = await boot('/w/desk-reload', 'ds4', { select: true })
await s.step()
await s.fire('command.run', { command: 'caveman:caveman', args: 'lite' }, (h) => !h.filter)
await s.render('desktop')
await s.buttons.get('tag-jev').onPress()
await s.buttons.get('tag-caveman').onPress()
s = await boot('/w/desk-reload', 'ds4', { select: true })
await s.step()
await s.render('desktop')
assert.ok(!s.buttons.get('tag-jev').dimColor)
assert.ok(s.buttons.get('tag-caveman').dimColor)
await s.fire('classic.SessionStart', { source: 'clear' })
await s.step()
await s.render('desktop')
assert.ok(s.buttons.get('tag-jev').dimColor)
await s.buttons.get('tag-caveman').onPress()
await s.render('desktop')
assert.equal(s.buttons.get('tag-caveman').label, 'caveman ultra')
// a level parked in the chat before, not the default, once that chat is gone
s = await boot('/w/desk-parked', 'ds4b', { select: true })
await s.step()
await s.fire('command.run', { command: 'caveman:caveman', args: 'lite' }, (h) => !h.filter)
await s.render('desktop')
await s.buttons.get('tag-caveman').onPress()
await s.fire('classic.SessionStart', { source: 'clear' })
await s.step()
await s.render('desktop')
await s.buttons.get('tag-caveman').onPress()
await s.render('desktop')
assert.equal(s.buttons.get('tag-caveman').label, 'caveman ultra')

// keep warm started with hours the picks lack shows them in the Select; a value
// no option has starts nothing
s = await boot('/w/desk-hours', 'ds5', { select: true })
await s.step()
await s.run('keepwarm', '2')
await s.render('desktop')
assert.equal(s.selects.get('keep-warm').value, '2')
assert.ok(s.selects.get('keep-warm').options.some((o) => o.value === '2'))
s = await boot('/w/desk-nan', 'ds6', { select: true })
await s.step()
await s.render('desktop')
s.log.length = 0
s.selects.get('keep-warm').onSelect('soon')
await settle()
assert.ok(!s.log.some((l) => l.startsWith('toast:Keeping')))

// picked while the handoff runs, what follows it changes too, either way
s = await boot('/w/desk-switch', 'ds7', { select: true })
await s.press('handoff', 'desktop')
await s.fire('turn.start', { turnId: 't1' })
await s.render('desktop')
s.selects.get('handoff-after').onSelect('none')
await s.end({ reason: 'answer', answer: body, turnId: 't1' })
assert.ok(!cleared(s))
s = await boot('/w/desk-switch-back', 'ds8', { select: true })
await s.step()
await s.render('desktop')
s.selects.get('handoff-after').onSelect('none')
await s.press('handoff', 'desktop')
await s.fire('turn.start', { turnId: 't1' })
await s.render('desktop')
s.selects.get('handoff-after').onSelect('clear')
await s.end({ reason: 'answer', answer: body, turnId: 't1' })
assert.ok(cleared(s))

// a handoff from an earlier chat goes beside the pair: this chat can still hand off
await makeHandoff('/w/desk-disk', 'ds9')
s = await boot('/w/desk-disk', 'ds10', { select: true })
await s.step()
let keys = drawn(await s.render('desktop'))
assert.ok(['continue', 'handoff', 'handoff-after'].every((k) => keys.has(k)))
// this chat's own handoff takes the pair's place
s = await boot('/w/desk-own', 'ds12', { select: true })
await s.step()
await s.render('desktop')
s.selects.get('handoff-after').onSelect('none')
await s.press('handoff', 'desktop')
await s.end({ reason: 'answer', answer: body, turnId: 't1' })
keys = drawn(await s.render('desktop'))
assert.ok(keys.has('continue') && !keys.has('handoff') && !keys.has('handoff-after'))

// a long landing offers stop now on the desktop band too
s = await boot('/w/desk-land', 'ds11', { working: true, select: true })
await s.press('handoff', 'desktop')
await s.step('busy', '', 'end_turn', undefined, 60000)
await batch(s)
await s.render('desktop')
assert.ok(s.buttons.has('stop'))

console.log('handoff-continue: ok')
