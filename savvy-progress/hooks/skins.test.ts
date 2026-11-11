import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

// Each crab in the pane wears a costume: a savvy tier's, else one for the
// agent's role read from its name, else the tier its model and effort match.

const PLUGIN = 'savvy-progress'
const pane = { title: '', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const

function session(on: On, model = 'claude-opus-5-5') {
  on('clock.now', () => ({ value: Date.parse('2026-11-10T10:00:00Z') }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', (_$, e) => ({ model, agentId: (e as { tool_use_id: string }).tool_use_id }) as never)
}

const spawn = ($: Engine, id: string, subagentType: string) =>
  $.agent.spawn({ tool_use_id: id, prompt: 'p', description: `Task ${id}`, subagentType, provider: 'engine', parentModel: 'claude-opus-5-5', background: false, fork: false } as never)

// The costume classes the pane's crabs are drawn with, in order
async function costumes($: Engine): Promise<string[]> {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: 'savvy-agents', props: pane })
  const svg = (await ui.findAll({ type: 'Svg' })).map(el => String(el.props.source)).join('')
  await ui.unmount()
  return [...svg.matchAll(/class="c-([a-z]+)/g)].map(m => m[1] as string)
}

test('desktop pane: an agent named for its role wears that role', async ($, on) => {
  session(on)
  const worn: [string, string][] = [
    ['lisa-reviewer', 'judge'], ['lisa-stark', 'accountant'], ['irene-factcheck', 'factcheck'], ['irene-writer', 'writer'],
    ['john-watson', 'analyst'], ['greg', 'photographer'], ['caveman:cavecrew-builder', 'caveman'], ['Plan', 'architect'],
    ['web-fetch', 'courier'], ['Explore', 'explore'], ['savvy-careful', 'careful'],
    // Names that only look like a role keep the model's costume
    ['artifact-builder', 'medium'], ['writing-plans', 'medium'],
  ]
  for (const [i, [t]] of worn.entries()) await spawn($, `a${i}`, t)
  // One crab per run, newest first as the pane lists them
  expect(await costumes($)).toEqual(worn.map(([, c]) => c).reverse())
})

test('desktop pane: the judge holds its gavel, not the bare crab', async ($, on) => {
  session(on)
  await spawn($, 'j1', 'lisa-reviewer')
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: 'savvy-agents', props: pane })
  const svg = (await ui.findAll({ type: 'Svg' })).map(el => String(el.props.source)).join('')
  await ui.unmount()
  // The gavel's head, in the judge's walnut
  expect(svg).toContain('fill="#7A4A26"')
})

test('desktop pane: an agent with no role wears the tier its model matches', async ($, on) => {
  session(on, 'claude-sonnet-5-5')
  await spawn($, 'g1', 'general-purpose')
  expect(await costumes($)).toContain('light')
})

test('desktop pane: Opus with no effort seen cooks, as Opus medium does', async ($, on) => {
  session(on)
  await spawn($, 'g2', 'general-purpose')
  expect(await costumes($)).toContain('medium')
})
