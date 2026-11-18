import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

// With few subagents (STEP_MAX, 3) the band counts their own reported steps, one
// coloured part of the bar per subagent; with more it counts the subagents.

const PLUGIN = 'savvy-progress'
const PROGRESS = 'mcp__savvy-progress__progress'
const STEP = 'mcp__savvy-progress__step'
const band = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} }
const T0 = Date.parse('2026-11-18T10:00:00Z')
const VIOLET = '#8f8cf4'
const TEAL = '#36a9c4'
const ORANGE = '#e08a4f'

function session(on: On) {
  const clock = { now: T0 }
  on('clock.now', () => ({ value: clock.now }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('agent.spawn', (_$, e) => ({ model: 'claude-opus-5-5', agentId: (e as { tool_use_id: string }).tool_use_id }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  return clock
}

const spawn = ($: Engine, id: string, description = `Task ${id}`) =>
  $.agent.spawn({ tool_use_id: id, prompt: 'p', description, subagentType: 'general-purpose', provider: 'engine', parentModel: 'claude-opus-5-5', background: false, fork: false } as never)

const finish = ($: Engine, id: string, reason = 'answer') =>
  ($.turn.complete as (e: unknown) => Promise<unknown>)({ agentId: id, reason, answer: 'ok' })

const report = ($: Engine, id: string, done: number, total?: number) =>
  $.tool.call({ tool: STEP, agentId: id, done, ...(total === undefined ? {} : { total }) } as never)

// The desktop band: its alt and its drawing
async function desktop($: Engine) {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: band })
  const svg = await ui.findAll({ type: 'Svg' })
  await ui.unmount()
  return svg.length ? { alt: String(svg[0]?.props.alt), source: String(svg[0]?.props.source) } : null
}

// The terminal band: its label and the coloured runs of its bar
async function terminal($: Engine) {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: band })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  const label = texts.map(el => String(el.text ?? '')).find(t => /^(Tasks|Steps|Review) \d+\/\d+$|^Done$/.test(t)) ?? ''
  const bar = texts
    .filter(el => /^[█░]+$/.test(String(el.text ?? '')))
    .map(el => ({ color: String(el.props.color), filled: [...String(el.text)].filter(c => c === '█').length, width: [...String(el.text)].length }))
  return { label, bar }
}

// The fill colours the desktop bar's dense dots use, in drawing order
const dotColors = (source: string) => [...source.matchAll(/<g fill="(#[0-9a-f]{6})">/g)].map(m => m[1])
const gapXs = (source: string) => [...source.matchAll(/<rect class="k" x="([\d.-]+)" width="2"/g)].map(m => Number(m[1]))
const gaps = (source: string) => gapXs(source).length
const barW = (source: string) => Number(/<rect class="k" width="(\d+)"/.exec(source)?.[1])
const pillColor = (source: string) => /rx="8" fill="(#[0-9a-f]{6})"\/>/.exec(source)?.[1]

test('steps: one agent at 5/8 shows 5/8, not 0/1', async ($, on) => {
  session(on)
  await $.tool.call({ tool: PROGRESS, title: 'Ship it', total: 1, phase: 'delegate' } as never)
  await spawn($, 'a')
  expect((await desktop($))?.alt).toBe('Ship it: Tasks 0/1, 0%')
  await report($, 'a', 5, 8)
  expect((await desktop($))?.alt).toBe('Ship it: Steps 5/8, 63%')
  const t = await terminal($)
  expect(t.label).toBe('Steps 5/8')
  expect(t.bar.map(p => p.color)).toEqual([VIOLET])
  // 5/8 of the terminal bar is filled
  expect(t.bar[0]?.filled).toBe(Math.round((t.bar[0]?.width ?? 0) * 5 / 8))
})

test('steps: two agents at 5/8 and 2/5 show 7/13 in two colours', async ($, on) => {
  session(on)
  await spawn($, 'a')
  await spawn($, 'b')
  await report($, 'a', 5, 8)
  await report($, 'b', 2, 5)
  const d = await desktop($)
  expect(d?.alt).toBe('Subagents: Steps 7/13, 54%')
  expect(dotColors(d?.source ?? '')).toEqual([VIOLET, TEAL])
  expect(gapXs(d?.source ?? '')).toEqual([Math.round((barW(d?.source ?? '') * 8) / 13) - 1])
  // The pill sits on the teal part's fill: teal, so that fill still reads as the teal part's
  expect(pillColor(d?.source ?? '')).toBe(TEAL)
  const t = await terminal($)
  expect(t.label).toBe('Steps 7/13')
  expect(t.bar.map(p => p.color)).toEqual([VIOLET, TEAL])
  // Each part is as wide as its total and filled by its done
  const [a, b] = t.bar
  const width = (a?.width ?? 0) + (b?.width ?? 0)
  expect(a?.width).toBe(Math.round((width * 8) / 13))
  expect(a?.filled).toBe(Math.round(((a?.width ?? 0) * 5) / 8))
  expect(b?.filled).toBe(Math.round(((b?.width ?? 0) * 2) / 5))
})

test('steps: an agent that has not reported counts 0/1, and its report only adds', async ($, on) => {
  session(on)
  await spawn($, 'a')
  await spawn($, 'b')
  expect((await desktop($))?.alt).toBe('Subagents: Tasks 0/2, 0%')
  await report($, 'a', 5, 8)
  expect((await desktop($))?.alt).toBe('Subagents: Steps 5/9, 56%')
  await report($, 'b', 0, 5)
  expect((await desktop($))?.alt).toBe('Subagents: Steps 5/13, 38%')
  // An agent that ends without a report counts 1/1
  await spawn($, 'c')
  await finish($, 'c')
  expect((await desktop($))?.alt).toBe('Subagents: Steps 6/14, 43%')
})

test('steps: a changed total is read as it stands now', async ($, on) => {
  session(on)
  await spawn($, 'a')
  await spawn($, 'b')
  await report($, 'a', 2, 4)
  expect((await desktop($))?.alt).toBe('Subagents: Steps 2/5, 40%')
  await report($, 'a', 3, 8)
  expect((await desktop($))?.alt).toBe('Subagents: Steps 3/9, 33%')
  // A smaller total cuts what is done to it
  await report($, 'a', 7, 6)
  expect((await desktop($))?.alt).toBe('Subagents: Steps 6/7, 86%')
})

test('steps: three agents still count steps, a fourth counts agents again', async ($, on) => {
  session(on)
  for (const id of ['a', 'b', 'c']) await spawn($, id)
  for (const id of ['a', 'b', 'c']) await report($, id, 1, 4)
  const d = await desktop($)
  expect(d?.alt).toBe('Subagents: Steps 3/12, 25%')
  expect(dotColors(d?.source ?? '')).toEqual([VIOLET, TEAL, ORANGE])
  expect(gaps(d?.source ?? '')).toBe(2)
  await spawn($, 'd')
  await report($, 'd', 1, 4)
  const four = await desktop($)
  expect(four?.alt).toBe('Subagents: Tasks 0/4, 0%')
  expect(gaps(four?.source ?? '')).toBe(0)
  expect((await terminal($)).bar.map(p => p.color)).toEqual([VIOLET])
})

test('steps: a plan of more than three tasks counts tasks', async ($, on) => {
  session(on)
  await $.tool.call({ tool: PROGRESS, title: 'Ship it', total: 4, done: 1, phase: 'delegate' } as never)
  await spawn($, 'a')
  await report($, 'a', 5, 8)
  expect((await desktop($))?.alt).toBe('Ship it: Tasks 1/4, 25%')
})

test('steps: an agent at its last step that still works is neither Done nor 100%', async ($, on) => {
  session(on)
  await $.tool.call({ tool: PROGRESS, title: 'Ship it', total: 1, phase: 'delegate' } as never)
  await spawn($, 'a')
  await report($, 'a', 8, 8)
  expect((await desktop($))?.alt).toBe('Ship it: Steps 8/8, 99%')
  expect((await terminal($)).label).toBe('Steps 8/8')
  await finish($, 'a')
  await $.tool.call({ tool: PROGRESS, done: 1, finished: true } as never)
  expect((await desktop($))?.alt).toBe('Ship it: Done, 100%')
})

test('steps: a wave of two at their last steps is not Done while they work', async ($, on) => {
  session(on)
  await spawn($, 'a')
  await spawn($, 'b')
  await report($, 'a', 3, 3)
  await report($, 'b', 2, 2)
  expect((await desktop($))?.alt).toBe('Subagents: Steps 5/5, 99%')
  await finish($, 'a')
  expect((await desktop($))?.alt).toBe('Subagents: Steps 5/5, 99%')
  await finish($, 'b')
  expect((await desktop($))?.alt).toBe('Subagents: Done, 100%')
})

test('steps: a plan task with no run of the wave counts as the plan accepted it', async ($, on) => {
  const clock = session(on)
  await $.tool.call({ tool: PROGRESS, title: 'Ship it', total: 2, phase: 'delegate' } as never)
  await spawn($, 'a')
  await finish($, 'a')
  await $.tool.call({ tool: PROGRESS, done: 1 } as never)
  // A later wave: the finished run is no longer in it, the plan's count stands for it
  clock.now += 60_000
  await spawn($, 'b')
  await report($, 'b', 1, 4)
  expect((await desktop($))?.alt).toBe('Ship it: Steps 2/5, 40%')
  // b, the wave's run, takes the first slot: violet and 4 of 5 wide
  const t = await terminal($)
  expect(t.bar.map(p => p.color)).toEqual([VIOLET, TEAL])
  const width = t.bar.reduce((w, p) => w + p.width, 0)
  expect(t.bar[0]?.width).toBe(Math.round((width * 4) / 5))
})

test('steps: a run of the wave that ended is not counted again by the plan’s accepted count', async ($, on) => {
  session(on)
  await $.tool.call({ tool: PROGRESS, title: 'Ship it', total: 3, phase: 'delegate' } as never)
  await spawn($, 'a')
  await finish($, 'a')
  await $.tool.call({ tool: PROGRESS, done: 1 } as never)
  // In the same millisecond: b joins a's wave, and a's own slot is the accepted one
  await spawn($, 'b')
  expect((await desktop($))?.alt).toBe('Ship it: Tasks 1/3, 33%')
})

test('steps: a task title matches only runs of the wave, not an ended earlier one', async ($, on) => {
  const clock = session(on)
  await $.tool.call({ tool: PROGRESS, title: 'Ship it', phase: 'delegate', tasks: [{ title: 'Task r' }, { title: 'Task s' }] } as never)
  await spawn($, 'r')
  await finish($, 'r')
  clock.now += 60_000
  await spawn($, 's')
  await report($, 's', 1, 4)
  // r ended in an earlier wave and the plan accepted nothing: its slot is 0/1
  expect((await desktop($))?.alt).toBe('Ship it: Steps 1/5, 20%')
})

test('steps: two tasks with one title take two runs, the latest first', async ($, on) => {
  session(on)
  await $.tool.call({ tool: PROGRESS, title: 'Ship it', phase: 'delegate', tasks: [{ title: 'Task x' }, { title: 'Task x' }] } as never)
  await spawn($, 'x1', 'Task x')
  await spawn($, 'x2', 'Task x')
  await report($, 'x1', 1, 4)
  await report($, 'x2', 2, 4)
  expect((await desktop($))?.alt).toBe('Ship it: Steps 3/8, 38%')
  const t = await terminal($)
  expect(t.bar[0]?.filled).toBe(Math.round((t.bar[0]?.width ?? 0) / 2))
  expect(t.bar[1]?.filled).toBe(Math.round((t.bar[1]?.width ?? 0) / 4))
})

test('steps: a total past the cap counts as the cap', async ($, on) => {
  session(on)
  await spawn($, 'a')
  await spawn($, 'b')
  await report($, 'a', 5, 1000)
  expect((await desktop($))?.alt).toBe('Subagents: Steps 5/201, 2%')
})

test('steps: the terminal parts sit flush, and a finished wave is one green bar', async ($, on) => {
  session(on)
  await spawn($, 'a')
  await spawn($, 'b')
  await report($, 'a', 1, 2)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: band })
  const box = await ui.find({ key: 'bar' })
  await ui.unmount()
  expect(box).toBeTruthy()
  expect(box?.props.gap ?? 0).toBe(0)
  await finish($, 'a')
  await finish($, 'b')
  expect((await terminal($)).bar.map(p => p.color)).toEqual(['#5fbf8f'])
})

test('steps: right to left, the gap between parts is mirrored', async ($, on) => {
  session(on)
  mock.env(on, { LANG: 'he_IL.UTF-8' })
  on('settings.read', async () => ({ value: {} }) as never)
  on('session.start', async () => ({ cwd: '/repo' }) as never)
  await $.session.start({ source: 'startup', cwd: '/repo', surface: 'desktop', isInteractive: true } as never)
  await spawn($, 'a')
  await spawn($, 'b')
  await report($, 'a', 5, 8)
  await report($, 'b', 2, 5)
  const source = (await desktop($))?.source ?? ''
  const w = barW(source)
  expect(gapXs(source)).toEqual([w - Math.round((w * 8) / 13) - 1])
})

test('steps: plan tasks take the runs that carry their titles, in the plan’s order', async ($, on) => {
  session(on)
  await $.tool.call({ tool: PROGRESS, title: 'Ship it', phase: 'delegate', tasks: [{ title: 'Task b' }, { title: 'Task a' }] } as never)
  await spawn($, 'a')
  await spawn($, 'b')
  await report($, 'a', 1, 4)
  const t = await terminal($)
  // b first: 0/1 in violet; a second: 1/4 in teal
  expect(t.label).toBe('Steps 1/5')
  expect(t.bar.map(p => p.color)).toEqual([VIOLET, TEAL])
  expect(t.bar[0]?.filled).toBe(0)
  expect(t.bar[1]?.filled).toBeGreaterThan(0)
})

test('steps: the pill rides the head of the last part with any fill', async ($, on) => {
  session(on)
  await spawn($, 'a')
  await spawn($, 'b')
  await report($, 'a', 5, 8)
  await report($, 'b', 2, 5)
  const source = (await desktop($))?.source ?? ''
  const w = barW(source)
  const start = Math.round((w * 8) / 13)
  const head = start + Math.round(((w - start) * 2) / 5)
  const pillW = Math.round(18 + 'Steps 7/13'.length * 6.6)
  const x = Number(/<rect x="([\d.-]+)" width="\d+" height="16" rx="8" fill=/.exec(source)?.[1])
  expect(x).toBe(Math.max(0, Math.min(w - pillW, head - pillW)))
})

test('steps: no tick inside a filled part', async ($, on) => {
  session(on)
  await $.tool.call({ tool: PROGRESS, title: 'Ship it', total: 1, phase: 'delegate' } as never)
  await spawn($, 'a')
  await report($, 'a', 2, 8)
  const source = (await desktop($))?.source ?? ''
  const fill = Math.round((barW(source) * 2) / 8)
  const ticks = [.../<g class="tk">(.*?)<\/g>/.exec(source)?.[1]?.matchAll(/<rect x="([\d.-]+)"/g) ?? []].map(m => Number(m[1]))
  expect(ticks.length).toBe(5)
  expect(ticks.every(x => x >= fill + 4)).toBe(true)
})

test('steps: a plan slot with no run draws no dots of its own', async ($, on) => {
  session(on)
  await $.tool.call({ tool: PROGRESS, title: 'Ship it', total: 2, phase: 'delegate' } as never)
  await spawn($, 'a')
  await report($, 'a', 1, 4)
  const source = (await desktop($))?.source ?? ''
  expect(source).toContain(`<g fill="${VIOLET}" opacity="0.45">`)
  expect(source).not.toContain(`<g fill="${TEAL}"`)
})

test('steps: with nothing filled the pill sits at the start, violet', async ($, on) => {
  session(on)
  await spawn($, 'a')
  await spawn($, 'b')
  const source = (await desktop($))?.source ?? ''
  expect(Number(/<rect x="([\d.-]+)" width="\d+" height="16" rx="8" fill=/.exec(source)?.[1])).toBe(0)
  expect(pillColor(source)).toBe(VIOLET)
})
