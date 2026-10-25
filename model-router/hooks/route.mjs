// Model Router's table logic, kept free of `$` so plain node can test it.
// A table (routing.json) names tiers, each a model alias and an effort; every
// tier becomes an agent type Claude picks by its description.

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const NAME = /^[a-z][a-z0-9-]{0,40}$/

// What a table needs before the router uses it; returns a reason or ''
export function invalidTable(t) {
  if (!t || typeof t !== 'object') return 'not an object'
  if (t.schema !== 2) return `schema ${t.schema} (this router reads schema 2)`
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(t.updated || ''))) return 'no updated date'
  if (!t.models || typeof t.models !== 'object') return 'no models'
  if (!Array.isArray(t.order) || t.order.length < 2) return 'no tier order'
  for (const name of t.order) {
    if (!NAME.test(name)) return `tier name ${name} is not a short lowercase name`
    const tier = t.tiers && t.tiers[name]
    if (!tier) return `tier ${name} missing`
    const model = t.models[tier.model]
    if (!model) return `tier ${name} names unknown model ${tier.model}`
    if (!EFFORTS.includes(tier.effort)) return `tier ${name} has effort ${tier.effort}`
    if (Array.isArray(model.efforts) && !model.efforts.includes(tier.effort)) return `tier ${name}: ${tier.model} does not take effort ${tier.effort}`
    if (!tier.description || String(tier.description).length < 20) return `tier ${name} has no description`
  }
  if (t.frontier && !t.order.includes(t.frontier)) return `frontier tier ${t.frontier} not in order`
  const f = t.fill
  if (!f || !t.models[f.model] || !EFFORTS.includes(f.effort) || !Array.isArray(f.types)) return 'fill needs a model, an effort and types'
  for (const [type, tier] of Object.entries(t.builtinTypes || {})) {
    if (!t.order.includes(tier)) return `built-in type ${type} names unknown tier ${tier}`
  }
  return ''
}

export function ageDays(table, nowMs) {
  const t = Date.parse(String(table.updated) + 'T00:00:00Z')
  return Number.isFinite(t) ? Math.floor((nowMs - t) / 86400000) : Infinity
}

// The system prompt every tier's agent runs with: it replaces the session's,
// so it says what a delegated worker is for
export const AGENT_PROMPT = [
  'You are a subagent: Claude delegated one task to you. Do that task fully with the tools you have.',
  'End with one concise report, because Claude reads only your final message and the user sees none of your work: what you found or changed (file paths and line numbers), what you checked and how, and what is left open.',
  'Do not ask questions. When something is ambiguous, take the most likely reading and say which one you took.',
  'Stay inside the task: no unrelated edits, and no commits, pushes or messages to anyone unless the task asks for them.',
].join('\n\n')

// One agent type per tier, as $.agent.register takes it
export function agentSpecs(table) {
  return table.order.map((name) => {
    const t = table.tiers[name]
    return { name, description: `${t.description} Runs on ${t.model} at ${t.effort} effort.`, prompt: AGENT_PROMPT, model: t.model, effort: t.effort }
  })
}

// The tier an Agent call's own type names: one of ours (`model-router:deep`), or a built-in the table maps
export function tierOfType(table, plugin, type) {
  const t = String(type || '')
  const prefix = `${plugin}:`
  if (t.startsWith(prefix) && table.order.includes(t.slice(prefix.length))) return t.slice(prefix.length)
  return (table.builtinTypes || {})[t] || ''
}

// What to do with one Agent call: { action, set?, tier, model, effort }
// - keep: Claude set the model or effort itself, or the type is a fork or a custom agent with its own frontmatter
// - typed: one of the tier types, whose definition already carries model and effort
// - builtin: a built-in type the table maps to a tier
// - fill: a general agent with nothing set gets the table's default
// - effort: a general or mapped built-in agent given only a model gets the effort of that model's first tier;
//   it has no effort of its own and would run at the session's
export function planAgentCall(table, plugin, e) {
  const type = String(e.subagent_type || '')
  if (type === 'fork') return { action: 'keep', why: 'fork' }
  const tier = tierOfType(table, plugin, type)
  const ours = Boolean(tier) && type.startsWith(`${plugin}:`)
  if (e.model && !e.effort && !ours && (tier || table.fill.types.includes(type))) {
    const modelTier = table.order.find((n) => table.tiers[n].model === e.model)
    if (modelTier) {
      const { effort } = table.tiers[modelTier]
      return { action: 'effort', tier: modelTier, model: e.model, effort, set: { effort } }
    }
  }
  if (e.model || e.effort) return { action: 'keep', why: 'set by Claude', tier: e.model ? '' : tier, model: e.model, effort: e.effort }
  if (ours) return { action: 'typed', tier, model: table.tiers[tier].model, effort: table.tiers[tier].effort }
  if (tier) {
    const { model, effort } = table.tiers[tier]
    return { action: 'builtin', tier, model, effort, set: { model, effort } }
  }
  if (table.fill.types.includes(type)) {
    const { model, effort } = table.fill
    return { action: 'fill', tier: '', model, effort, set: { model, effort } }
  }
  return { action: 'keep', why: 'own definition' }
}

// Whether a call lands on the frontier tier or names its model outright
export function isFrontier(table, plan) {
  if (!table.frontier) return false
  return plan.tier === table.frontier || plan.model === table.tiers[table.frontier].model
}

// The tiers Claude is offered under a ceiling: 'opus' leaves out the frontier tier, 'fable' offers them all
export function offeredTiers(table, ceiling) {
  return ceiling === 'fable' || !table.frontier ? table.order : table.order.filter((n) => n !== table.frontier)
}

// The strongest tier below the frontier: where a capped frontier call lands
export function capTier(table) {
  const below = offeredTiers(table, 'opus')
  return below[below.length - 1]
}

// Under the 'opus' ceiling a call bound for the frontier model runs on the cap tier instead
export function capPlan(table, plan, ceiling) {
  if (ceiling === 'fable' || !isFrontier(table, plan)) return plan
  const tier = capTier(table)
  const { model, effort } = table.tiers[tier]
  return { ...plan, action: 'capped', tier, model, effort, set: { model, effort } }
}

// The section added to Claude's system prompt: which type to pick for which task
export function policyText(table, plugin, ceiling = 'opus') {
  const tiers = offeredTiers(table, ceiling)
  const lines = tiers.map((n) => `- ${plugin}:${n} (${table.tiers[n].model}, ${table.tiers[n].effort}): ${table.tiers[n].description}`)
  const frontier = !table.frontier
    ? ''
    : ceiling === 'fable'
      ? ` Pick ${plugin}:${table.frontier} only as its description says.`
      : ` ${table.tiers[table.frontier].model} is switched off: the strongest tier is ${plugin}:${capTier(table)}, and a call naming ${table.tiers[table.frontier].model} runs there.`
  return [
    `Model routing (${plugin}, table of ${table.updated}). When you delegate with the Agent tool, pick the agent type by the task's difficulty:`,
    ...lines,
    `Give cheap work (searching, reading, summarizing many files) its own ${plugin}:quick or ${plugin}:light agents, and keep hard judgment for the tiers that need it.${frontier} A general agent you start with no model runs on ${table.fill.model} at ${table.fill.effort} effort; a general or built-in agent given only a model runs at the effort of that model's first tier. A specialised agent type (Explore, Plan, a custom one) still wins when it fits the task better.`,
  ].join('\n')
}

// Counts kept across sessions: { since, total, byAction, byTier, frontier }
export function countDecision(stats, plan, frontier, nowMs) {
  const s = stats && typeof stats === 'object' ? stats : {}
  const out = {
    since: s.since || nowMs,
    total: (s.total || 0) + 1,
    byAction: { ...(s.byAction || {}) },
    byTier: { ...(s.byTier || {}) },
    frontier: (s.frontier || 0) + (frontier ? 1 : 0),
  }
  out.byAction[plan.action] = (out.byAction[plan.action] || 0) + 1
  if (plan.tier) out.byTier[plan.tier] = (out.byTier[plan.tier] || 0) + 1
  return out
}
