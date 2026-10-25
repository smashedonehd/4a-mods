// Runs one routing policy over the sampled calls and scores it against gold. Every model reply is
// cached, so a second run of the same configuration costs nothing. Before any model call every mode
// that can make one (the split runs, --record, --live, --one) estimates the spend and stops above
// --budget unless --yes is given; --dry only estimates. --live reads no cache, so its estimate counts
// every call. A transport error (spend limit, timeout, network) aborts the run without writing
// results: it is never scored as the router's fallback.
//
//   node model-router/eval/run.mjs --policy today|text|rules|jev --split train|heldout|all
//        [--model haiku|sonnet|opus --effort low|medium] [--descriptions-from <git-ref>] [--theta 0.8]
//        [--gold provisional] [--dry] [--budget 0.5] [--yes] [-j 8]
//        [--heldout-row <name> [--again]] [--tuning "<one-sentence change>"] [--final <row>]
//   node model-router/eval/run.mjs --record [--dry]  decisions.json from the shipped policy, all 400
//   node model-router/eval/run.mjs --rescore         results.winner.metrics from repo files only, no model call
//   node model-router/eval/run.mjs --live [--dry]    the shipped policy on all 400, no cache reads (about
//                                                    400 router calls: over the default --budget, so --yes)
//   node model-router/eval/run.mjs --one <file.json> [--dry]  the shipped policy's decision for one call
//   MODEL_ROUTER_EVAL_ACCOUNT=2 ...                  on the second account

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { POLICIES, invalidTable, routerRequest, jevRequest, jevHttp } from '../hooks/route.mjs'
import { cached, complete, isCached, pool } from './claude.mjs'
import { hashInputs, policyInputs, policyHash } from './hash.mjs'
import { loadTable, readJson, readJsonl, writeJson } from './io.mjs'
import { eventOf, filterCalls, heldoutRecord, heldoutRefusal, loadAgentDefs, policyDecision, withDescriptions } from './lib.mjs'
import { criteria, invalidMetrics, pairOf, printConfusion, score, weightsFor } from './metrics.mjs'
import { CALLS, DATA, DECISIONS, GOLD, GOLD_PROVISIONAL, RESULTS, SAMPLE, TABLE } from './paths.mjs'

const P = 'model-router'
// Estimated USD per uncached router call by model (measured: haiku low ~$0.0002 on a short prompt,
// opus high ~$0.028 on a judge prompt); a router prompt is a few thousand tokens in, ~50 out
const EST = { haiku: 0.0006, sonnet: 0.012, opus: 0.03 }

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
function opt(name, fallback) {
  const i = argv.indexOf(name)
  if (i < 0) return fallback
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) die(`${name} needs a value`)
  return v
}
function die(msg) {
  console.error(msg)
  process.exit(2)
}
const today = () => new Date().toISOString().slice(0, 10)
// Metrics as results.json keeps them: without the per-category counts
const brief = (m) => ({ ...m, byCategory: undefined })

// Why the eval cannot use a table: what the hook refuses, or what the metrics need
const invalid = (t) => invalidTable(t) || invalidMetrics(t)

const shipped = loadTable()
const refused = invalid(shipped)
if (refused) die(`routing.json refused: ${refused}`)
const concurrency = Number(opt('-j', 8)) || 8

// The table a run uses: the shipped one, or a variant for tuning
function variantTable() {
  let t = shipped
  const ref = opt('--descriptions-from')
  if (ref) {
    const root = execFileSync('git', ['-C', dirname(TABLE), 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
    t = withDescriptions(t, JSON.parse(execFileSync('git', ['-C', root, 'show', `${ref}:model-router/routing.json`], { encoding: 'utf8' })))
  }
  const router = { ...t.router }
  if (opt('--model')) router.model = opt('--model')
  if (opt('--effort')) router.effort = opt('--effort')
  if (opt('--theta')) router.jev = { ...router.jev, theta: Number(opt('--theta')) }
  if (opt('--policy')) router.policy = opt('--policy')
  if (!POLICIES.includes(router.policy)) die(`--policy must be one of ${POLICIES.join(', ')}`)
  if (!t.models[router.model]) die(`unknown router model ${router.model}`)
  const variant = { ...t, router }
  const why = invalid(variant)
  if (why) die(`variant table refused: ${why}`)
  return variant
}

// The request a policy sends for one call, and the cache it lives in; null for today (no model)
function requestOf(table, call) {
  const e = eventOf(call)
  if (table.router.policy === 'today') return null
  if (table.router.policy === 'jev') return { cache: 'jev', req: jevRequest(table, P, e) }
  return { cache: 'router', req: { ...routerRequest(table, P, e), modelId: table.models[table.router.model].id } }
}

// Every call with its request, built once for the estimate and the run
const jobsOf = (table, calls) => calls.map((call) => ({ call, r: requestOf(table, call) }))

async function callJev(req) {
  const key = process.env.TYPESAFE_API_KEY
  if (!key) throw new Error('jev needs TYPESAFE_API_KEY')
  const { url, init } = jevHttp(process.env.TYPESAFE_BASE_URL, key, req)
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60000) })
  const text = await res.text()
  if (!res.ok) throw new Error(`jev HTTP ${res.status}: ${text.slice(0, 300)}`)
  return { reply: JSON.parse(text), costUsd: 0 }
}

// claude -p needs seconds to start, so the eval allows far more than the hook's timeoutMs; the cache key
// stays the request as the hook sends it
const callRouter = (table) => (req) => complete(table, { ...req, timeoutMs: 180000 }).then((o) => ({ text: o.text, costUsd: o.costUsd }))

// Estimated USD of one uncached call: EST at low effort, times the cost model's factor for the router's
// effort over low's; a Jev call is not billed here
function perCallUsd(table) {
  const { policy, model, effort } = table.router
  return policy === 'jev' ? 0 : (EST[model] * table.costModel.effort[effort]) / table.costModel.effort.low
}

// Decides every job (jobsOf); returns {decisions, categories, fallbacks, errors, spent, policyCost, misses}
async function decideAll(table, jobs, { live = false } = {}) {
  const defs = loadAgentDefs(homedir())
  const per = perCallUsd(table)
  const cacheName = (c) => (live ? `live-${today()}-${c}` : c)
  const out = { decisions: {}, categories: {}, fallbacks: [], errors: [], spent: 0, policyCost: 0, misses: 0 }
  await pool(jobs, concurrency, async ({ call, r }) => {
    let reply = null
    if (r) {
      const send = r.cache === 'jev' ? callJev : callRouter(table)
      // cached runs this only for a request it does not answer, so each run is a new model call
      const run = (req) => {
        out.misses++
        out.spent += per
        return send(req)
      }
      try {
        const v = await cached(cacheName(r.cache), r.req, run, { read: !live })
        reply = r.cache === 'jev' ? v.reply : v.text
        out.policyCost += v.costUsd || 0
      } catch (e) {
        out.errors.push(`${call.id}: ${e.message}`)
        return
      }
    }
    const d = policyDecision(table, P, call, reply, defs)
    out.decisions[call.id] = d.decision
    if (d.category) out.categories[call.id] = d.category
    if (d.fallback) out.fallbacks.push(call.id)
  })
  return out
}

// Uncached calls and their estimated cost, before anything runs; a live run reads no cache, so every call counts
function estimate(table, jobs, live) {
  const misses = jobs.filter(({ r }) => r && (live || !isCached(r.cache, r.req))).length
  return { misses, usd: misses * perCallUsd(table) }
}

// Every mode that can call a model passes here first: --dry stops after the estimate, and an estimate
// over --budget stops unless --yes
function guard(table, jobs, { live = false } = {}) {
  const { misses, usd } = estimate(table, jobs, live)
  const where = process.env.MODEL_ROUTER_EVAL_ACCOUNT === '2' ? 'account 2' : 'account 1'
  console.log(`plan: ${jobs.length} calls, ${misses} uncached${live ? ' (live: no cache reads)' : ''}, est. $${usd.toFixed(3)} on ${where} (policy ${table.router.policy}, router ${table.router.model} ${table.router.effort})`)
  if (flag('--dry')) process.exit(0)
  const budget = Number(opt('--budget', 0.5))
  if (usd > budget && !flag('--yes')) die(`estimate $${usd.toFixed(3)} is over --budget ${budget}; pass --yes or a higher --budget`)
}

const label = (table, d) => {
  if (typeof d === 'string') return d
  const t = Object.keys(table.tiers).find((k) => table.tiers[k].model === d.model && table.tiers[k].effort === d.effort)
  return t ? `${t}*` : `${d.model}/${d.effort}`
}

function loadGold() {
  const src = opt('--gold')
  const file = src === 'provisional' ? GOLD_PROVISIONAL : src || GOLD
  if (!existsSync(file)) die(`no gold at ${file}: run eval/gold.mjs (or eval/gold.mjs --provisional and --gold provisional)`)
  return { gold: readJson(file), provisional: file !== GOLD }
}

function report(table, gold, res, sample) {
  const corpus = filterCalls(readJsonl(CALLS))
  const m = score(table, gold, res.decisions)
  const w = score(table, gold, res.decisions, weightsFor(corpus, sample))
  const c = criteria(table, m)
  const pct = (x) => `${(x * 100).toFixed(1)} %`
  console.log(`\nn ${m.n}  agreement ${pct(m.agreement)}  under ${pct(m.under)}  underCritical ${m.underCritical} (${pct(m.underCriticalRate)})  cost vs gold ${m.costRatio.toFixed(3)} (${pct(m.costOver)} over)`)
  console.log(`weighted to the corpus: agreement ${pct(w.agreement)}  under ${pct(w.under)}  cost vs gold ${w.costRatio.toFixed(3)}`)
  console.log(`criteria: ${c.pass ? 'PASS' : `miss ${c.missed.join(', ')}`}`)
  console.log(`by stratum: ${Object.entries(m.byStratum).map(([k, x]) => `${k} ${x.agree}/${x.n} (under ${x.under})`).join(', ')}`)
  const labels = new Map(gold.map((g) => [g.id, label(table, res.decisions[g.id])]))
  const cols = [...new Set(labels.values())].sort()
  const rows = [...new Set(gold.map((g) => g.tier))].sort((a, b) => table.order.indexOf(a) - table.order.indexOf(b))
  printConfusion("confusion (rows gold, columns decision; * = today's plan landing on a tier)", rows, cols, gold.map((g) => [g.tier, labels.get(g.id)]), 13)
  const byId = new Map(sample.map((s) => [s.id, s]))
  const wrong = gold.filter((g) => labels.get(g.id).replace(/\*$/, '') !== g.tier)
  console.log(`\nerrors (${wrong.length}):`)
  for (const g of wrong) console.log(`  ${g.id}  gold ${g.tier}/${g.category}  got ${labels.get(g.id)}  ${String(byId.get(g.id).description || '').slice(0, 80)}`)
  console.log(`\nfallbacks ${res.fallbacks.length}, new model calls ${res.misses}, spent now ~$${res.spent.toFixed(4)}, policy cost over these calls $${res.policyCost.toFixed(4)}`)
  return { m, w, c }
}

function failOnErrors(res) {
  if (!res.errors.length) return
  console.error(`\n${res.errors.length} calls failed; nothing written, rerun resumes from cache:\n  ${res.errors.slice(0, 10).join('\n  ')}`)
  process.exit(1)
}

if (flag('--one')) {
  const e = readJson(opt('--one'))
  const call = { id: 'one', type: e.subagent_type || '', description: e.description || '', prompt: e.prompt || '', model: '', effort: '', parentModel: '', parentEffort: '' }
  const jobs = jobsOf(shipped, [call])
  guard(shipped, jobs)
  const res = await decideAll(shipped, jobs)
  failOnErrors(res)
  const d = res.decisions.one
  console.log(JSON.stringify({ policy: shipped.router.policy, tier: typeof d === 'string' ? d : undefined, ...pairOf(shipped, d), fallback: res.fallbacks.length > 0 }))
} else if (flag('--rescore')) {
  const results = readJson(RESULTS)
  const dec = readJson(DECISIONS)
  if (!results || !results.winner || !dec) die('--rescore needs results.json with a winner and decisions.json')
  const gold = readJson(GOLD).filter((g) => g.split === 'heldout')
  results.winner.metrics = score(shipped, gold, dec.decisions)
  writeJson(RESULTS, results)
  console.log(`winner ${results.winner.row}: ${JSON.stringify({ ...brief(results.winner.metrics), byStratum: undefined })}`)
} else if (flag('--record')) {
  for (const f of ['--model', '--effort', '--theta', '--descriptions-from', '--policy', '--gold']) if (flag(f)) die(`--record takes the policy from routing.json only; drop ${f}`)
  const jobs = jobsOf(shipped, readJsonl(SAMPLE))
  guard(shipped, jobs)
  const t0 = Date.now()
  const res = await decideAll(shipped, jobs)
  failOnErrors(res)
  const inputs = policyInputs(shipped)
  writeJson(DECISIONS, { policy: shipped.router.policy, policyHash: hashInputs(inputs), router: inputs.router, recorded: today(), decisions: Object.fromEntries(Object.entries(res.decisions).sort()) })
  console.log(`${Object.keys(res.decisions).length} decisions, ${res.misses} cache misses, fallbacks ${res.fallbacks.length}, ${Math.round((Date.now() - t0) / 1000)} s -> ${DECISIONS}`)
} else if (flag('--live')) {
  const dec = readJson(DECISIONS)
  if (!dec) die('--live needs decisions.json')
  const sample = readJsonl(SAMPLE)
  const jobs = jobsOf(shipped, sample)
  guard(shipped, jobs, { live: true })
  const res = await decideAll(shipped, jobs, { live: true })
  failOnErrors(res)
  const changed = sample.filter((c) => JSON.stringify(res.decisions[c.id]) !== JSON.stringify(dec.decisions[c.id])).map((c) => c.id)
  const gold = readJson(GOLD).filter((g) => g.split === 'heldout')
  const m = score(shipped, gold, res.decisions)
  const c = criteria(shipped, m)
  const out = { at: new Date().toISOString(), policy: shipped.router.policy, policyHash: policyHash(shipped), n: sample.length, changed: changed.length, changedShare: changed.length / sample.length, changedIds: changed, heldout: brief(m), criteria: c, policyCost: res.policyCost }
  const file = join(DATA, `live-${today()}.json`)
  writeJson(file, out)
  console.log(`changed ${changed.length}/${sample.length}, held-out agreement ${(m.agreement * 100).toFixed(1)} %, under ${(m.under * 100).toFixed(1)} %, criteria ${c.pass ? 'PASS' : `miss ${c.missed.join(', ')}`} -> ${file}`)
  if (out.changedShare > 0.05 || (shipped.router.default === 'on' && !c.pass)) process.exit(1)
} else {
  const split = opt('--split')
  if (!['train', 'heldout', 'all'].includes(split)) die('--split must be train, heldout or all')
  const row = opt('--heldout-row')
  const note = opt('--tuning')
  const fin = opt('--final')
  // Every flag is checked before guard (which can exit on cost) or decideAll (which spends), so a
  // bad combination never runs a call it could not record
  if ((split === 'heldout' || split === 'all') && !row) die(`--split ${split} needs --heldout-row`)
  if (note && split !== 'train') die('--tuning records train runs only')
  if (fin && split !== 'train') die('--final records a train run on the final gold')
  const table = variantTable()
  const { gold: allGold, provisional } = loadGold()
  if (fin && provisional) die('--final records a train run on the final gold')
  const gold = allGold.filter((g) => split === 'all' || g.split === split)
  const ids = new Set(gold.map((g) => g.id))
  const sample = readJsonl(SAMPLE)
  const calls = sample.filter((c) => ids.has(c.id))
  const results = readJson(RESULTS, { heldoutRuns: 0, heldout: {}, tuning: { rounds: [], final: {} } })
  const inputs = policyInputs(table)
  const hash = hashInputs(inputs)
  if (row) {
    if (split !== 'heldout') die('--heldout-row needs --split heldout')
    if (provisional) die('--heldout-row needs the final gold.json, not provisional gold')
    const prev = results.heldout[row]
    if (prev && prev.policyHash === hash && !flag('--again')) die(`held-out row ${row} already ran with this policy (${prev.at}); the held-out split runs once. --again to rerun`)
    // Before any call: a refused row must not be run, since its metrics would be seen and not recorded
    const refusal = heldoutRefusal(results, row, hash)
    if (refusal) die(refusal)
  }
  const jobs = jobsOf(table, calls)
  guard(table, jobs)
  const res = await decideAll(table, jobs)
  failOnErrors(res)
  const { m, w, c } = report(table, gold, res, sample)
  const { router } = inputs
  let nextResults = results
  if (row) {
    const entry = { metrics: m, weighted: w, criteria: c, router, policy: table.router.policy, policyHash: hash, routerCostUsd: res.policyCost, at: new Date().toISOString() }
    nextResults = heldoutRecord(results, row, hash, entry).results
  }
  if (note) {
    nextResults = { ...nextResults, tuning: { ...nextResults.tuning, rounds: [...nextResults.tuning.rounds, { round: nextResults.tuning.rounds.length + 1, change: note, policy: table.router.policy, router, policyHash: hash, metrics: brief(m), gold: provisional ? 'provisional' : 'final', at: today() }] } }
  }
  if (fin) {
    nextResults = { ...nextResults, tuning: { ...nextResults.tuning, final: { ...nextResults.tuning.final, [fin]: { router, descriptionsFrom: opt('--descriptions-from') || null, policyHash: hash, metrics: brief(m), at: today() } } } }
  }
  if (row || note || fin) {
    writeJson(RESULTS, nextResults)
    console.log(`-> ${RESULTS}`)
  }
}
