import { expect, test } from 'claude-code/testing'

// The hooks' wiring against the engine; the shipped routing.json and the
// decisions themselves are checked by route.test.mjs under plain node.
const TABLE = {
  schema: 2,
  updated: '2026-10-24',
  models: {
    haiku: { id: 'h', efforts: ['low', 'medium'] },
    opus: { id: 'o', efforts: ['low', 'medium', 'high'] },
    fable: { id: 'f', efforts: ['high'] },
  },
  tiers: {
    quick: { model: 'haiku', effort: 'low', description: 'Quick lookups and other read-only answers.' },
    deep: { model: 'opus', effort: 'high', description: 'Hard engineering, architecture and reviews.' },
    frontier: { model: 'fable', effort: 'high', description: 'Only after Opus fell short on the same task.' },
  },
  order: ['quick', 'deep', 'frontier'],
  frontier: 'frontier',
  fill: { model: 'opus', effort: 'medium', types: ['general-purpose', ''] },
  builtinTypes: { Explore: 'quick' },
}

function engine(on: any, seen: any[], agents: any[], tableText = JSON.stringify(TABLE), stored: Record<string, any> = {}) {
  const store = new Map<string, any>(Object.entries(stored))
  on('command.register', () => ({ value: { command: 'route' } }))
  on('agent.register', (_: any, e: any) => {
    agents.push(e)
    return { value: { agent: `model-router:${e.name}` } }
  })
  on('fs.read', () => ({ value: tableText }))
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('clock.now', () => ({ value: Date.parse('2026-10-25T00:00:00Z') }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('agent.offer', () => ({ isOffered: true }))
  on('tool.call', (_: any, e: any) => {
    seen.push(e)
    return { result: {} }
  })
}

test('each tier is registered as an agent type with its model and effort', async ($, on) => {
  const seen: any[] = []
  const agents: any[] = []
  engine(on, seen, agents)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(agents.map((a) => [a.name, a.model, a.effort])).toEqual([
    ['quick', 'haiku', 'low'],
    ['deep', 'opus', 'high'],
    ['frontier', 'fable', 'high'],
  ])
})

test('an unset general agent gets Opus at medium, a tier type is left alone', async ($, on) => {
  const seen: any[] = []
  engine(on, seen, [])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'Dokážeš najít, proč padá test?' })
  await $.tool.call({ tool: 'Agent', description: 't', prompt: 'look', subagent_type: 'model-router:quick' })
  expect([seen[0].model, seen[0].effort]).toEqual(['opus', 'medium'])
  expect([seen[1].model, seen[1].effort]).toEqual([undefined, undefined])
  expect(seen[1].subagent_type).toBe('model-router:quick')
})

test('a general agent given only a model runs at that model\'s tier effort', async ($, on) => {
  const seen: any[] = []
  engine(on, seen, [])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'x', model: 'opus' })
  await $.tool.call({ tool: 'Agent', description: 'b', prompt: 'x', model: 'opus', effort: 'low' })
  expect([seen[0].model, seen[0].effort]).toEqual(['opus', 'high'])
  expect([seen[1].model, seen[1].effort]).toEqual(['opus', 'low'])
})

test('a model without a tier is kept, a fork is left alone, Explore gets its tier', async ($, on) => {
  const seen: any[] = []
  engine(on, seen, [])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'x', model: 'sonnet' })
  await $.tool.call({ tool: 'Agent', description: 'f', prompt: 'x', subagent_type: 'fork' })
  await $.tool.call({ tool: 'Agent', description: 'e', prompt: 'x', subagent_type: 'Explore' })
  expect([seen[0].model, seen[0].effort]).toEqual(['sonnet', undefined])
  expect(seen[1].model).toBe(undefined)
  expect([seen[2].model, seen[2].effort]).toEqual(['haiku', 'low'])
})

test('a broken table leaves every call as it came', async ($, on) => {
  const seen: any[] = []
  engine(on, seen, [], '{"schema": 1}')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'x' })
  expect(seen[0].model).toBe(undefined)
})

test('plain /route caps at Opus, /route fable opens Fable, and /route goes back', async ($, on) => {
  const seen: any[] = []
  engine(on, seen, [])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Agent', description: 'a', prompt: 'x', model: 'fable' })
  expect([seen[0].model, seen[0].effort]).toEqual(['opus', 'high'])
  const open = await $.command.run({ command: 'route', args: 'fable' })
  expect(String(open.text)).toContain('haiku → fable')
  await $.tool.call({ tool: 'Agent', description: 'b', prompt: 'x', model: 'fable' })
  expect(seen[1].model).toBe('fable')
  const back = await $.command.run({ command: 'route', args: '' })
  expect(String(back.text)).toContain('haiku → opus')
  await $.tool.call({ tool: 'Agent', description: 'c', prompt: 'x', subagent_type: 'model-router:frontier' })
  expect([seen[2].subagent_type, seen[2].model, seen[2].effort]).toEqual(['model-router:deep', 'opus', 'high'])
})

const offer = (agent: string) => ({ agent, description: 'd', source: 'plugin', provider: { plugin: 'model-router', tier: 'user' } })

test('plain /route hides the frontier type from the listing and dispatch, /route fable offers it', async ($, on) => {
  engine(on, [], [])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((await $.agent.offer(offer('model-router:frontier'))).isOffered).toBe(false)
  expect((await $.agent.offer(offer('model-router:deep'))).isOffered).toBe(true)
  await $.command.run({ command: 'route', args: 'fable' })
  expect((await $.agent.offer(offer('model-router:frontier'))).isOffered).toBe(true)
})

test('the stored range is read at the start', async ($, on) => {
  const seen: any[] = []
  engine(on, seen, [], JSON.stringify(TABLE), { settings: { fill: true, ceiling: 'fable' } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Agent', description: 'a', prompt: 'x', model: 'fable' })
  expect(seen[0].model).toBe('fable')
})

test('a stored range the router does not know falls back to Opus', async ($, on) => {
  const seen: any[] = []
  engine(on, seen, [], JSON.stringify(TABLE), { settings: { fill: true, ceiling: 'bogus' } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Agent', description: 'a', prompt: 'x', model: 'fable' })
  expect(seen[0].model).toBe('opus')
  expect((await $.agent.offer(offer('model-router:frontier'))).isOffered).toBe(false)
})

test('with the safety net off a Fable call is still capped', async ($, on) => {
  const seen: any[] = []
  engine(on, seen, [])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'route', args: 'fill off' })
  await $.tool.call({ tool: 'Agent', description: 'a', prompt: 'x', model: 'fable' })
  await $.tool.call({ tool: 'Agent', description: 'b', prompt: 'x' })
  expect([seen[0].model, seen[0].effort]).toEqual(['opus', 'high'])
  expect(seen[1].model).toBe(undefined)
})

test('/route fill off leaves every call as it came except the Opus cap', async ($, on) => {
  const seen: any[] = []
  engine(on, seen, [])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const off = await $.command.run({ command: 'route', args: 'fill off' })
  expect(String(off.text)).toContain('safety net: off')
  await $.tool.call({ tool: 'Agent', description: 'a', prompt: 'x', model: 'opus' })
  await $.tool.call({ tool: 'Agent', description: 'b', prompt: 'x' })
  await $.tool.call({ tool: 'Agent', description: 'e', prompt: 'x', subagent_type: 'Explore' })
  await $.tool.call({ tool: 'Agent', description: 'c', prompt: 'x', model: 'fable' })
  expect([seen[0].model, seen[0].effort]).toEqual(['opus', undefined])
  expect([seen[1].model, seen[1].effort]).toEqual([undefined, undefined])
  expect([seen[2].model, seen[2].effort]).toEqual([undefined, undefined])
  expect([seen[3].model, seen[3].effort]).toEqual(['opus', 'high'])
  const status = await $.command.run({ command: 'route', args: '' })
  expect(String(status.text)).toContain('4 Agent calls (keep 3, capped 1)')
  const back = await $.command.run({ command: 'route', args: 'fill on' })
  expect(String(back.text)).toContain('safety net: on')
})
