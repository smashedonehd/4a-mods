// The reviews' slow inputs, at the reviews' sizes. Each bound is three times
// the slowest of three runs when written (at least 100 ms, so a pause for
// garbage collection cannot fail a 4 ms case), and never over the 1,500 ms
// budget.
import { expect, test } from 'claude-code/testing'
import { Run, matches, readBlocks, taskOf, trimBlocks } from './trim.ts'

const none = new Set<string>()
const timed = (name: string, bound: number, f: () => unknown) => {
  const start = performance.now()
  f()
  const ms = performance.now() - start
  // A failure names the case and its time.
  expect([name, ms < bound ? 'within bound' : `${ms.toFixed(0)} ms, bound ${bound}`]).toEqual([name, 'within bound'])
}
// Read, then trim, as the hook does: one run.
const hook = (text: string) => () => {
  const run = new Run()
  const data = readBlocks([text], run)
  if (typeof data !== 'string') trimBlocks(data, none, { run, maxChars: text.length })
}
// Measured with node 24 on the author's machine: 97, 155, 153, 97, 653, 90 ms at most.
const BOUND = { chain28: 300, chain80: 470, obj190: 460, idmap: 300, keys200k: 1500, dense: 270 }
const records = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: i, name: `n${i}`, v: i * 1.5, w: `x${i}` })))

test('perf: a key of 40,000 capitals, and 2,000 keys of 2,000', () => {
  timed('UPPER key 40000', 100, hook(`{"${'A'.repeat(40_000)}":"v","pad":"${'x'.repeat(20_000)}"}`))
  timed('2000 UPPER keys x2000', 100, hook(`{${Array.from({ length: 2000 }, (_, i) => `"${'A'.repeat(1990)}${i}":1`).join(',')}}`))
})

test('perf: one closing reminder tag, then 200,000 opening ones', () => {
  const text = `</system-reminder>${'<system-reminder>'.repeat(200_000)}`
  timed('task close + 200k opens', 100, () => taskOf([{ role: 'user', text }, { role: 'assistant', text }]))
})

test('perf: 97 levels of lists over 28,000 and 80,000 records', () => {
  const chain = (n: number) => {
    let s = records(n)
    for (let i = 0; i < 97; i++) s = `[{"a":${s}},{},{}]`
    return s
  }
  timed('hoist chain 97 x28k', BOUND.chain28, hook(chain(28_000)))
  timed('hoist chain 97 x80k', BOUND.chain80, hook(chain(80_000)))
})

test('perf: 190 levels of objects over 80,000 records', () => {
  let s = records(80_000)
  for (let i = 0; i < 190; i++) s = `{"a":${s},"b":1}`
  timed('obj chain 190', BOUND.obj190, hook(s))
})

test('perf: 40,000 and 200,000 distinct keys', () => {
  timed('id map 40k', BOUND.idmap, hook(`{${Array.from({ length: 40_000 }, (_, i) => `"${100_000 + i}":{"name":"n${i}","clicks":${i}}`).join(',')}}`))
  timed('200k distinct keys', BOUND.keys200k, hook(`{${Array.from({ length: 200_000 }, (_, i) => `"k${i}":"v${i}"`).join(',')}}`))
})

test('perf: 4,800 records of 30 short fields', () => {
  const text = JSON.stringify({
    total: 4800,
    next_page_token: 'abc',
    rows: Array.from({ length: 4800 }, (_, i) => Object.fromEntries(Array.from({ length: 30 }, (_, j) => [`field_${j}`, `value ${i} ${j}`]))),
  })
  timed('dense 4800x30', BOUND.dense, hook(text))
})

test('perf: JSON 20,000 levels deep is refused while reading', () => {
  timed('20k levels', 100, hook('['.repeat(20_000) + ']'.repeat(20_000)))
})

test('perf: a glob of many stars', () => {
  timed('glob of many stars', 100, () => matches(`mcp__${'a'.repeat(100_000)}__b`, ['*a*a*a*a*a*a*b*c']))
})
