// Model Router: one agent type per model and effort tier, and a routing policy
// that picks the tier of every Agent call. Every tier of routing.json (quick
// lookup -> Haiku at low effort, standard coding -> Sonnet at medium, hard
// engineering -> Opus at high, and so on) becomes the agent type
// model-router:<tier>, and the system prompt tells Claude which tier fits which task.
//
// With auto routing on (/route auto on, or router.default "on" in the table) the
// policy decides: a small router model (text), the router plus hard floors for
// review, security and architecture (rules), or Jev Choice (jev) reads the call
// as the eval read it (eval/ calls the same functions from route.mjs) and names
// the tier; Claude's own choice is only an input. A fork is never routed, and
// under /route fable the frontier type stays manual.
//
// The safety net is the fallback, and the whole router while auto routing is
// off: a general agent Claude started with nothing set gets the table's default
// (Opus at medium), a general or mapped built-in agent given only a model gets
// the effort of that model's first tier instead of the session's, a tier type
// and a model and effort Claude chose are kept, and a fork is left alone. A
// router that is refused, fails, times out or answers nonsense leaves the call
// to it. The one exception is the Opus cap (plain /route): a call with model
// Fable runs on Opus instead, and a call naming the Fable type, which the host
// would refuse as not offered, moves to the cap type.
// Current: the table ships with the plugin and changes through pull requests
// (UPDATING.md); aliases already follow each line's newest model.
// Cost: with auto routing off, zero tokens per call; on, one small router call
// (or one Jev call) per Agent call, bounded by router.timeoutMs.

import { invalidTable, ageDays, agentSpecs, planAgentCall, isFrontier, policyText, countDecision, offeredTiers, capPlan, capTier, routerRequest, jevRequest, routedPlan, routesCall, policyTier } from './route.mjs'

const settings = {
  fill: true, // the safety net described above; off, only the Opus cap still applies
  ceiling: 'opus', // opus: Haiku up to Opus, the frontier tier off (/route) · fable: up to Fable (/route fable)
  auto: undefined, // auto routing: true or false once /route auto on|off set it, else the table's router.default
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

function autoOn() {
  return typeof settings.auto === 'boolean' ? settings.auto : table.router.default === 'on'
}

function autoLine() {
  const r = table.router
  const on = autoOn() && r.policy !== 'today'
  return `Auto routing: ${on ? 'on' : 'off'} (policy ${r.policy}, router ${r.policy === 'jev' ? r.jev.model : `${r.model} ${r.effort}`}).`
}

// Whether the policy routes this call: not a fork, not the frontier type Claude may name under /route fable
function routes(e) {
  return autoOn() && routesCall(table, plugin, e, settings.ceiling)
}

// The policy's tier for one call, or '' when it has none (refused, failed, timed out, unusable): never throws
async function decide($, e) {
  try {
    const r = table.router
    if (r.policy === 'jev') {
      const key = await $.env.get('TYPESAFE_API_KEY')
      if (!key) return ''
      const base = (await $.env.get('TYPESAFE_BASE_URL')) || 'https://api.typesafe.ai'
      const req = jevRequest(table, plugin, e)
      const init = { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(req.body) }
      const res = await Promise.race([$.http.fetch(base + req.path, init), $.clock.sleep(r.timeoutMs).then(() => null)])
      const reply = res && res.ok ? JSON.parse(res.text) : null
      return (policyTier(table, plugin, e, reply) || {}).tier || ''
    }
    const res = await $.model.complete(routerRequest(table, plugin, e))
    const reply = res && res.isAnswered ? res.text : null
    return (policyTier(table, plugin, e, reply) || {}).tier || ''
  } catch {
    return ''
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
  const lines = [`Model Router ${table.updated} (${ageDays(table, now)} days old): routes ${range()}, safety net ${settings.fill ? 'on' : 'off'}.`, autoLine()]
  lines.push(`Agent types (${registered.length} of ${table.order.length} registered):`)
  for (const n of table.order) {
    const off = offered.includes(n) ? '' : ` (off: /${commandName} fable turns it on; calls go to ${plugin}:${capTier(table)})`
    lines.push(`  ${`${plugin}:${n}`.padEnd(26)} ${tag(table.tiers[n]).padEnd(14)} ${table.tiers[n].description}${off}`)
  }
  lines.push(`  general agent with nothing set -> ${tag(table.fill)}`)
  lines.push(`  general or built-in agent with only a model -> the effort of that model's first tier`)
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
  lines.push(`Settings: /${commandName} (Haiku up to Opus) · /${commandName} fable (up to Fable) · /${commandName} auto on|off · /${commandName} fill on|off · /${commandName} stats reset`)
  return lines.join('\n')
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    plugin = $.plugin.name || plugin
    const saved = await $.store.get('settings')
    if (saved && typeof saved === 'object') Object.assign(settings, saved)
    if (settings.ceiling !== 'fable') settings.ceiling = 'opus'
    if (typeof settings.auto !== 'boolean') settings.auto = undefined
    await loadTable($)
    if (table) await registerTypes($)
    for (const name of ['route', 'model-router']) {
      try {
        await $.command.register({ name, description: 'Model Router: route Haiku up to Opus (/route) or up to Fable (/route fable), and what the router did', argumentHint: '[fable|auto on|off|fill on|off|stats reset]', immediate: true })
        commandName = name
        break
      } catch {
        // taken: try the next name
      }
    }
    await showStatus($)
    return next(e)
  })

  // The policy, then the safety net: never refuses and never touches the prompt; subagent_type changes only
  // to move our own tier type to the routed tier's, or the hidden frontier type to the cap's
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (!table) return next(e)
    const tier = routes(e) ? await decide($, e) : ''
    const plan = tier ? routedPlan(table, plugin, e, tier) : capPlan(table, plugin, e, planAgentCall(table, plugin, e, settings.fill), settings.ceiling)
    const frontier = isFrontier(table, plan)
    remember({ ...plan, what: `${e.subagent_type || 'agent'}: ${String(e.description || '').slice(0, 20)}` })
    try {
      await $.store.set('stats', countDecision(await $.store.get('stats'), plan, frontier, await $.clock.now()))
    } catch {
      // the count is a convenience
    }
    if (plan.action !== 'keep' || frontier) await showStatus($, `${e.subagent_type || 'agent'} → ${tag(plan)}${frontier ? ' (frontier)' : ''}${plan.action === 'capped' ? ' (capped)' : ''}${plan.action === 'routed' ? ' (routed)' : ''}`)
    return next(plan.set ? { ...e, ...plan.set } : e)
  }).catch(($, e, next) => next(e))

  // A type the start could not register (the session not bound yet) is tried again before a turn
  on('prompt.submit', async ($, e, next) => {
    if (table && registered.length < table.order.length && attempts < 4) await registerTypes($)
    return next(e)
  })

  // Under the Opus ceiling the frontier type is neither listed to Claude nor dispatched;
  // tool.call has already moved a call naming it to the cap tier's type
  on('agent.offer', async ($, e, next) => {
    if (table && table.frontier && e.agent === `${plugin}:${table.frontier}` && settings.ceiling !== 'fable') return { isOffered: false }
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!table || !registered.length || !e.tools.includes('Agent')) return r
    return { sections: [...r.sections, { id: 'model-router:policy', text: policyText(table, plugin, settings.ceiling, autoOn() && table.router.policy !== 'today'), scope: 'session' }] }
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
    if (k === 'auto' && ['on', 'off'].includes(v)) {
      settings.auto = v === 'on'
      await $.store.set('settings', settings)
      return { text: autoLine() }
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
    return { text: `Not an option: /${commandName} ${String(e.args || '').trim()}. ${await statusText($)}` }
  })
}
