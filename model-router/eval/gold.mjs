// Gold tiers for the 400 sampled calls: the judges' shared verdict where they agree, Filip's ruling
// (DATA/rulings.json, {<id>: {tier, category}}) where they disagree. Writes eval/gold.json, which keeps
// ids, tiers, categories, split and stratum only. Every disagreement needs a ruling first.
//
//   node model-router/eval/gold.mjs
//   node model-router/eval/gold.mjs --provisional   (missing rulings take the recommendation;
//                                                    writes DATA/gold-provisional.json, never the repo)

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildGold } from './lib.mjs'
import { DATA, GOLD, JUDGMENTS, RULINGS, SAMPLE, TABLE } from './paths.mjs'

const jsonl = (f) =>
  readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
const provisional = process.argv.includes('--provisional')
const table = JSON.parse(readFileSync(TABLE, 'utf8'))
const rulings = existsSync(RULINGS) ? JSON.parse(readFileSync(RULINGS, 'utf8')) : {}
const { gold, missing } = buildGold(table, jsonl(SAMPLE), jsonl(JUDGMENTS), rulings, { provisional })
if (missing.length) {
  console.error(`${missing.length} disagreements have no ruling in ${RULINGS}: ${missing.join(', ')}`)
  process.exit(1)
}

const count = (rows, key) => Object.entries(rows.reduce((m, r) => ((m[r[key]] = (m[r[key]] || 0) + 1), m), {})).map(([k, n]) => `${k} ${n}`).join(', ')
for (const split of ['train', 'heldout']) {
  const rows = gold.filter((g) => g.split === split)
  console.log(`${split} ${rows.length}\n  tiers: ${count(rows, 'tier')}\n  categories: ${count(rows, 'category')}\n  sources: ${count(rows, 'source')}`)
}
const re = new RegExp(table.rules[0].match, 'iu')
const sample = new Map(jsonl(SAMPLE).map((r) => [r.id, r]))
const crit = gold.filter((g) => g.split === 'heldout' && table.critical.includes(g.category))
const unmatched = crit.filter((g) => !re.test(`${sample.get(g.id).type || ''} ${sample.get(g.id).description || ''}`)).length
console.log(`held-out critical ${crit.length}, of them not caught by rules[0].match ${unmatched}`)

const out = provisional ? join(DATA, 'gold-provisional.json') : GOLD
writeFileSync(out, JSON.stringify(gold, null, 1) + '\n')
console.log(`-> ${out}`)
