// Two blind Opus judges give every sampled call a tier and a category; where they disagree, a third
// request weighs both and recommends one for Filip's ruling. Replies are cached, so a crashed run
// resumes where it stopped. Output stays in the private DATA directory.
//
//   node model-router/eval/judge.mjs [concurrency=6]
//   MODEL_ROUTER_EVAL_ACCOUNT=2 node model-router/eval/judge.mjs   (second account)

import { cached, complete, pool } from './claude.mjs'
import { loadTable, readJsonl, writeJsonl } from './io.mjs'
import { disagrees, judgeRequest, parseJudge } from './lib.mjs'
import { agreement, printConfusion } from './metrics.mjs'
import { JUDGMENTS, SAMPLE } from './paths.mjs'

const P = 'model-router'
const table = loadTable()
const rows = readJsonl(SAMPLE)
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
writeJsonl(JUDGMENTS, out)

const both = out.filter((r) => r.A && r.B)
const a = both.map((r) => r.A.tier)
const b = both.map((r) => r.B.tier)
console.log(`\n${out.length} rows, ${both.length} with both verdicts, null: ${failed.length ? failed.join(', ') : 0}`)
const ag = agreement(a, b)
console.log(`tier agreement raw ${ag.raw.toFixed(3)}, kappa ${ag.kappa.toFixed(3)}`)
const tiers = Object.keys(table.tiers).filter((t) => a.includes(t) || b.includes(t))
printConfusion('confusion (rows A, columns B)', tiers, tiers, both.map((r) => [r.A.tier, r.B.tier]), 9)
const dis = both.filter((r) => disagrees(table, r.A, r.B))
console.log(`disagreements (tier or critical): ${dis.length}, with recommendation ${dis.filter((r) => r.R).length}`)
console.log(`-> ${JUDGMENTS}`)
