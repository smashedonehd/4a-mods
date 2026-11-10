import { expect, test } from 'claude-code/testing'
import {
  CLEARED,
  chunks,
  clip,
  clipEnd,
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
  const t = trimmed(JSON.stringify({ rows: [{ body: long, pic: b64(300), note: null }] }), wordsOf('the body, pic and note'))
  expect(t.value).toEqual({ rows: [{ body: long, pic: b64(300), note: null }] })
})

test('long strings in a list are cut with a marker and counted', () => {
  const t = trimmed(JSON.stringify({ rows: [{ body: 'word '.repeat(400) }] }))
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
  for (const part of [
    '@odata.count=99',
    '@odata.nextLink="https://graph.microsoft.com/v1.0/users?$skiptoken=X"',
    '_links.next.href="https://api/x?page=2"',
    `nextLink="${long}"`,
    `next_page_key="${marker}"`,
    `NextMarker="${marker}"`,
    `bookmark="${b64(5000)}"`,
    `LastEvaluatedKey.pk.S="${b64(5000)}"`,
  ])
    expect([part, t.paging.includes(part)]).toEqual([part, true])
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
      rows: [{ id: 1, KeyMarker: b64(300), VersionIdMarker: b64(300), pageBookmark: b64(300), links: [b64(300), 'w '.repeat(800)] }],
    }),
  )
  expect(t.value.rows).toEqual([
    { id: 1, KeyMarker: b64(300), VersionIdMarker: b64(300), pageBookmark: b64(300), links: [b64(300), 'w '.repeat(800)] },
  ])
  expect(leftOut(t.stats)).toBe('')
})

test('a pageInfo group is kept whole inside a list, and listed in the header beside the records', () => {
  const inList = trimmed(JSON.stringify({ results: [{ id: 1, pageInfo: { blob: b64(300), prose: 'w '.repeat(800) } }] }))
  expect(inList.value.results[0].pageInfo).toEqual({ blob: b64(300), prose: 'w '.repeat(800) })
  expect(trimmed(JSON.stringify({ pageInfo: { foo: 'x', n: 3 }, rows: [] })).paging).toBe('pageInfo.foo="x", pageInfo.n=3')
})

test('a key with token in it is a credential unless it pages; a secret word anywhere makes one', () => {
  for (const k of [
    'private_token',
    'oauth_token',
    'bot_token',
    'csrf_token',
    'x-auth-token',
    'personal_access_token',
    'github_token',
    'SecurityToken',
    'token_secret',
    'api_secret',
    'webhook_secret',
    'signing_secret',
    'app_secret',
    'cookie',
    'Set-Cookie',
    'accessKey',
    'access_key_id',
    'connection_string',
    'ConnectionString',
    'client_credentials',
    'X-Amz-Signature',
    'apiKey',
    'Authorization',
    'token',
    'passphrase',
    'jwt',
    'id_jwt',
    'auth',
    'session_id',
    'dsn',
    'next_auth_token',
  ])
    expect([k, isSecretKey(k), isPaging(k)]).toEqual([k, true, false])
  for (const k of [
    'next_token',
    'nextPageToken',
    'page-token',
    'continuationToken',
    'sync_token',
    '$skiptoken',
    'resumeToken',
    'start_token',
    'scroll_token',
    'token_type',
    'expires_in',
  ])
    expect([k, isSecretKey(k)]).toEqual([k, false])
  expect([
    isSecretKey('pwd', 'hunter22'),
    isSecretKey('pwd', '/home/me'),
    isSecretKey('pwd', 'C:\\Users\\me'),
    isSecretKey('pwd'),
  ]).toEqual([true, false, false, false])
  const r = redactJson(
    JSON.stringify({
      private_token: 'glpat-abcdefghij1234567890',
      oauth_token: 'zzz',
      cookie: 'sid=abcdef',
      api_secret: 's3cr3tvalue',
      pwd: 'hunter22',
      shell: { pwd: '/srv/app' },
      rows: [{ bot_token: '123456:ABCdef' }],
    }),
  )!
  expect(JSON.parse(r.text)).toEqual({
    private_token: '[REDACTED]',
    oauth_token: '[REDACTED]',
    cookie: '[REDACTED]',
    api_secret: '[REDACTED]',
    pwd: '[REDACTED]',
    shell: { pwd: '/srv/app' },
    rows: [{ bot_token: '[REDACTED]' }],
  })
  expect(trimmed(r.text).paging).toBe('')
})

test('a page token in a paging URL stays; a credential in one goes', () => {
  const v = JSON.parse(
    redactJson(
      JSON.stringify({
        next: 'https://a/b?page-token=CAESBAgCEAE&limit=60',
        links: { next: 'https://a/b?token=CAESBAgCEAE' },
        prev: 'https://a/b?access_token=zzzzzzzz&cursor=abc',
        note: 'see https://a/b?token=CAESBAgCEAE',
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
