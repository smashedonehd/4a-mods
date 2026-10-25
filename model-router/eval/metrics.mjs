// How a policy's decisions compare with gold: agreement, underestimates (all and on critical
// categories) and cost against gold, by the table's labelled cost assumption.
import { EFFORTS } from '../hooks/route.mjs'

const FAMILIES = ['haiku', 'sonnet', 'opus', 'fable']

// Relative cost of one call on a model at an effort (routing.json costModel)
export function costOf(table, model, effort) {
  const p = table.models[model].price
  const c = table.costModel
  return (c.inputShare * p.in + (1 - c.inputShare) * p.out) * c.effort[effort]
}

// Capability order: the model line first, then the effort
export function rankOf(table, model, effort) {
  return FAMILIES.indexOf(model) * 10 + EFFORTS.indexOf(effort)
}

// A decision is a tier name or a { model, effort } pair (today's router can land between tiers)
function pairOf(table, d) {
  return typeof d === 'string' ? { model: table.tiers[d].model, effort: table.tiers[d].effort } : d
}

function bump(map, key, agree, under) {
  const x = map[key] || (map[key] = { n: 0, agree: 0, under: 0 })
  x.n++
  if (agree) x.agree++
  if (under) x.under++
}

// The metrics over gold rows { id, tier, category, stratum? }. With weights by stratum the rates and
// costs are weighted; n and the per-category and per-stratum counts stay raw.
export function score(table, gold, decisions, weights) {
  let total = 0
  let agree = 0
  let under = 0
  let critical = 0
  let cost = 0
  let goldCost = 0
  const byCategory = {}
  const byStratum = {}
  for (const g of gold) {
    if (decisions[g.id] === undefined) throw new Error(`no decision for ${g.id}`)
    const d = pairOf(table, decisions[g.id])
    const want = table.tiers[g.tier]
    const ok = d.model === want.model && d.effort === want.effort
    const low = rankOf(table, d.model, d.effort) < rankOf(table, want.model, want.effort)
    const w = weights && Number.isFinite(weights[g.stratum]) ? weights[g.stratum] : 1
    total += w
    if (ok) agree += w
    if (low) under += w
    if (low && table.critical.includes(g.category)) critical += w
    cost += w * costOf(table, d.model, d.effort)
    goldCost += w * costOf(table, want.model, want.effort)
    bump(byCategory, g.category, ok, low)
    bump(byStratum, g.stratum || 'all', ok, low)
  }
  const costRatio = cost / goldCost
  return { n: gold.length, agreement: agree / total, under: under / total, underCritical: critical, costRatio, costOver: costRatio - 1, byCategory, byStratum }
}

// How much each stratum stands for in the corpus against its share of the sample
export function weightsFor(corpus, sample) {
  const share = (rows) => {
    const out = {}
    for (const r of rows) out[r.stratum] = (out[r.stratum] || 0) + 1 / rows.length
    return out
  }
  const c = share(corpus)
  const s = share(sample)
  return Object.fromEntries(Object.keys(s).map((k) => [k, (c[k] || 0) / s[k]]))
}

// Which thresholds the metrics miss
export function criteria(table, m) {
  const t = table.thresholds
  const eps = 1e-12
  const missed = []
  if (!(m.agreement >= t.agreement - eps)) missed.push('agreement')
  if (!(m.under <= t.under + eps)) missed.push('under')
  if (!(m.underCritical <= t.underCritical + eps)) missed.push('underCritical')
  if (!(m.costOver <= t.costOver + eps)) missed.push('costOver')
  return { pass: missed.length === 0, missed }
}

// Cohen's kappa of two label series
export function kappa(a, b) {
  const n = a.length
  const labels = [...new Set([...a, ...b])]
  const po = a.filter((x, i) => x === b[i]).length / n
  const pe = labels.reduce((s, l) => s + (a.filter((x) => x === l).length / n) * (b.filter((x) => x === l).length / n), 0)
  return pe === 1 ? 1 : (po - pe) / (1 - pe)
}
