// How a policy's decisions compare with gold: agreement, underestimates (all and on critical
// categories) and cost against gold, by the table's labelled cost assumption.
import { EFFORTS, FAMILIES } from '../hooks/route.mjs'

// What the metrics read of a table beyond what the hook checks (route.mjs invalidTable): a price for
// every model, the cost model and the thresholds; returns a reason or ''
export function invalidMetrics(t) {
  for (const [alias, m] of Object.entries(t.models)) {
    if (!m || !m.price || !Number.isFinite(m.price.in) || !Number.isFinite(m.price.out)) return `model ${alias} has no price`
  }
  const c = t.costModel
  if (!c || !Number.isFinite(c.inputShare) || !c.effort || EFFORTS.some((x) => !Number.isFinite(c.effort[x]))) return 'costModel needs an input share and a factor for every effort'
  const th = t.thresholds
  if (!th || ['under', 'underCritical', 'costOver'].some((k) => !Number.isFinite(th[k]))) return 'thresholds need under, underCritical and costOver'
  return ''
}

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
export function pairOf(table, d) {
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
  let criticalTotal = 0
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
    if (table.critical.includes(g.category)) {
      criticalTotal += w
      if (low) critical += w
    }
    cost += w * costOf(table, d.model, d.effort)
    goldCost += w * costOf(table, want.model, want.effort)
    bump(byCategory, g.category, ok, low)
    bump(byStratum, g.stratum || 'all', ok, low)
  }
  const costRatio = cost / goldCost
  return { n: gold.length, agreement: agree / total, under: under / total, underCritical: critical, underCriticalRate: criticalTotal ? critical / criticalTotal : 0, costRatio, costOver: costRatio - 1, byCategory, byStratum }
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

// Which thresholds the metrics miss. Agreement is reported, not gated: the two judges agree with
// each other on only 92.7 % of calls, so exact agreement with gold has no meaningful ceiling. For
// the same reason under is 5 %, and underCritical is a share of the critical calls, also 5 %: either
// Opus judge alone under-routes 2.5-5 % of all calls and up to 4.2 % of critical ones against gold.
export function criteria(table, m) {
  const t = table.thresholds
  const eps = 1e-12
  const missed = []
  if (!(m.under <= t.under + eps)) missed.push('under')
  if (!(m.underCriticalRate <= t.underCritical + eps)) missed.push('underCritical')
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

// How often two label series agree: the raw share and Cohen's kappa
export function agreement(a, b) {
  return { raw: a.filter((x, i) => x === b[i]).length / a.length, kappa: kappa(a, b) }
}

// Prints a confusion matrix: a caption, then one line per row label with the count of [row, column]
// pairs under each column label
export function printConfusion(caption, rows, cols, pairs, width) {
  const key = (r, c) => `${r}\u0000${c}`
  const counts = new Map()
  for (const [r, c] of pairs) counts.set(key(r, c), (counts.get(key(r, c)) || 0) + 1)
  console.log(`${caption}:\n${''.padEnd(9)}${cols.map((c) => c.padStart(width)).join('')}`)
  for (const r of rows) console.log(r.padEnd(9) + cols.map((c) => String(counts.get(key(r, c)) || 0).padStart(width)).join(''))
}
