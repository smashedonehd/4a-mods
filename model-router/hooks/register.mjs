// Model Router: one agent type per model and effort tier, so Claude delegates
// each task to the model it needs. Every tier of routing.json (quick lookup ->
// Haiku at low effort, standard coding -> Sonnet at medium, hard engineering ->
// Opus at high, and so on) becomes the agent type model-router:<tier>, and the
// system prompt tells Claude which tier fits which task.
//
// Why types and not a classifier: the main Claude sees the whole conversation,
// so it judges a task better than keywords or a small model reading one prompt.
// The hook below is only a safety net: a general agent Claude started with
// nothing set gets the table's default (Opus at medium), one given only a model
// gets the effort of that model's first tier instead of the session's, a model
// and effort Claude chose are kept, a fork is left alone, and nothing is ever refused.
// Current: the table ships with the plugin and changes through pull requests
// (UPDATING.md); aliases already follow each line's newest model.
// Cost: zero tokens per call; the policy is one cached system prompt section.

import { invalidTable, ageDays, agentSpecs, planAgentCall, isFrontier, policyText, countDecision, offeredTiers, capPlan, capTier } from './route.mjs'

const settings = {
  fill: true, // give an unset general agent the table's default model and effort
  ceiling: 'opus', // opus: Haiku up to Opus, the frontier tier off (/route) · fable: up to Fable (/route fable)
}

let table = null
let plugin = 'model-router'
let problem = '' // why no table is in use
let registered = [] // the agent types registered this session
let attempts = 0 // registrations tried: one at the start, again before a prompt while any is missing
let commandName = 'route'
const recent = [] // the last decisions, newest last

function remember(d) {
  recent.push(d)
  if (recent.length > 12) recent.shift()
}

// The range Claude may route to, as the status line and /route say it
function range() {
  const tiers = offeredTiers(table, settings.ceiling)
  return `${table.tiers[tiers[0]].model} → ${table.tiers[tiers[tiers.length - 1]].model}`
}

function tag(d) {
  return d.model ? `${d.model}·${d.effort || 'default'}` : 'unchanged'
}

// The status line never decides anything, so a failure here stays here
async function showStatus($, text) {
  try {
    const age = table ? ageDays(table, await $.clock.now()) : 0
    const stale = table && age > (table.staleDays || 30) ? ` (table ${age} days old, see /${commandName})` : ''
    $.ui.status(table ? `router ${range()}${text ? `: ${text}` : ''}${stale}` : undefined)
  } catch {
    // no status this time
  }
}

async function loadTable($) {
  try {
    const t = JSON.parse(await $.fs.read(`${$.plugin.root}/routing.json`))
    const why = invalidTable(t)
    if (why) problem = `routing.json refused: ${why}`
    else table = t
  } catch (err) {
    problem = `routing.json unreadable: ${(err && err.message) || err}`
  }
  if (problem) $.ui.log(`model-router: ${problem}`, { to: 'debug' })
}

async function registerTypes($) {
  attempts++
  for (const spec of agentSpecs(table)) {
    if (registered.includes(`${plugin}:${spec.name}`)) continue
    try {
      const r = await $.agent.register(spec)
      registered.push((r && r.agent) || `${plugin}:${spec.name}`)
    } catch (err) {
      $.ui.log(`model-router: agent type ${spec.name} not registered: ${(err && err.message) || err}`, { to: 'debug' })
    }
  }
}

async function statusText($) {
  const now = await $.clock.now()
  const offered = offeredTiers(table, settings.ceiling)
  const lines = [`Model Router ${table.updated} (${ageDays(table, now)} days old): routes ${range()}, safety net ${settings.fill ? 'on' : 'off'}.`]
  lines.push(`Agent types (${registered.length} of ${table.order.length} registered):`)
  for (const n of table.order) {
    const off = offered.includes(n) ? '' : ` (off: /${commandName} fable turns it on; calls go to ${plugin}:${capTier(table)})`
    lines.push(`  ${`${plugin}:${n}`.padEnd(26)} ${tag(table.tiers[n]).padEnd(14)} ${table.tiers[n].description}${off}`)
  }
  lines.push(`  general agent with nothing set -> ${tag(table.fill)}`)
  const s = await $.store.get('stats')
  if (s && s.total) {
    const by = Object.entries(s.byAction || {}).map(([k, n]) => `${k} ${n}`).join(', ')
    const tiers = Object.entries(s.byTier || {}).map(([k, n]) => `${k} ${n}`).join(', ')
    lines.push(`Since ${new Date(s.since).toISOString().slice(0, 10)}: ${s.total} Agent calls (${by}); tiers: ${tiers || 'none'}; on ${table.frontier || 'frontier'}: ${s.frontier || 0}.`)
  }
  if (recent.length) {
    lines.push('This session:')
    for (const d of recent.slice(-6)) lines.push(`  ${d.what.padEnd(34)} ${d.action.padEnd(8)} ${tag(d)}`)
  }
  lines.push(`Settings: /${commandName} (Haiku up to Opus) · /${commandName} fable (up to Fable) · /${commandName} fill on|off · /${commandName} stats reset`)
  return lines.join('\n')
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    plugin = $.plugin.name || plugin
    const saved = await $.store.get('settings')
    if (saved && typeof saved === 'object') Object.assign(settings, saved)
    if (settings.ceiling !== 'fable') settings.ceiling = 'opus'
    await loadTable($)
    if (table) await registerTypes($)
    for (const name of ['route', 'model-router']) {
      try {
        await $.command.register({ name, description: 'Model Router: route Haiku up to Opus (/route) or up to Fable (/route fable), and what the router did', argumentHint: '[fable|fill on|off|stats reset]', immediate: true })
        commandName = name
        break
      } catch {
        // taken: try the next name
      }
    }
    await showStatus($)
    return next(e)
  })

  // The safety net: never refuses, never touches subagent_type or prompt
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (!table) return next(e)
    const plan = capPlan(table, planAgentCall(table, plugin, e), settings.ceiling)
    if (plan.set && !settings.fill && plan.action !== 'capped') plan.set = null
    const frontier = isFrontier(table, plan)
    remember({ ...plan, what: `${e.subagent_type || 'agent'}: ${String(e.description || '').slice(0, 20)}` })
    try {
      await $.store.set('stats', countDecision(await $.store.get('stats'), plan, frontier, await $.clock.now()))
    } catch {
      // the count is a convenience
    }
    if (plan.action !== 'keep' || frontier) await showStatus($, `${e.subagent_type || 'agent'} → ${tag(plan)}${frontier ? ' (frontier)' : ''}${plan.action === 'capped' ? ' (capped)' : ''}`)
    return next(plan.set ? { ...e, ...plan.set } : e)
  }).catch(($, e, next) => next(e))

  // A type the start could not register (the session not bound yet) is tried again before a turn
  on('prompt.submit', async ($, e, next) => {
    if (table && registered.length < table.order.length && attempts < 4) await registerTypes($)
    return next(e)
  })

  // Under the Opus ceiling the frontier type is neither listed to Claude nor dispatched
  on('agent.offer', async ($, e, next) => {
    if (table && table.frontier && e.agent === `${plugin}:${table.frontier}` && settings.ceiling !== 'fable') return { isOffered: false }
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!table || !registered.length || !e.tools.includes('Agent')) return r
    return { sections: [...r.sections, { id: 'model-router:policy', text: policyText(table, plugin, settings.ceiling), scope: 'session' }] }
  })

  on('command.run', { command: ['route', 'model-router'] }, async ($, e) => {
    const [key, ...rest] = String(e.args || '').trim().split(/\s+/)
    const k = (key || '').toLowerCase()
    const v = (rest[0] || '').toLowerCase()
    if (!table) return { text: `Model Router has no table in use: ${problem || 'not loaded yet'}.` }
    // Bare /route (or /route opus) routes Haiku up to Opus; /route fable up to Fable
    if (k === '' || k === 'opus' || k === 'fable') {
      settings.ceiling = k === 'fable' ? 'fable' : 'opus'
      await $.store.set('settings', settings)
      await showStatus($)
      return { text: await statusText($) }
    }
    if (k === 'fill' && ['on', 'off'].includes(v)) {
      settings.fill = v === 'on'
      await $.store.set('settings', settings)
      return { text: `Model Router safety net: ${v}.` }
    }
    if (k === 'stats' && v === 'reset') {
      await $.store.set('stats', null)
      return { text: 'Model Router counts reset.' }
    }
    return { text: `Unknown option ${key}. ${await statusText($)}` }
  })
}
