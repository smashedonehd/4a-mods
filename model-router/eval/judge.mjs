// Two blind Opus judges give every sampled call a tier and a category; where they disagree, a third
// request weighs both and recommends one for Filip's ruling. Replies are cached, so a crashed run
// resumes where it stopped. Output stays in the private DATA directory.
//
//   node model-router/eval/judge.mjs [concurrency=6]
//   MODEL_ROUTER_EVAL_ACCOUNT=2 node model-router/eval/judge.mjs   (second account)

import { readFileSync, writeFileSync } from 'node:fs'
import { cached, complete, pool } from './claude.mjs'
import { disagrees, judgeRequest, parseJudge } from './lib.mjs'
import { kappa } from './metrics.mjs'
import { JUDGMENTS, SAMPLE, TABLE } from './paths.mjs'

const P = 'model-router'
const table = JSON.parse(readFileSync(TABLE, 'utf8'))
const rows = readFileSync(SAMPLE, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l))
const n = Number(process.argv[2]) || 6
let done = 0
const failed = []

// One verdict; an unreadable reply is asked once more without the cache, then recorded as null
async function verdict(row, variant, verdicts) {
  const req = judgeRequest(table, P, row, variant, verdicts)
  const run = (r) => complete(table, r).then((o) => ({ text: o.text, costUsd: o.costUsd }))
  for (const read of [true, false]) {
    try {
      const v = parseJudge(table, (await cached('judges', req, run, { read })).text)
      if (v) return v
    } catch (e) {
      console.error(`${row.id} ${variant}: ${e.message}`)
    }
  }
  failed.push(`${row.id} ${variant}`)
  return null
}

const out = await pool(rows, n, async (row) => {
  const [A, B] = await Promise.all([verdict(row, 'A'), verdict(row, 'B')])
  const rec = { id: row.id, A, B }
  if (A && B && disagrees(table, A, B)) rec.R = await verdict(row, 'R', { A, B })
  if (++done % 25 === 0) console.log(`${done}/${rows.length}`)
  return rec
})
writeFileSync(JUDGMENTS, out.map((r) => JSON.stringify(r)).join('\n') + '\n')

const both = out.filter((r) => r.A && r.B)
const a = both.map((r) => r.A.tier)
const b = both.map((r) => r.B.tier)
console.log(`\n${out.length} rows, ${both.length} with both verdicts, null: ${failed.length ? failed.join(', ') : 0}`)
console.log(`tier agreement raw ${(a.filter((x, i) => x === b[i]).length / both.length).toFixed(3)}, kappa ${kappa(a, b).toFixed(3)}`)
const tiers = Object.keys(table.tiers).filter((t) => a.includes(t) || b.includes(t))
console.log(`confusion (rows A, columns B):\n${''.padEnd(9)}${tiers.map((t) => t.padStart(9)).join('')}`)
for (const ta of tiers) console.log(ta.padEnd(9) + tiers.map((tb) => String(both.filter((r) => r.A.tier === ta && r.B.tier === tb).length).padStart(9)).join(''))
const dis = both.filter((r) => disagrees(table, r.A, r.B))
console.log(`disagreements (tier or critical): ${dis.length}, with recommendation ${dis.filter((r) => r.R).length}`)
console.log(`-> ${JUDGMENTS}`)
