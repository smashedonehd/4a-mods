import { expect, test } from 'claude-code/testing'
import {
  CLEARED,
  chunks,
  isFiller,
  isNamed,
  matches,
  pagingOf,
  redact,
  taskOf,
  textsOf,
  toClear,
  trimTexts,
  wordsOf,
} from './trim.ts'

test('Czech and English approvals are filler, diacritics or not', () => {
  for (const t of ['jo', 'Ano.', 'ok', 'pokračuj', 'pokracuj', 'Dělej!', 'jo, dělej', 'ok pokračuj', 'yes go ahead'.replace(' ahead', ''), 'díky'])
    expect(isFiller(t)).toBe(true)
  for (const t of ['Pokračuj s reportem GA4', 'ano, ale jen kampaně z října', 'show the top queries'])
    expect(isFiller(t)).toBe(false)
})

test('the task is the last real request, with the words said after it', () => {
  const rows = [
    { role: 'user', text: 'Stáhni výkon kampaní za říjen' },
    { role: 'assistant', text: 'Spustím report.' },
    { role: 'user', text: '<system-reminder>x</system-reminder>ano' },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 't1' }] },
    { role: 'user', text: 'něco později' },
  ]
  expect(taskOf(rows, 't1')).toEqual({ user: 'Stáhni výkon kampaní za říjen', assistant: 'Spustím report.' })
})

test('words match field names across case, parts and diacritics', () => {
  const words = wordsOf('Jaké jsou kampaně a jejich cost?')
  expect(isNamed('costMicros', words)).toBe(true)
  expect(isNamed('cost_micros', words)).toBe(true)
  expect(isNamed('kampane', words)).toBe(true)
  expect(isNamed('clicks', words)).toBe(false)
})

test('paging fields are copied exactly, records left alone', () => {
  const data = { page: 2, pageSize: 50, nextPageToken: 'a/b+c==', meta: { has_more: true }, rows: [{ count: 3 }] }
  expect(pagingOf(data)).toBe('page=2, pageSize=50, nextPageToken="a/b+c==", meta.has_more=true')
})

test('the trim keeps paging and named fields, drops empty, blob and noise fields', () => {
  const blob = 'Zm9v'.repeat(60) + '1'
  const text = JSON.stringify({ total: null, next_page_token: '', items: [{ id: 1, pic: blob, etag: 'x', empty: [] }] })
  const t = trimTexts([text], wordsOf('need the empty ones'))
  expect(JSON.parse(t.text)).toEqual({ total: null, next_page_token: '', items: [{ id: 1, empty: [] }] })
  expect([...t.stats.blobs, ...t.stats.noise]).toEqual(['pic', 'etag'])
})

test('long strings are cut with a marker; plain text keeps its words', () => {
  const t = trimTexts([JSON.stringify({ body: 'word '.repeat(400) })], new Set())
  expect(t.text).toMatch(/…\[cut: 1,000 more characters in the saved file\]/)
  expect(t.stats.cut).toBe(1)
  expect(trimTexts(['a  b\n\n\n\nc   '], new Set()).text).toBe('a b\n\nc')
})

test('secrets are redacted, keys kept', () => {
  const key = 'sk-ant-' + 'q'.repeat(40)
  const pem = ['-----BEGIN', 'RSA PRIVATE KEY-----\nMIIx\n-----END', 'RSA PRIVATE KEY-----'].join(' ')
  const r = redact(`a ${key} b password=s3cretpw token: Bearer ${'t'.repeat(30)} ${pem}`)
  expect(r.text).toBe(
    'a [REDACTED API key] b password=[REDACTED] token: [REDACTED bearer token] [REDACTED private key]',
  )
  expect(redact(r.text).found).toEqual([])
})

test('result shapes: text blocks, a string, the SDK object, images and errors', () => {
  expect(textsOf('x')).toEqual({ texts: ['x'] })
  expect(textsOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toEqual({ texts: ['a', 'b'] })
  expect(textsOf({ content: [{ type: 'text', text: 'a' }], isError: false })).toEqual({ texts: ['a'] })
  expect(textsOf({ content: [], isError: true })).toEqual({ skip: 'error' })
  expect(textsOf([{ type: 'image', data: '' }])).toEqual({ skip: 'image' })
  expect(textsOf([{ type: 'resource_link', uri: 'x' }])).toEqual({ skip: 'a resource_link block' })
})

test('the skip list matches servers and tool names by glob, not by substring', () => {
  const skip = ['claude-in-chrome', 'ccd_*', 'find', '*snapshot*']
  expect(matches('mcp__claude-in-chrome__computer', skip)).toBe(true)
  expect(matches('mcp__ccd_session__mark_chapter', skip)).toBe(true)
  expect(matches('mcp__Claude_Browser__find', skip)).toBe(true)
  expect(matches('mcp__camofox__navigate_and_snapshot', skip)).toBe(true)
  expect(matches('mcp__ads__find_wasted_spend', skip)).toBe(false)
})

test('chunks split on lines and never exceed their size', () => {
  const parts = chunks(['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(75)].join('\n'), 40)
  expect(parts.every(p => p.length <= 40)).toBe(true)
  expect(parts.join('').replace(/\n/g, '')).toBe('a'.repeat(30) + 'b'.repeat(30) + 'c'.repeat(75))
})

test('retention: past the keep time, then oldest over the cap; cleared ones are skipped', () => {
  const f = (name: string, size: number, mtimeMs: number) => ({ name, kind: 'file', size, mtimeMs })
  const list = [f('new', 600, 100), f('mid', 600, 90), f('old', 600, 80), f('ancient', 600, 1), f('done', CLEARED.length, 1)]
  expect(toClear(list, 100, 50, 10_000)).toEqual(['ancient'])
  expect(toClear(list, 100, 50, 1000)).toEqual(['mid', 'old', 'ancient'])
})
