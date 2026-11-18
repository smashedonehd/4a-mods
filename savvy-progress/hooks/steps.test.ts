import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
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

const spawn = ($: Engine, id: string) =>
  $.agent.spawn({ tool_use_id: id, prompt: 'p', description: `Task ${id}`, subagentType: 'general-purpose', provider: 'engine', parentModel: 'claude-opus-5-5', background: false, fork: false } as never)

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
const gaps = (source: string) => (source.match(/<rect class="k" x="[\d.-]+" width="2"/g) ?? []).length

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
  expect(gaps(d?.source ?? '')).toBe(1)
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
