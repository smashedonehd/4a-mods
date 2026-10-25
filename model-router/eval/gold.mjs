// Gold tiers for the 400 sampled calls: the judges' shared verdict where they agree, Filip's ruling
// (DATA/rulings.json, {<id>: {tier, category}}) where he gave one, and the safer verdict (the higher
// tier, a critical category if either judge saw one) for every other disagreement. Writes
// eval/gold.json, which keeps ids, tiers, categories, split and stratum only.
//
//   node model-router/eval/gold.mjs
//   node model-router/eval/gold.mjs --provisional   (missing rulings take the recommendation;
//                                                    writes DATA/gold-provisional.json, never the repo)

import { loadTable, readJson, readJsonl, writeJson } from './io.mjs'
import { buildGold } from './lib.mjs'
import { GOLD, GOLD_PROVISIONAL, JUDGMENTS, RULINGS, SAMPLE } from './paths.mjs'

const provisional = process.argv.includes('--provisional')
const table = loadTable()
const sample = readJsonl(SAMPLE)
const { gold, missing } = buildGold(table, sample, readJsonl(JUDGMENTS), readJson(RULINGS, {}), { fill: provisional ? 'recommendation' : 'safer' })
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
const byId = new Map(sample.map((r) => [r.id, r]))
const crit = gold.filter((g) => g.split === 'train' && table.critical.includes(g.category))
const unmatched = crit.filter((g) => !re.test(`${byId.get(g.id).type || ''} ${byId.get(g.id).description || ''}`)).length
console.log(`train critical ${crit.length}, of them not caught by rules[0].match ${unmatched}`)

const out = provisional ? GOLD_PROVISIONAL : GOLD
writeJson(out, gold)
console.log(`-> ${out}`)
