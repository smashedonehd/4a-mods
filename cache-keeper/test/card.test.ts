// Run: claude plugin test cache-keeper
// The handoff card through the engine's own test kit: the trees it draws must
// pass the engine's checks on the terminal and in the desktop app, and the
// presses must reach the module's ui.press hooks.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120 } as never } as const

async function session($: Engine, on: On) {
  const clock = mock.clock(on, { now: Date.parse('2026-11-10T10:00:00Z') })
  mock.env(on, { HOME: '/home/t' })
  mock.store(on)
  const files = new Map<string, string>()
  on('session.id', () => ({ value: 'abcdef01-0000' }) as never)
  on('session.cwd', () => ({ value: '/repo' }) as never)
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as never)
  on('session.measure', () => ({ changed: [] }) as never)
  on('fs.exists', (_$, e: never) => ({ value: files.has((e as { path: string }).path) }) as never)
  on('fs.read', (_$, e: never) => ({ value: files.get((e as { path: string }).path) ?? '' }) as never)
  on('fs.write', (_$, e: never) => (files.set((e as { path: string }).path, (e as { text: string }).text), { value: undefined }) as never)
  on('state.get', () => ({ value: { value: undefined } }) as never)
  on('state.set', () => ({ value: undefined }) as never)
  on('command.register', (_$, e: never) => ({ value: { command: (e as { name: string }).name } }) as never)
  on('command.list', () => ({ value: [] }) as never)
  on('agent.list', () => ({ value: [] }) as never)
  on('session.start', async () => ({ cwd: '/repo' }) as never)
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 320000, cache_creation_input_tokens: 0 } } as never
  })
  await $.session.start({ source: 'startup', cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  return clock
}

test('a big context opens the offer on both surfaces', async ($, on) => {
  await session($, on)
  await $.session.measure({ context: { tokens: 320000, window: 1000000 } } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'cache-keeper', surface, ...BAND })
    expect((await ui.find({ type: 'Text', text: /Context 320k/ }))?.text).toContain('hand this chat off')
    expect(await ui.find({ key: 'ck-ho-start' })).toBeTruthy()
    await ui.unmount()
  }
})

// One request of the main loop: after it the band has figures and its buttons
const step = async ($: Engine) => {
  const stream = ($.turn.step as (e: unknown) => AsyncIterable<unknown>)({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of stream) void _
}

const ROWS = [
  { role: 'user', text: 'Fix /repo/src/a.ts', toolUses: [] },
  { role: 'assistant', text: 'ok https://github.com/o/r/pull/3', toolUses: [{ tool_use_id: 'u1', tool: 'Edit', input: { file_path: '/repo/src/a.ts' } }] },
]
const SECTIONS = ['# Session Handoff: fix a.ts', '## Where it started', '## Decisions locked + what shipped', '## Key files for next session', '## Running state', '## Verification', '## Deferred + open questions', '## Pick up here']
const GOOD = SECTIONS.map((h, i) => (i ? `${h}\n- none` : h)).join('\n\n') + '\n\n' + 'Detail. '.repeat(40)

// The pipeline's own calls, answered: the conversation, the disk, the fork
function pipeline(on: On, fork: unknown) {
  on('session.messages', () => ({ value: ROWS }) as never)
  // The path as the engine hands it on (a drive in front on Windows)
  on('fs.stat', (_$: never, e: never) => (/[\\/]repo[\\/]src[\\/]a\.ts$/.test((e as { path: string }).path) ? { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } } : { value: { kind: 'other', size: 0, mtimeMs: 0, isLink: false } }) as never)
  on('model.fork', () => ({ value: typeof fork === 'function' ? fork() : fork }) as never)
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'no git' } }) as never)
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: Start handoff runs the five steps to a ready card`, async ($: Engine, on: On) => {
    pipeline(on, { isAnswered: true, text: GOOD, usage: {} })
    const clock = await session($, on)
    await $.session.measure({ context: { tokens: 320000, window: 1000000 } } as never)
    const ui = await $.ui.mount({ plugin: 'cache-keeper', surface, ...BAND })
    await ui.press({ key: 'ck-ho-start' } as never)
    await clock.advance(0) // the press starts the pipeline and returns
    expect((await ui.find({ type: 'Text', text: /^Handoff ready/ }))?.text).toMatch(/Handoff ready: \d+ words/)
    expect((await ui.findAll({ type: 'Text', text: /messages?$|files?$/ })).map((x: { text: string }) => x.text)).toEqual(['2 messages', '1 file'])
    for (const key of ['ck-ho-clear', 'ck-ho-keep', 'ck-ho-open', 'ck-ho-close']) expect(await ui.find({ key } as never)).toBeTruthy()
    await ui.press({ key: 'ck-ho-close' } as never)
    expect(await ui.find({ type: 'Text', text: /^Handoff ready/ })).toBeFalsy()
    await ui.unmount()
  })

  test(`${surface}: a failed fork shows the reason, the draft and Try again`, async ($: Engine, on: On) => {
    pipeline(on, { isAnswered: false, reason: 'api-error', status: 529, usage: {} })
    const clock = await session($, on)
    await $.session.measure({ context: { tokens: 320000, window: 1000000 } } as never)
    const ui = await $.ui.mount({ plugin: 'cache-keeper', surface, ...BAND })
    await ui.press({ key: 'ck-ho-start' } as never)
    await clock.advance(0) // the press starts the pipeline and returns
    expect(await ui.find({ type: 'Text', text: /did not finish/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /HTTP 529/ })).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /^Draft saved to / }))?.text).toMatch(/\.draft\.md$/)
    expect(await ui.find({ key: 'ck-ho-retry' } as never)).toBeTruthy()
    await ui.unmount()
  })
}

test('Clear and continue runs /clear and sends the handoff as the first prompt', async ($: Engine, on: On) => {
  const ran: string[] = []
  const sent: string[] = []
  pipeline(on, { isAnswered: true, text: GOOD, usage: {} })
  on('ui.toast', () => ({ value: undefined }) as never)
  on('command.run', (_$: never, e: never) => (ran.push((e as { command: string }).command), {}) as never)
  on('prompt.submit', (_$: never, e: never) => (sent.push((e as { text: string }).text), { text: (e as { text: string }).text }) as never)
  const clock = await session($, on)
  await $.session.measure({ context: { tokens: 320000, window: 1000000 } } as never)
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'desktop', ...BAND })
  await ui.press({ key: 'ck-ho-start' } as never)
  await clock.advance(0)
  await ui.press({ key: 'ck-ho-clear' } as never)
  await clock.advance(0)
  expect(ran).toContain('clear')
  expect(sent.length).toBe(1)
  expect(sent[0]).toMatch(/^Handoff from my previous session/)
  expect(sent[0]).toContain('# Session Handoff: fix a.ts')
  await ui.unmount()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: a slow press returns before its work starts: the hook never waits for it`, async ($: Engine, on: On) => {
    let forks = 0
    const ran: string[] = []
    pipeline(on, () => (forks++, { isAnswered: true, text: GOOD, usage: {} }))
    on('ui.toast', () => ({ value: undefined }) as never)
    on('command.run', (_$: never, e: never) => (ran.push((e as { command: string }).command), {}) as never)
    on('prompt.submit', (_$: never, e: never) => ({ text: (e as { text: string }).text }) as never)
    const clock = await session($, on)
    await $.session.measure({ context: { tokens: 320000, window: 1000000 } } as never)
    await step($)
    const ui = await $.ui.mount({ plugin: 'cache-keeper', surface, ...BAND })
    await ui.press({ key: 'ck-ho-start' } as never)
    expect(forks).toBe(0)
    expect(await ui.find({ type: 'Text', text: /^Handoff ready/ })).toBeFalsy()
    await clock.advance(0)
    expect(forks).toBe(1)
    expect(await ui.find({ type: 'Text', text: /^Handoff ready/ })).toBeTruthy()
    // The band's own handoff button starts its work the same way
    await ui.press({ key: 'ck-ho-close' } as never)
    await ui.press({ key: 'handoff' } as never)
    expect(forks).toBe(1)
    await clock.advance(0)
    expect(forks).toBe(2)
    // So does the card's Clear and continue
    await ui.press({ key: 'ck-ho-clear' } as never)
    expect(ran).toEqual([])
    await clock.advance(0)
    expect(ran).toEqual(['clear'])
    await ui.unmount()
  })

  test(`${surface}: the band's clear and continue returns before it clears`, async ($: Engine, on: On) => {
    const ran: string[] = []
    pipeline(on, { isAnswered: true, text: GOOD, usage: {} })
    on('ui.toast', () => ({ value: undefined }) as never)
    on('command.run', (_$: never, e: never) => (ran.push((e as { command: string }).command), {}) as never)
    on('prompt.submit', (_$: never, e: never) => ({ text: (e as { text: string }).text }) as never)
    const clock = await session($, on)
    await $.session.measure({ context: { tokens: 320000, window: 1000000 } } as never)
    await step($)
    const ui = await $.ui.mount({ plugin: 'cache-keeper', surface, ...BAND })
    await ui.press({ key: 'ck-ho-start' } as never)
    await clock.advance(0)
    await ui.press({ key: 'ck-ho-close' } as never)
    await ui.press({ key: 'continue' } as never)
    expect(ran).toEqual([])
    await clock.advance(0)
    expect(ran).toEqual(['clear'])
    await ui.unmount()
  })
}

test('a Start pressed twice writes one handoff: the second runs on a card that is gone', async ($: Engine, on: On) => {
  let forks = 0
  pipeline(on, () => (forks++, { isAnswered: true, text: GOOD, usage: {} }))
  on('ui.toast', () => ({ value: undefined }) as never)
  const clock = await session($, on)
  await $.session.measure({ context: { tokens: 320000, window: 1000000 } } as never)
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'desktop', ...BAND })
  await Promise.all([ui.press({ key: 'ck-ho-start' } as never), ui.press({ key: 'ck-ho-start' } as never)])
  await clock.advance(0)
  expect(forks).toBe(1)
  await ui.unmount()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: Keep chat takes "clear and continue" off the band until a new handoff is saved`, async ($: Engine, on: On) => {
    pipeline(on, { isAnswered: true, text: GOOD, usage: {} })
    on('ui.toast', () => ({ value: undefined }) as never)
    const clock = await session($, on)
    await $.session.measure({ context: { tokens: 320000, window: 1000000 } } as never)
    await step($)
    const ui = await $.ui.mount({ plugin: 'cache-keeper', surface, ...BAND })
    await ui.press({ key: 'ck-ho-start' } as never)
    await clock.advance(0)
    // The ready card has its own button, the band none
    expect(await ui.find({ key: 'continue' } as never)).toBeFalsy()
    await ui.press({ key: 'ck-ho-keep' } as never)
    expect(await ui.find({ type: 'Text', text: /^Handoff ready/ })).toBeFalsy()
    expect(await ui.find({ key: 'continue' } as never)).toBeFalsy()
    expect(await ui.find({ key: 'handoff' } as never)).toBeTruthy()
    // A new handoff, its card closed: the band offers to clear again
    await ui.press({ key: 'handoff' } as never)
    await clock.advance(0)
    await ui.press({ key: 'ck-ho-close' } as never)
    expect((await ui.find({ key: 'continue' } as never))?.text).toBe('clear and continue')
    await ui.unmount()
  })
}

test('a plain /clear after Keep chat brings "clear and continue" back: the choice was about the old chat', async ($: Engine, on: On) => {
  pipeline(on, { isAnswered: true, text: GOOD, usage: {} })
  on('ui.toast', () => ({ value: undefined }) as never)
  on('classic.SessionStart', () => ({}) as never)
  const clock = await session($, on)
  await $.session.measure({ context: { tokens: 320000, window: 1000000 } } as never)
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'desktop', ...BAND })
  await ui.press({ key: 'ck-ho-start' } as never)
  await clock.advance(0)
  await ui.press({ key: 'ck-ho-keep' } as never)
  await ui.unmount()
  await step($)
  const kept = await $.ui.mount({ plugin: 'cache-keeper', surface: 'desktop', ...BAND })
  expect(await kept.find({ key: 'handoff' } as never)).toBeTruthy()
  expect(await kept.find({ key: 'continue' } as never)).toBeFalsy()
  await kept.unmount()
  await ($.classic.SessionStart as (e: unknown) => Promise<unknown>)({ source: 'clear' })
  await step($)
  const fresh = await $.ui.mount({ plugin: 'cache-keeper', surface: 'desktop', ...BAND })
  expect((await fresh.find({ key: 'continue' } as never))?.text).toBe('clear and continue')
  await fresh.unmount()
})
