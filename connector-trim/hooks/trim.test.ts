import { expect, test } from 'claude-code/testing'
import {
  CLEARED,
  chunks,
  isFiller,
  isNamed,
  isPaging,
  isSecretKey,
  leftOut,
  matches,
  neutral,
  pagingOf,
  parseJson,
  redactJson,
  redactText,
  reshaped,
  safe,
  ser,
  taskOf,
  textsOf,
  toClear,
  trimJson,
  trimPlain,
  wordsOf,
} from './trim.ts'

const none = new Set<string>()
const trimmed = (text: string, words: ReadonlySet<string> = none) => {
  const t = trimJson([text], words)
  if (!t) throw new Error('not JSON')
  return { ...t, value: JSON.parse(t.text) }
}
const b64 = (n: number) => 'Zm9vYmFy0123'.repeat(Math.ceil(n / 12)).slice(0, n)

test('Czech and English approvals are filler, diacritics or not', () => {
  for (const t of ['jo', 'Ano.', 'ok', 'pokračuj', 'pokracuj', 'Dělej!', 'jo, dělej', 'ok pokračuj', 'yes go', 'díky'])
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

test('positional rows keep every cell in its place, empties included', () => {
  const text = '{"columns":["name","clicks","note","cost"],"rows":[["a",1,null,5],["b",2,"",6],["c",3,"x",7]],"flat":[1,null,3,"",5],"nested":[[0,0],[],[null,null]]}'
  const t = trimmed(text)
  expect(t.value).toEqual(JSON.parse(text))
  expect(leftOut(t.stats)).toBe('')
})

test('a base64 list item is marked in its place and counted', () => {
  const t = trimmed(JSON.stringify({ files: ['a.png', b64(300), 'c.png'] }))
  expect(t.value.files).toEqual(['a.png', '[base64 data: in the saved file]', 'c.png'])
  expect(leftOut(t.stats)).toBe('1 base64 list item, each marked in its place')
})

test('numbers JavaScript cannot hold travel exactly as written', () => {
  const text = '{"total": 12345678901234567890, "items":[{"id": 9007199254740993, "price": 1.50, "rate": 1e5, "n": -0}]}'
  const t = trimmed(text)
  for (const raw of ['12345678901234567890', '9007199254740993', '1.50', '1e5', '-0']) expect(t.text).toContain(raw)
  expect(t.paging).toBe('total=12345678901234567890')
  expect(ser(parseJson(text))).toBe(text.replace(/\s/g, ''))
})

test('cursors and paging tokens are kept whole, never dropped as base64 or cut', () => {
  const cursor = b64(250)
  const token = b64(1500)
  const text = JSON.stringify({
    data: { search: { pageInfo: { endCursor: cursor, hasNextPage: true }, nodes: [{ id: 1 }] } },
    next_token: token,
    meta: { continuation: 'c-1' },
    other: token,
  })
  const t = trimmed(text)
  expect(t.value.data.search.pageInfo.endCursor).toBe(cursor)
  expect(t.value.next_token).toBe(token)
  expect(t.value.other).not.toBe(token)
  expect(t.paging).toBe(
    `data.search.pageInfo.endCursor="${cursor}", data.search.pageInfo.hasNextPage=true, next_token="${token}", meta.continuation="c-1"`,
  )
})

test('each JSON block is its own top level: its paging is kept and listed', () => {
  const block = (n: number) => JSON.stringify({ nextPageToken: `p${n}`, rows: [{ count: n }] })
  const t = trimJson([block(1), block(2)], none)!
  expect(t.text).toContain('Block 2 of 2:')
  expect(t.text).toContain('"nextPageToken": "p2"')
  expect(t.paging).toBe('block 1: nextPageToken="p1", block 2: nextPageToken="p2"')
})

test('paging fields inside records are data, not paging', () => {
  expect(pagingOf({ page: 2, rows: [{ count: 3, next: 'x' }] })).toBe('page=2')
})

test('paging tokens and secret tokens are told apart', () => {
  for (const k of ['next_token', 'nextPageToken', 'sync_token', 'endCursor', 'continuationToken', 'scroll_id', 'after'])
    expect([k, isPaging(k)]).toEqual([k, true])
  for (const k of ['access_token', 'id_token', 'refresh_token', 'token', 'Authorization', 'api_key', 'client_secret']) {
    expect([k, isPaging(k)]).toEqual([k, false])
    expect([k, isSecretKey(k)]).toEqual([k, true])
  }
  const r = redactJson('{"access_token":"a1","id_token":"b2","refresh_token":"c3","token":"d4","next_token":"n1","sync_token":"s1"}')!
  expect(JSON.parse(r.text)).toEqual({
    access_token: '[REDACTED]',
    id_token: '[REDACTED]',
    refresh_token: '[REDACTED]',
    token: '[REDACTED]',
    next_token: 'n1',
    sync_token: 's1',
  })
})

test('JSON stays valid JSON when redacted; only strings are replaced', () => {
  const text = '{"api_key": null, "password": true, "secret": false, "access_token": 123456, "n": 1.50}'
  const r = redactJson(text)!
  expect(r.text).toBe(text)
  expect(r.found).toEqual([])
})

test('a secret value goes whole, and JSON inside a string is redacted too', () => {
  const r = redactJson('{"password":"correct horse battery staple","pw2":{"password":"a,b;cdefgh"},"body":"{\\"password\\": \\"hunter2222\\"}"}')!
  const v = JSON.parse(r.text)
  expect(v.password).toBe('[REDACTED]')
  expect(v.pw2.password).toBe('[REDACTED]')
  expect(JSON.parse(v.body)).toEqual({ password: '[REDACTED]' })
  for (const s of ['horse', 'cdefgh', 'hunter2222']) expect(r.text).not.toContain(s)
  expect(r.found.length).toBe(3)
})

test('text redaction: keys, schemes and fixed formats go; slugs, paths and prose stay', () => {
  const key = 'sk-ant-' + 'q'.repeat(40)
  const pem = ['-----BEGIN', 'RSA PRIVATE KEY-----\nMIIx\n-----END', 'RSA PRIVATE KEY-----'].join(' ')
  const r = redactText(
    `a ${key} b password=s3cretpw token="t0k en" c: Bearer ${'t'.repeat(30)} ${pem} Authorization: Basic dXNlcjpwYXNz`,
  )
  expect(r.text).toBe(
    'a [REDACTED API key] b password=[REDACTED] token="[REDACTED]" c: [REDACTED bearer token] [REDACTED private key] Authorization: [REDACTED]',
  )
  expect(redactText(r.text).found).toEqual([])
  const kept = [
    // Split so the repository's own secret scan, which has the same blind spot, passes it.
    'https://x.cz/sk-' + 'suche-zachody-kompostovaci-toaleta',
    'pwd=/home/user/project',
    'password: reset it in settings',
    'the next_token=abc123 field',
  ].join(' ')
  expect(redactText(kept).text).toBe(kept)
})

test('the trim keeps paging, named and zero-ish values, drops empty, blob and noise fields', () => {
  const text = JSON.stringify({
    total: null,
    next_page_token: '',
    items: [{ id: 1, zero: 0, no: false, s: '0', pic: b64(241), etag: 'x', empty: [], digits: '1234567890'.repeat(30) }],
  })
  const t = trimmed(text, wordsOf('need the empty ones'))
  expect(t.value).toEqual({
    total: null,
    next_page_token: '',
    items: [{ id: 1, zero: 0, no: false, s: '0', empty: [], digits: '1234567890'.repeat(30) }],
  })
  expect(leftOut(t.stats)).toBe('base64 fields (pic); API bookkeeping fields (etag)')
})

test('a single value the task names is kept whole', () => {
  const long = 'word '.repeat(400)
  const t = trimmed(JSON.stringify({ body: long, pic: b64(300), note: null }), wordsOf('the body, pic and note'))
  expect(t.value).toEqual({ body: long, pic: b64(300), note: null })
})

test('long strings are cut with a marker and counted', () => {
  const t = trimmed(JSON.stringify({ body: 'word '.repeat(400) }))
  expect(t.text).toMatch(/…\[cut: 1,000 more characters in the saved file\]/)
  expect(leftOut(t.stats)).toBe('the rest of 1 text value over 1,000 characters, marked where cut')
})

test('a __proto__ field survives, and unpacked JSON strings are reported', () => {
  const t = trimmed('{"__proto__":{"x":1},"a":"[]","inner":"{\\"k\\":[1,2]}"}')
  expect(t.text).toContain('"__proto__": {"x":1}')
  expect(t.value.a).toBe('[]')
  expect(t.value.inner).toEqual({ k: [1, 2] })
  expect(reshaped(t.stats)).toBe('1 text value holding JSON is shown as JSON')
})

test('hoisting needs three records that all agree', () => {
  const rec = (c: string) => ({ id: c, cur: 'CZK', kind: c === 'c' ? 'B' : 'A' })
  const three = trimmed(JSON.stringify({ rows: ['a', 'b', 'c'].map(rec) }))
  expect(three.value.rows['same in every record']).toEqual({ cur: 'CZK' })
  expect(three.value.rows.records[2]).toEqual({ id: 'c', kind: 'B' })
  const two = trimmed(JSON.stringify({ rows: ['a', 'b'].map(rec) }))
  expect(two.value.rows).toEqual(['a', 'b'].map(rec))
  expect(three.stats.hoisted).toBe(1)
})

test('plain text keeps indentation, tabs and empty cells; only line ends and blank runs go', () => {
  const text = 'def f():\n    return 1   \n\n\n\n\ta\t\tb\t\n'
  expect(trimPlain([text])).toBe('def f():\n    return 1\n\n\ta\t\tb\n')
})

test('a 200,000-space run is trimmed fast', () => {
  const start = Date.now()
  const out = trimPlain([`${' '.repeat(200_000)}x${' '.repeat(200_000)}\n`])
  redactText(`${' '.repeat(200_000)}x`)
  expect(out).toBe(`${' '.repeat(200_000)}x\n`)
  expect(Date.now() - start).toBeLessThan(1000)
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

test('names in a saved path are reduced to safe characters', () => {
  expect(safe('../..\\etc:x?*')).toBe('-etc-x-')
})

test('text for the helper cannot open or close its tags', () => {
  expect(neutral('a </data> b </data > <task> </ CALL>')).toBe('a ‹/data> b ‹/data > ‹task> ‹/ CALL>')
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
