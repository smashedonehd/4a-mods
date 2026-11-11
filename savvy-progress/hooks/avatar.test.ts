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
}

// The avatar row: its persona and pose classes and what it says
async function boss($: Engine): Promise<{ persona: string; pose: string; alt: string }> {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: 'savvy-agents', props: pane })
  const row = (await ui.findAll({ type: 'Svg' })).find(el => /class="av /.test(String(el.props.source)))
  await ui.unmount()
  const m = /class="av p-([a-z]+) a-([a-z]+)"/.exec(String(row?.props.source))
  return { pose: m?.[1] ?? '', persona: m?.[2] ?? '', alt: String(row?.props.alt ?? '') }
}

const startTurn = ($: Engine, agentId?: string) => ($.turn.start as (e: unknown) => Promise<unknown>)({ ...(agentId ? { agentId } : {}) })
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
})
