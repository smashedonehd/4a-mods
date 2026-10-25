// Run: node model-router/test/eval-lib.test.mjs
// Checks the eval's pure parts: the sample and its split, the judges' prompts and replies,
// the metrics, the policy hash and today's router as a baseline. No model is called.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rng, stratumOf, STRATA, drawSample, filterCalls, heldoutRecord, judgeRequest, parseJudge, disagrees, familyOf, todayDecision, withDescriptions, policyDecision, buildGold, saferVerdict } from '../eval/lib.mjs'
import { costOf, rankOf, score, criteria, kappa, weightsFor } from '../eval/metrics.mjs'
import { policyInputs, policyHash, noEol } from '../eval/hash.mjs'

const table = JSON.parse(readFileSync(new URL('../routing.json', import.meta.url), 'utf8'))
const P = 'model-router'
let n = 0
function check(name, fn) {
  fn()
  n++
  console.log(`ok ${n} ${name}`)
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`)

check('rng is deterministic', () => {
  const a = rng(20261025)
  const b = rng(20261025)
  const c = rng(1)
  const first = [a(), a(), a(), a(), a()]
  assert.deepEqual([b(), b(), b(), b(), b()], first)
  assert.notDeepEqual([c(), c(), c(), c(), c()], first)
  assert.ok(first.every((x) => x >= 0 && x < 1))
})

check('strata from descriptions', () => {
  const s = (description, extra = {}) => stratumOf({ type: 'general-purpose', description, prompt: 'x', ...extra })
  assert.equal(s('Review správnosti a bezpečnosti'), 'security')
  assert.equal(s('Re-review fix round 1'), 'review')
  assert.equal(s('Design dashboard architecture'), 'architecture')
  assert.equal(s('Implement plan A Task 7'), 'implement')
  assert.equal(s('Find Upgates Chrome addon'), 'search')
  assert.equal(s('Visual read FV batch 7'), 'summarize')
  assert.equal(s('Research WP site-building add-ons'), 'research')
  assert.equal(s('Wrap-up + state'), 'other')
  assert.equal(s('Wrap-up + state', { prompt: 'Look for a vulnerability in the login form' }), 'security')
  assert.equal(stratumOf({ type: 'lisa-reviewer', description: 'PR 12', prompt: 'x' }), 'review')
})

const KINDS = { security: 'Security audit of', review: 'Review task', architecture: 'Design the architecture of', implement: 'Implement task', search: 'Find file', summarize: 'Summarize log', research: 'Research topic', other: 'Wrap-up' }
function corpus(perStratum = 300, sessions = 60, only = {}) {
  const calls = []
  let i = 0
  for (const [stratum, words] of Object.entries(KINDS)) {
    const count = only[stratum] ?? perStratum
    for (let k = 0; k < count; k++, i++) {
      calls.push({ id: `c${i}`, session: `s${i % sessions}`, type: k % 3 ? 'general-purpose' : 'opus-medium', description: `${words} ${k}`, prompt: `Prompt for call number ${i}, long enough.` })
    }
  }
  for (let k = 0; k < 10; k++) calls.push({ ...calls[k * 7], id: `dup${k}` })
  for (let k = 0; k < 5; k++) calls.push({ id: `fork${k}`, session: 's1', type: 'fork', description: `Implement fork ${k}`, prompt: `A forked task number ${k}, long enough.` })
  return calls
}

check('the sample is stratified, deduplicated and split 80/20 by session', () => {
  const calls = corpus()
  const sample = drawSample(calls)
  assert.equal(sample.length, 400)
  for (const [stratum, size] of Object.entries(STRATA)) {
    const got = sample.filter((c) => c.stratum === stratum)
    assert.equal(got.length, size, stratum)
    assert.equal(got.filter((c) => c.split === 'heldout').length, size / 5, stratum)
  }
  assert.equal(sample.filter((c) => c.split === 'heldout').length, 80)
  assert.ok(!sample.some((c) => c.type === 'fork' || c.id.startsWith('dup')))
  assert.equal(new Set(sample.map((c) => `${c.description}\u0000${c.prompt.slice(0, 500)}`)).size, 400)
  const held = new Set(sample.filter((c) => c.split === 'heldout').map((c) => c.session))
  assert.ok(!sample.some((c) => c.split === 'train' && held.has(c.session)))
  assert.deepEqual(drawSample(calls).map((c) => c.id), sample.map((c) => c.id))
})

check('a small stratum gives all it has and other takes the rest', () => {
  const sample = drawSample(corpus(300, 60, { research: 3 }))
  assert.equal(sample.length, 400)
  assert.equal(sample.filter((c) => c.stratum === 'research').length, 3)
  assert.equal(sample.filter((c) => c.stratum === 'other').length, STRATA.other + STRATA.research - 3)
  assert.equal(sample.filter((c) => c.split === 'heldout').length, 80)
})

check('judges see the routable tiers, and the recommender sees both verdicts', () => {
  const call = { type: 'opus-high', description: 'Review Task 3', prompt: 'Check the diff.' }
  const a = judgeRequest(table, P, call, 'A')
  const b = judgeRequest(table, P, call, 'B')
  assert.deepEqual([a.model, a.effort], ['opus', 'high'])
  for (const r of [a, b]) {
    assert.ok(!/frontier|fable/i.test(r.system))
    assert.match(r.prompt, /Agent type: general-purpose/)
  }
  assert.match(b.system, /one tier lower/)
  assert.notEqual(a.system, b.system)
  const r = judgeRequest(table, P, call, 'R', { A: { tier: 'standard', category: 'review', reason: 'ra' }, B: { tier: 'deep', category: 'review', reason: 'rb' } })
  assert.match(r.prompt, /standard/)
  assert.match(r.prompt, /rb/)
})

check('judge replies parse and disagreements follow the rule', () => {
  assert.deepEqual(parseJudge(table, 'Thinking...\n{"category":"review","tier":"deep","reason":"A diff review."}'), { tier: 'deep', category: 'review', reason: 'A diff review.' })
  assert.equal(parseJudge(table, '{"category":"review","tier":"frontier","reason":"x"}'), null)
  assert.equal(parseJudge(table, 'no json'), null)
  // Braces inside the reason (a judge quoting `{model, effort}`) must not split the object
  assert.deepEqual(parseJudge(table, '{"category": "review", "tier": "deep", "reason": "Every type × {model, effort} pair."}'), { tier: 'deep', category: 'review', reason: 'Every type × {model, effort} pair.' })
  assert.deepEqual(parseJudge(table, 'Draft {"tier": "quick"} then {"category": "search", "tier": "light", "reason": "x"}'), { tier: 'light', category: 'search', reason: 'x' })
  const v = (tier, category) => ({ tier, category, reason: '' })
  assert.equal(disagrees(table, v('quick', 'search'), v('light', 'search')), true)
  assert.equal(disagrees(table, v('deep', 'review'), v('deep', 'implement')), true)
  assert.equal(disagrees(table, v('quick', 'search'), v('quick', 'summarize')), false)
  assert.equal(disagrees(table, v('deep', 'review'), v('deep', 'security')), false)
})

check('tier costs follow the labelled assumption', () => {
  const tiers = Object.fromEntries(['quick', 'light', 'standard', 'deep', 'long'].map((t) => [t, costOf(table, table.tiers[t].model, table.tiers[t].effort)]))
  near(tiers.quick, 0.09)
  near(tiers.light, 0.18)
  near(tiers.standard, 3.6)
  near(tiers.deep, 11.52)
  near(tiers.long, 18)
  assert.ok(rankOf(table, 'opus', 'medium') < rankOf(table, 'opus', 'high'))
  assert.ok(rankOf(table, 'sonnet', 'max') < rankOf(table, 'opus', 'low'))
})

const gold5 = [
  { id: 'a', tier: 'quick', category: 'search', stratum: 'search' },
  { id: 'b', tier: 'standard', category: 'implement', stratum: 'implement' },
  { id: 'c', tier: 'deep', category: 'review', stratum: 'review' },
  { id: 'd', tier: 'deep', category: 'security', stratum: 'security' },
  { id: 'e', tier: 'light', category: 'summarize', stratum: 'summarize' },
]
const dec5 = { a: 'quick', b: 'standard', c: 'standard', d: 'deep', e: 'standard' }

check('score on a hand-built set', () => {
  const m = score(table, gold5, dec5)
  assert.equal(m.n, 5)
  near(m.agreement, 0.6)
  near(m.under, 0.2)
  assert.equal(m.underCritical, 1)
  near(m.underCriticalRate, 0.5)
  near(m.costRatio, (0.09 + 3.6 + 3.6 + 11.52 + 3.6) / (0.09 + 3.6 + 11.52 + 11.52 + 0.18))
  near(m.costOver, m.costRatio - 1)
  assert.deepEqual(m.byCategory.review, { n: 1, agree: 0, under: 1 })
  // A pair outside the tiers is never agreement; below the gold tier it is an underestimate
  const opusMedium = { model: 'opus', effort: 'medium' }
  const deep = score(table, [gold5[2]], { c: opusMedium })
  assert.deepEqual([deep.agreement, deep.under, deep.underCritical], [0, 1, 1])
  const standard = score(table, [gold5[1]], { b: opusMedium })
  assert.deepEqual([standard.agreement, standard.under], [0, 0])
  // Weights change the weighted rates, not the per-stratum counts
  const w = score(table, gold5, dec5, { search: 2 })
  assert.deepEqual(w.byStratum, m.byStratum)
  near(w.agreement, 4 / 6)
  assert.throws(() => score(table, gold5, { a: 'quick' }), /no decision/)
})

check('weights are corpus share over sample share', () => {
  const corpusCalls = [...Array(9)].map(() => ({ stratum: 'review' })).concat([{ stratum: 'search' }])
  const sample = [{ stratum: 'review' }, { stratum: 'search' }]
  const w = weightsFor(corpusCalls, sample)
  near(w.review, 0.9 / 0.5)
  near(w.search, 0.1 / 0.5)
})

check('criteria name what is missed', () => {
  assert.deepEqual(criteria(table, { agreement: 0.9, under: 0, underCriticalRate: 0.06, costOver: 0.2 }), { pass: false, missed: ['underCritical', 'costOver'] })
  assert.deepEqual(criteria(table, { agreement: 0.1, under: 0.05, underCriticalRate: 0.05, costOver: 0.15 }), { pass: true, missed: [] })
  assert.deepEqual(criteria(table, { agreement: 1, under: 0.06, underCriticalRate: 0, costOver: 0 }), { pass: false, missed: ['under'] })
})

check('kappa', () => {
  assert.equal(kappa(['a', 'b', 'a'], ['a', 'b', 'a']), 1)
  assert.ok(kappa(['a', 'b'], ['b', 'a']) < 0)
})

check('the policy hash covers the policy and nothing else', () => {
  const h = policyHash(table)
  assert.match(h, /^[0-9a-f]{64}$/)
  assert.equal(policyHash(Object.fromEntries(Object.entries(table).reverse())), h)
  const changed = [
    { ...table, tiers: { ...table.tiers, quick: { ...table.tiers.quick, description: `${table.tiers.quick.description} More.` } } },
    { ...table, rules: [{ ...table.rules[0], floor: 'long' }] },
    { ...table, router: { ...table.router, model: table.router.model === 'haiku' ? 'sonnet' : 'haiku' } },
    { ...table, router: { ...table.router, jev: { ...table.router.jev, theta: 0.9 } } },
    { ...table, categories: [...table.categories, 'poetry'] },
  ]
  for (const t of changed) assert.notEqual(policyHash(t), h)
  const same = [
    { ...table, router: { ...table.router, default: table.router.default === 'on' ? 'off' : 'on' } },
    { ...table, costModel: { ...table.costModel, inputShare: 0.5 } },
    { ...table, models: { ...table.models, opus: { ...table.models.opus, price: { in: 1, out: 2 } } } },
    { ...table, thresholds: { ...table.thresholds, under: 0.5 } },
    { ...table, updated: '2030-01-01', sources: [] },
  ]
  for (const t of same) assert.equal(policyHash(t), h)
  const code = policyInputs(table).code.join('\n')
  assert.match(code, /function blindView/)
  assert.match(code, /function applyRules/)
  assert.match(code, /9000/)
})

check('the hash normalises line endings, so a CRLF checkout hashes the same as an LF one', () => {
  const fn = function example() {
    return 1
  }
  const lf = fn.toString()
  const crlf = lf.replace(/\n/g, '\r\n')
  assert.notEqual(lf, crlf)
  assert.equal(noEol(crlf), lf)
  assert.equal(noEol(lf), lf)
})

check('the policy hash also covers the router model\'s pinned id', () => {
  const h = policyHash(table)
  const otherAlias = Object.keys(table.models).find((a) => a !== table.router.model) || table.router.model
  const changedId = { ...table, models: { ...table.models, [table.router.model]: { ...table.models[table.router.model], id: 'some-other-id' } } }
  assert.notEqual(policyHash(changedId), h)
  assert.equal(policyInputs(table).router.modelId, table.models[table.router.model].id)
  void otherAlias
})

check('filterCalls drops forks and near-empty prompts and dedupes, exactly as drawSample\'s pool does', () => {
  const calls = [
    { id: 'a', description: 'd', prompt: 'A long enough prompt for a.' },
    { id: 'dup', description: 'd', prompt: 'A long enough prompt for a.' },
    { id: 'fork', type: 'fork', description: 'd', prompt: 'A long enough prompt for a fork.' },
    { id: 'short', description: 'd', prompt: 'short' },
  ]
  const pool = filterCalls(calls)
  assert.deepEqual(pool.map((c) => c.id), ['a'])
  assert.equal(pool[0].stratum, stratumOf(calls[0]))
})

check('a held-out run is refused without a matching tuned final row, and keeps history instead of overwriting', () => {
  const miss = heldoutRecord({ tuning: { final: {} } }, 'r1', 'h1', { at: 'now' })
  assert.match(miss.error, /needs a tuning\.final\[r1\]/)
  const wrongHash = heldoutRecord({ tuning: { final: { r1: { policyHash: 'other' } } } }, 'r1', 'h1', { at: 'now' })
  assert.match(wrongHash.error, /tuning\.final\[r1\]/)
  const base = { tuning: { final: { r1: { policyHash: 'h1' } } }, heldout: { r1: { policyHash: 'h1', at: 'first' } }, heldoutRuns: 1 }
  const again = heldoutRecord(base, 'r1', 'h1', { policyHash: 'h1', at: 'second' })
  assert.equal(again.error, undefined)
  assert.deepEqual(again.results.heldoutHistory, [{ row: 'r1', policyHash: 'h1', at: 'first' }])
  assert.deepEqual(again.results.heldout.r1, { policyHash: 'h1', at: 'second' })
  assert.equal(again.results.heldoutRuns, 2)
})

check('a table with the descriptions of another', () => {
  const other = { ...table, tiers: Object.fromEntries(Object.entries(table.tiers).map(([k, t]) => [k, { ...t, description: `old ${k}` }])) }
  const t = withDescriptions(table, other)
  assert.equal(t.tiers.deep.description, 'old deep')
  assert.equal(t.tiers.deep.model, table.tiers.deep.model)
  assert.equal(table.tiers.deep.description === 'old deep', false)
})

check("today's router on recorded calls", () => {
  const defs = new Map([['opus-medium', { model: 'opus', effort: 'medium' }]])
  const today = (call) => todayDecision(table, P, { parentModel: 'claude-opus-5-5', parentEffort: '', model: '', effort: '', ...call }, defs)
  assert.deepEqual(today({ type: 'opus-medium' }), { model: 'opus', effort: 'medium' })
  assert.deepEqual(today({ type: 'general-purpose', model: 'sonnet' }), { model: 'sonnet', effort: 'medium' })
  assert.deepEqual(today({ type: 'general-purpose' }), { model: 'opus', effort: 'medium' })
  assert.deepEqual(today({ type: '', model: 'fable' }), { model: 'opus', effort: 'xhigh' })
  assert.deepEqual(today({ type: 'Explore' }), { model: 'haiku', effort: 'low' })
  assert.deepEqual(today({ type: 'model-router:standard' }), { model: 'sonnet', effort: 'medium' })
  assert.deepEqual(today({ type: 'mystery', parentModel: 'claude-opus-4-8' }), { model: 'opus', effort: 'medium' })
  assert.deepEqual(today({ type: 'mystery', parentModel: 'claude-sonnet-5', parentEffort: 'high' }), { model: 'sonnet', effort: 'high' })
  assert.equal(familyOf('claude-haiku-4-5-20251001'), 'haiku')
  assert.equal(familyOf('inherit'), '')
})

check('a policy decides from the reply, and an unusable reply falls back to today', () => {
  const defs = new Map()
  const call = { type: 'general-purpose', description: 'Review Task 3', prompt: 'x', model: '', effort: '', parentModel: 'claude-opus-5-5', parentEffort: '' }
  const d = (policy, reply, c = call) => policyDecision(table, P, c, policy, reply, defs)
  assert.deepEqual(d('text', '{"category":"search","tier":"quick"}'), { decision: 'quick', category: 'search', fallback: false })
  assert.deepEqual(d('rules', '{"category":"search","tier":"quick"}'), { decision: 'deep', category: 'search', fallback: false })
  assert.deepEqual(d('text', 'no json'), { decision: { model: 'opus', effort: 'medium' }, category: null, fallback: true })
  assert.deepEqual(d('text', '{"tier":"frontier"}'), { decision: { model: 'opus', effort: 'medium' }, category: null, fallback: true })
  assert.deepEqual(d('jev', { answers: { tier: { probabilities: { quick: 0.9, light: 0.1 } } } }), { decision: 'quick', category: null, fallback: false })
  assert.deepEqual(d('jev', {}), { decision: { model: 'opus', effort: 'medium' }, category: null, fallback: true })
  assert.deepEqual(d('today', null), { decision: { model: 'opus', effort: 'medium' }, category: null, fallback: false })
  assert.throws(() => d('x', null), /unknown policy/)
})

check('gold takes agreed verdicts and rulings, and names what is missing', () => {
  const sample = [
    { id: 'a', split: 'train', stratum: 'search' },
    { id: 'b', split: 'heldout', stratum: 'review' },
    { id: 'c', split: 'train', stratum: 'other' },
  ]
  const v = (tier, category) => ({ tier, category, reason: 'r' })
  const judgments = [
    { id: 'a', A: v('quick', 'search'), B: v('quick', 'summarize') },
    { id: 'b', A: v('standard', 'implement'), B: v('deep', 'review'), R: v('deep', 'review') },
    { id: 'c', A: v('light', 'other'), B: v('standard', 'other'), R: v('light', 'other') },
  ]
  const full = buildGold(table, sample, judgments, { b: { tier: 'deep', category: 'review' }, c: { tier: 'standard', category: 'writing' } })
  assert.deepEqual(full.missing, [])
  assert.deepEqual(full.gold, [
    { id: 'a', tier: 'quick', category: 'search', split: 'train', stratum: 'search', source: 'agreed' },
    { id: 'b', tier: 'deep', category: 'review', split: 'heldout', stratum: 'review', source: 'filip' },
    { id: 'c', tier: 'standard', category: 'writing', split: 'train', stratum: 'other', source: 'filip' },
  ])
  const part = buildGold(table, sample, judgments, { b: { tier: 'deep', category: 'review' } })
  assert.deepEqual(part.missing, ['c'])
  const prov = buildGold(table, sample, judgments, {}, { provisional: true })
  assert.deepEqual(prov.missing, [])
  assert.deepEqual(prov.gold.map((g) => [g.id, g.tier, g.source]), [['a', 'quick', 'agreed'], ['b', 'deep', 'recommendation'], ['c', 'light', 'recommendation']])
  assert.throws(() => buildGold(table, sample, judgments, { b: { tier: 'frontier', category: 'review' } }), /ruling for b/)
  assert.throws(() => buildGold(table, sample, [judgments[0]], {}), /no judgment for b/)
  const safe = buildGold(table, sample, judgments, { c: { tier: 'light', category: 'other' } }, { safer: true })
  assert.deepEqual(safe.missing, [])
  assert.deepEqual(safe.gold.map((g) => [g.id, g.tier, g.category, g.source]), [['a', 'quick', 'search', 'agreed'], ['b', 'deep', 'review', 'safer'], ['c', 'light', 'other', 'filip']])
})

check('the safer verdict takes the higher tier and a critical category', () => {
  const v = (tier, category) => ({ tier, category, reason: 'r' })
  assert.deepEqual(saferVerdict(table, v('light', 'other'), v('standard', 'research'), v('light', 'other')), { tier: 'standard', category: 'research' })
  assert.deepEqual(saferVerdict(table, v('deep', 'implement'), v('standard', 'review'), v('standard', 'review')), { tier: 'deep', category: 'review' })
  assert.deepEqual(saferVerdict(table, v('standard', 'implement'), v('standard', 'security'), v('standard', 'implement')), { tier: 'standard', category: 'security' })
  assert.deepEqual(saferVerdict(table, v('quick', 'review'), v('quick', 'security'), v('quick', 'security')), { tier: 'quick', category: 'security' })
  assert.deepEqual(saferVerdict(table, v('quick', 'search'), v('quick', 'other'), v('quick', 'other')), { tier: 'quick', category: 'other' })
})

// The runner's cache and pool, against a temporary DATA directory; no model is spawned
const tmp = mkdtempSync(join(tmpdir(), 'mr-eval-test-'))
process.env.MODEL_ROUTER_EVAL_DATA = tmp
const { cached, pool } = await import('../eval/claude.mjs')

{
  let inFlight = 0
  let peak = 0
  const got = await pool([5, 1, 3, 2, 4], 2, async (x, i) => {
    inFlight++
    peak = Math.max(peak, inFlight)
    await new Promise((r) => setTimeout(r, x * 3))
    inFlight--
    return x * 10 + i
  })
  check('pool keeps input order and caps concurrency', () => {
    assert.deepEqual(got, [50, 11, 32, 23, 44])
    assert.equal(peak, 2)
  })
  const none = await pool([], 4, async () => 1)
  check('pool of nothing returns nothing', () => assert.deepEqual(none, []))
}

{
  let runs = 0
  const run = async (req) => {
    runs++
    return { echo: req.prompt, runs }
  }
  const a = await cached('t', { prompt: 'x' }, run)
  const b = await cached('t', { prompt: 'x' }, run)
  const c = await cached('t', { prompt: 'y' }, run)
  const d = await cached('t', { prompt: 'x' }, run, { read: false })
  const file = join(tmp, 'cache', 't.jsonl')
  appendFileSync(file, '{"key":"cut by a cra')
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  check('cached runs each distinct request once and appends one line per run', () => {
    assert.deepEqual(a, { echo: 'x', runs: 1 })
    assert.deepEqual(b, a)
    assert.deepEqual(c, { echo: 'y', runs: 2 })
    assert.deepEqual(d, { echo: 'x', runs: 3 })
    assert.equal(lines.length, 4)
    assert.equal(JSON.parse(lines[0]).key.length, 64)
  })
  // A fresh process reads the file back; the truncated line is skipped
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { cached } = await import(${JSON.stringify(new URL('../eval/claude.mjs', import.meta.url).href)})
    const v = await cached('t', { prompt: 'y' }, async () => 'ran')
    console.log(JSON.stringify(v))`], { env: { ...process.env, MODEL_ROUTER_EVAL_DATA: tmp } })
  check('cached resumes from the file in a new process and skips a cut line', () => {
    assert.deepEqual(JSON.parse(String(out)), { echo: 'y', runs: 2 })
  })
}
rmSync(tmp, { recursive: true, force: true })

// The CLI scripts, each against their own temporary DATA directory; every case here dies before
// any model call or any write to the repo's results.json or gold.json
{
  const runMjs = fileURLToPath(new URL('../eval/run.mjs', import.meta.url))
  const goldMjs = fileURLToPath(new URL('../eval/gold.mjs', import.meta.url))
  const cli = (script, args, extraEnv) => {
    try {
      const out = execFileSync(process.execPath, [script, ...args], { env: { ...process.env, ...extraEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { status: 0, stdout: out }
    } catch (e) {
      return { status: e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') }
    }
  }
  const tmp2 = mkdtempSync(join(tmpdir(), 'mr-eval-cli-'))
  writeFileSync(join(tmp2, 'sample.jsonl'), '')
  const env = { MODEL_ROUTER_EVAL_DATA: tmp2 }

  check('a theta out of (0, 1] or not a number refuses the variant table before any call', () => {
    for (const theta of ['abc', '1.5']) {
      const r = cli(runMjs, ['--policy', 'jev', '--theta', theta, '--split', 'train'], env)
      assert.equal(r.status, 2)
      assert.match(r.stderr, /variant table refused/)
    }
  })

  check('--split heldout or --split all without --heldout-row dies with a clear message', () => {
    for (const split of ['heldout', 'all']) {
      const r = cli(runMjs, ['--policy', 'today', '--split', split], env)
      assert.equal(r.status, 2)
      assert.match(r.stderr, /needs --heldout-row/)
    }
  })

  check('--tuning and --final outside --split train die before guard or decideAll', () => {
    const tuning = cli(runMjs, ['--policy', 'today', '--split', 'heldout', '--heldout-row', 'r1', '--tuning', 'note'], env)
    assert.equal(tuning.status, 2)
    assert.match(tuning.stderr, /--tuning records train runs only/)
    const final = cli(runMjs, ['--policy', 'today', '--split', 'heldout', '--heldout-row', 'r1', '--final', 'r1'], env)
    assert.equal(final.status, 2)
    assert.match(final.stderr, /--final records a train run on the final gold/)
  })

  check('--final refuses provisional gold', () => {
    writeFileSync(join(tmp2, 'gold-provisional.json'), '[]\n')
    const r = cli(runMjs, ['--policy', 'today', '--split', 'train', '--gold', 'provisional', '--final', 'r1'], env)
    assert.equal(r.status, 2)
    assert.match(r.stderr, /--final records a train run on the final gold/)
  })

  check('gold.mjs reports rule coverage on train critical calls, not held-out', () => {
    writeFileSync(join(tmp2, 'sample.jsonl'), [
      { id: 't1', session: 's1', split: 'train', stratum: 'review', type: 'general-purpose', description: 'Review the diff' },
      { id: 'h1', session: 's2', split: 'heldout', stratum: 'review', type: 'general-purpose', description: 'Review the diff' },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n')
    const v = { tier: 'deep', category: 'review', reason: 'r' }
    writeFileSync(join(tmp2, 'judgments.jsonl'), [{ id: 't1', A: v, B: v }, { id: 'h1', A: v, B: v }].map((r) => JSON.stringify(r)).join('\n') + '\n')
    const r = cli(goldMjs, ['--provisional'], env)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /train critical 1, of them not caught by rules\[0\]\.match 0/)
    assert.doesNotMatch(r.stdout, /held-out critical/)
  })

  rmSync(tmp2, { recursive: true, force: true })
}

console.log(`${n} checks passed`)
