// Run: claude plugin test cache-keeper
// The handoff card through the engine's own test kit: the trees it draws must
// pass the engine's checks on the terminal and in the desktop app, and the
// presses must reach the module's ui.press hooks.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 200 } as never } as const
// The band laid out in this many cells (bodyColumns); the window is the
// engine's five cells wider
const laidOut = (columns: number) => ({ ...BAND, props: { ...(BAND.props as object), bodyColumns: columns } as never, viewport: { columns: columns + 5, rows: 40 } })

async function session($: Engine, on: On, ctx = 320000) {
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
    return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 10, cache_read_input_tokens: ctx, cache_creation_input_tokens: 0 } } as never
  })
  // What the module sends out: the commands it runs and the prompts it submits
  const ran: string[] = []
  const sent: string[] = []
  on('ui.toast', () => ({ value: undefined }) as never)
  on('command.run', (_$, e: never) => (ran.push((e as { command: string }).command), {}) as never)
  on('prompt.submit', (_$, e: never) => (sent.push((e as { text: string }).text), { text: (e as { text: string }).text }) as never)
  on('classic.SessionStart', () => ({}) as never)
  await $.session.start({ source: 'startup', cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  // A context big enough for the handoff offer
  await $.session.measure({ context: { tokens: ctx, window: 1000000 } } as never)
  return { clock, ran, sent }
}

test('a big context opens the offer on both surfaces', async ($, on) => {
  await session($, on)
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
    const { clock } = await session($, on)
    const ui = await $.ui.mount({ plugin: 'cache-keeper', surface, ...BAND })
    await ui.press({ key: 'ck-ho-start' } as never)
    await clock.advance(0) // the press starts the pipeline and returns
    expect((await ui.find({ type: 'Text', text: /^Handoff ready/ }))?.text).toMatch(/Handoff ready · [\d,]+ words/)
    // The terminal keeps the five steps under the title; the desktop card is one line once ready
    expect((await ui.findAll({ type: 'Text', text: /messages?$|files?$/ })).map((x: { text: string }) => x.text)).toEqual(surface === 'terminal' ? ['2 messages', '1 file'] : [])
    expect(!!(await ui.find({ key: 'ck-ho-step-0' } as never))).toBe(surface === 'terminal')
    for (const key of ['ck-ho-clear', 'ck-ho-keep', 'ck-ho-open', 'ck-ho-close']) expect(await ui.find({ key } as never)).toBeTruthy()
    await ui.press({ key: 'ck-ho-close' } as never)
    expect(await ui.find({ type: 'Text', text: /^Handoff ready/ })).toBeFalsy()
    await ui.unmount()
  })

  test(`${surface}: a failed fork shows the reason, the draft and Try again`, async ($: Engine, on: On) => {
    pipeline(on, { isAnswered: false, reason: 'api-error', status: 529, usage: {} })
    const { clock } = await session($, on)
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
  pipeline(on, { isAnswered: true, text: GOOD, usage: {} })
  const { clock, ran, sent } = await session($, on)
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
    pipeline(on, () => (forks++, { isAnswered: true, text: GOOD, usage: {} }))
    const { clock, ran } = await session($, on)
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
    pipeline(on, { isAnswered: true, text: GOOD, usage: {} })
    const { clock, ran } = await session($, on)
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
  const { clock } = await session($, on)
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'desktop', ...BAND })
  await Promise.all([ui.press({ key: 'ck-ho-start' } as never), ui.press({ key: 'ck-ho-start' } as never)])
  await clock.advance(0)
  expect(forks).toBe(1)
  await ui.unmount()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: Keep chat takes "clear and continue" off the band until a new handoff is saved`, async ($: Engine, on: On) => {
    pipeline(on, { isAnswered: true, text: GOOD, usage: {} })
    const { clock } = await session($, on)
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
  const { clock } = await session($, on)
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

// ---- the desktop band: a row of captioned cards ---------------------------

// A session whose main loop reads `ctx` tokens from the cache each request
async function sized($: Engine, on: On, ctx: number) {
  const s = await session($, on, ctx)
  await step($)
  return s
}

const captions = async (ui: { findAll: (m: never) => Promise<{ text: string }[]> }) =>
  (await ui.findAll({ type: 'Text', text: /^(Cache|Rewrite|Context|Next chat)( ·|$| cost$)/ } as never)).map((x) => x.text)

test('desktop band: one row of captioned cards, each control inside its card', async ($: Engine, on: On) => {
  await sized($, on, 320000)
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'desktop', ...BAND })
  expect(await captions(ui)).toEqual(['Cache · warm', 'Rewrite cost', 'Context · of 1M', 'Next chat · turn on after clear'])
  const row = await ui.find({ key: 'cards' } as never)
  expect(row?.props.flexWrap).toBe('wrap')
  for (const key of ['card-cache', 'card-cost', 'card-ctx', 'card-next']) expect((await ui.find({ key } as never))?.props.borderStyle).toBe('round')
  expect(await ui.find({ type: 'Text', text: '320k' } as never)).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^if cold ≈ / } as never)).toBeTruthy()
  for (const key of ['keep-warm', 'tag-caveman', 'tag-jev', 'tag-lsp', 'handoff']) expect(await ui.find({ key } as never)).toBeTruthy()
  await ui.unmount()
})

test('desktop band: a calm card has a dim border and the handoff is a plain button', async ($: Engine, on: On) => {
  await sized($, on, 320000)
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'desktop', ...BAND })
  for (const key of ['card-cache', 'card-cost', 'card-ctx', 'card-next']) {
    const card = await ui.find({ key } as never)
    expect(card?.props.borderDimColor).toBe(true)
    expect(card?.props.borderColor).toBeUndefined()
  }
  const handoff = await ui.find({ key: 'handoff' } as never)
  expect(handoff?.props.plain).toBe(true)
  expect(handoff?.props.variant).toBeUndefined()
  await ui.unmount()
})

test('desktop band: past 600k the context card is coloured and the handoff is the primary button', async ($: Engine, on: On) => {
  await sized($, on, 650000)
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'desktop', ...BAND })
  const ctx = await ui.find({ key: 'card-ctx' } as never)
  expect(ctx?.props.borderColor).toBe('#f85149')
  expect(ctx?.props.borderDimColor).toBeUndefined()
  // The other cards stay calm
  expect((await ui.find({ key: 'card-cache' } as never))?.props.borderDimColor).toBe(true)
  const handoff = await ui.find({ key: 'handoff' } as never)
  expect(handoff?.props.variant).toBe('primary')
  expect(handoff?.props.plain).toBeUndefined()
  await ui.unmount()
})

test('desktop band: a cache gone cold on a big context colours the cache and cost cards and says what the next send costs', async ($: Engine, on: On) => {
  const { clock } = await sized($, on, 320000)
  await clock.advance(2 * 60 * 60 * 1000)
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'desktop', ...BAND })
  expect(await captions(ui)).toContain('Cache · cold')
  expect((await ui.find({ key: 'card-cache' } as never))?.props.borderColor).toBe('#f85149')
  expect((await ui.find({ key: 'card-cost' } as never))?.props.borderColor).toBe('#f85149')
  expect(await ui.find({ type: 'Text', text: /^next send rewrites ≈ / } as never)).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^if cold ≈ / } as never)).toBeFalsy()
  expect((await ui.find({ key: 'handoff' } as never))?.props.variant).toBe('primary')
  await ui.unmount()
})

test('desktop band: a narrow window shortens the captions and the tags', async ($: Engine, on: On) => {
  await sized($, on, 320000)
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'desktop', ...laidOut(80) } as never)
  expect(await captions(ui)).toEqual(['Cache', 'Rewrite', 'Context', 'Next chat'])
  expect((await ui.find({ key: 'tag-caveman' } as never))?.text).toBe('cave')
  await ui.unmount()
})

test('desktop card: the offer and the failed steps stand in a frame, the terminal has none', async ($: Engine, on: On) => {
  pipeline(on, { isAnswered: false, reason: 'api-error', status: 529, usage: {} })
  const { clock } = await session($, on)
  const term = await $.ui.mount({ plugin: 'cache-keeper', surface: 'terminal', ...BAND })
  expect(await term.find({ key: 'ck-ho-offer' } as never)).toBeTruthy()
  expect(await term.find({ key: 'ck-ho-offer-card' } as never)).toBeFalsy()
  await term.unmount()
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'desktop', ...BAND })
  expect((await ui.find({ key: 'ck-ho-offer-card' } as never))?.props.borderColor).toBe('#d97757')
  await ui.press({ key: 'ck-ho-start' } as never)
  await clock.advance(0)
  // Failed: the frame turns red and the five steps stand side by side in one wrapping row
  expect((await ui.find({ key: 'ck-ho-card' } as never))?.props.borderColor).toBe('#f85149')
  const steps = await ui.find({ key: 'ck-ho-steps' } as never)
  expect(steps?.props.flexDirection).toBe('row')
  expect(steps?.props.flexWrap).toBe('wrap')
  for (let i = 0; i < 5; i++) expect((await ui.find({ key: 'ck-ho-step-' + i } as never))?.props.flexDirection).toBe('column')
  await ui.unmount()
})

test('desktop card: ready, Clear and continue is the primary button of a green frame', async ($: Engine, on: On) => {
  pipeline(on, { isAnswered: true, text: GOOD, usage: {} })
  const { clock } = await session($, on)
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'desktop', ...BAND })
  await ui.press({ key: 'ck-ho-start' } as never)
  await clock.advance(0)
  expect((await ui.find({ key: 'ck-ho-card' } as never))?.props.borderColor).toBe('#3fb950')
  expect((await ui.find({ key: 'ck-ho-clear' } as never))?.props.variant).toBe('primary')
  expect(await ui.find({ type: 'Text', text: /^Saved to / } as never)).toBeTruthy()
  await ui.unmount()
})

// ---- the cards hug what they hold; the context card takes the rest --------

// The cache window is 60 minutes; it cools for the last five
const COOLING_AFTER = 56 * 60 * 1000

const limits = ($: Engine, list: { kind: string; percentUsed: number }[]) => $.session.measure({ rateLimits: list } as never)

// The context gauge in a window of that many columns: its Svg and the Box it grows in
async function ctxGauge($: Engine, columns?: number) {
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'desktop', ...(columns ? laidOut(columns) : BAND) } as never)
  const svgs = await ui.findAll({ type: 'Svg' } as never)
  const svg = svgs.find((x: { props: { alt?: string } }) => /^context /.test(String(x.props.alt))) as { props: Record<string, unknown> }
  const box = (await ui.find({ key: 'ctx-gauge' } as never)) as { props: Record<string, unknown> }
  await ui.unmount()
  return { svg: svg.props, box: box.props }
}

test('desktop band: only the context card stretches; the others hug what they hold', async ($: Engine, on: On) => {
  await sized($, on, 320000)
  await limits($, [{ kind: 'seven_day', percentUsed: 34 }])
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'desktop', ...BAND })
  for (const key of ['card-cache', 'card-cost', 'card-ctx', 'card-limit-seven_day', 'card-next']) {
    const card = await ui.find({ key } as never)
    // The context card takes the rest of the row, so the row ends flush right
    expect(card?.props.flexGrow).toBe(key === 'card-ctx' ? 1 : undefined)
    expect(card?.props.flexShrink).toBe(0)
    expect(card?.props.width).toBeUndefined()
  }
  // The context card stands third, between the cost and the limits
  const drawn = (await ui.findAll({ type: 'Box' } as never)).map((b: { key?: string }) => String(b.key)).filter((k: string) => /^card-[a-z_-]+$/.test(k) && !k.endsWith('-value'))
  expect(drawn).toEqual(['card-cache', 'card-cost', 'card-ctx', 'card-limit-seven_day', 'card-next'])
  await ui.unmount()
})

test('desktop band: the context gauge stretches over its card, on one line or a wrapped one', async ($: Engine, on: On) => {
  await sized($, on, 320000)
  await limits($, [{ kind: 'seven_day', percentUsed: 34 }])
  for (const columns of [400, 200, 120, 60]) {
    const { svg, box } = await ctxGauge($, columns)
    // No width of its own: the surface stretches the markup over the slot
    expect(svg.width).toBeUndefined()
    expect(svg.height).toBe(8)
    expect(String(svg.source)).toContain('preserveAspectRatio="none"')
    // The slot grows into what the card has, from nothing up, never below the floor
    expect(box.flexGrow).toBe(1)
    expect(box.width).toBe(0)
    expect(Number(box.minWidth)).toBeGreaterThanOrEqual(1)
  }
  // The limit gauges keep their width while the full form fits
  expect(await limitGauges($, 400)).toEqual([64])
})

// The cells a drawn element takes on one line, counted from the tree itself
// (not from the module's own count): text by its characters, a native Button
// two cells around its label, a Select five around its label and value, a
// gauge a cell per 8 px, a row its parts and gaps, a card its border and padding
type Drawn = { type?: string; props?: Record<string, unknown>; children?: unknown[] } | string
function cells(n: Drawn): number {
  if (typeof n === 'string') return n.length
  if (!n || typeof n !== 'object') return 0
  const p = n.props || {}
  const kids = (n.children || []) as Drawn[]
  if (n.type === 'Text') return kids.reduce((a: number, c) => a + cells(c), 0)
  if (n.type === 'Button') return String(p.label ?? kids.map((c) => (typeof c === 'string' ? c : '')).join('')).length + 2
  if (n.type === 'Select') {
    const opt = (p.options as { value: string; label: string }[]).find((o) => o.value === p.value)
    return String(p.label).length + 1 + String(opt ? opt.label : p.value).length + 5
  }
  if (n.type === 'Svg') return p.width === undefined ? 0 : Math.ceil(Number(p.width) / 8)
  const inner = p.flexDirection === 'column' ? Math.max(0, ...kids.map(cells)) : kids.reduce((a: number, c) => a + cells(c), 0) + (typeof p.columnGap === 'number' ? p.columnGap : 0) * Math.max(0, kids.length - 1)
  return Math.max(Number(p.minWidth) || 0, inner) + (p.borderStyle ? 2 : 0) + 2 * (Number(p.paddingX) || 0)
}

// The band at one width: whether its cards fit one line, the widest card, and
// whether the cards may shrink
async function bandAt($: Engine, columns: number) {
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'desktop', ...laidOut(columns) } as never)
  const row = (await ui.find({ key: 'cards' } as never)) as unknown as { children: Drawn[] }
  await ui.unmount()
  const cards = row.children as { props: Record<string, unknown> }[]
  const each = cards.map((c) => cells(c as Drawn))
  return { line: each.reduce((a, w) => a + w + 1, -1), widest: Math.max(...each), shrink: cards.every((c) => c.props.flexShrink === 1), still: cards.every((c) => c.props.flexShrink === 0) }
}

const limitGauges = async ($: Engine, columns: number) => {
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'desktop', ...laidOut(columns) } as never)
  const svgs = await ui.findAll({ type: 'Svg' } as never)
  await ui.unmount()
  return svgs.filter((x: { props: { alt?: string } }) => /limit/.test(String(x.props.alt))).map((x: { props: { width: number } }) => x.props.width)
}

// Every width from 200 down to 24: the widths that hold one line
async function sweep($: Engine) {
  const oneLine: number[] = []
  for (let columns = 200; columns >= 24; columns -= 2) {
    const b = await bandAt($, columns)
    if (b.line <= columns) {
      // One line: the context card grows into the rest, nothing shrinks
      expect(b.still).toBe(true)
      oneLine.push(columns)
    } else if (b.widest <= columns) {
      // Wrapped onto more lines: every card fits the window as it is
      expect(b.still).toBe(true)
    } else {
      // A card wider than the window itself: the cards may shrink and wrap their rows
      expect(b.shrink).toBe(true)
    }
  }
  return oneLine
}

test('desktop band: kept warm for 12 h, two limits and a cooling cache never overflow either', async ($: Engine, on: On) => {
  const { clock } = await sized($, on, 320000)
  await limits($, [{ kind: 'five_hour', percentUsed: 100 }, { kind: 'seven_day', percentUsed: 34 }])
  await $.command.run({ command: 'keepwarm', args: '12' } as never)
  const kept = await sweep($)
  expect(kept[0]).toBe(200)
  await $.command.run({ command: 'keepwarm', args: 'off' } as never)
  await clock.advance(COOLING_AFTER)
  const cooling = await sweep($)
  expect(cooling[0]).toBe(200)
})

test('desktop band: below the context floor the band compacts, then wraps; nothing is ever cut off', async ($: Engine, on: On) => {
  await sized($, on, 320000)
  await limits($, [{ kind: 'seven_day', percentUsed: 34 }])
  const oneLine = await sweep($)
  // One line all the way down from a wide window, with no gap in between
  expect(oneLine[0]).toBe(200)
  expect(oneLine.every((c, i) => i === 0 || oneLine[i - 1] - c === 2)).toBe(true)
  // The compact steps keep a common desktop band on one line
  expect(oneLine.at(-1)).toBeLessThanOrEqual(106)
  // The compact form: half-width limit gauges and short labels where the full form would not fit
  const last = oneLine.at(-1) as number
  expect(await limitGauges($, last)).toEqual([32])
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'desktop', ...laidOut(last) } as never)
  expect((await ui.find({ key: 'keep-warm' } as never))?.props.label).toBe('warm')
  expect((await ui.find({ key: 'tag-autoclear' } as never))?.props.label).toBe('auto')
  expect(await captions(ui)).toEqual(['Cache', 'Rewrite', 'Context', 'Next chat'])
  await ui.unmount()
})

test('desktop band: with no limit card the context gauge stops at a limit gauge width', async ($: Engine, on: On) => {
  await sized($, on, 320000)
  // Never below a full limit gauge while the full form is drawn, then a compact one
  const full: number[] = []
  for (let columns = 160; columns >= 96; columns -= 2) {
    const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'desktop', ...laidOut(columns) } as never)
    const isFull = !!(await ui.find({ type: 'Text', text: 'Rewrite cost' } as never))
    await ui.unmount()
    if (isFull) full.push(Number((await ctxGauge($, columns)).box.minWidth))
  }
  expect(Math.min(...full)).toBeGreaterThanOrEqual(8)
  expect(Number((await ctxGauge($, 60)).box.minWidth)).toBe(4)
})

test('desktop band: each plan limit has a card, coloured from 80%', async ($: Engine, on: On) => {
  await sized($, on, 320000)
  await limits($, [{ kind: 'five_hour', percentUsed: 85 }, { kind: 'seven_day', percentUsed: 79 }])
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'desktop', ...BAND })
  const hot = await ui.find({ key: 'card-limit-five_hour' } as never)
  expect(hot?.props.borderColor).toBe('#d29922')
  expect(hot?.props.borderDimColor).toBeUndefined()
  const calm = await ui.find({ key: 'card-limit-seven_day' } as never)
  expect(calm?.props.borderDimColor).toBe(true)
  expect(calm?.props.borderColor).toBeUndefined()
  expect((await ui.findAll({ type: 'Text', text: /^(5h|Week) limit$/ } as never)).map((x: { text: string }) => x.text)).toEqual(['5h limit', 'Week limit'])
  expect((await ui.findAll({ type: 'Text', text: /^\d+%$/ } as never)).map((x: { text: string }) => x.text)).toEqual(['85%', '79%'])
  await ui.unmount()
  // A narrow window names them as the terminal does
  const narrow = await $.ui.mount({ plugin: 'cache-keeper', surface: 'desktop', ...laidOut(80) } as never)
  expect((await narrow.findAll({ type: 'Text', text: /^(5h|week)$/ } as never)).map((x: { text: string }) => x.text)).toEqual(['5h', 'week'])
  await narrow.unmount()
})

test('desktop band: a cache cooling on a big context turns its card yellow and offers one press to keep it warm, then cyan', async ($: Engine, on: On) => {
  const { clock } = await sized($, on, 320000)
  const warm = await $.ui.mount({ plugin: 'cache-keeper', surface: 'desktop', ...BAND })
  expect(await warm.find({ key: 'keepwarm' } as never)).toBeFalsy()
  await warm.unmount()
  await clock.advance(COOLING_AFTER)
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'desktop', ...BAND })
  expect(await captions(ui)).toContain('Cache · cools soon')
  expect((await ui.find({ key: 'card-cache' } as never))?.props.borderColor).toBe('#d29922')
  expect((await ui.find({ key: 'keepwarm' } as never))?.text).toBe('keep 4 h')
  await ui.press({ key: 'keepwarm' } as never)
  await ui.unmount()
  const kept = await $.ui.mount({ plugin: 'cache-keeper', surface: 'desktop', ...BAND })
  expect((await captions(kept))[0]).toMatch(/^Cache · kept warm · /)
  expect((await kept.find({ key: 'card-cache' } as never))?.props.borderColor).toBe('#39c5cf')
  expect(await kept.find({ key: 'keepwarm' } as never)).toBeFalsy()
  await kept.unmount()
})
