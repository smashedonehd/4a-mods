// Run: node model-router/test/eval.test.mjs
// Replays the committed eval: the recorded decisions must come from the shipped policy, and a fresh
// score over the held-out gold must match the recorded result. Reads only repo files (no private
// eval data, no model call), so it runs in CI and in the cloud refresh.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { policyInputs, policyHash } from '../eval/hash.mjs'
import { score, criteria } from '../eval/metrics.mjs'

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
const table = read('../routing.json')
const gold = read('../eval/gold.json')
const decisions = read('../eval/decisions.json')
const results = read('../eval/results.json')
const heldoutGold = gold.filter((g) => g.split === 'heldout')
let n = 0
function check(name, fn) {
  fn()
  n++
  console.log(`ok ${n} ${name}`)
}

const CHANGED = 'policy changed: re-run the eval locally (UPDATING.md, Eval guards the policy)'
check('the decisions were recorded with the shipped policy', () => {
  assert.equal(decisions.policyHash, policyHash(table), CHANGED)
  assert.equal(decisions.policy, table.router.policy, CHANGED)
  assert.deepEqual(decisions.router, policyInputs(table).router, CHANGED)
})

check('the recorded decisions are the ones the held-out run measured', () => {
  const run = results.heldout[results.winner.row]
  assert.ok(run, `no held-out run for the winner ${results.winner.row}`)
  assert.equal(run.policyHash, decisions.policyHash)
  // costRatio and costOver follow routing.json prices, which a refresh may change and then rescore
  // only results.winner; check 4 guards them against the current prices
  const routing = ({ costRatio, costOver, ...m }) => m
  assert.deepEqual(routing(results.winner.metrics), routing(run.metrics))
})

check('gold covers 400 calls, 80 held out, each with a decision', () => {
  assert.equal(gold.length, 400)
  assert.equal(new Set(gold.map((g) => g.id)).size, 400)
  assert.equal(heldoutGold.length, 80)
  assert.deepEqual(Object.keys(decisions.decisions).sort(), gold.map((g) => g.id).sort())
})

check('recorded results match a fresh score', () => {
  assert.deepEqual(score(table, heldoutGold, decisions.decisions), results.winner.metrics)
})

check("the thresholds are the spec's", () => {
  assert.deepEqual(table.thresholds, { under: 0.05, underCritical: 0.05, costOver: 0.15 })
})

check('auto routing ships on only when the held-out eval passes', () => {
  if (table.router.default !== 'on') return
  const c = criteria(table, score(table, heldoutGold, decisions.decisions))
  assert.ok(c.pass, `router.default is on, but the held-out eval misses ${c.missed.join(', ')}`)
})

check('no private text in the eval files', () => {
  const GOLD_KEYS = ['id', 'tier', 'category', 'split', 'stratum', 'source']
  for (const g of gold) assert.deepEqual(Object.keys(g).filter((k) => !GOLD_KEYS.includes(k)), [], `gold ${g.id}`)
  assert.deepEqual(Object.keys(decisions).sort(), ['decisions', 'policy', 'policyHash', 'recorded', 'router'])
  const long = (v, at) => {
    if (typeof v === 'string') assert.ok(v.length <= 200, `${at}: a string of ${v.length} chars`)
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) long(k, at), long(x, `${at}.${k}`)
  }
  long(gold, 'gold.json')
  long(decisions, 'decisions.json')
  long(results, 'results.json')
})

console.log(`${n} checks passed`)
