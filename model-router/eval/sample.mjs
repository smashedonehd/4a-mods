// Draws the stratified 400-call sample and its session-level train/held-out split from the corpus.
// The sample keeps prompts, so it is written to the private DATA directory, never to the repo.
//
//   node model-router/eval/sample.mjs

import { readJsonl, writeJsonl } from './io.mjs'
import { drawSample } from './lib.mjs'
import { CALLS, SAMPLE } from './paths.mjs'

const FIELDS = ['id', 'session', 'stratum', 'split', 'type', 'model', 'effort', 'parentModel', 'parentEffort', 'description', 'prompt']

const rows = drawSample(readJsonl(CALLS)).map((c) => Object.fromEntries(FIELDS.map((k) => [k, c[k] ?? ''])))

const count = (pred) => rows.filter(pred).length
const sessions = (split) => new Set(rows.filter((r) => r.split === split).map((r) => r.session))
const train = sessions('train')
const held = sessions('heldout')
const shared = [...held].filter((s) => train.has(s)).length

for (const k of [...new Set(rows.map((r) => r.stratum))]) {
  console.log(`${k.padEnd(13)} ${String(count((r) => r.stratum === k)).padStart(3)}  held-out ${count((r) => r.stratum === k && r.split === 'heldout')}`)
}
console.log(`total ${rows.length}, held-out ${count((r) => r.split === 'heldout')}, train ${count((r) => r.split === 'train')}`)
console.log(`sessions: train ${train.size}, held-out ${held.size}, shared ${shared}`)

writeJsonl(SAMPLE, rows)
console.log(`-> ${SAMPLE}`)
