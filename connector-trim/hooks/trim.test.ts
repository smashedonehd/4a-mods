import { expect, test } from 'claude-code/testing'
import type { KeyClass } from './trim.ts'
import {
  CLEARED,
  chunks,
  clip,
  clipEnd,
  isFiller,
  isNamed,
  keyClass,
  leftOut,
  matches,
  neutral,
  pagingLine,
  pagingOf,
  parseJson,
  redactJson,
  redactText,
  reshaped,
  restore,
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
    others: [token],
  })
  const t = trimmed(text)
  expect(t.value.data.search.pageInfo.endCursor).toBe(cursor)
  expect(t.value.next_token).toBe(token)
  expect(t.value.others).toEqual(['[base64 data: in the saved file]'])
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
  expect(pagingOf({ page: 2, rows: [{ count: 3, next: 'x' }] })).toEqual([['page', '2']])
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
    'a [REDACTED API key] b password=[REDACTED] token="t0k en" c: [REDACTED bearer token] [REDACTED private key] Authorization: [REDACTED]',
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
  const t = trimmed(JSON.stringify({ rows: [{ body: long, pic: b64(300), note: null }] }), wordsOf('the body, pic and note'))
  expect(t.value).toEqual({ rows: [{ body: long, pic: b64(300), note: null }] })
})

test('long strings in a list are cut with a marker and counted', () => {
  const t = trimmed(JSON.stringify({ rows: [{ body: 'word '.repeat(400) }] }))
  expect(t.text).toMatch(/…\[cut: 1,000 more characters in the saved file\]/)
  expect(leftOut(t.stats)).toBe('the rest of 1 text value over 1,000 characters, marked where cut')
})

test('a __proto__ field survives, and unpacked JSON strings are reported', () => {
  const t = trimmed('{"__proto__":{"x":1},"a":"[]","inner":"{\\"k\\":[1,2],\\"n\\":3}"}')
  expect(t.text).toContain('"__proto__": {"x":1}')
  expect(t.value.a).toBe('[]')
  expect(t.value.inner).toEqual({ k: [1, 2], n: 3 })
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

// ---------- second review ----------

// Pieces joined at run time, so the repository's own secret scan does not
// take the fixtures for keys.
const PEM_HEAD = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ')
const wellFormed = (s: string) => {
  try {
    encodeURIComponent(s)
    return true
  } catch {
    return false
  }
}

test('OData, HAL, markers, bookmarks and DynamoDB keys are paging: kept whole and listed', () => {
  const long = `https://api.x/items?page=2&q=${'q'.repeat(1100)}`
  const marker = b64(240)
  const text = JSON.stringify({
    '@odata.context': 'https://graph/$metadata#users',
    '@odata.count': 99,
    '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?$skiptoken=X',
    _links: { next: { href: 'https://api/x?page=2' }, self: { href: 'https://api/x?page=1' } },
    nextLink: long,
    next_page_key: marker,
    NextMarker: marker,
    bookmark: b64(5000),
    LastEvaluatedKey: { pk: { S: b64(5000) } },
    value: [{ id: 1, nextLink: long, Marker: marker, selfLink: 'https://x/1' }],
  })
  const t = trimmed(text)
  expect(t.value['@odata.count']).toBe(99)
  expect(t.value['@odata.nextLink']).toBe('https://graph.microsoft.com/v1.0/users?$skiptoken=X')
  expect(t.value._links).toEqual({ next: { href: 'https://api/x?page=2' }, self: { href: 'https://api/x?page=1' } })
  expect(t.value.nextLink).toBe(long)
  expect(t.value.next_page_key).toBe(marker)
  expect(t.value.NextMarker).toBe(marker)
  expect(t.value.bookmark).toBe(b64(5000))
  expect(t.value.LastEvaluatedKey.pk.S).toBe(b64(5000))
  expect(t.value.value).toEqual([{ id: 1, nextLink: long, Marker: marker }])
  expect([...t.stats.noise]).toEqual(['@odata.context', 'selfLink'])
  // Over 4,000 characters of values: the header names them, the body holds them.
  expect(t.paging).toMatch(
    /^@odata\.count, @odata\.nextLink, _links\.next\.href, _links\.self\.href, nextLink, next_page_key, NextMarker, bookmark, LastEvaluatedKey\.pk\.S \(/,
  )
  const small = trimmed(
    JSON.stringify({ '@odata.count': 99, '@odata.nextLink': 'https://g/u?$skiptoken=X', _links: { next: { href: 'h' } }, NextMarker: marker, rows: [] }),
  )
  expect(small.paging).toBe(`@odata.count=99, @odata.nextLink="https://g/u?$skiptoken=X", _links.next.href="h", NextMarker="${marker}"`)
})

test('beside the records a value is kept whole up to 4,000 characters; past that the usual rules apply', () => {
  const opaque = b64(3000)
  const t = trimmed(JSON.stringify({ state: opaque, huge: b64(4500), prose: 'w '.repeat(2500), rows: [{ id: 1, state: opaque }] }))
  expect(t.value.state).toBe(opaque)
  expect(t.value.huge).toBeUndefined()
  expect(t.value.prose).toMatch(/ …\[cut: 4,000 more characters in the saved file\]$/)
  expect(t.value.rows).toEqual([{ id: 1 }])
  expect(leftOut(t.stats)).toBe('base64 fields (huge, state); the rest of 1 text value over 1,000 characters, marked where cut')
})

test('marker and bookmark keys, and lists under a paging key, are kept whole inside a list', () => {
  const t = trimmed(
    JSON.stringify({
      rows: [{ id: 1, KeyMarker: b64(300), VersionIdMarker: b64(300), pageBookmark: b64(300), links: [b64(300), `https://x/next?c=${'q'.repeat(1500)}`] }],
    }),
  )
  expect(t.value.rows).toEqual([
    { id: 1, KeyMarker: b64(300), VersionIdMarker: b64(300), pageBookmark: b64(300), links: [b64(300), `https://x/next?c=${'q'.repeat(1500)}`] },
  ])
  expect(leftOut(t.stats)).toBe('')
})

test('a pageInfo group is kept whole inside a list, and listed in the header beside the records', () => {
  const inList = trimmed(JSON.stringify({ results: [{ id: 1, pageInfo: { blob: b64(300), long: 'q'.repeat(1500) } }] }))
  expect(inList.value.results[0].pageInfo).toEqual({ blob: b64(300), long: 'q'.repeat(1500) })
  expect(trimmed(JSON.stringify({ pageInfo: { foo: 'x', n: 3 }, rows: [] })).paging).toBe('pageInfo.foo="x", pageInfo.n=3')
})

test('a page token in a paging URL stays; a credential in one goes', () => {
  const v = JSON.parse(
    redactJson(
      JSON.stringify({
        next: 'https://a/b?page-token=CAESBAgCEAE&limit=60',
        links: { next: 'https://a/b?token=CAESBAgCEAE' },
        prev: 'https://a/b?access_token=zzzzzzzz&cursor=abc',
        note: 'see https://a/b?token=CAESBAgCEAE12',
      }),
    )!.text,
  )
  expect(v).toEqual({
    next: 'https://a/b?page-token=CAESBAgCEAE&limit=60',
    links: { next: 'https://a/b?token=CAESBAgCEAE' },
    prev: 'https://a/b?access_token=[REDACTED]&cursor=abc',
    note: 'see https://a/b?token=[REDACTED]',
  })
  const url = 'https://a/b?page-token=CAESBAgCEAE&next_token=abcdefgh&x_page_token=zzzzzzzz'
  expect(redactText(url).text).toBe(url)
  // The tail of a name too long to read whole is not a name of its own.
  const tailOnly = `${'p'.repeat(70)}-token=abcdefgh`
  expect(redactText(tailOnly).text).toBe(tailOnly)
})

test('code and empties beside a secret name are not secrets', () => {
  for (const s of [
    'const token = await getToken(user)',
    'if (token===undefined) return',
    'if (password == other) x',
    'password=None',
    'password=undefined',
    'token=null',
    'password=abc',
    'secret_rotated=2024-05-01T10:00',
    'password: reset it in settings',
    'pwd=/home/user/project',
  ])
    expect(redactText(s).text).toBe(s)
})

test('lower-case bearer, header-style keys, JWTs, URL passwords and cut-off keys are redacted', () => {
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxIn0', 'abcDEFghiJKLmno_pqrSTU'].join('.')
  const cases: [string, string][] = [
    ['authorization: bearer abc.def', 'authorization: [REDACTED]'],
    ['Authorization: Bearer short', 'Authorization: [REDACTED]'],
    ['x-api-key: abcdef123456', 'x-api-key: [REDACTED]'],
    ['api_key: abcdef123456 next', 'api_key: [REDACTED] next'],
    ['cookie: session=abcdef0123456789', 'cookie: [REDACTED]'],
    [`token ${jwt} end`, 'token [REDACTED JWT] end'],
    ['postgres://user:secretpw@db:5432/x', 'postgres://user:[REDACTED]@db:5432/x'],
    ['https://u:p4ssw0rd@host/db', 'https://u:[REDACTED]@host/db'],
    [`a ${PEM_HEAD.replace('RSA', 'ENCRYPTED')}\nMIIEabc+/=\nMIIE\nthe end.`, 'a [REDACTED private key]the end.'],
  ]
  for (const [input, out] of cases) expect([input, redactText(input).text]).toEqual([input, out])
  expect(redactText('authorization: bearer abcdefghijklmnopqrst').text).not.toContain('abcdefghij')
  expect(redactText('https://host:8080/path@x').text).toBe('https://host:8080/path@x')
})

test('a sk- slug is no key, with a digit or without; a real key is', () => {
  const slug = 'https://x.cz/sk-' + 'kompostovacitoaleta2024modelxyzabc' + '-navod'
  const plain = 'sk-' + 'a'.repeat(40)
  expect(redactText(`${slug} ${plain}`).text).toBe(`${slug} ${plain}`)
  expect(redactText('sk-' + 'a1'.repeat(20)).text).toBe('[REDACTED API key]')
})

test('JSON inside a string is redacted by key: an array of strings under a secret key goes whole', () => {
  const r = redactJson(JSON.stringify({ body: JSON.stringify({ api_key: ['k1longvalue', 'k2longvalue', 3] }) }))!
  expect(JSON.parse(JSON.parse(r.text).body)).toEqual({ api_key: ['[REDACTED]', '[REDACTED]', 3] })
  expect(r.found).toEqual(['apikey value', 'apikey value'])
})

test('a value already redacted is neither changed nor counted', () => {
  const text = '{"password":"[REDACTED]","rows":["password=[REDACTED]"]}'
  expect(redactJson(text)).toEqual({ text, found: [] })
})

test('a bookkeeping field the task names is kept', () => {
  const t = trimmed('{"rows":[{"id":1,"etag":"W/x","__typename":{"v":1}}]}', wordsOf('show the etag and typename'))
  expect(t.value.rows).toEqual([{ id: 1, etag: 'W/x', __typename: { v: 1 } }])
  expect(t.stats.noise.size).toBe(0)
})

test('the JSON reader: a string ending in a backslash, and trailing text is no JSON', () => {
  expect(parseJson('{"p":"C:\\\\","q":"x\\\\\\"y"}')).toEqual({ p: 'C:\\', q: 'x\\"y' })
  expect(parseJson('{"a":1} x')).toBeUndefined()
  expect(redactJson('{"a":1} x')).toBeUndefined()
})

test('a long hex id is no base64; padding, other letters or great length make it so', () => {
  const hex = 'a1'.repeat(150)
  const t = trimmed(
    JSON.stringify({ rows: [{ id: hex, b: b64(300), pad: `${'abcdef0123'.repeat(30)}==`, longHex: 'f0'.repeat(600) }] }),
  )
  expect(t.value.rows).toEqual([{ id: hex }])
  expect([...t.stats.blobs]).toEqual(['b', 'pad', 'longHex'])
})

test('input nested too deep to walk gives undefined, not an error', () => {
  for (const depth of [3000, 20_000]) {
    const deep = '['.repeat(depth) + ']'.repeat(depth)
    let r: unknown
    expect(() => {
      r = trimJson([deep], none)
    }).not.toThrow()
    if (r !== undefined) expect(typeof (r as { text: string }).text).toBe('string')
  }
})

test('plain text keeps CRLF line endings', () => {
  expect(trimPlain(['a  \r\nb\r\n\r\n\r\n\r\nc'])).toBe('a\r\nb\r\n\r\nc')
})

test('cuts never split a surrogate pair', () => {
  const s = `${'x'.repeat(999)}😀${'y'.repeat(50)}`
  const a = trimmed(JSON.stringify({ rows: [{ a: s }] })).value.rows[0].a as string
  expect(a).toBe(`${'x'.repeat(999)} …[cut: 52 more characters in the saved file]`)
  expect([clip('ab😀', 3), clipEnd('😀ab', 3), clip('ab😀', 4)]).toEqual(['ab', 'ab', 'ab😀'])
  expect(chunks(`${'x'.repeat(39)}😀y`, 40)).toEqual(['x'.repeat(39), '😀y'])
  const task = taskOf([
    { role: 'user', text: `${'x'.repeat(1999)}😀 more` },
    { role: 'assistant', text: `😀${'z'.repeat(1499)}` },
  ])
  expect([wellFormed(task.user), wellFormed(task.assistant)]).toEqual([true, true])
  expect(task.user).toBe(`${'x'.repeat(1999)}…`)
})

test('a line longer than a part is split after a JSON element, never inside a value', () => {
  const line = `[${Array.from({ length: 50 }, (_, i) => `{"id":${1_000_000 + i},"v":"a b"}`).join(',')}]`
  const parts = chunks(line, 100)
  expect(parts.join('')).toBe(line)
  expect(parts.every(p => p.length <= 100)).toBe(true)
  for (const p of parts.slice(0, -1)) expect(p.endsWith(',')).toBe(true)
  const nums = Array.from({ length: 60 }, (_, i) => 100_000 + i).join(',')
  const numParts = chunks(nums, 50)
  expect(numParts.join('')).toBe(nums)
  for (const p of numParts.slice(0, -1)) expect(p.endsWith(',')).toBe(true)
})

test('tags are neutralised and restored in one pass', () => {
  const text = 'a </data> <TASK x> < / call > <datasets> b'
  expect(neutral(text)).toBe('a ‹/data> ‹TASK x> ‹ / call > <datasets> b')
  expect(restore(neutral(text))).toBe(text)
  expect(restore('‹x ‹ data')).toBe('‹x < data')
})

test('inputs that made the regexes quadratic run in linear time', () => {
  const start = Date.now()
  expect(redactText(`${PEM_HEAD}\n`.repeat(20_000)).found.length).toBe(20_000)
  expect(redactJson(JSON.stringify({ log: `${PEM_HEAD}\n`.repeat(3000) }))!.found.length).toBe(3000)
  neutral(`<${' '.repeat(99_990)}x`)
  neutral(`<${' '.repeat(5000)}`.repeat(400))
  restore(`‹${' '.repeat(99_990)}x`)
  redactText(`password"${' '.repeat(1000)}x`.repeat(2000))
  redactText(`password${' '.repeat(1_000_000)}x`)
  redactText(`Bearer${' '.repeat(50)}`.repeat(20_000))
  redactText(`Authorization${' '.repeat(100)}`.repeat(10_000))
  redactText('a'.repeat(1_000_000))
  redactText(`${'x'.repeat(63)}=`.repeat(20_000))
  chunks('a'.repeat(3_000_000), 100_000)
  expect(Date.now() - start).toBeLessThan(2000)
})

// ---------- third review: the key rules ----------

// Every key the reviews named, with its class by name. A strong key's text
// is always a secret, a weak key's only when token-shaped, a paging key's is
// kept as returned when paging-shaped, a group's fields are all paging.
const KEY_TABLE: Record<KeyClass, string[]> = {
  strong: [
    'password', 'passwd', 'passphrase', 'secret', 'client_secret', 'api_key', 'apiKey', 'api-key', 'x-api-key', 'X-API-Key',
    'x_api_key', 'api_secret', 'access_key', 'accessKey', 'secret_key', 'secretKey', 'private_key', 'privateKey',
    'access_token', 'refresh_token', 'refreshToken', 'id_token', 'authorization', 'Authorization', 'Proxy-Authorization',
    'cookie', 'Cookie', 'set-cookie', 'Set-Cookie', 'set_cookie', 'connection_string', 'connectionString', 'dsn', 'pwd', 'PWD',
  ],
  weak: [
    'private_token', 'oauth_token', 'bot_token', 'csrf_token', 'x-auth-token', 'X-Auth-Token', 'personal_access_token',
    'github_token', 'SecurityToken', 'X-Amz-Security-Token', 'token_secret', 'webhook_secret', 'signing_secret', 'app_secret',
    'api_token', 'sessionToken', 'session_token', 'bearer_token', 'next_auth_token', 'auth', 'auth_header', 'basic_auth',
    'jwt', 'id_jwt', 'token', 'sig', 'credentials', 'client_credentials', 'X-Amz-Credential', 'X-Amz-Signature',
    'password_hash', 'my_password', 'secrets', 'AWS_SECRET_ACCESS_KEY', 'secretAccessKey', 'signing_key', 'encryption_key',
    'ssh_key', 'app_key', 'Ocp-Apim-Subscription-Key',
    // Weak by name, yet their usual values are no token: see the value table.
    'password_changed_at', 'has_password', 'password_policy', 'cookies', 'cookie_consent', 'cookies_enabled',
    'cookie_policy_url', 'signature', 'email_signature', 'method_signature', 'signature_required', 'secret_santa',
    'credentials_type', 'credential_type', 'jwt_enabled',
  ],
  paging: [
    'next_page_token', 'pageToken', 'nextPageToken', 'page-token', 'continuationToken', 'ContinuationToken',
    'NextContinuationToken', 'sync_token', 'nextSyncToken', '$skiptoken', '$deltatoken', 'delta_token', 'cursor_token',
    'pagination_token', 'paging_token', 'previous_token', 'prev_token', 'prevPageToken', 'bookmark_token', 'marker_token',
    'offset_token', 'after_token', 'resumeToken', 'start_token', 'scroll_token', 'last_token', '@odata.nextLink',
    '@odata.deltaLink', '@odata.count', 'nextLink', 'next_link', 'next_url', 'nextRecordsUrl', 'next_page', 'next_page_key',
    'NextMarker', 'Marker', 'KeyMarker', 'VersionIdMarker', 'marker', 'bookmark', 'pageBookmark', 'endCursor', 'startCursor',
    'next_cursor', 'cursor', 'continuation', 'resumePoint', 'scroll', 'scroll_id', 'LastEvaluatedKey', 'ExclusiveStartKey',
    'starting_after', 'ending_before', 'has_more', 'hasNextPage', 'IsTruncated', 'total', 'totalCount', 'page', 'per_page',
    'offset', 'limit', 'skip', 'next', 'prev', 'previous', 'after', 'before', 'last_page', 'first_url', 'search_after',
    'since_id',
  ],
  group: ['pageInfo', 'page_info', 'pagination', 'paging', 'links', '_links'],
  none: [
    'tokens', 'token_type', 'token_count', 'token_usage', 'token_symbol', 'token_name', 'token_address', 'token_id', 'tokenId',
    'token_price', 'tokenizer', 'tokensUsed', 'num_tokens', 'max_tokens', 'total_tokens', 'input_tokens', 'output_tokens',
    'prompt_tokens', 'completion_tokens', 'cache_read_input_tokens', 'stoken', 'broken', 'spoken_language',
    'request_token', 'idempotency_token', 'upload_token', 'device_token', 'push_token', 'state_token', 'end_token',
    'history_token', 'key', 'keys', 'session_id', 'authorization_status', 'authorization_url', 'authority', 'author',
    'authors', 'authored_by', 'secretary', 'passwordless', 'next_steps', 'nextAction', 'next_of_kin', 'nextel',
    'linkedin_link', 'permalink', 'hyperlink', 'html_link', 'download_link', 'blink', 'markers', 'meta',
    'response_metadata', 'selfLink', '@odata.editLink', '@odata.context', 'first', 'last', 'pwd2',
  ],
}

test('the key rules, class by class', () => {
  for (const [want, keys] of Object.entries(KEY_TABLE)) for (const k of keys) expect([k, keyClass(k)]).toEqual([k, want])
})

test('a strong key loses any text, a weak key only a token-shaped value', () => {
  const cases: [string, unknown, boolean][] = [
    // strong: any non-empty text; pwd unless a path
    ['password', 'hunter2', true],
    ['password', 'correct horse battery staple', true],
    ['api_key', 'k1', true],
    ['Cookie', 'a=b', true],
    ['pwd', 'hunter22', true],
    ['pwd', '/home/filip/project', false],
    ['PWD', 'C:\\Users\\x', false],
    ['pwd', '~/project', false],
    ['password', '', false],
    ['password', '[REDACTED]', false],
    // weak: token-shaped only (no blanks, 8+, not all digits, no date, time or URL)
    ['oauth_token', 'ya-abc123def456', true],
    ['oauth_token', 'zzz', false],
    ['token', 'tok1abcdef', true],
    ['signature', 'Best regards,\nJohn Smith', false],
    ['email_signature', 'S pozdravem, Filip', false],
    ['method_signature', 'void f(int)', false],
    ['password_changed_at', '2024-11-10T10:00:00Z', false],
    ['has_password', 'yes', false],
    ['secret_santa', 'Alice', false],
    ['credentials_type', 'oauth', false],
    ['cookie_policy_url', 'https://x/cookies', false],
    ['token', '12345678901', false],
    ['token', '10:30:00.000', false],
    // none
    ['authorization_status', 'approved', false],
    ['token_address', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', false],
    ['tokenizer', 'cl100k_base', false],
    ['session_id', 'abcdef123456', false],
  ]
  for (const [key, value, gone] of cases) {
    const r = redactJson(JSON.stringify({ [key]: value }))!
    expect([key, value, r.found.length > 0]).toEqual([key, value, gone])
  }
  const kept = { password: 12345678, pin: '1234', api_key: null, secret: true, tokens: ['the', 'quick'], max_tokens: '4096' }
  expect(redactJson(JSON.stringify(kept))!.found).toEqual([])
})

test('a secret-named object or list loses its token-shaped values at any depth; a header pair is judged by its name', () => {
  const out = (o: unknown) => JSON.parse(redactJson(JSON.stringify(o))!.text)
  expect(out({ credentials: { user: 'bob', value: 's3cretValue99', nested: [{ v: 's3cretValue98' }] } })).toEqual({
    credentials: { user: 'bob', value: '[REDACTED]', nested: [{ v: '[REDACTED]' }] },
  })
  expect(out({ token: { value: 's3cretValue99', expires: 3600 } })).toEqual({ token: { value: '[REDACTED]', expires: 3600 } })
  expect(out({ cookies: [{ name: 'sid', value: 's3cretValue99' }] })).toEqual({ cookies: [{ name: 'sid', value: '[REDACTED]' }] })
  expect(
    out({
      headers: [
        { name: 'Cookie', value: 'sid=s3' },
        { key: 'X-Api-Key', value: 'abc' },
        { name: 'Authorization', value: 'Basic dXNlcjpwYXNz' },
        { name: 'X-Request-Id', value: 'abcdef123456' },
        { name: 'sessions', value: '123' },
      ],
    }),
  ).toEqual({
    headers: [
      { name: 'Cookie', value: '[REDACTED]' },
      { key: 'X-Api-Key', value: '[REDACTED]' },
      { name: 'Authorization', value: '[REDACTED]' },
      { name: 'X-Request-Id', value: 'abcdef123456' },
      { name: 'sessions', value: '123' },
    ],
  })
  expect(out({ token_usage: { prompt_tokens: '120', total_tokens: 'abcdefgh1' } })).toEqual({
    token_usage: { prompt_tokens: '120', total_tokens: 'abcdefgh1' },
  })
})

test('paging values are left to their own rules: no value patterns, only credential-named parameters', () => {
  const jwt = ['eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9', 'eyJib3JkZXJfcmFuayI6NDI5MTY3fQ', 'Zm9vYmFyYmF6cXV4MTIz'].join('.')
  const v = JSON.parse(
    redactJson(
      JSON.stringify({
        next_page: { offset: jwt, uri: `https://app.asana.com/api/1.0/tasks?limit=5&offset=${jwt}` },
        next_cursor: jwt,
        pagination: { token: 'abc123def456', limit: 10 },
        paging: { next: 'https://graph.facebook.com/v19.0/me/posts?access_token=EAAGm0PX4ZCpsBA&after=QVFIUk&limit=25' },
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/messages/delta?$deltatoken=LztZwWjo5IivWBhyxw5rACKxf7mPm0oW6JZZ7fvdI',
        nextLink: 'https://x.io/a?page-token=CAESBAgCEAE12&sig=AbCd123456789',
        cursor: 'password:12345678',
        note: `see ${jwt}`,
      }),
    )!.text,
  )
  expect(v.next_page.offset).toBe(jwt)
  expect(v.next_page.uri).toBe(`https://app.asana.com/api/1.0/tasks?limit=5&offset=${jwt}`)
  expect(v.next_cursor).toBe(jwt)
  expect(v.pagination.token).toBe('abc123def456')
  expect(v.paging.next).toBe('https://graph.facebook.com/v19.0/me/posts?access_token=[REDACTED]&after=QVFIUk&limit=25')
  expect(v['@odata.deltaLink']).toContain('$deltatoken=LztZwWjo5IivWBhyxw5rACKxf7mPm0oW6JZZ7fvdI')
  expect(v.nextLink).toBe('https://x.io/a?page-token=CAESBAgCEAE12&sig=[REDACTED]')
  expect(v.cursor).toBe('password:12345678')
  expect(v.note).toBe('see [REDACTED JWT]')
})

test('a paging name holds paging only when its value is paging-shaped', () => {
  const prose = 'Lorem ipsum 123 '.repeat(400)
  const t = trimmed(
    JSON.stringify({
      next_steps: prose,
      before: prose,
      marker: { lat: 1, label: prose },
      next_cursor: 'session:12345678 key:ab12cd34ef',
      linkedin_link: 'https://linkedin.com/in/x',
      links: Array.from({ length: 30 }, (_, i) => ({ href: `https://x/${i}` })),
      nextLink: 'https://x/next',
      rows: [{ id: 1, before: prose }],
    }),
  )
  expect(t.paging).toBe('nextLink="https://x/next"')
  expect(t.value.before).toMatch(/…\[cut: /)
  expect(t.value.marker.label).toMatch(/…\[cut: /)
  expect(t.value.rows[0].before).toMatch(/…\[cut: /)
  expect(t.value.links).toHaveLength(30)
})

test('the header lists paging values up to 4,000 characters, then only their names', () => {
  const t = trimmed(JSON.stringify({ next_cursor: 'c'.repeat(3000), bookmark: 'b'.repeat(1500), page: 2, rows: [] }))
  expect(t.paging).toBe('next_cursor, bookmark, page (4,535 characters of values, in the body below)')
  expect(t.value.next_cursor).toBe('c'.repeat(3000))
  expect(pagingLine([['a', '1']])).toBe('a=1')
  expect(pagingLine([['a', 'x'.repeat(3998)]])).toBe(`a=${'x'.repeat(3998)}`)
  expect(pagingLine([['a', 'x'.repeat(3999)]])).toBe('a (4,001 characters of values, in the body below)')
})

test('text: strong names take any 6+ value, weak names a token-shaped one with a digit, code stays', () => {
  const cases: [string, string][] = [
    ['PASSWORD = hunter22', 'PASSWORD = [REDACTED]'],
    ['password: hunter', 'password: [REDACTED]'],
    ['password: 12345678', 'password: [REDACTED]'],
    ['X-API-Key: abcdefghijkl', 'X-API-Key: [REDACTED]'],
    ["password=\"it's secret22\"", 'password="[REDACTED]"'],
    ["{'password': 'hunter22'}", "{'password': '[REDACTED]'}"],
    ['password := "hunter22"', 'password := "[REDACTED]"'],
    ['X-Auth-Token: abcdefgh12', 'X-Auth-Token: [REDACTED]'],
    ['the token:abc12345def', 'the token:[REDACTED]'],
    ['my_password_is=hunter22', 'my_password_is=[REDACTED]'],
    ['pwd=hunter22', 'pwd=[REDACTED]'],
    ['Cookie: sid=abcdef0123456789; theme=dark', 'Cookie: [REDACTED]; theme=dark'],
    ['https://x.io/a?token=CAESBAgCEAE12', 'https://x.io/a?token=[REDACTED]'],
  ]
  for (const [input, out] of cases) expect([input, redactText(input).text]).toEqual([input, out])
  for (const s of [
    'def f(token=DEFAULT_TOKEN_12): pass',
    'let apiKey = process.env.API_KEY',
    'password = input("Password: ")',
    'const token = getToken(user)',
    'password = getPassword()',
    'retry(max_tokens=4096, token_limit=128000)',
    'total_tokens=1234567',
    'Tokens: 123456789',
    'max_tokens: 4096000000',
    'Password: reset it in settings',
    'signature: John Smith 3rd',
    'passwords: 12345678 found',
    'password: 2024-11-10',
    'secret: none',
    'password=true',
    'token: abc',
    'key: value123456',
    'session_id: 12345678',
    'pwd=/home/x',
    'https://x.io/a?pageToken=abc123456&nextPageToken=abc123456&continuation_token=abc1234567&$skiptoken=X12345678&sync_token=abc123456&$deltatoken=abc123456',
  ])
    expect(redactText(s).text).toBe(s)
})

test('empty-user URL passwords, PGP private keys and more key formats are caught', () => {
  const pgp = ['-----BEGIN', 'PGP PRIVATE KEY BLOCK-----\n\nlQOYBF\n-----END', 'PGP PRIVATE KEY BLOCK-----'].join(' ')
  const cases: [string, string][] = [
    ['redis://:s3cretpw@cache:6379/0', 'redis://:[REDACTED]@cache:6379/0'],
    [`key ${pgp} end`, 'key [REDACTED private key] end'],
    ['authorization: digest abc123', 'authorization: [REDACTED]'],
    [`x ${'glpat-'}${'abcdefghij0123456789'} y`, 'x [REDACTED GitLab token] y'],
    [`x ${'npm_'}${'a1'.repeat(18)} y`, 'x [REDACTED npm token] y'],
    [`x ${'sk_live_'}${'a1'.repeat(12)} y`, 'x [REDACTED Stripe key] y'],
  ]
  for (const [input, out] of cases) expect([input, redactText(input).text]).toEqual([input, out])
})

test('a JWT-like run, and every other pattern on its near misses, is read in linear time', () => {
  const start = Date.now()
  redactText('eyJaaaaa-'.repeat(60_000))
  redactText('eyJaaaaa.'.repeat(60_000))
  redactJson(JSON.stringify({ rows: [{ note: 'eyJaaaaa-'.repeat(60_000) }] }))
  redactText('sk-ant-'.repeat(100_000))
  redactText('ya29.'.repeat(200_000))
  redactText('xoxb-'.repeat(200_000))
  redactText('glpat-'.repeat(200_000))
  redactText('a.bearer '.repeat(100_000))
  redactText('ab://:'.repeat(200_000))
  redactText('password= '.repeat(100_000))
  redactText('<system-reminder>'.repeat(50_000))
  taskOf([{ role: 'user', text: '<system-reminder>'.repeat(50_000) }])
  expect(Date.now() - start).toBeLessThan(3000)
})

test('only records are unpacked from a text value: "[12]" and "{}" stay text', () => {
  const t = trimmed(JSON.stringify({ ref: '[12]', tags: '["a","b"]', one: '{"x":1}', two: '{"x":1,"y":2}', rows: '[{"a":1,"b":2}]' }))
  expect(t.value).toEqual({ ref: '[12]', tags: '["a","b"]', one: '{"x":1}', two: { x: 1, y: 2 }, rows: [{ a: 1, b: 2 }] })
  expect(t.stats.unpacked).toBe(2)
})

test('JSON nested deeper than 200 levels is not laid out', () => {
  const at = (n: number) => '['.repeat(n) + ']'.repeat(n)
  expect(trimJson([at(200)], none)).toBeDefined()
  expect(trimJson([at(202)], none)).toBeUndefined()
})

test('a value beside the records is kept whole at exactly 4,000 characters and cut past that', () => {
  const t = trimmed(JSON.stringify({ a: 'w '.repeat(2000), b: `${'w '.repeat(2000)}x`, rows: [] }))
  expect(t.value.a).toBe('w '.repeat(2000))
  expect(t.value.b).toMatch(/…\[cut: 3,001 more/)
})

test('null and bookkeeping fields inside a paging group are kept as returned', () => {
  const t = trimmed(JSON.stringify({ pageInfo: { etag: 'x', endCursor: null, startCursor: '' }, rows: [] }))
  expect(t.value.pageInfo).toEqual({ etag: 'x', endCursor: null, startCursor: '' })
})

test('the JSON reader refuses a missing colon', () => {
  expect(parseJson('{"a" 1}')).toBeUndefined()
  expect(parseJson('{"a":1}')).toEqual({ a: 1 })
})

test('chunks fill a part to exactly its size', () => {
  expect(chunks('aaaa\nbbbb', 9)).toEqual(['aaaa\nbbbb'])
  expect(chunks('aaaa\nbbbbb', 9)).toEqual(['aaaa', 'bbbbb'])
})
