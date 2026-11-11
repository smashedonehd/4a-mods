import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

// The main agent's avatar at the top of the pane: a persona read from the
// folder the chat runs in, in a pose that follows what the main loop does.

const PLUGIN = 'savvy-progress'
const pane = { title: '', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const

function session(on: On, root: string | (() => string)) {
  on('clock.now', () => ({ value: Date.parse('2026-11-11T10:00:00Z') }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.root', () => ({ value: typeof root === 'string' ? root : root() }) as never)
  on('agent.spawn', (_$, e) => ({ model: 'claude-opus-5-5', agentId: (e as { tool_use_id: string }).tool_use_id }) as never)
  on('turn.start', () => ({ turnId: 'turn' }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('tool.call', () => ({ result: 'ok' }) as never)
  on('turn.step', async function* () {
    return { turnId: 'turn', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: { model: 'claude-opus-5-5', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never
  })
}

// One model request of the main loop, or of a subagent
const modelStep = async ($: Engine, agentId?: string) => {
  const stream = ($.turn.step as (e: unknown) => AsyncIterable<unknown>)({ turnId: 'turn', index: 0, model: 'claude-opus-5-5', messageCount: 1, ...(agentId ? { agentId } : {}) })
  for await (const _ of stream) void _
}

// The avatar row: its persona and pose classes and what it says
async function boss($: Engine): Promise<{ persona: string; pose: string; alt: string }> {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: 'savvy-agents', props: pane })
  const row = (await ui.findAll({ type: 'Svg' })).find(el => /class="av /.test(String(el.props.source)))
  await ui.unmount()
  const m = /class="av p-([a-z]+) a-([a-z]+)"/.exec(String(row?.props.source))
  return { pose: m?.[1] ?? '', persona: m?.[2] ?? '', alt: String(row?.props.alt ?? '') }
}

const startTurn = ($: Engine, agentId?: string) => ($.turn.start as (e: unknown) => Promise<unknown>)({ turnId: 'turn', ...(agentId ? { agentId } : {}) })
const endTurn = ($: Engine, agentId?: string) => ($.turn.complete as (e: unknown) => Promise<unknown>)({ ...(agentId ? { agentId } : {}), reason: 'answer', answer: 'ok' })
const callTool = ($: Engine, tool: string, agentId?: string) => $.tool.call({ tool, ...(agentId ? { agentId } : {}) } as never)

test('the avatar wears the persona of the folder the chat runs in', async ($, on) => {
  const cases: [string, string, string][] = [
    ['D:\\ClaudeWork\\john-watson', 'watson', 'John Watson'],
    ['D:\\ClaudeWork\\Lisa Stark\\agent', 'lisa', 'Lisa Stark'],
    ['D:\\ClaudeWork\\Stark', 'lisa', 'Lisa Stark'],
    ['D:/ClaudeWork/greg-publisher/.claude/worktrees/x', 'greg', 'Greg'],
    ['D:\\ClaudeWork\\irene-adler', 'irene', 'Irene Adler'],
    ['D:\\ClaudeWork\\claude-code-mods', 'claude', 'Claude'],
    // A folder that only contains a persona's name is not its project
    ['D:\\ClaudeWork\\lisa-starkish', 'claude', 'Claude'],
  ]
  let root = ''
  session(on, () => root)
  for (const [path, persona, name] of cases) {
    root = path
    const b = await boss($)
    expect([path, b.persona]).toEqual([path, persona])
    expect(b.alt.startsWith(`${name}: `)).toBe(true)
  }
})

test('the main loop sets the pose: a turn thinks, an edit works, the end waits', async ($, on) => {
  session(on, 'D:\\ClaudeWork\\john-watson')
  // Nothing happened yet: waiting for the person
  expect((await boss($)).pose).toBe('wait')
  await startTurn($)
  expect((await boss($)).pose).toBe('think')
  await callTool($, 'Edit')
  expect((await boss($)).pose).toBe('write')
  await callTool($, 'Read')
  expect((await boss($)).pose).toBe('think')
  await callTool($, 'Bash')
  expect((await boss($)).pose).toBe('write')
  // The next model request thinks again, a subagent's does not
  await modelStep($, 'a1')
  expect((await boss($)).pose).toBe('write')
  await modelStep($)
  expect((await boss($)).pose).toBe('think')
  await callTool($, 'PowerShell')
  expect((await boss($)).pose).toBe('write')
  await callTool($, 'Task')
  expect((await boss($)).pose).toBe('delegate')
  await endTurn($)
  const b = await boss($)
  expect(b.pose).toBe('wait')
  expect(b.alt).toBe('John Watson: waiting for you')
})

test('a subagent moves nothing; while one runs the main agent hands out tasks', async ($, on) => {
  session(on, 'D:\\ClaudeWork')
  await startTurn($)
  // A subagent's own turn, tools and end leave the main pose alone
  await startTurn($, 'a1')
  await callTool($, 'Edit', 'a1')
  await endTurn($, 'a1')
  expect((await boss($)).pose).toBe('think')
  // A launch is handing out tasks, and stays so while the subagent runs
  await callTool($, 'Agent')
  expect((await boss($)).pose).toBe('delegate')
  await $.agent.spawn({ tool_use_id: 't1', prompt: 'p', description: 'Task t1', subagentType: 'general-purpose', provider: 'engine', parentModel: 'claude-opus-5-5', background: true, fork: false } as never)
  await callTool($, 'Read')
  expect((await boss($)).pose).toBe('delegate')
  // The main turn ends: the person is asked, even with a worker still out
  await endTurn($)
  expect((await boss($)).pose).toBe('wait')
  // A subagent starting a turn of its own does not wake the main agent
  await startTurn($, 't1')
  expect((await boss($)).pose).toBe('wait')
})

test('the dotted grid is as tall as the avatar row plus the rest', async ($, on) => {
  session(on, 'D:\\ClaudeWork')
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: 'savvy-agents', props: pane })
  const svgs = await ui.findAll({ type: 'Svg' })
  await ui.unmount()
  const grid = svgs.filter(el => el.props.alt === 'dotted grid').reduce((h, el) => h + Number(el.props.height), 0)
  const rows = svgs.filter(el => el.props.alt !== 'dotted grid').reduce((h, el) => h + Number(el.props.height), 0)
  // Empty pane: the avatar, the header and two text lines (the button, the empty note)
  expect(rows).toBe(74 + 44)
  expect(grid).toBe(rows + 2 * 24)
})
