import { expect, test } from 'claude-code/testing'

// The hooks' wiring against the engine; the shipped routing.json and the
// decisions themselves are checked by route.test.mjs under plain node.
const TABLE = {
  schema: 3,
  updated: '2026-10-24',
  models: {
    haiku: { id: 'h', efforts: ['low', 'medium'], price: { in: 0.1, out: 0.5 } },
    opus: { id: 'o', efforts: ['low', 'medium', 'high'], price: { in: 4, out: 20 } },
    fable: { id: 'f', efforts: ['high'], price: { in: 10, out: 50 } },
  },
  costModel: { inputShare: 0.8, effort: { low: 0.5, medium: 1, high: 1.6, xhigh: 2.5, max: 4 } },
  categories: ['search', 'implement', 'review', 'security', 'architecture', 'other'],
  critical: ['review', 'security', 'architecture'],
  rules: [{ floor: 'deep', categories: ['review', 'security', 'architecture'], match: '\\breview' }],
  router: { policy: 'text', default: 'off', model: 'haiku', effort: 'low', timeoutMs: 8000, jev: { model: 'jev-1.13.0', theta: 0.8 } },
  thresholds: { agreement: 0.95, under: 0.01, underCritical: 0, costOver: 0.15 },
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
  return store
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
  const store = engine(on, seen, [], JSON.stringify(TABLE), { settings: { fill: true, ceiling: 'bogus' } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Agent', description: 'a', prompt: 'x', model: 'fable' })
  expect(seen[0].model).toBe('opus')
  // The next save writes the fallback back, so the unknown range does not stay stored
  await $.command.run({ command: 'route', args: 'fill on' })
  expect(store.get('settings').ceiling).toBe('opus')
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

test('/route fill without on or off is not an option and changes nothing', async ($, on) => {
  const seen: any[] = []
  const store = engine(on, seen, [])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'route', args: 'fill' })
  expect(String(r.text)).toContain('Not an option: /route fill.')
  expect(String(r.text)).toContain('safety net on')
  expect(store.get('settings')).toBe(undefined)
})

// Auto routing: the same table with the router on by default
const AUTO = { ...TABLE, router: { ...TABLE.router, default: 'on' } }
const answered = (text: string) => ({ value: { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1 } } })

function router(on: any, reply: any, count = { n: 0 }) {
  on('model.complete', () => {
    count.n++
    return typeof reply === 'function' ? reply() : reply
  })
  return count
}

test('auto routing sends a general agent to the tier the router names', async ($, on) => {
  const seen: any[] = []
  engine(on, seen, [], JSON.stringify(AUTO))
  router(on, answered('{"category":"search","tier":"quick"}'))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Agent', description: 'find', prompt: 'find the config' })
  expect([seen[0].model, seen[0].effort]).toEqual(['haiku', 'low'])
})

test('auto routing moves a tier type to the routed type', async ($, on) => {
  const seen: any[] = []
  engine(on, seen, [], JSON.stringify(AUTO))
  router(on, answered('{"category":"search","tier":"quick"}'))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Agent', description: 'find', prompt: 'x', subagent_type: 'model-router:deep' })
  expect([seen[0].subagent_type, seen[0].model, seen[0].effort]).toEqual(['model-router:quick', 'haiku', 'low'])
})

test('a fork is never routed and the router is not asked', async ($, on) => {
  const seen: any[] = []
  engine(on, seen, [], JSON.stringify(AUTO))
  const count = router(on, answered('{"category":"search","tier":"quick"}'))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Agent', description: 'f', prompt: 'x', subagent_type: 'fork' })
  expect(count.n).toBe(0)
  expect(seen[0].model).toBe(undefined)
})

test('a failed, empty or out-of-range router reply falls back to the safety net', async ($, on) => {
  const seen: any[] = []
  engine(on, seen, [], JSON.stringify(AUTO))
  const replies = [
    { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: {} } },
    answered('frontier'),
    answered('{"tier":"frontier"}'),
    answered(''),
  ]
  let i = 0
  router(on, () => replies[i++])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (let k = 0; k < replies.length; k++) await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'x' })
  expect(seen.map((s) => [s.model, s.effort])).toEqual(replies.map(() => ['opus', 'medium']))
})

test('a router call that is refused falls back to the safety net', async ($, on) => {
  const seen: any[] = []
  engine(on, seen, [], JSON.stringify(AUTO))
  router(on, () => ({ deny: 'refused' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'x' })
  expect([seen[0].model, seen[0].effort]).toEqual(['opus', 'medium'])
})

test('under /route fable the frontier type stays manual', async ($, on) => {
  const seen: any[] = []
  engine(on, seen, [], JSON.stringify(AUTO))
  const count = router(on, answered('{"category":"search","tier":"quick"}'))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'route', args: 'fable' })
  await $.tool.call({ tool: 'Agent', description: 'f', prompt: 'x', subagent_type: 'model-router:frontier' })
  expect(count.n).toBe(0)
  expect([seen[0].subagent_type, seen[0].model]).toEqual(['model-router:frontier', undefined])
})

test("/route auto off restores today's router and survives a new session", async ($, on) => {
  const seen: any[] = []
  const store = engine(on, seen, [], JSON.stringify(AUTO))
  const count = router(on, answered('{"category":"search","tier":"quick"}'))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const off = await $.command.run({ command: 'route', args: 'auto off' })
  expect(String(off.text)).toContain('Auto routing: off')
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'x' })
  expect([seen[0].model, seen[0].effort]).toEqual(['opus', 'medium'])
  expect(count.n).toBe(0)
  expect(store.get('settings').auto).toBe(false)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'x' })
  expect(count.n).toBe(0)
  const back = await $.command.run({ command: 'route', args: 'auto on' })
  expect(String(back.text)).toContain('Auto routing: on')
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'x' })
  expect([seen[2].model, seen[2].effort]).toEqual(['haiku', 'low'])
})

test('with the table default off, nothing is routed until /route auto on', async ($, on) => {
  const seen: any[] = []
  engine(on, seen, [])
  const count = router(on, answered('{"category":"search","tier":"quick"}'))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'x' })
  expect(count.n).toBe(0)
  expect(String((await $.command.run({ command: 'route', args: '' })).text)).toContain('Auto routing: off (policy text, router haiku low)')
})

test('the rules policy lifts a review to deep', async ($, on) => {
  const seen: any[] = []
  engine(on, seen, [], JSON.stringify({ ...AUTO, router: { ...AUTO.router, policy: 'rules' } }))
  router(on, answered('{"category":"search","tier":"quick"}'))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Agent', description: 'Review Task 3', prompt: 'x' })
  expect([seen[0].model, seen[0].effort]).toEqual(['opus', 'high'])
})

const JEV = JSON.stringify({ ...AUTO, router: { ...AUTO.router, policy: 'jev' } })

test('the jev policy routes by probabilities', async ($, on) => {
  const seen: any[] = []
  const calls: any[] = []
  engine(on, seen, [], JEV)
  on('env.get', (_: any, e: any) => ({ value: e.name === 'TYPESAFE_API_KEY' ? 'k' : undefined }))
  on('http.fetch', (_: any, e: any) => {
    calls.push(e)
    return { value: { ok: true, status: 200, headers: {}, text: '{"answers":{"tier":{"probabilities":{"quick":0.9,"deep":0.1}}}}' } }
  })
  on('clock.sleep', () => new Promise(() => {}))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'x' })
  expect([seen[0].model, seen[0].effort]).toEqual(['haiku', 'low'])
  expect(calls[0].url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(calls[0].init.headers.authorization).toBe('Bearer k')
})

test('the jev policy without a key, or with a slow proxy, falls back', async ($, on) => {
  const seen: any[] = []
  let key: string | undefined
  let fetched = 0
  engine(on, seen, [], JEV)
  on('env.get', (_: any, e: any) => ({ value: e.name === 'TYPESAFE_API_KEY' ? key : undefined }))
  on('http.fetch', () => {
    fetched++
    return new Promise(() => {})
  })
  on('clock.sleep', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'x' })
  expect(fetched).toBe(0)
  key = 'k'
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'x' })
  expect(fetched).toBe(1)
  expect(seen.map((s) => [s.model, s.effort])).toEqual([['opus', 'medium'], ['opus', 'medium']])
})
