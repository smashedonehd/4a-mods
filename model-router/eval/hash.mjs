// The policy hash: what decides a routed call's tier, data and code alike. Recorded decisions
// carry it, and the replay test fails when the shipped policy no longer hashes the same.
// Costs, thresholds, router.default, model ids and dates are not policy: they change no decision.
import { createHash } from 'node:crypto'
import { routableTiers, POLICY_CODE, ROUTER_SYSTEM, JEV_INSTRUCTIONS, CATEGORY_GUIDE } from '../hooks/route.mjs'

export function policyInputs(table) {
  const { default: _on, ...router } = table.router
  const tiers = Object.fromEntries(routableTiers(table).map((n) => {
    const t = table.tiers[n]
    return [n, { model: t.model, effort: t.effort, description: t.description }]
  }))
  return {
    tiers,
    order: table.order,
    fill: table.fill,
    builtinTypes: table.builtinTypes,
    categories: table.categories,
    critical: table.critical,
    rules: table.rules,
    router,
    texts: { ROUTER_SYSTEM, JEV_INSTRUCTIONS, CATEGORY_GUIDE },
    code: POLICY_CODE.map(String),
  }
}

// JSON with sorted keys, so key order never changes the hash
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  return JSON.stringify(v)
}

export function policyHash(table) {
  return createHash('sha256').update(canonical(policyInputs(table))).digest('hex')
}
