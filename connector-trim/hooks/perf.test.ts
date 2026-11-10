// The review's slow inputs, at the review's sizes. Each bound is three times
// the slowest of three runs when written (at least 100 ms, so a pause for
// garbage collection cannot fail a 4 ms case), and never over the 1,500 ms
// budget: `200k distinct keys` and `hoist chain 97 x80k` sit at that cap.
import { expect, test } from 'claude-code/testing'
import { Run, matches, redactJson, redactText, taskOf, trimJsonWhy } from './trim.ts'

const none = new Set<string>()
const timed = (name: string, bound: number, f: () => unknown) => {
  const start = performance.now()
  f()
  const ms = performance.now() - start
  console.log(`perf ${name}: ${ms.toFixed(0)} ms (bound ${bound})`)
  expect([name, ms < bound]).toEqual([name, true])
}
// Redact, then trim, as the hook does: one run, the redaction's reading reused.
const both = (text: string) => () => {
  const run = new Run()
  const r = redactJson(text, run)
  if (r) trimJsonWhy([r.text], none, { run, read: [r], maxChars: text.length })
}
const records = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: i, name: `n${i}`, v: i * 1.5, w: `x${i}` })))

test('perf: a key of 40,000 capitals, and 2,000 keys of 2,000', () => {
  timed('UPPER key 40000', 100, both(`{"${'A'.repeat(40_000)}":"v","pad":"${'x'.repeat(20_000)}"}`))
  timed('2000 UPPER keys x2000', 120, both(`{${Array.from({ length: 2000 }, (_, i) => `"${'A'.repeat(1990)}${i}":1`).join(',')}}`))
})

test('perf: 100,000 private-key headers in one string', () => {
  timed('PEM heads 100k', 210, both(JSON.stringify({ a: '-----BEGIN PRIVATE KEY-----'.repeat(100_000) })))
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
  timed('hoist chain 97 x28k', 620, both(chain(28_000)))
  timed('hoist chain 97 x80k', 1500, both(chain(80_000)))
})

test('perf: 190 levels of objects over 80,000 records', () => {
  let s = records(80_000)
  for (let i = 0; i < 190; i++) s = `{"a":${s},"b":1}`
  timed('obj chain 190', 1425, both(s))
})

test('perf: 40,000 and 200,000 distinct keys', () => {
  timed('id map 40k', 1010, both(`{${Array.from({ length: 40_000 }, (_, i) => `"${100_000 + i}":{"name":"n${i}","clicks":${i}}`).join(',')}}`))
  timed('200k distinct keys', 1500, both(`{${Array.from({ length: 200_000 }, (_, i) => `"k${i}":"v${i}"`).join(',')}}`))
})

test('perf: 4,800 records of 30 short fields', () => {
  const text = JSON.stringify({
    total: 4800,
    next_page_token: 'abc',
    rows: Array.from({ length: 4800 }, (_, i) => Object.fromEntries(Array.from({ length: 30 }, (_, j) => [`field_${j}`, `value ${i} ${j}`]))),
  })
  timed('dense 4800x30', 560, both(text))
})

test('perf: near-miss runs and many findings in one string', () => {
  timed('eyJ run 540k', 100, both(JSON.stringify({ a: 'eyJaaaaa-'.repeat(60_000) })))
  timed('200k password pairs', 730, both(JSON.stringify({ log: 'password=hunter22 '.repeat(200_000) })))
  timed('350k pwd finds', 1170, both(JSON.stringify({ log: 'pwd=abcdef '.repeat(350_000) })))
  timed('text PEM heads 120k', 160, () => redactText('-----BEGIN PRIVATE KEY-----'.repeat(120_000)))
  timed('glob of many stars', 100, () => matches(`mcp__${'a'.repeat(100_000)}__b`, ['*a*a*a*a*a*a*b*c']))
})
