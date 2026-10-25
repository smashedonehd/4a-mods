// Run: node model-router/test/route.test.mjs
// Checks the shipped routing.json and the router's decision for each kind of Agent call.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { invalidTable, agentSpecs, planAgentCall, isFrontier, policyText, countDecision, ageDays, offeredTiers, capTier, capPlan, tierOfType, routableTiers, blindView, tierTable, routerRequest, parseRouterReply, applyRules, jevRequest, pickJevTier, routedPlan, routesCall, policyTier, askOf, weaker, autoTier } from '../hooks/route.mjs'

const table = JSON.parse(readFileSync(new URL('../routing.json', import.meta.url), 'utf8'))
const P = 'model-router'
let n = 0
function check(name, fn) {
  fn()
  n++
  console.log(`ok ${n} ${name}`)
}

check('the shipped table is valid', () => assert.equal(invalidTable(table), ''))

check('tiers rise from Haiku to Fable', () => {
  const rank = { haiku: 0, sonnet: 1, opus: 2, fable: 3 }
  const ranks = table.order.map((t) => rank[table.tiers[t].model])
  assert.deepEqual([...ranks].sort((a, b) => a - b), ranks)
  assert.equal(table.tiers[table.frontier].model, 'fable')
})

check('the default for an unset general agent is Opus at medium effort', () => {
  assert.deepEqual([table.fill.model, table.fill.effort], ['opus', 'medium'])
})

check('long autonomous runs stay on Opus, not Sonnet', () => {
  assert.deepEqual([table.tiers.long.model, table.tiers.long.effort], ['opus', 'xhigh'])
})

check('one agent type per tier, each with model, effort and a prompt', () => {
  const specs = agentSpecs(table)
  assert.equal(specs.length, table.order.length)
  for (const s of specs) {
    assert.match(s.name, /^[a-z][a-z0-9-]*$/)
    assert.ok(s.model && s.effort && s.prompt.length > 100 && s.description.length > 20)
  }
})

check('a tier type is left to its own definition', () => {
  const p = planAgentCall(table, P, { subagent_type: 'model-router:deep', prompt: 'x' })
  assert.equal(p.action, 'typed')
  assert.equal(p.set, undefined)
  assert.equal(p.model, 'opus')
})

check('an unset general agent gets the default', () => {
  for (const type of [undefined, '', 'general-purpose', 'claude']) {
    const p = planAgentCall(table, P, { subagent_type: type, prompt: 'Proveď refaktoring modulu auth' })
    assert.equal(p.action, 'fill')
    assert.deepEqual(p.set, { model: 'opus', effort: 'medium' })
  }
})

check('Czech prompts are never read: "Proveď" and "Dokážeš" no longer reach Fable', () => {
  for (const prompt of ['Proveď refaktoring modulu auth na ESM', 'Dokážeš najít, proč padá test?', 'Plánovač úloh: přidej pauzu']) {
    const p = planAgentCall(table, P, { subagent_type: 'general-purpose', prompt })
    assert.equal(isFrontier(table, p), false)
    assert.equal(p.model, 'opus')
  }
})

check('a model and effort Claude set, or an effort alone, is kept', () => {
  assert.equal(planAgentCall(table, P, { model: 'sonnet', effort: 'high', prompt: 'x' }).action, 'keep')
  assert.equal(planAgentCall(table, P, { effort: 'high', prompt: 'x' }).action, 'keep')
  const typed = planAgentCall(table, P, { subagent_type: 'model-router:quick', model: 'opus' })
  assert.deepEqual([typed.action, typed.tier, typed.set], ['keep', '', undefined])
  // The frontier type given a model below it keeps that model; only the hidden type moves
  const e = { subagent_type: 'model-router:frontier', model: 'sonnet' }
  const frontier = capPlan(table, P, e, planAgentCall(table, P, e), 'opus')
  assert.deepEqual([frontier.model, frontier.set], ['sonnet', { subagent_type: 'model-router:long' }])
})

check('a model Claude set without an effort runs at the effort of that model\'s first tier', () => {
  const want = { haiku: 'low', sonnet: 'medium', opus: 'high', fable: 'high' }
  for (const [model, effort] of Object.entries(want)) {
    for (const type of [undefined, 'general-purpose']) {
      const p = planAgentCall(table, P, { subagent_type: type, model, prompt: 'x' })
      assert.deepEqual([p.action, p.model, p.effort, p.set], ['effort', model, effort, { effort }])
    }
  }
  assert.deepEqual(planAgentCall(table, P, { subagent_type: 'Explore', model: 'sonnet' }).set, { effort: 'medium' })
  assert.equal(planAgentCall(table, P, { model: 'gpt-x' }).action, 'keep')
  assert.equal(planAgentCall(table, P, { subagent_type: 'opus-high', model: 'sonnet' }).action, 'keep')
})

check('with the safety net off a general or built-in call is kept, and a Fable call is still capped', () => {
  for (const e of [{ prompt: 'x' }, { subagent_type: 'Explore' }, { model: 'sonnet' }]) {
    const p = planAgentCall(table, P, e, false)
    assert.deepEqual([p.action, p.tier, p.set], ['keep', '', undefined])
  }
  assert.equal(planAgentCall(table, P, { subagent_type: 'model-router:quick' }, false).action, 'typed')
  assert.deepEqual(capPlan(table, P, { model: 'fable' }, planAgentCall(table, P, { model: 'fable' }, false), 'opus').set, { model: 'opus', effort: 'xhigh' })
})

check('a fork and a custom agent keep their own model', () => {
  assert.equal(planAgentCall(table, P, { subagent_type: 'fork' }).action, 'keep')
  assert.equal(planAgentCall(table, P, { subagent_type: 'opus-high' }).action, 'keep')
  assert.equal(planAgentCall(table, P, { subagent_type: 'other-plugin:deep' }).action, 'keep')
})

check('built-in types the table maps get their tier', () => {
  const p = planAgentCall(table, P, { subagent_type: 'Explore' })
  assert.deepEqual([p.action, p.model, p.effort], ['builtin', 'haiku', 'low'])
  assert.equal(planAgentCall(table, P, { subagent_type: 'Plan' }).model, 'opus')
})

check('the frontier tier is recognised by type and by model', () => {
  assert.equal(isFrontier(table, planAgentCall(table, P, { subagent_type: 'model-router:frontier' })), true)
  assert.equal(isFrontier(table, planAgentCall(table, P, { model: 'fable' })), true)
  assert.equal(isFrontier(table, planAgentCall(table, P, { subagent_type: 'model-router:long' })), false)
})

check('the policy under /route fable names every type and the frontier rule', () => {
  const text = policyText(table, P, 'fable')
  for (const t of table.order) assert.ok(text.includes(`${P}:${t}`))
  assert.match(text, /only as its description says/)
})

check('the Opus ceiling (plain /route) offers Haiku up to Opus only', () => {
  const tiers = offeredTiers(table, 'opus')
  assert.ok(!tiers.includes('frontier'))
  assert.deepEqual([...new Set(tiers.map((t) => table.tiers[t].model))], ['haiku', 'sonnet', 'opus'])
  assert.equal(capTier(table), 'long')
  assert.deepEqual(offeredTiers(table, 'fable'), table.order)
  const text = policyText(table, P, 'opus')
  assert.ok(!text.includes(`${P}:frontier`))
  assert.match(text, /fable is switched off/)
  assert.match(text, /naming the fable type moves to model-router:long; a call with model fable and any other type keeps that type and runs on opus/)
})

check('under the Opus ceiling a Fable call runs on Opus xhigh; under /route fable it stays', () => {
  const cap = (e, ceiling = 'opus') => capPlan(table, P, e, planAgentCall(table, P, e), ceiling)
  // A bare `model: 'fable'` still gets the frontier tier's effort; the frontier type carries its own
  const fable = { effort: 'high' }
  for (const [e, set] of [[{ model: 'fable' }, fable], [{ subagent_type: 'model-router:frontier' }, undefined], [{ subagent_type: 'Explore', model: 'fable' }, fable]]) {
    const capped = cap(e)
    assert.deepEqual([capped.action, capped.tier, capped.model, capped.effort], ['capped', 'long', 'opus', 'xhigh'])
    assert.deepEqual([capped.set.model, capped.set.effort], ['opus', 'xhigh'])
    assert.equal(isFrontier(table, capped), false)
    const open = cap(e, 'fable')
    assert.equal(isFrontier(table, open), true)
    assert.deepEqual(open.set, set)
  }
  const deep = planAgentCall(table, P, { subagent_type: 'model-router:deep' })
  assert.equal(capPlan(table, P, { subagent_type: 'model-router:deep' }, deep, 'opus'), deep)
  assert.equal(cap({ subagent_type: 'model-router:deep', model: 'opus' }).set, undefined)
})

check('the host refuses the hidden frontier type, so a call naming it moves to the cap type', () => {
  const cap = (e) => capPlan(table, P, e, planAgentCall(table, P, e), 'opus')
  assert.equal(cap({ subagent_type: 'model-router:frontier' }).set.subagent_type, 'model-router:long')
  assert.equal(cap({ subagent_type: 'model-router:frontier', model: 'fable' }).set.subagent_type, 'model-router:long')
  assert.equal(cap({ model: 'fable' }).set.subagent_type, undefined)
  assert.equal(cap({ subagent_type: 'Explore', model: 'fable' }).set.subagent_type, undefined)
  const sonnet = cap({ subagent_type: 'model-router:frontier', model: 'sonnet' })
  assert.deepEqual([sonnet.action, sonnet.tier, sonnet.model, sonnet.effort], ['capped', 'long', 'sonnet', 'xhigh'])
  assert.deepEqual(sonnet.set, { subagent_type: 'model-router:long' })
  const low = cap({ subagent_type: 'model-router:frontier', model: 'sonnet', effort: 'low' })
  assert.deepEqual([low.model, low.effort, low.set], ['sonnet', 'low', { subagent_type: 'model-router:long' }])
})

check('our type names compare as the host matches them: case, spaces, dashes and underscores do not count', () => {
  for (const type of ['Model-Router:Frontier', 'MODEL_ROUTER:FRONTIER', ' model router : frontier ', 'ｍodel-router:frontier', 'model–router:frontier']) {
    const capped = capPlan(table, P, { subagent_type: type }, planAgentCall(table, P, { subagent_type: type }), 'opus')
    assert.deepEqual([capped.action, capped.set], ['capped', { subagent_type: 'model-router:long', model: 'opus', effort: 'xhigh' }])
  }
  assert.equal(tierOfType(table, P, 'Model-Router:Deep'), 'deep')
  // A built-in or general name is matched exactly: a custom agent named `explore` keeps its own definition
  assert.equal(tierOfType(table, P, 'explore'), '')
  assert.equal(planAgentCall(table, P, { subagent_type: 'constructor' }).action, 'keep')
  assert.equal(planAgentCall(table, P, { subagent_type: 'general_purpose' }).action, 'keep')
  assert.equal(tierOfType(table, P, 'model-router:nope'), '')
  assert.equal(tierOfType(table, P, 'other-plugin:deep'), '')
  assert.equal(planAgentCall(table, P, { subagent_type: 'Model-Router:Deep' }).action, 'typed')
  const dashed = { ...table, order: [...table.order, 'long-run'], tiers: { ...table.tiers, 'long-run': table.tiers.long } }
  assert.equal(tierOfType(dashed, P, 'Model-Router:Long-Run'), 'long-run')
})

check('a capped call keeps the effort Claude set', () => {
  const cap = (e) => capPlan(table, P, e, planAgentCall(table, P, e), 'opus')
  const low = cap({ model: 'fable', effort: 'low' })
  assert.deepEqual([low.action, low.model, low.effort], ['capped', 'opus', 'low'])
  const max = cap({ subagent_type: 'model-router:frontier', effort: 'max' })
  assert.deepEqual(max.set, { subagent_type: 'model-router:long', model: 'opus', effort: 'max' })
  const narrow = { ...table, models: { ...table.models, opus: { ...table.models.opus, efforts: ['high', 'xhigh'] } } }
  const e = { model: 'fable', effort: 'low' }
  assert.equal(capPlan(narrow, P, e, planAgentCall(narrow, P, e), 'opus').effort, 'xhigh')
})

check('a built-in type given only an effort runs on its own model and counts under no tier', () => {
  const p = planAgentCall(table, P, { subagent_type: 'Explore', effort: 'high' })
  assert.deepEqual([p.action, p.tier], ['keep', ''])
  assert.equal(planAgentCall(table, P, { subagent_type: 'model-router:deep', effort: 'max' }).tier, 'deep')
})

check('counts add up', () => {
  let s = countDecision(null, { action: 'fill', tier: '' }, false, 5)
  s = countDecision(s, { action: 'typed', tier: 'deep' }, false, 9)
  s = countDecision(s, { action: 'typed', tier: 'frontier' }, true, 9)
  assert.deepEqual(s, { since: 5, total: 3, byAction: { fill: 1, typed: 2 }, byTier: { deep: 1, frontier: 1 }, frontier: 1 })
})

check('a broken table is refused with a reason', () => {
  assert.match(invalidTable({ ...table, schema: 1 }), /schema 1/)
  assert.match(invalidTable({ ...table, tiers: { ...table.tiers, deep: { ...table.tiers.deep, model: 'gpt' } } }), /unknown model gpt/)
  assert.match(invalidTable({ ...table, tiers: { ...table.tiers, quick: { ...table.tiers.quick, effort: 'ultra' } } }), /effort ultra/)
  assert.match(invalidTable({ ...table, fill: { model: 'opus' } }), /fill/)
})

check('the shipped table is schema 3 and valid', () => {
  assert.equal(table.schema, 3)
  assert.equal(invalidTable(table), '')
  assert.match(invalidTable({ ...table, router: { ...table.router, policy: 'x' } }), /router policy/)
  assert.match(invalidTable({ ...table, router: { ...table.router, default: 'maybe' } }), /router default/)
  assert.match(invalidTable({ ...table, router: { ...table.router, model: 'gpt' } }), /router model/)
  assert.match(invalidTable({ ...table, critical: ['nope'] }), /critical/)
  assert.match(invalidTable({ ...table, rules: [{ ...table.rules[0], floor: 'ultra' }] }), /floor/)
  assert.match(invalidTable({ ...table, rules: [{ ...table.rules[0], floor: table.frontier }] }), /floor/)
  assert.match(invalidTable({ ...table, rules: [{ ...table.rules[0], match: '(' }] }), /match/)
  assert.match(invalidTable({ ...table, rules: [{ ...table.rules[0], match: '' }] }), /match/)
  assert.match(invalidTable({ ...table, rules: [{ ...table.rules[0], match: 123 }] }), /match/)
  // Prices, the cost model and the thresholds are the eval's (eval/metrics.mjs invalidMetrics); the hook does not read them
  const { costModel: _c, thresholds: _t, ...bare } = table
  assert.equal(invalidTable({ ...bare, models: Object.fromEntries(Object.entries(table.models).map(([k, { price: _p, ...m }]) => [k, m])) }), '')
})

check('the blind view hides the chosen model', () => {
  for (const type of ['opus-high', 'model-router:deep', 'claude', '', undefined]) {
    const v = blindView(table, P, { subagent_type: type, description: 'Find a file', prompt: 'List files.' })
    assert.match(v, /^Agent type: general-purpose$/m)
    assert.ok(!v.includes('opus-high') && !v.includes('model-router'))
  }
  assert.match(blindView(table, P, { subagent_type: 'irene-reviewer', description: 'd', prompt: 'p' }), /^Agent type: irene-reviewer$/m)
  assert.match(blindView(table, P, { subagent_type: 'Explore', description: 'd', prompt: 'p' }), /^Agent type: Explore$/m)
})

check('the blind view cuts a huge prompt and survives an empty one', () => {
  const v = blindView(table, P, { description: 'd', prompt: 'x'.repeat(100000) })
  assert.ok(v.length < 12500)
  assert.match(v, /characters cut/)
  assert.match(blindView(table, P, {}), /Task prompt:/)
})

check('the router never offers the frontier', () => {
  assert.ok(!routableTiers(table).includes('frontier'))
  const req = routerRequest(table, P, { description: 'd', prompt: 'p' })
  for (const text of [tierTable(table), req.system]) assert.ok(!/frontier|fable/i.test(text))
  assert.deepEqual([req.model, req.effort, req.timeoutMs], [table.router.model, table.router.effort, table.router.timeoutMs])
  assert.ok(req.maxTokens >= 1024)
  assert.match(req.prompt, /Task description: d/)
  for (const t of routableTiers(table)) assert.ok(req.system.includes(`- ${t} (`))
  for (const c of table.categories) assert.ok(req.system.includes(c))
})

check('router replies parse strictly', () => {
  assert.deepEqual(parseRouterReply(table, '{"category":"search","tier":"quick"}'), { tier: 'quick', category: 'search' })
  assert.deepEqual(parseRouterReply(table, 'Sure.\n{"category": "search", "tier": "quick"}\nDone'), { tier: 'quick', category: 'search' })
  for (const text of ['{"category":"search","tier":"frontier"}', '{"tier":"ultra"}', 'quick', '', '{not json}', undefined]) {
    assert.equal(parseRouterReply(table, text), null)
  }
  assert.deepEqual(parseRouterReply(table, '{"category":"poetry","tier":"light"}'), { tier: 'light', category: 'other' })
  // A stray or nested brace before the answer must not keep it from being found
  assert.deepEqual(parseRouterReply(table, 'Considering {scope}… {"category":"review","tier":"deep"}'), { tier: 'deep', category: 'review' })
  assert.deepEqual(parseRouterReply(table, 'Draft {"tier": "ultra"} then {"category": "search", "tier": "light"}'), { tier: 'light', category: 'search' })
})

check('rules raise review, security and architecture to the floor', () => {
  assert.deepEqual(applyRules(table, P, { description: 'Review Task 3' }, { tier: 'quick', category: 'search' }), { tier: 'deep', category: 'search', ruled: true })
  assert.equal(applyRules(table, P, { description: 'Look at this' }, { tier: 'quick', category: 'security' }).tier, 'deep')
  assert.deepEqual(applyRules(table, P, { description: 'Review Task 3' }, { tier: 'long', category: 'review' }), { tier: 'long', category: 'review' })
  assert.deepEqual(applyRules(table, P, { description: 'Implement Task 2' }, { tier: 'standard', category: 'implement' }), { tier: 'standard', category: 'implement' })
  // A rule reads the type and the description, never the prompt
  assert.equal(applyRules(table, P, { description: 'Implement Task 2', prompt: 'then review it' }, { tier: 'standard', category: 'implement' }).tier, 'standard')
  assert.equal(applyRules(table, P, { subagent_type: 'lisa-reviewer', description: 'PR 12' }, { tier: 'standard', category: 'other' }).tier, 'deep')
})

check('Jev picks the cheapest tier whose cumulative probability reaches theta', () => {
  const reply = { answers: { tier: { probabilities: { quick: 0.5, light: 0.2, standard: 0.2, deep: 0.1, long: 0 } } } }
  assert.equal(pickJevTier(table, reply, 0.5), 'quick')
  assert.equal(pickJevTier(table, reply, 0.8), 'standard')
  assert.equal(pickJevTier(table, reply, 0.95), 'deep')
  assert.equal(pickJevTier(table, reply), 'standard')
  // Probabilities that do not sum to 1 are read as shares of their sum
  assert.equal(pickJevTier(table, { answers: { tier: { probabilities: { quick: 0.45, light: 0.05 } } } }, 0.8), 'quick')
  for (const r of [null, {}, { answers: {} }, { answers: { tier: { probabilities: { quick: 0 } } } }]) assert.equal(pickJevTier(table, r), null)
  const req = jevRequest(table, P, { description: 'd', prompt: 'p' })
  assert.equal(req.path, '/v1/systemone')
  assert.deepEqual([req.body.model, req.body.questions.tier.type], ['jev-1.13.0', 'choice'])
  assert.deepEqual(Object.keys(req.body.questions.tier.criteria), routableTiers(table))
  assert.match(req.body.state, /Task description: d/)
})

check('a routed plan sets model and effort, and moves only our own type', () => {
  assert.deepEqual(routedPlan(table, P, { subagent_type: 'model-router:deep' }, 'standard'), {
    action: 'routed', tier: 'standard', model: 'sonnet', effort: 'medium',
    set: { subagent_type: 'model-router:standard', model: 'sonnet', effort: 'medium' },
  })
  assert.deepEqual(routedPlan(table, P, { subagent_type: 'irene-reviewer' }, 'standard').set, { model: 'sonnet', effort: 'medium' })
  assert.deepEqual(routedPlan(table, P, {}, 'quick').set, { model: 'haiku', effort: 'low' })
})

check('what a call asks for: a model or effort it sets, else what its type names; a general or custom agent asks for nothing', () => {
  assert.deepEqual(askOf(table, P, { model: 'opus', effort: 'xhigh' }), { model: 'opus', effort: 'xhigh' })
  assert.deepEqual(askOf(table, P, { subagent_type: 'model-router:long' }), { model: 'opus', effort: 'xhigh' })
  assert.deepEqual(askOf(table, P, { subagent_type: 'Model-Router:Quick', model: 'opus' }), { model: 'opus', effort: 'low' })
  assert.deepEqual(askOf(table, P, { subagent_type: 'opus-xhigh' }), { model: 'opus', effort: 'xhigh' })
  assert.deepEqual(askOf(table, P, { subagent_type: 'haiku-low', effort: 'high' }), { model: 'haiku', effort: 'high' })
  assert.deepEqual(askOf(table, P, { subagent_type: 'Explore', effort: 'high' }), { model: '', effort: 'high' })
  for (const type of [undefined, '', 'general-purpose', 'claude', 'Explore', 'Plan', 'irene-reviewer', 'opus-ultra', 'other-plugin:deep']) {
    assert.deepEqual(askOf(table, P, { subagent_type: type, description: 'Review', prompt: 'x' }), { model: '', effort: '' })
  }
})

check('strength compares the model line first, then the effort, only where the call names it', () => {
  const t = table.tiers
  assert.equal(weaker(t.standard, { model: 'opus', effort: 'xhigh' }), true)
  assert.equal(weaker(t.deep, { model: 'opus', effort: 'xhigh' }), true)
  assert.equal(weaker(t.long, { model: 'opus', effort: 'xhigh' }), false)
  assert.equal(weaker(t.deep, { model: 'haiku', effort: '' }), false)
  assert.equal(weaker(t.deep, { model: 'sonnet', effort: 'max' }), false)
  assert.equal(weaker(t.light, { model: 'haiku', effort: 'medium' }), false)
  assert.equal(weaker(t.quick, { model: 'haiku', effort: 'medium' }), true)
  assert.equal(weaker(t.long, { model: 'fable', effort: '' }), true)
  assert.equal(weaker(t.quick, { model: '', effort: '' }), false)
  assert.equal(weaker(t.deep, { model: '', effort: 'xhigh' }), true)
  assert.equal(weaker(t.deep, { model: '', effort: 'low' }), false)
  // A model outside the known lines cannot be compared, so the call keeps it
  assert.equal(weaker(t.long, { model: 'gpt-x', effort: '' }), true)
})

check('an explicit request is a floor: the router may raise a call, never lower it', () => {
  const today = (e) => capPlan(table, P, e, planAgentCall(table, P, e), 'opus')
  const opus = { model: 'opus', effort: 'xhigh', description: 'd', prompt: 'x' }
  assert.equal(autoTier(table, P, opus, 'standard'), '')
  assert.deepEqual([today(opus).model, today(opus).effort], ['opus', 'xhigh'])
  assert.equal(autoTier(table, P, { model: 'haiku', description: 'd' }, 'deep'), 'deep')
  assert.equal(autoTier(table, P, { subagent_type: 'general-purpose', description: 'd' }, 'quick'), 'quick')
  assert.equal(autoTier(table, P, { description: 'd' }, 'quick'), 'quick')
  const long = { subagent_type: 'model-router:long', description: 'd' }
  assert.equal(autoTier(table, P, long, 'standard'), '')
  assert.deepEqual([today(long).action, today(long).tier, today(long).set], ['typed', 'long', undefined])
  assert.equal(autoTier(table, P, { subagent_type: 'model-router:quick' }, 'deep'), 'deep')
  assert.equal(autoTier(table, P, { subagent_type: 'opus-xhigh' }, 'deep'), '')
  assert.equal(autoTier(table, P, { subagent_type: 'haiku-low' }, 'standard'), 'standard')
  assert.equal(autoTier(table, P, { subagent_type: 'Explore' }, 'standard'), 'standard')
  assert.equal(autoTier(table, P, { subagent_type: 'irene-reviewer' }, 'quick'), 'quick')
  assert.equal(autoTier(table, P, { effort: 'xhigh' }, 'deep'), '')
  assert.equal(autoTier(table, P, { effort: 'low' }, 'deep'), 'deep')
  // A Fable request is above every routable tier: it keeps today's plan, which the Opus cap still caps
  const fable = { model: 'fable', description: 'd' }
  assert.equal(autoTier(table, P, fable, 'long'), '')
  assert.deepEqual([today(fable).action, today(fable).model, today(fable).effort], ['capped', 'opus', 'xhigh'])
  assert.equal(autoTier(table, P, { subagent_type: 'model-router:frontier' }, 'long'), '')
  assert.equal(autoTier(table, P, opus, ''), '')
})

check('routesCall is false for today, for a fork, and for the frontier type under /route fable', () => {
  assert.equal(routesCall(table, P, { subagent_type: 'general-purpose' }, 'opus'), true)
  assert.equal(routesCall({ ...table, router: { ...table.router, policy: 'today' } }, P, { subagent_type: 'general-purpose' }, 'opus'), false)
  assert.equal(routesCall(table, P, { subagent_type: 'fork' }, 'opus'), false)
  assert.equal(routesCall(table, P, { subagent_type: 'model-router:frontier' }, 'fable'), false)
  assert.equal(routesCall(table, P, { subagent_type: 'model-router:deep' }, 'fable'), true)
})

check('policyTier reads a jev reply or a router reply by the table\'s policy, and today never routes', () => {
  const e = { description: 'Review Task 3' }
  const jevTable = { ...table, router: { ...table.router, policy: 'jev' } }
  const reply = { answers: { tier: { probabilities: { quick: 0.9, deep: 0.1 } } } }
  assert.deepEqual(policyTier(jevTable, P, e, reply), { tier: 'quick', category: null })
  assert.equal(policyTier(jevTable, P, e, null), null)
  const textTable = { ...table, router: { ...table.router, policy: 'text' } }
  assert.deepEqual(policyTier(textTable, P, e, '{"category":"search","tier":"quick"}'), { tier: 'quick', category: 'search' })
  const rulesTable = { ...table, router: { ...table.router, policy: 'rules' } }
  assert.deepEqual(policyTier(rulesTable, P, e, '{"category":"search","tier":"quick"}'), { tier: 'deep', category: 'search' })
  assert.equal(policyTier({ ...table, router: { ...table.router, policy: 'today' } }, P, e, 'anything'), null)
})

check('age in days', () => assert.equal(ageDays({ updated: '2026-10-24' }, Date.parse('2026-11-03T12:00:00Z')), 10))

check('the policy text says routing is automatic only when auto is on', () => {
  const on = policyText(table, P, 'opus', true)
  assert.match(on, /routed automatically/)
  assert.match(on, /\/route auto off/)
  assert.match(on, /A model or effort you set, or a type that names one .* is a floor/)
  assert.doesNotMatch(on, /whatever type or model/)
  assert.equal(policyText(table, P, 'opus'), policyText(table, P, 'opus', false))
  assert.doesNotMatch(policyText(table, P, 'opus'), /routed automatically/)
  assert.ok(on.startsWith(policyText(table, P, 'opus')))
})

console.log(`${n} checks passed`)
