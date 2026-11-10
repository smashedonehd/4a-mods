import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

// The band without a reported plan: it draws itself from the subagents of the
// current wave, so a main session that never calls `progress` still shows one.

const PLUGIN = 'savvy-progress'
const PROGRESS = 'mcp__savvy-progress__progress'
const band = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} }
const T0 = Date.parse('2026-11-10T10:00:00Z')

// A session whose clock the test moves, and whose spawns answer with the id asked for
function session(on: On) {
  const clock = { now: T0 }
  on('clock.now', () => ({ value: clock.now }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', (_$, e) => ({ model: 'claude-opus-5-5', agentId: (e as { tool_use_id: string }).tool_use_id }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('turn.step', async function* () {
    return { turnId: 'turn', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: { model: 'claude-opus-5-5', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never
  })
  return clock
}

const spawn = ($: Engine, id: string, subagentType = 'general-purpose') =>
  $.agent.spawn({ tool_use_id: id, prompt: 'p', description: `Task ${id}`, subagentType, provider: 'engine', parentModel: 'claude-opus-5-5', background: false, fork: false } as never)

const finish = ($: Engine, id: string, reason = 'answer') =>
  ($.turn.complete as (e: unknown) => Promise<unknown>)({ agentId: id, reason, answer: 'ok' })

// One model request of a subagent: for a finished one, a follow-up sent to it
const step = async ($: Engine, id: string) => {
  const stream = ($.turn.step as (e: unknown) => AsyncIterable<unknown>)({ turnId: 'turn', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: id })
  for await (const _ of stream) void _
}

const drawn = ($: Engine) => $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: band })

const dismiss = async (ui: Awaited<ReturnType<typeof drawn>>) => {
  await ui.press({ key: 'savvy-dismiss' } as never)
  await ui.unmount()
}

// What the terminal band says: its title and label, or null when no band draws
async function shown($: Engine) {
  const ui = await drawn($)
  const texts = (await ui.findAll({ type: 'Text' })).map(el => String(el.text ?? ''))
  const crew = await ui.find({ key: 'savvy-agents' })
  await ui.unmount()
  if (!crew) return null
  return { title: texts.includes('Subagents'), label: texts.find(t => /^(Tasks \d+\/\d+|Done)$/.test(t)) ?? '' }
}

test('auto band: one subagent draws nothing, the second one draws the band', async ($, on) => {
  session(on)
  expect(await shown($)).toBeNull()
  await spawn($, 'a')
  expect(await shown($)).toBeNull()
  await spawn($, 'b')
  expect(await shown($)).toMatchObject({ title: true, label: 'Tasks 0/2' })
})

test('auto band: finished and failed runs count as done, the last one closes it', async ($, on) => {
  session(on)
  await spawn($, 'a')
  await spawn($, 'b')
  await spawn($, 'c')
  await finish($, 'a')
  expect(await shown($)).toMatchObject({ label: 'Tasks 1/3' })
  await finish($, 'b', 'error')
  expect(await shown($)).toMatchObject({ label: 'Tasks 2/3' })
  await finish($, 'c')
  expect(await shown($)).toMatchObject({ title: true, label: 'Done' })
})

test('auto band: a spawn while others run joins the wave', async ($, on) => {
  const clock = session(on)
  await spawn($, 'a')
  await spawn($, 'b')
  // The run still working is not the last one of the list
  await finish($, 'b')
  clock.now += 60_000
  await spawn($, 'c')
  expect(await shown($)).toMatchObject({ label: 'Tasks 1/3' })
})

// The wave ends when its last run ends, not when that run started
test('auto band: a spawn in the millisecond the wave ended still joins it', async ($, on) => {
  const clock = session(on)
  await spawn($, 'a')
  await spawn($, 'b')
  clock.now += 1000
  await finish($, 'a')
  await finish($, 'b')
  await spawn($, 'c')
  expect(await shown($)).toMatchObject({ label: 'Tasks 2/3' })
})

test('auto band: a finished run that works again joins the current wave, not its old one', async ($, on) => {
  const clock = session(on)
  for (const id of ['a', 'b']) await spawn($, id)
  // A failed run moves as a finished one does
  await finish($, 'a', 'error')
  await finish($, 'b')
  clock.now += 1000
  for (const id of ['c', 'd']) await spawn($, id)
  for (const id of ['c', 'd']) await finish($, id)
  expect(await shown($)).toMatchObject({ label: 'Done' })
  clock.now += 1000
  await step($, 'a')
  expect(await shown($)).toMatchObject({ label: 'Tasks 2/3' })
})

test('auto band: a follow-up to an old run does not bring a dismissed band back', async ($, on) => {
  const clock = session(on)
  for (const id of ['a', 'b']) await spawn($, id)
  for (const id of ['a', 'b']) await finish($, id)
  clock.now += 1000
  for (const id of ['c', 'd']) await spawn($, id)
  await dismiss(await drawn($))
  clock.now += 1000
  await step($, 'a')
  expect(await shown($)).toBeNull()
})

test('auto band: a spawn after everything finished starts a new wave', async ($, on) => {
  const clock = session(on)
  await spawn($, 'a')
  await spawn($, 'b')
  await finish($, 'a')
  await finish($, 'b')
  clock.now += 60_000
  await spawn($, 'c')
  // One run in the new wave: below the minimum, and the old wave no longer counts
  expect(await shown($)).toBeNull()
  await spawn($, 'd')
  expect(await shown($)).toMatchObject({ label: 'Tasks 0/2' })
})

test('auto band: dismissed, it stays away for the rest of the wave and returns with the next', async ($, on) => {
  const clock = session(on)
  await spawn($, 'a')
  await spawn($, 'b')
  await dismiss(await drawn($))
  expect(await shown($)).toBeNull()
  clock.now += 1000
  await spawn($, 'c')
  expect(await shown($)).toBeNull()
  for (const id of ['a', 'b', 'c']) await finish($, id)
  clock.now += 1000
  await spawn($, 'd')
  await spawn($, 'e')
  expect(await shown($)).toMatchObject({ label: 'Tasks 0/2' })
})

test('auto band: dismissing a reported plan clears it', async ($, on) => {
  session(on)
  await $.tool.call({ tool: PROGRESS, title: 'Ship it', total: 5, done: 1, phase: 'delegate' } as never)
  await dismiss(await drawn($))
  expect(await shown($)).toBeNull()
})

test('auto band: a reported plan wins while it is open', async ($, on) => {
  session(on)
  await spawn($, 'a')
  await spawn($, 'b')
  await $.tool.call({ tool: PROGRESS, title: 'Ship it', total: 5, done: 1, phase: 'delegate' } as never)
  expect(await shown($)).toMatchObject({ title: false, label: 'Tasks 1/5' })
})

test('auto band: a running wave shows over a plan that is finished', async ($, on) => {
  const clock = session(on)
  await $.tool.call({ tool: PROGRESS, title: 'Ship it', total: 1, done: 1, finished: true } as never)
  expect(await shown($)).toMatchObject({ title: false, label: 'Done' })
  clock.now += 1000
  await spawn($, 'a')
  await spawn($, 'b')
  expect(await shown($)).toMatchObject({ title: true, label: 'Tasks 0/2' })
  // Both finished: the reported plan's own Done comes back
  await finish($, 'a')
  await finish($, 'b')
  expect(await shown($)).toMatchObject({ title: false, label: 'Done' })
})

test('auto band: the desktop draws it as one Svg with the count in its alt', async ($, on) => {
  session(on)
  await spawn($, 'a')
  await spawn($, 'b')
  await finish($, 'a')
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: band })
  const svg = await ui.findAll({ type: 'Svg' })
  expect(svg.length).toBe(1)
  expect(String(svg[0]?.props.alt)).toBe('Subagents: Tasks 1/2, 50%')
})

// The press dismisses the wave that runs now, not an earlier one
test('auto band: a dismiss hides the wave that runs now, not an earlier one', async ($, on) => {
  const clock = session(on)
  await spawn($, 'a')
  await spawn($, 'b')
  await finish($, 'a')
  await finish($, 'b')
  // Drawn before the new wave begins: the press must still hide the new one
  const ui = await drawn($)
  clock.now += 1000
  await spawn($, 'c')
  await spawn($, 'd')
  await dismiss(ui)
  expect(await shown($)).toBeNull()
})

// Only a finished run moves: one that never stopped keeps its place, and its wave
test('auto band: a run that never stopped keeps its wave together while it works', async ($, on) => {
  const clock = session(on)
  await spawn($, 'a')
  await spawn($, 'b')
  clock.now += 1000
  await finish($, 'b')
  clock.now += 1000
  await spawn($, 'c')
  await finish($, 'c')
  await step($, 'a')
  expect(await shown($)).toMatchObject({ label: 'Tasks 2/3' })
})

// The dismissed wave is named by a run, and a follow-up moves that run: the wave stays hidden
test('auto band: a follow-up to the first run of a dismissed wave keeps it hidden', async ($, on) => {
  session(on)
  await spawn($, 'a')
  await spawn($, 'b')
  await finish($, 'a')
  await dismiss(await drawn($))
  await step($, 'a')
  expect(await shown($)).toBeNull()
})

// ---- a subagent this session never saw start (it ran before a /clear) ----------

const pane = { title: '', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const

// What the Agents panel says
async function panelTexts($: Engine) {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'savvy-agents', props: pane })
  const texts = (await ui.findAll({ type: 'Text' })).map(el => String(el.text ?? ''))
  await ui.unmount()
  return texts.join(' | ')
}

// The engine's own list of agents: the ids it names, with a description each.
// An id written `x:completed` stands at that status; the others run.
const listed = (on: On, ...ids: string[]) =>
  on('agent.list', () => ({ value: ids.map(s => s.split(':')).map(([id, status = 'running']) => ({ id, description: `Old ${id}`, type: 'general-purpose', status })) }) as never)

const cleared = ($: Engine) => ($.classic.SessionStart as (e: unknown) => Promise<unknown>)({ source: 'clear' })

test('unseen: a step of a listed subagent that never spawned here founds its run', async ($, on) => {
  session(on)
  listed(on, 'x')
  expect(await panelTexts($)).toContain('No subagents yet.')
  await step($, 'x')
  const texts = await panelTexts($)
  expect(texts).not.toContain('No subagents yet.')
  expect(texts).toContain('Old x')
  // Its first request is counted: 2 tokens, not 0
  expect(texts).toContain('· 2 tokens ·')
})

test('unseen: two of them make a wave, and their ends close it', async ($, on) => {
  session(on)
  listed(on, 'x', 'y')
  await step($, 'x')
  expect(await shown($)).toBeNull()
  await step($, 'y')
  // A second step of the same one founds nothing more
  await step($, 'x')
  expect(await shown($)).toMatchObject({ title: true, label: 'Tasks 0/2' })
  await finish($, 'x')
  expect(await shown($)).toMatchObject({ label: 'Tasks 1/2' })
  await finish($, 'y')
  expect(await shown($)).toMatchObject({ label: 'Done' })
})

test('unseen: one that ends before any step was seen shows as finished', async ($, on) => {
  session(on)
  listed(on, 'x', 'y')
  await step($, 'y')
  await finish($, 'x')
  expect(await shown($)).toMatchObject({ label: 'Tasks 1/2' })
})

test('unseen: an id the engine does not list (its own fork, a workflow agent) gets no run', async ($, on) => {
  session(on)
  listed(on, 'x')
  await step($, 'fork-1')
  await finish($, 'fork-2')
  expect(await panelTexts($)).toContain('No subagents yet.')
})

test('unseen: a list that fails founds nothing and breaks nothing', async ($, on) => {
  session(on)
  on('agent.list', () => {
    throw new Error('no list')
  })
  await step($, 'x')
  expect(await panelTexts($)).toContain('No subagents yet.')
})

test('unseen: a spawned subagent is not founded a second time', async ($, on) => {
  session(on)
  listed(on, 'a', 'b')
  await spawn($, 'a')
  await step($, 'a')
  await step($, 'b')
  expect(await shown($)).toMatchObject({ label: 'Tasks 0/2' })
  // A spawn answered with a founded run's id takes its place
  await spawn($, 'b')
  expect(await shown($)).toMatchObject({ label: 'Tasks 0/2' })
})

test('unseen: a /clear gives the agents still at work a run at once, and the ended ones none', async ($, on) => {
  session(on)
  on('classic.SessionStart', () => ({}) as never)
  listed(on, 'x', 'y:waiting', 'z:completed', 'w:idle')
  await cleared($)
  const texts = await panelTexts($)
  expect(texts).toContain('Old x')
  expect(texts).toContain('Old y')
  expect(texts).not.toContain('Old z')
  expect(texts).not.toContain('Old w')
  expect(await shown($)).toMatchObject({ title: true, label: 'Tasks 0/2' })
  // The first request of one names its model and founds nothing more
  await step($, 'x')
  expect(await shown($)).toMatchObject({ label: 'Tasks 0/2' })
  expect(await panelTexts($)).toContain('Opus 5.5')
})

test('unseen: a /clear keeps the runs the list still has, and survives a list that fails', async ($, on) => {
  session(on)
  on('classic.SessionStart', () => ({}) as never)
  let fails = false
  on('agent.list', () => {
    if (fails) throw new Error('no list')
    return { value: [{ id: 'a', description: 'Task a', type: 'general-purpose', status: 'running' }] } as never
  })
  await spawn($, 'a')
  await spawn($, 'b')
  await cleared($)
  expect(await shown($)).toMatchObject({ label: 'Tasks 0/2' })
  fails = true
  await cleared($)
  expect(await shown($)).toMatchObject({ label: 'Tasks 0/2' })
})
