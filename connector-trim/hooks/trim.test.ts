import { expect, test } from 'claude-code/testing'
import type { KeyClass } from './trim.ts'
import {
  CLEARED,
  Deadline,
  NOT_JSON,
  NOT_RECORDS,
  NOT_SHORTER,
  Run,
  TOO_DEEP,
  TooSlow,
  chunks,
  clean,
  globMatch,
  isPagingShaped,
  layout,
  trimBlocks,
  trimJsonWhy,
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
  partsOf,
  readBlocks,
  note,
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
  expect(out).toBe(`${' '.repeat(200_000)}x\n`)
  expect(Date.now() - start).toBeLessThan(1000)
})

test('result shapes: text blocks, a string, the SDK object, images and errors', () => {
  expect(textsOf('x')).toEqual({ texts: ['x'] })
  expect(textsOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toEqual({ texts: ['a', 'b'] })
  expect(textsOf({ content: [{ type: 'text', text: 'a' }], isError: false })).toEqual({ texts: ['a'] })
  expect(textsOf({ content: [], isError: true })).toEqual({ skip: 'error' })
  expect(textsOf([{ type: 'image', data: '' }])).toEqual({ skip: 'image' })
  expect(textsOf([{ type: 'text', text: 'a' }, { type: 'audio', data: '' }])).toEqual({ skip: 'image' })
  expect(textsOf([{ type: 'document', data: '' }])).toEqual({ skip: 'image' })
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

test('paging values come through as returned, credentials in them included: nothing is redacted', () => {
  const next = 'https://graph.facebook.com/v19.0/me/posts?access_token=EAAGm0PX4ZCpsBA&after=QVFIUk&limit=25'
  const t = trimmed(
    JSON.stringify({
      secrets: { nextPageToken: 'abc123DEF456', api_key: 'sk-live-1' },
      paging: { next, auth_token: 'abc123DEF456' },
      nextLink: 'https://x.io/a?page-token=CAESBAgCEAE12&sig=AbCd123456789',
      rows: [{ password: 'hunter22', note: 'password=hunter22 Bearer abcdefghijklmnopqrstuvwxyz' }],
    }),
  )
  expect(t.value).toEqual({
    secrets: { nextPageToken: 'abc123DEF456', api_key: 'sk-live-1' },
    paging: { next, auth_token: 'abc123DEF456' },
    nextLink: 'https://x.io/a?page-token=CAESBAgCEAE12&sig=AbCd123456789',
    rows: [{ password: 'hunter22', note: 'password=hunter22 Bearer abcdefghijklmnopqrstuvwxyz' }],
  })
  expect(t.paging).toBe(
    `secrets.nextPageToken="abc123DEF456", paging.next="${next}", paging.auth_token="abc123DEF456", nextLink="https://x.io/a?page-token=CAESBAgCEAE12&sig=AbCd123456789"`,
  )
})

test('a bookkeeping field the task names is kept', () => {
  const t = trimmed('{"rows":[{"id":1,"etag":"W/x","__typename":{"v":1}}]}', wordsOf('show the etag and typename'))
  expect(t.value.rows).toEqual([{ id: 1, etag: 'W/x', __typename: { v: 1 } }])
  expect(t.stats.noise.size).toBe(0)
})

test('the JSON reader: a string ending in a backslash, and trailing text is no JSON', () => {
  expect(parseJson('{"p":"C:\\\\","q":"x\\\\\\"y"}')).toEqual({ p: 'C:\\', q: 'x\\"y' })
  expect(parseJson('{"a":1} x')).toBeUndefined()
  expect(readBlocks(['{"a":1} x'])).toBe(NOT_JSON)
})

test('a long hex id is no base64; padding, other letters or great length make it so', () => {
  const hex = 'a1'.repeat(150)
  const t = trimmed(
    JSON.stringify({ rows: [{ id: hex, b: b64(300), pad: `${'abcdef0123'.repeat(30)}==`, longHex: 'f0'.repeat(600) }] }),
  )
  expect(t.value.rows).toEqual([{ id: hex }])
  expect([...t.stats.blobs]).toEqual(['b', 'pad', 'longHex'])
})

test('JSON nested thousands of levels deep is too deep, never "not JSON", and never overflows', () => {
  for (const depth of [3000, 20_000]) {
    expect(readBlocks(['['.repeat(depth) + ']'.repeat(depth)])).toBe(TOO_DEEP)
    expect(readBlocks(['{"a":'.repeat(depth) + '1' + '}'.repeat(depth)])).toBe(TOO_DEEP)
    // Too deep wins over a block that is no JSON at all.
    expect(readBlocks(['plain text', '['.repeat(depth)])).toBe(TOO_DEEP)
  }
  // JSON that deep inside a text value stays text.
  const deep = '['.repeat(1900) + ']'.repeat(1900)
  expect(trimmed(JSON.stringify({ a: deep, b: 1 })).value.a).toBe(deep)
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

test('inputs that made the tag swap and the chunks quadratic run in linear time', () => {
  const start = Date.now()
  neutral(`<${' '.repeat(99_990)}x`)
  neutral(`<${' '.repeat(5000)}`.repeat(400))
  restore(`‹${' '.repeat(99_990)}x`)
  chunks('a'.repeat(3_000_000), 100_000)
  expect(Date.now() - start).toBeLessThan(2000)
})

// ---------- third review: the key rules ----------

// Every key the reviews named, with its class by name: a paging key's value
// is kept as returned when paging-shaped, a group's fields are all paging.
const KEY_TABLE: Record<KeyClass, string[]> = {
  paging: [
    'next_page_token', 'pageToken', 'nextPageToken', 'page-token', 'continuationToken', 'ContinuationToken',
    'NextContinuationToken', 'sync_token', 'nextSyncToken', '$skiptoken', '$deltatoken', 'delta_token', 'cursor_token',
    'pagination_token', 'paging_token', 'previous_token', 'prev_token', 'prevPageToken', 'bookmark_token', 'marker_token',
    'offset_token', 'after_token', 'before_token', 'resumeToken', 'start_token', 'scroll_token', '@odata.nextLink',
    '@odata.deltaLink', '@odata.count', 'nextLink', 'nextlink', 'next_link', 'next_url', 'nexturl', 'nextRecordsUrl',
    'next_page', 'next_page_key', 'nextpagetoken', 'NextMarker', 'Marker', 'KeyMarker', 'VersionIdMarker', 'marker',
    'bookmark', 'pageBookmark', 'endCursor', 'startCursor', 'next_cursor', 'cursor', 'continuation', 'resumePoint', 'scroll',
    'scroll_id', 'LastEvaluatedKey', 'ExclusiveStartKey', 'starting_after', 'ending_before', 'has_more', 'hasNextPage',
    'IsTruncated', 'total', 'totalCount', 'page', 'per_page', 'offset', 'limit', 'skip', 'next', 'prev', 'previous', 'after',
    'before', 'last_page', 'lastpage', 'first_url', 'search_after', 'since_id', 'page2', 'next_offset', 'nextoffset',
    // An acronym glued to a word; `previous` read before `prev`.
    'NEXTLink', 'previoustoken', 'previouspagetoken', 'first_id', 'last_id', 'next_id',
    // Paging by name whatever else is in it: kept as returned when paging-shaped.
    'next_auth_token', 'cursor_secret', 'last_token',
    // The longest key read as a name: 200 characters.
    `${'a'.repeat(190)}_pageToken`,
  ],
  group: ['pageInfo', 'page_info', 'pagination', 'paging', 'links', '_links', 'cursors'],
  none: [
    'tokens', 'token_type', 'token_count', 'token_usage', 'token_symbol', 'token_name', 'token_address', 'token_id', 'tokenId',
    'token_price', 'tokenizer', 'tokensUsed', 'num_tokens', 'max_tokens', 'total_tokens', 'input_tokens', 'output_tokens',
    'prompt_tokens', 'completion_tokens', 'cache_read_input_tokens', 'stoken', 'broken', 'spoken_language', 'key', 'keys',
    'session_id', 'authorization_status', 'authorization_url', 'authority', 'author', 'authors', 'authored_by', 'secretary',
    'passwordless', 'preauth', 'next_steps', 'nextAction', 'next_of_kin', 'nextel', 'linkedin_link', 'permalink',
    'hyperlink', 'html_link', 'download_link', 'blink', 'markers', 'meta', 'response_metadata', 'selfLink',
    '@odata.editLink', '@odata.context', 'first', 'last', 'monkey', 'xyzkey', 'firstname', 'token',
    // Credential names are data like any other.
    'password', 'api_key', 'access_token', 'refresh_token', 'auth_token', 'slack_token', 'oauth2_token', 'sig', 'credentials',
    // Longer than any name: never split, never paging.
    `${'a'.repeat(191)}_pageToken`,
  ],
}

test('the key rules, class by class', () => {
  const wrong: string[] = []
  for (const [want, keys] of Object.entries(KEY_TABLE)) for (const k of keys) if (keyClass(k) !== want) wrong.push(`${k}: ${keyClass(k)}, not ${want}`)
  expect(wrong).toEqual([])
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
  // 30 values are more than a paging group holds: they are data, base64 left out.
  const many = trimmed(JSON.stringify({ links: Array.from({ length: 30 }, () => b64(300)), rows: [] }))
  expect(many.stats.blobItems).toBe(30)
})

test('the header lists paging values up to 4,000 characters, then only their names', () => {
  const t = trimmed(JSON.stringify({ next_cursor: 'c'.repeat(3000), bookmark: 'b'.repeat(1500), page: 2, rows: [] }))
  expect(t.paging).toBe('next_cursor, bookmark, page (4,535 characters of values, in the body below)')
  expect(t.value.next_cursor).toBe('c'.repeat(3000))
  expect(pagingLine([['a', '1']])).toBe('a=1')
  expect(pagingLine([['a', 'x'.repeat(3998)]])).toBe(`a=${'x'.repeat(3998)}`)
  expect(pagingLine([['a', 'x'.repeat(3999)]])).toBe('a (4,001 characters of values, in the body below)')
})

test('a request of many reminder tags is read in linear time', () => {
  const start = Date.now()
  taskOf([{ role: 'user', text: '<system-reminder>'.repeat(50_000) }])
  expect(Date.now() - start).toBeLessThan(1000)
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
  expect(parseJson('{"a";1}')).toBeUndefined()
  expect(parseJson('{"a":1}')).toEqual({ a: 1 })
})

test('chunks fill a part to exactly its size', () => {
  expect(chunks('aaaa\nbbbb', 9)).toEqual(['aaaa\nbbbb'])
  expect(chunks('aaaa\nbbbbb', 9)).toEqual(['aaaa', 'bbbbb'])
})

// ---------- fourth review ----------

// A clock that starts before the deadline and moves on one unit per read.
const ticking = (at: number) => {
  let now = 0
  return new Deadline(at, () => now++)
}

test('a deadline in the past stops each entry point with TooSlow', () => {
  const past = () => new Run(new Deadline(0, () => 1))
  expect(() => readBlocks(['{"a":"b"}'], past())).toThrow(TooSlow)
  expect(() => trimBlocks([{ a: 'b' }], none, { run: past() })).toThrow(TooSlow)
  expect(() => trimJsonWhy(['{"a":"b"}'], none, { run: past() })).toThrow(TooSlow)
})

test('the deadline is checked inside the long loops, not only between stages', () => {
  const records = JSON.stringify(Array.from({ length: 20_000 }, (_, i) => ({ id: i, name: `n${i}` })))
  // The entry check reads the clock once (0 < 3); only the loops read it again.
  expect(() => readBlocks([records], new Run(ticking(3)))).toThrow(TooSlow)
  const data = readBlocks([records]) as unknown[]
  expect(() => trimBlocks(data, none, { run: new Run(ticking(3)) })).toThrow(TooSlow)
  expect(() => trimJsonWhy([records], none, { run: new Run(ticking(1e9)) })).not.toThrow()
})

test('inside a paging group every field travels as returned, an empty object or list included', () => {
  const t = trimmed('{"pageInfo":{"endCursor":"c1","filter":{},"sort":[],"etag":"x"},"rows":[{"a":1,"filter":{}}]}')
  expect(t.value).toEqual({ pageInfo: { endCursor: 'c1', filter: {}, sort: [], etag: 'x' }, rows: [{ a: 1 }] })
  expect([...t.stats.empty]).toEqual(['filter'])
})

test('empty paging containers stay; a HAL link counts as one value', () => {
  const t = trimmed(JSON.stringify({ LastEvaluatedKey: {}, next: [], cursors: {}, Items: [{ a: 1 }] }))
  expect(t.value).toEqual({ LastEvaluatedKey: {}, next: [], cursors: {}, Items: [{ a: 1 }] })
  const link = (n: string) => ({ href: `https://x/items?page=${n}`, title: `Page ${n}`, type: 'application/hal+json', templated: false })
  const hal = trimmed(JSON.stringify({ _links: { self: link('2'), first: link('1'), last: link('9'), next: link('3'), prev: link('1') }, rows: [] }))
  for (const k of ['self', 'first', 'last', 'next', 'prev']) expect(hal.paging).toContain(`_links.${k}.href=`)
})

test('paging shape: 20 values hold, 21 do not; five levels hold, six do not', () => {
  const list = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`)
  expect(isPagingShaped(list(20))).toBe(true)
  expect(isPagingShaped(list(21))).toBe(false)
  const nest = (n: number): unknown => (n === 0 ? 'x' : { a: nest(n - 1) })
  expect(isPagingShaped(nest(5))).toBe(true)
  expect(isPagingShaped(nest(6))).toBe(false)
})

test('bookkeeping fields under a paging group are kept', () => {
  expect(trimmed(JSON.stringify({ pageInfo: { etag: [1], n: 2 }, rows: [] })).value.pageInfo).toEqual({ etag: [1], n: 2 })
})

test('hoisting compares single values only; a field holding an object or list is never hoisted', () => {
  const rows = [1, 2, 3].map(i => ({ id: i, kind: 'A', nested: { x: 1 }, list: [1] }))
  const t = trimmed(JSON.stringify({ rows }))
  expect(t.value.rows['same in every record']).toEqual({ kind: 'A' })
  expect(t.value.rows.records[0]).toEqual({ id: 1, nested: { x: 1 }, list: [1] })
})

test('the layout indents at most 12 levels and stops past its length limit', () => {
  let v: unknown = { a: [{ b: 1 }, { b: 2 }] }
  for (let i = 0; i < 20; i++) v = { a: v, b: 1 }
  const text = layout(v)
  const widest = Math.max(...text.split('\n').map(l => l.length - l.trimStart().length))
  expect(widest).toBe(2 * 12)
  expect(JSON.parse(text)).toEqual(v)
  expect(trimJsonWhy([JSON.stringify(v)], none, { maxChars: 100 })).toBe(NOT_SHORTER)
})

test('depth: 200 levels are laid out, 201 are not', () => {
  const at = (n: number) => '['.repeat(n) + '"x"' + ']'.repeat(n)
  expect(typeof trimJsonWhy([at(200)], none)).toBe('object')
  expect(trimJsonWhy([at(201)], none)).toBe(TOO_DEEP)
  const obj = (n: number) => '{"a":'.repeat(n) + '1' + '}'.repeat(n)
  expect(typeof trimJsonWhy([obj(200)], none)).toBe('object')
  expect(trimJsonWhy([obj(201)], none)).toBe(TOO_DEEP)
  expect(trimJsonWhy(['"just text"'], none)).toBe(NOT_RECORDS)
  expect(trimJsonWhy(['just text'], none)).toBe(NOT_JSON)
})

test('the request is read up to 20,000 characters, reminders taken out in one scan', () => {
  expect(clean(`a<system-reminder>x</system-reminder>b<system-reminder>y</system-reminder>c`)).toBe('abc')
  expect(clean('</system-reminder>a<system-reminder>b')).toBe('</system-reminder>a<system-reminder>b')
  expect(clean(`${'x'.repeat(30_000)}`)).toHaveLength(20_000)
})

test('globs match in linear passes, however many stars', () => {
  expect([globMatch('ccd_*', 'ccd_session'), globMatch('*snap?hot*', 'navigate_and_snapshot'), globMatch('a*b', 'ab'), globMatch('a*b', 'ac')]).toEqual([true, true, true, false])
  const start = Date.now()
  expect(matches(`mcp__${'a'.repeat(100_000)}__b`, ['*a*a*a*a*a*a*b*c'])).toBe(false)
  expect(Date.now() - start).toBeLessThan(1500)
})

test('a deadline reached exactly has passed', () => {
  expect(() => new Deadline(5, () => 5).checkNow()).toThrow(TooSlow)
  expect(() => new Deadline(5, () => 4).checkNow()).not.toThrow()
})

test('the reader and the trim walk each check the deadline', () => {
  const far = () => new Deadline(Number.MAX_SAFE_INTEGER)
  // 20,000 numbers: the reader checks once per value.
  const b = far()
  readBlocks([JSON.stringify(Array.from({ length: 20_000 }, (_, i) => i))], new Run(b))
  expect(b.calls).toBeGreaterThanOrEqual(20_000)
  // 20,000 records of two fields, 60,001 values: trimmed and laid out.
  const data = readBlocks([JSON.stringify(Array.from({ length: 20_000 }, (_, i) => ({ id: i, n: `n${i}` })))]) as unknown[]
  const c = far()
  trimBlocks(data, none, { run: new Run(c) })
  expect(c.calls).toBeGreaterThanOrEqual(60_001 + 20_000)
})

test('a run classifies each key once, in its own book', () => {
  const run = new Run()
  trimJsonWhy(['[{"next_page_token":"x","n":"1"},{"next_page_token":"y","n":"2"}]'], none, { run })
  expect([...run.keys.keys()].sort()).toEqual(['n', 'next_page_token'])
  expect(run.keys.get('next_page_token')).toEqual({ paging: true, group: true })
})


// ---------- fifth review: boundaries ----------

test('next_offset is paging, and listed in the header', () => {
  expect(pagingOf({ next_offset: 40, rows: [] })).toEqual([['next_offset', '40']])
})

test('a paging group holds 20 HAL links, each one value; 21 are data', () => {
  const links = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`l${i}`, { href: `https://x/${i}`, title: 'Page x' }]))
  expect(isPagingShaped(links(20))).toBe(true)
  expect(isPagingShaped(links(21))).toBe(false)
  expect(isPagingShaped({ next: { href: 'page two' } })).toBe(false)
})

test('in a list a text of 1,000 characters is kept, one of 1,001 is cut', () => {
  const t = trimmed(JSON.stringify({ rows: [{ a: 'w '.repeat(500) }, { a: `${'w '.repeat(500)}x` }] }))
  expect(t.value.rows[0].a).toBe('w '.repeat(500))
  expect(t.value.rows[1].a).toBe(`${'w '.repeat(500)} …[cut: 1 more characters in the saved file]`)
})

test('a hex run is base64 from 1,000 characters on; letters with no digit never are', () => {
  const t = trimmed(JSON.stringify({ rows: [{ a: 'f0'.repeat(500), b: `${'f0'.repeat(499)}f`, c: 'abcxyz'.repeat(50) }] }))
  expect([...t.stats.blobs]).toEqual(['a'])
  expect(t.value.rows[0]).toEqual({ b: `${'f0'.repeat(499)}f`, c: 'abcxyz'.repeat(50) })
})

test('the layout may be exactly as long as its limit', () => {
  const v = { a: [{ b: 1 }, { b: 2 }] }
  const n = layout(v).length
  expect(layout(v, n)).toBe(layout(v))
  expect(() => layout(v, n - 1)).toThrow()
})

test('a long line breaks after a comma that opens a list before it breaks at a blank', () => {
  const line = `${'a'.repeat(60)} ${'b'.repeat(20)},[${'c'.repeat(40)}`
  expect(chunks(line, 100)[0]).toBe(line.slice(0, 82))
})

test("the note's header states the note's own length, across a change in digits", () => {
  for (let n = 9_400; n < 9_700; n++) {
    const text = note({ tool: 't', before: 50_000, how: 'trim', leftOut: '', reshaped: '', paging: '', file: 'f', body: 'x'.repeat(n) })
    const stated = Number(/→ ([\d,]+) characters/.exec(text)![1]!.replace(/,/g, ''))
    expect([n, stated]).toEqual([n, text.length])
  }
})

test('retention keeps a file exactly at the keep time and a folder exactly at its cap', () => {
  const f = (name: string, size: number, mtimeMs: number) => ({ name, kind: 'file', size, mtimeMs })
  expect(toClear([f('a', 600, 50)], 100, 50, 10_000)).toEqual([])
  expect(toClear([f('a', 600, 49)], 100, 50, 10_000)).toEqual(['a'])
  expect(toClear([f('a', 600, 100), f('b', 400, 90)], 100, 50, 1000)).toEqual([])
  expect(toClear([f('a', 600, 100), f('b', 401, 90)], 100, 50, 1000)).toEqual(['b'])
})

test('a name in a saved path is at most 60 characters', () => {
  expect(safe('a'.repeat(100))).toBe('a'.repeat(60))
})

test('six filler words are an approval; seven are not', () => {
  expect(isFiller('jo ok dobre super jasne fajn')).toBe(true)
  expect(isFiller('jo ok dobre super jasne fajn diky')).toBe(false)
})

test('a plural loses its s only past four letters', () => {
  expect([...wordsOf('cars costs')].sort()).toEqual(['cars', 'cost', 'costs'])
})

test('a key part of three letters is named; a key past 200 characters is not', () => {
  expect(isNamed('fooBar', new Set(['foo']))).toBe(true)
  const cost = new Set(['cost'])
  expect(isNamed(`cost_${'x'.repeat(195)}`, cost)).toBe(true)
  expect(isNamed(`cost_${'x'.repeat(196)}`, cost)).toBe(false)
})

test('exact numbers that agree in every record are hoisted', () => {
  const t = trimJson(['{"rows":[{"id":1,"price":1.50},{"id":2,"price":1.50},{"id":3,"price":1.50}]}'], none)!
  expect(t.text).toContain('"same in every record": {"price":1.50}')
  expect(t.stats.hoisted).toBe(1)
})

test('the JSON reader: no bare decimal point, no raw control character, CR is a blank, __proto__ is a field', () => {
  expect(parseJson('[1.]')).toBeUndefined()
  expect(parseJson('["a\tb"]')).toBeUndefined()
  expect(parseJson('{\r\n"a":1\r\n}')).toEqual({ a: 1 })
  const proto = parseJson('{"__proto__":{"a":1},"b":2}') as Record<string, unknown>
  expect(Object.keys(proto)).toEqual(['__proto__', 'b'])
  expect(ser(proto)).toBe('{"__proto__":{"a":1},"b":2}')
})

test('JSON records nested past 200 levels inside a text value stay text', () => {
  const deep = '{"b":1,"a":'.repeat(300) + '1' + '}'.repeat(300)
  expect(trimmed(JSON.stringify({ a: deep, n: 1 })).value.a).toBe(deep)
})

test('blocks share one length limit', () => {
  const block = JSON.stringify({ a: 'x'.repeat(100) })
  const one = layout(JSON.parse(block)).length
  expect(typeof trimJsonWhy([block], none, { maxChars: one + 10 })).toBe('object')
  expect(trimJsonWhy([block, block], none, { maxChars: one + 10 })).toBe(NOT_SHORTER)
})

test('a run keeps which keys each set of words names apart', () => {
  const run = new Run()
  const rows = '[{"cost":1,"clicks":2,"etag":"x"}]'
  expect(JSON.parse(trimJson([rows], new Set(['etag']), { run })!.text)).toEqual([{ cost: 1, clicks: 2, etag: 'x' }])
  expect(JSON.parse(trimJson([rows], new Set(['cost']), { run })!.text)).toEqual([{ cost: 1, clicks: 2 }])
})

// ---------- sixth review ----------

test('paging values held in lists are kept as returned and listed in the header', () => {
  const links = [
    { rel: 'next', href: 'https://x?p=2', method: 'GET' },
    { rel: 'prev', href: 'https://x?p=0', method: 'GET' },
    { rel: 'self', href: 'https://x?p=1', method: 'GET' },
  ]
  const items = Array.from({ length: 300 }, (_, i) => ({ id: i, name: `n${i}`, kind: 'A' }))
  const t = trimmed(JSON.stringify({ items, links, search_after: [1700000000000, 'id#9'] }))
  expect(t.value.links).toEqual(links)
  expect(t.value.search_after).toEqual([1700000000000, 'id#9'])
  expect(t.paging).toBe(`links=${JSON.stringify(links)}, search_after=[1700000000000,"id#9"]`)
  // Records outside a paging group are still hoisted.
  expect(t.value.items['same in every record']).toEqual({ kind: 'A' })
  // A list of values past the header's 4,000 characters is named, its values left to the body.
  const long = Array.from({ length: 20 }, (_, i) => `${'c'.repeat(250)}${i}`)
  expect(trimmed(JSON.stringify({ search_after: long, rows: [] })).paging).toMatch(/^search_after \([\d,]+ characters of values, in the body below\)$/)
})

test('two different exact ids are not hoisted as one', () => {
  const t = trimJson(['{"rows":[{"id":9007199254740993,"n":1},{"id":9007199254740993,"n":2},{"id":9007199254740995,"n":3}]}'], none)!
  expect(t.stats.hoisted).toBe(0)
  expect(t.text).toContain('9007199254740995')
})

test('an empty text and an empty list are left out as empty fields', () => {
  const t = trimmed('{"rows":[{"id":1,"s":"","l":[],"o":{},"n":null}]}')
  expect(t.value.rows).toEqual([{ id: 1 }])
  expect([...t.stats.empty]).toEqual(['s', 'l', 'o', 'n'])
})

test('a field present in only some records is not hoisted', () => {
  const t = trimmed('{"rows":[{"id":1,"k":null},{"id":2},{"id":3,"k":null}]}')
  expect(t.stats.hoisted).toBe(0)
})

test('the task holds what the assistant wrote in the row that makes the call', () => {
  const rows = [
    { role: 'user', text: 'Stáhni report kampaní' },
    { role: 'assistant', text: 'Stahuji report.', toolUses: [{ tool_use_id: 't1' }] },
    { role: 'assistant', text: 'Hotovo.' },
  ]
  expect(taskOf(rows, 't1')).toEqual({ user: 'Stáhni report kampaní', assistant: 'Stahuji report.' })
})

test('the request is cut at 2,000 characters and what was said at its last 1,500', () => {
  const task = taskOf([
    { role: 'user', text: `${'x'.repeat(2000)}y` },
    { role: 'assistant', text: `a${'z'.repeat(1500)}` },
  ])
  expect(task.user).toBe(`${'x'.repeat(2000)}…`)
  expect(task.assistant).toBe(`…${'z'.repeat(1500)}`)
  expect(taskOf([{ role: 'user', text: 'x'.repeat(2000) }]).user).toBe('x'.repeat(2000))
})

test('base64 starts at 200 characters', () => {
  const t = trimmed(JSON.stringify({ rows: [{ a: b64(200), b: b64(199) }] }))
  expect([...t.stats.blobs]).toEqual(['a'])
  expect(t.value.rows[0]).toEqual({ b: b64(199) })
})

test('the JSON reader refuses a leading zero and a word that only starts like false', () => {
  expect(parseJson('[01]')).toBeUndefined()
  expect(parseJson('[falsy]')).toBeUndefined()
  expect(parseJson('[0,10,false]')).toEqual([0, 10, false])
})

test('a cut never splits the highest surrogate pair', () => {
  expect(clip('ab􏿿', 3)).toBe('ab')
  expect(clipEnd('􏿿ab', 3)).toBe('ab')
})

test('__typename is bookkeeping', () => {
  const t = trimmed('{"rows":[{"id":1,"__typename":"Campaign"}]}')
  expect(t.value.rows).toEqual([{ id: 1 }])
  expect([...t.stats.noise]).toEqual(['__typename'])
})

test('blocks share one length limit, the blank line between them counted', () => {
  const a = JSON.stringify({ a: 'x'.repeat(100) })
  const whole = trimJsonWhy([a, a], none)
  if (typeof whole === 'string') throw new Error(whole)
  const [first, second] = whole.text.split('\n\n')
  const layoutOf2 = second!.length - 'Block 2 of 2:\n'.length
  expect(typeof trimJsonWhy([a, a], none, { maxChars: first!.length + 2 + layoutOf2 })).toBe('object')
  expect(trimJsonWhy([a, a], none, { maxChars: first!.length + 1 + layoutOf2 })).toBe(NOT_SHORTER)
})

test('the left-out line names 40 fields, then counts the rest', () => {
  const stats = (n: number) => {
    const t = trimmed(JSON.stringify({ rows: [Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, null]))] }))
    return leftOut(t.stats)
  }
  expect(stats(40)).toBe(`empty fields (${Array.from({ length: 40 }, (_, i) => `f${i}`).join(', ')})`)
  expect(stats(41)).toBe(`empty fields (${Array.from({ length: 40 }, (_, i) => `f${i}`).join(', ')}, and 1 more names)`)
})

test('a long line breaks after a comma before an object, and only in the second half of a piece', () => {
  const line = `${'a'.repeat(60)} ${'b'.repeat(20)},{${'c'.repeat(40)}`
  expect(chunks(line, 100)[0]).toBe(line.slice(0, 82))
  const early = `${'a'.repeat(30)},"${'b'.repeat(200)}`
  expect(chunks(early, 100)[0]).toBe(early.slice(0, 100))
})

test('a cleared file and one up to 8 bytes longer are not counted again', () => {
  const f = (name: string, size: number) => ({ name, kind: 'file', size, mtimeMs: 1 })
  expect(toClear([f('a', CLEARED.length + 8), f('b', CLEARED.length + 9)], 100, 50, 10_000)).toEqual(['b'])
})

test('a tool name keeps every part after the server', () => {
  expect(partsOf('mcp__srv__a__b')).toEqual({ server: 'srv', name: 'a__b' })
})
