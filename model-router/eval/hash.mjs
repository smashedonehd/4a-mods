// The policy hash: what decides a routed call's tier, data and code alike. Recorded decisions
// carry it, and the replay test fails when the shipped policy no longer hashes the same.
// Costs, thresholds, router.default, model ids and dates are not policy: they change no decision.
import { createHash } from 'node:crypto'
import { routableTiers, POLICY_CODE, ROUTER_SYSTEM, JEV_INSTRUCTIONS, CATEGORY_GUIDE } from '../hooks/route.mjs'

// CRLF and LF source for the same function must hash the same; .gitattributes pins the repo's
// own copies to LF, but a clone's line endings are not under our control
export function noEol(s) {
  return String(s).replace(/\r\n/g, '\n')
}

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
    router: { ...router, modelId: table.models[router.model].id },
    texts: { ROUTER_SYSTEM, JEV_INSTRUCTIONS, CATEGORY_GUIDE },
    code: POLICY_CODE.map((f) => noEol(f)),
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
