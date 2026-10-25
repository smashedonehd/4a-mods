// Run: node model-router/test/route.test.mjs
// Checks the shipped routing.json and the router's decision for each kind of Agent call.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { invalidTable, agentSpecs, planAgentCall, isFrontier, policyText, countDecision, ageDays, offeredTiers, capTier, capPlan } from '../hooks/route.mjs'

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

check('a model or effort Claude set is kept', () => {
  assert.equal(planAgentCall(table, P, { model: 'sonnet', prompt: 'x' }).action, 'keep')
  assert.equal(planAgentCall(table, P, { effort: 'high', prompt: 'x' }).action, 'keep')
  assert.equal(planAgentCall(table, P, { subagent_type: 'model-router:quick', model: 'opus' }).set, undefined)
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
})

check('under the Opus ceiling a Fable call runs on Opus xhigh; under /route fable it stays', () => {
  for (const e of [{ model: 'fable' }, { subagent_type: 'model-router:frontier' }]) {
    const capped = capPlan(table, planAgentCall(table, P, e), 'opus')
    assert.deepEqual([capped.action, capped.model, capped.effort], ['capped', 'opus', 'xhigh'])
    assert.deepEqual(capped.set, { model: 'opus', effort: 'xhigh' })
    assert.equal(isFrontier(table, capped), false)
    const open = capPlan(table, planAgentCall(table, P, e), 'fable')
    assert.equal(isFrontier(table, open), true)
    assert.equal(open.set, undefined)
  }
  const effortOnly = capPlan(table, planAgentCall(table, P, { subagent_type: 'model-router:frontier', effort: 'max' }), 'opus')
  assert.deepEqual([effortOnly.action, effortOnly.model], ['capped', 'opus'])
  const deep = planAgentCall(table, P, { subagent_type: 'model-router:deep' })
  assert.equal(capPlan(table, deep, 'opus'), deep)
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

check('age in days', () => assert.equal(ageDays({ updated: '2026-10-24' }, Date.parse('2026-11-03T12:00:00Z')), 10))

console.log(`${n} checks passed`)
