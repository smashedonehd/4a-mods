// Connector Trim's pure helpers: reading a tool result, the deterministic
// trim, the task words, the note's header and retention.
// Nothing here calls the engine, so the tests reach every rule directly.
import { Exact, TooDeep, TooSlow, isObject, isScalar, parseJson, put, readJson, ser } from './json.ts'
import type { Json } from './json.ts'

export { TooSlow, isObject, parseJson, ser }
export const NL = '\n'
// A text value inside a list is cut past this many characters.
export const STRING_CAP = 1000
// A text value outside every list (beside the records) is kept whole up to this.
export const HEAD_CAP = 4000
// The header lists paging values up to this many characters in all; past
// that it names the fields and leaves their values to the body.
export const PAGING_CAP = 4000
// Deeper JSON is passed whole: laying it out would cost more than it saves.
export const MAX_DEPTH = 200
// The layout indents at most this many levels; deeper levels keep that indent.
export const MAX_INDENT = 12
// A key longer than this is no name anyone reads: class none, never split.
export const MAX_KEY = 200
// Approximate tokens, the way the savings ledger counts them.
export const tokens = (chars: number) => Math.ceil(chars / 4)
export const fmt = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

// ---------- one result's run: its time budget and its key book ----------

// The time a result may take. `check` reads the clock on every 256th call, so
// it can sit inside the tightest loop; `checkNow` reads it every time.
// `calls` counts the checks, so tests can see which loops make them.
export class Deadline {
  calls = 0
  constructor(
    readonly at: number,
    private readonly clock: () => number = Date.now,
  ) {}
  check() {
    if ((++this.calls & 255) === 0) this.checkNow()
  }
  checkNow() {
    if (this.clock() >= this.at) throw new TooSlow()
  }
}

type KeyInfo = { paging: boolean; group: boolean }

// What one result shares across its passes: the deadline, each distinct key
// classified once, and which keys each set of task words names.
export class Run {
  readonly keys = new Map<string, KeyInfo>()
  readonly named = new WeakMap<ReadonlySet<string>, Map<string, boolean>>()
  constructor(readonly deadline?: Deadline) {}
}

let current: Run | undefined
const tick = () => current?.deadline?.check()
// `f` inside `run`, or inside a run of its own.
function inRun<T>(run: Run | undefined, f: () => T): T {
  const outer = current
  current = run ?? new Run()
  try {
    current.deadline?.checkNow()
    return f()
  } finally {
    current = outer
  }
}

// ---------- slicing ----------

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff
// An end index that does not split a surrogate pair: one back when it would.
export const safeEnd = (s: string, n: number) => (n > 0 && n < s.length && isHigh(s.charCodeAt(n - 1)) ? n - 1 : n)
// A start index that does not split a surrogate pair: one on when it would.
export const safeStart = (s: string, n: number) => (n > 0 && n < s.length && isLow(s.charCodeAt(n)) ? n + 1 : n)
// The first `n` characters, or the last, never half an emoji.
export const clip = (s: string, n: number) => s.slice(0, safeEnd(s, n))
export const clipEnd = (s: string, n: number) => s.slice(safeStart(s, Math.max(0, s.length - n)))

// ---------- the result's text ----------

// The text blocks of an MCP result (a string, a list of content blocks, or
// the SDK's `{ content, isError }`), or why it is not ours to change.
export function textsOf(result: unknown): { texts: string[] } | { skip: string } {
  if (typeof result === 'string') return { texts: [result] }
  let blocks: unknown[] | undefined
  if (Array.isArray(result)) blocks = result
  else if (isObject(result) && Array.isArray(result.content)) {
    if (result.isError === true) return { skip: 'error' }
    blocks = result.content
  }
  if (!blocks) return { skip: 'not text' }
  const texts: string[] = []
  for (const b of blocks) {
    const type = isObject(b) ? b.type : undefined
    if (type === 'image' || type === 'audio' || type === 'document') return { skip: 'image' }
    if (type !== 'text' || !isObject(b) || typeof b.text !== 'string') return { skip: `a ${String(type)} block` }
    texts.push(b.text)
  }
  return { texts }
}

// ---------- keys ----------
//
// A key is read as words: `nextPageToken`, `next_page_token` and
// `NEXT-PAGE-TOKEN` are next, page, token; a digit run is no word. Page words glued to `token` are split (`$skiptoken`,
// `nextpagetoken`), and so is a link name (`nextlink`). Each key is in one
// class:
//   paging: the way to the next page; kept as returned when its value is
//     paging-shaped.
//   group: every field under it is paging, when the whole is paging-shaped.
//   none.

// Words that make `<word>_token` a page's token.
const PAGE_WORDS = new Set(
  'next prev previous page paging pagination continuation sync skip resume start scroll cursor delta bookmark marker offset after before'.split(
    ' ',
  ),
)
const GLUED = [...PAGE_WORDS].sort((a, b) => b.length - a.length)
// `next`, `prev`, ... with `link`, `url`, `page`, ...: `nextLink`, `last_page`.
const LINK_FIRST = ['previous', 'delta', 'first', 'last', 'next', 'prev']
const LINK_LAST = new Set(['link', 'url', 'uri', 'href', 'page', 'token', 'cursor', 'key', 'marker', 'offset', 'id'])

// `head` read as page words, or undefined.
function pageWords(head: string): string[] | undefined {
  const out: string[] = []
  while (head !== '') {
    const w = GLUED.find(g => head.startsWith(g))
    if (!w) return undefined
    out.push(w)
    head = head.slice(w.length)
  }
  return out
}

// One lower-case word, split where page words were glued to `token` or a
// link name to its link word.
function unglue(word: string): string[] {
  if (word.endsWith('token')) {
    const known = pageWords(word.slice(0, -5))
    if (known) return [...known, 'token']
  }
  for (const first of LINK_FIRST)
    if (word.startsWith(first) && LINK_LAST.has(word.slice(first.length))) return [first, word.slice(first.length)]
  return [word]
}

const charKind = (c: number) => (c >= 97 && c <= 122 ? 1 : c >= 65 && c <= 90 ? 2 : c >= 48 && c <= 57 ? 3 : 0)

// The words of a key, by one scan.
export function keyWords(key: string): string[] {
  const out: string[] = []
  let start = -1
  for (let i = 0; i <= key.length; i++) {
    const k = i < key.length ? charKind(key.charCodeAt(i)) : 0
    if (start >= 0) {
      const p = charKind(key.charCodeAt(i - 1))
      // A word ends at a separator, at aB and between letters and digits.
      // A run of digits is no word: `page2` is page.
      if (k === 0 || (p === 1 && k === 2) || (p === 3) !== (k === 3)) {
        if (p !== 3) out.push(...unglue(key.slice(start, i).toLowerCase()))
        start = -1
      }
    }
    if (k !== 0 && start < 0) start = i
  }
  return out
}

// Paging by name. A paging token is `<page word>_token`.
const PAGING_NAMES = new Set(
  (
    'page pages pagenumber pagesize perpage pagecount nextpage hasnextpage haspreviouspage hasmore more total totalcount ' +
    'totalresults totalrows totalsize totalitems totalpages count rowcount offset limit skip cursor next prev previous ' +
    'after before startindex startat maxresults itemsperpage truncated istruncated islast scrollid marker bookmark ' +
    'continuation odatacount exclusivestartkey startingafter endingbefore searchafter pitid sinceid maxid'
  ).split(' '),
)
// Words that make any key paging: `endCursor`, `KeyMarker`, `pageBookmark`, `resumePoint`.
const PAGING_WORDS = new Set(['cursor', 'marker', 'bookmark', 'continuation', 'resume', 'scroll'])
// Objects whose fields are all paging.
const GROUP_NAMES = new Set(['pageinfo', 'pagination', 'paging', 'links', 'cursors'])
const LINK_FIRST_SET = new Set(LINK_FIRST)

function pagingNameOf(w: readonly string[], joined: string) {
  const p = w[0] === 'odata' ? w.slice(1) : w
  const first = p[0]
  const last = p[p.length - 1]
  const before = p[p.length - 2]
  if (first === undefined) return false
  return (
    PAGING_NAMES.has(joined) ||
    PAGING_NAMES.has(p.join('')) ||
    (p.length >= 2 && LINK_FIRST_SET.has(first) && LINK_LAST.has(last!)) ||
    p.some(x => PAGING_WORDS.has(x)) ||
    (last === 'token' && before !== undefined && PAGE_WORDS.has(before))
  )
}

const NO_INFO: KeyInfo = { paging: false, group: false }
function keyInfo(key: string): KeyInfo {
  if (key.length > MAX_KEY) return NO_INFO
  const words = keyWords(key)
  const joined = words.join('')
  const paging = pagingNameOf(words, joined)
  return { paging, group: paging || GROUP_NAMES.has(joined) }
}
// A key's class, read once per result.
function infoOf(key: string): KeyInfo {
  const book = current?.keys
  let info = book?.get(key)
  if (!info) {
    info = keyInfo(key)
    book?.set(key, info)
  }
  return info
}

export type KeyClass = 'paging' | 'group' | 'none'
// The class of a key by its name, for the rules above and their tests.
export function keyClass(key: string): KeyClass {
  const i = infoOf(key)
  return i.paging ? 'paging' : i.group ? 'group' : 'none'
}

// A value paging can hold: a number, a boolean, null, a string without
// blanks (a cursor or a URL), or an object or list of at most 20 such values
// all told; a HAL link (`{ href, title, templated }`) is one value, judged by
// its href.
export function isPagingShaped(v: unknown) {
  let left = 20
  const ok = (x: unknown, depth: number): boolean => {
    if (typeof x === 'string') return !/\s/.test(x)
    if (isScalar(x)) return true
    if (isObject(x) && typeof x.href === 'string') return !/\s/.test(x.href)
    const xs = Array.isArray(x) ? x : isObject(x) ? Object.values(x) : undefined
    if (!xs || depth > 4 || (left -= xs.length) < 0) return false
    return xs.every(y => ok(y, depth + 1))
  }
  return ok(v, 0)
}
// ---------- reading a result as JSON ----------

const looksLikeJson = (s: string) => /^\s*[[{]/.test(s)
// Why a result is passed whole rather than trimmed as JSON.
export const NOT_JSON = 'the result is not JSON'
export const NOT_RECORDS = 'the JSON is not an object or a list'
export const TOO_DEEP = `the JSON nests deeper than ${MAX_DEPTH} levels`
export const NOT_SHORTER = 'the trimmed JSON would be longer than the result'

// Each block of a result read as one JSON value, or why the result is not
// trimmed as JSON: a block that is no JSON, or one nested deeper than
// MAX_DEPTH. Depth is counted while reading, so no nesting can overflow the
// stack; a block that deep is passed whole, never read as text.
export function readBlocks(texts: readonly string[], run?: Run): unknown[] | string {
  return inRun(run, () => {
    const data: unknown[] = []
    let json = true
    for (const t of texts) {
      try {
        data.push(readJson(t, tick, MAX_DEPTH))
      } catch (e) {
        if (e instanceof TooDeep) return TOO_DEEP
        if (e instanceof TooSlow) throw e
        json = false
      }
    }
    return json ? data : NOT_JSON
  })
}

// ---------- the task's words ----------

// Lower case without diacritics, so "kampaně" and "kampane" are one word.
export const fold = (s: string) => s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase()

// Short approvals that carry no task of their own, Czech and English.
const FILLER = new Set(
  (
    'jo ja jj ano ok okay oki okej dobre dobra dobry super jasne fajn parada pokracuj pokracujte ' +
    'pokracovat dal dalsi delej makej jed jedem hotovo souhlas souhlasim schvaleno tak teda ted tedy no a i ' +
    'prosim diky dik dekuji dekuju yes yep yeah sure continue proceed go next thanks thx fine good great ' +
    'nice cool perfect done approved lgtm do it that this please'
  ).split(' '),
)

export function isFiller(text: string) {
  const words = fold(text).match(/[\p{L}\p{N}]+/gu) ?? []
  return words.length <= 6 && words.every(w => FILLER.has(w))
}

// The most of a request read before the reminders are taken out: past this
// it is clipped, so a huge message costs no more than a long one.
const TASK_READ = 20_000
const OPEN = '<system-reminder>'
const CLOSE = '</system-reminder>'

// What the person wrote, minus the reminders the engine puts into user rows:
// one forward scan, each reminder from its opening tag to the first closing
// tag after it; an opening tag with no closing one is text.
export function clean(s: string) {
  const text = s.length > TASK_READ ? clip(s, TASK_READ) : s
  let out = ''
  let at = 0
  for (let open = text.indexOf(OPEN); open >= 0; open = text.indexOf(OPEN, at)) {
    const close = text.indexOf(CLOSE, open)
    if (close < 0) break
    out += text.slice(at, open)
    at = close + CLOSE.length
  }
  return (out + text.slice(at)).trim()
}
const head = (s: string, n: number) => (s.length > n ? `${clip(s, n)}…` : s)
const tail = (s: string, n: number) => (s.length > n ? `…${clipEnd(s, n)}` : s)

export type Row = { role: string; text: string; toolUses?: readonly { tool_use_id: string }[] }

// The last real request before the call (approvals skipped) and what the
// assistant said between it and the call.
export function taskOf(rows: readonly Row[], toolUseId?: string) {
  const at = toolUseId ? rows.findIndex(r => r.toolUses?.some(u => u.tool_use_id === toolUseId)) : -1
  const end = at >= 0 ? at + 1 : rows.length
  let ask = -1
  let asked = ''
  for (let i = end - 1; i >= 0; i--) {
    const r = rows[i]!
    if (r.role !== 'user') continue
    const c = clean(r.text)
    if (c !== '' && !isFiller(c)) {
      ask = i
      asked = c
      break
    }
  }
  const said = rows
    .slice(ask + 1, end)
    .filter(r => r.role === 'assistant' && r.text.trim() !== '')
    .map(r => r.text.trim())
  return { user: ask >= 0 ? head(asked, 2000) : '', assistant: tail(said.join(NL), 1500) }
}

export function wordsOf(text: string) {
  const out = new Set<string>()
  for (const w of fold(text).match(/[\p{L}\p{N}]{3,}/gu) ?? []) {
    out.add(w)
    if (w.length > 4 && w.endsWith('s')) out.add(w.slice(0, -1))
  }
  return out
}

// A field the task names: its whole name or one of its parts
// (`costMicros`, `cost_micros`: `cost`). A key past MAX_KEY is never named.
export function isNamed(key: string, words: ReadonlySet<string>) {
  if (key.length > MAX_KEY || words.size === 0) return false
  let book = current?.named.get(words)
  if (current && !book) current.named.set(words, (book = new Map()))
  const hit = book?.get(key)
  if (hit !== undefined) return hit
  const parts = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^\p{L}\p{N}]+/u)
  const named = words.has(fold(key).replace(/[^\p{L}\p{N}]+/gu, '')) || parts.some(p => p.length >= 3 && words.has(fold(p)))
  book?.set(key, named)
  return named
}

// ---------- paging ----------

// The paging and count fields outside the records, as [name, value as
// returned]: `page`, `2`; `data.pageInfo.endCursor`, `"abc"`; a list whole,
// `search_after`, `[1700000000000,"id#9"]`. An object in a paging group is
// walked into, so each of its values is named by its path.
export function pagingOf(data: unknown, prefix = '') {
  const out: [string, string][] = []
  const walk = (v: unknown, path: string, group: boolean) => {
    if (!isObject(v)) return
    for (const k of Object.keys(v)) {
      tick()
      const x = v[k]
      const info = infoOf(k)
      const paging = group || (info.group && isPagingShaped(x))
      if (paging && (isScalar(x) || Array.isArray(x))) out.push([`${prefix}${path}${k}`, ser(x)])
      else if (!isScalar(x)) walk(x, `${path}${k}.`, paging)
    }
  }
  walk(data, '', false)
  return out
}

// The header's paging line: `name=value, …`, or past PAGING_CAP characters
// the names alone.
export function pagingLine(fields: readonly [string, string][]) {
  const full = fields.map(([k, v]) => `${k}=${v}`).join(', ')
  if (full.length <= PAGING_CAP) return full
  return `${fields.map(([k]) => k).join(', ')} (${fmt(full.length)} characters of values, in the body below)`
}

// ---------- the deterministic trim ----------

export type TrimStats = {
  empty: Set<string>
  blobs: Set<string>
  noise: Set<string>
  blobItems: number
  cut: number
  hoisted: number
  unpacked: number
}
export const newStats = (): TrimStats => ({
  empty: new Set(),
  blobs: new Set(),
  noise: new Set(),
  blobItems: 0,
  cut: 0,
  hoisted: 0,
  unpacked: 0,
})

export const SAME = 'same in every record'
export const BLOB_MARK = '[base64 data: in the saved file]'
const BLOB = /^(?:data:[\w/+.-]+;base64,)?[A-Za-z0-9+/_-]{200,}={0,2}$/
// Base64, not a long hex id: letters and digits both, and a character hex
// has not, `=` padding, or a length no id runs to.
const isBlob = (v: string) =>
  v.length >= 200 &&
  BLOB.test(v) &&
  /\d/.test(v) &&
  /[A-Za-z]/.test(v) &&
  (/[G-Zg-z+/_]/.test(v) || v.endsWith('=') || v.length >= 1000)
const DROPPED = Symbol('base64')
// Bookkeeping fields APIs add to every object. Paging fields are never here.
const NOISE = /^(?:etag|__typename|selfLink|@odata\.(?:etag|type|id|editLink|context))$/i

const isEmpty = (v: unknown) =>
  v === null ||
  v === undefined ||
  v === '' ||
  (Array.isArray(v) && v.length === 0) ||
  (isObject(v) && Object.keys(v).length === 0)

// JSON in a text value that is shown as JSON: an object of two fields or
// more, or a list of such objects. `"[12]"` or `"{}"` stays text.
const isRecord = (v: unknown) => isObject(v) && Object.keys(v).length >= 2
const isUnpackable = (v: unknown) => isRecord(v) || (Array.isArray(v) && v.length > 0 && v.every(isRecord))

// A text value: JSON in it is shown as JSON; inside a list, base64 is left out
// and a long value is cut. Beside the records, a value is kept whole up to
// HEAD_CAP characters, so a cursor or link under an unknown name survives.
function trimString(v: string, words: ReadonlySet<string>, t: TrimStats, inList: boolean): unknown {
  // Read to the same depth as the result: deeper, it stays text.
  const inner = v.length > 1 && looksLikeJson(v) ? parseJson(v, tick, MAX_DEPTH) : undefined
  if (isUnpackable(inner)) {
    t.unpacked += 1
    return trimValue(inner, words, t, false, inList)
  }
  if (!inList && v.length <= HEAD_CAP) return v
  if (isBlob(v)) return DROPPED
  if (v.length > STRING_CAP) {
    t.cut += 1
    const kept = clip(v, STRING_CAP)
    return `${kept} …[cut: ${fmt(v.length - kept.length)} more characters in the saved file]`
  }
  return v
}

// One trimmed value. Only an object's fields are ever left out; an array keeps
// every element in its place, since a row's position is its meaning. In a
// paging group every single value travels as returned.
function trimValue(v: unknown, words: ReadonlySet<string>, t: TrimStats, group: boolean, inList: boolean): unknown {
  tick()
  if (typeof v === 'string') return group ? v : trimString(v, words, t, inList)
  if (Array.isArray(v)) {
    const items = v.map(x => {
      const y = trimValue(x, words, t, group, true)
      if (y !== DROPPED) return y
      t.blobItems += 1
      return BLOB_MARK
    })
    // A paging group's list travels as returned, never reshaped.
    return group ? items : hoist(items, t)
  }
  if (!isObject(v)) return v
  const out: Json = {}
  for (const k of Object.keys(v)) {
    const x = v[k]
    const named = isNamed(k, words)
    const info = infoOf(k)
    const paging = group || (info.paging && isPagingShaped(x))
    // Single values the task names travel as returned (paging ones do in
    // the paging group below).
    if (named && isScalar(x)) {
      put(out, k, x)
      continue
    }
    if (!named && !paging && NOISE.test(k)) {
      t.noise.add(k)
      continue
    }
    const y = trimValue(x, words, t, group || (info.group && isPagingShaped(x)), inList)
    if (y === DROPPED) t.blobs.add(k)
    // An empty paging container (`LastEvaluatedKey: {}`) says there is no
    // next page, and inside a paging group every value travels: it stays.
    else if (isEmpty(y) && !named && !group && !info.group) t.empty.add(k)
    else put(out, k, y)
  }
  return out
}

const sameScalar = (a: unknown, b: unknown) => (a instanceof Exact ? b instanceof Exact && a.raw === b.raw : a === b)

// Records of three or more whose single value (text, number, true, false,
// null) is one in all of them: the field is written once, beside the
// records. A field holding an object or a list is never the same: each
// record's was built on its own.
function hoist(items: unknown[], t: TrimStats): unknown {
  if (items.length < 3 || !items.every(isObject)) return items
  const records = items as Json[]
  const first = records[0]!
  const same: Json = {}
  for (const k of Object.keys(first)) {
    tick()
    const v = first[k]
    // A record without the field reads undefined, which no JSON value is.
    if (records.every(r => sameScalar(r[k], v))) put(same, k, v)
  }
  if (Object.keys(same).length === 0) return items
  t.hoisted += Object.keys(same).length
  return {
    [SAME]: same,
    records: records.map(r => {
      const o: Json = {}
      for (const k of Object.keys(r)) if (!Object.hasOwn(same, k)) put(o, k, r[k])
      return o
    }),
  }
}

// The layout would come out longer than this: the caller passes the result whole.
class TooLong extends Error {}
const PADS = Array.from({ length: MAX_INDENT + 2 }, (_, i) => '  '.repeat(i))
const isFlat = (x: unknown) => !isObject(x) && !Array.isArray(x)

// JSON with one record per line: compact, and still valid JSON. Indented at
// most MAX_INDENT levels; written into one list of parts, so a deep chain is
// not copied once per level; throws TooLong past `max` characters.
export function layout(v: unknown, max = Infinity): string {
  const out: string[] = []
  let length = 0
  const push = (s: string) => {
    out.push(s)
    length += s.length
    if (length > max) throw new TooLong()
  }
  const pad = (depth: number) => PADS[Math.min(depth, MAX_INDENT)]!
  const write = (x: unknown, depth: number) => {
    tick()
    if (Array.isArray(x)) {
      if (x.every(isFlat)) return push(ser(x))
      push(`[${NL}`)
      for (let i = 0; i < x.length; i++) {
        tick()
        push(`${pad(depth + 1)}${ser(x[i])}${i < x.length - 1 ? ',' : ''}${NL}`)
      }
      return push(`${pad(depth)}]`)
    }
    if (isObject(x)) {
      const keys = Object.keys(x)
      let flat = true
      let plain = true
      for (const k of keys) {
        const y = x[k]
        if (y !== null && typeof y === 'object') {
          plain = false
          if (!(y instanceof Exact)) {
            flat = false
            break
          }
        }
      }
      if (plain) return push(JSON.stringify(x))
      if (flat) return push(ser(x))
      push(`{${NL}`)
      for (let i = 0; i < keys.length; i++) {
        push(`${pad(depth + 1)}${JSON.stringify(keys[i])}: `)
        write(x[keys[i]!], depth + 1)
        push(`${i < keys.length - 1 ? ',' : ''}${NL}`)
      }
      return push(`${pad(depth)}}`)
    }
    push(ser(x))
  }
  write(v, 0)
  return out.join('')
}

export type Trimmed = { text: string; paging: string; stats: TrimStats }

// JSON blocks, as `readBlocks` read them, trimmed field by field, each block
// on its own: paging at the top of the second block is still the top. A
// reason instead when a block is not an object or a list, or would lay out
// longer than `maxChars`. Throws TooSlow when the run's deadline passes.
export function trimBlocks(
  data: readonly unknown[],
  words: ReadonlySet<string>,
  opts: { run?: Run; maxChars?: number } = {},
): Trimmed | string {
  return inRun(opts.run, () => {
    if (!data.every(d => isObject(d) || Array.isArray(d))) return NOT_RECORDS
    try {
      const t = newStats()
      const many = data.length > 1
      const max = opts.maxChars ?? Infinity
      let used = 0
      const blocks = data.map((d, i) => {
        const body = `${many ? `Block ${i + 1} of ${data.length}:${NL}` : ''}${layout(trimValue(d, words, t, false, false), max - used)}`
        used += body.length + 2
        return body
      })
      const paging = pagingLine(data.flatMap((d, i) => pagingOf(d, many ? `block ${i + 1}: ` : '')))
      return { text: blocks.join(`${NL}${NL}`), paging, stats: t }
    } catch (e) {
      if (e instanceof TooLong) return NOT_SHORTER
      throw e
    }
  })
}

// Text blocks read and trimmed: the trim, or why it is passed whole.
export function trimJsonWhy(texts: readonly string[], words: ReadonlySet<string>, opts: { run?: Run; maxChars?: number } = {}) {
  const data = readBlocks(texts, opts.run)
  return typeof data === 'string' ? data : trimBlocks(data, words, opts)
}

// The trim, or undefined when the JSON is passed whole.
export function trimJson(texts: readonly string[], words: ReadonlySet<string>, opts: { run?: Run; maxChars?: number } = {}) {
  const r = trimJsonWhy(texts, words, opts)
  return typeof r === 'string' ? undefined : r
}

// Plain text keeps every character but blanks at line ends and runs of more
// than one blank line; a line keeps its own ending (CRLF or LF). Line by line:
// no regex that can take quadratic time.
export function trimPlain(texts: readonly string[]) {
  const out: string[] = []
  let blank = 0
  for (const line of texts.join(`${NL}${NL}`).split(NL)) {
    const cr = line.endsWith('\r') ? '\r' : ''
    const kept = line.trimEnd()
    blank = kept === '' ? blank + 1 : 0
    if (blank < 2) out.push(kept + cr)
  }
  return out.join(NL)
}

const listed = (s: ReadonlySet<string>) => {
  const a = [...s]
  return a.slice(0, 40).join(', ') + (a.length > 40 ? `, and ${a.length - 40} more names` : '')
}

// What the trim changed, in words; '' for nothing.
export function leftOut(t: TrimStats) {
  const parts: string[] = []
  if (t.empty.size > 0) parts.push(`empty fields (${listed(t.empty)})`)
  if (t.blobs.size > 0) parts.push(`base64 fields (${listed(t.blobs)})`)
  if (t.blobItems > 0) parts.push(`${t.blobItems} base64 list item${t.blobItems > 1 ? 's' : ''}, each marked in its place`)
  if (t.noise.size > 0) parts.push(`API bookkeeping fields (${listed(t.noise)})`)
  if (t.cut > 0) parts.push(`the rest of ${t.cut} text value${t.cut > 1 ? 's' : ''} over ${fmt(STRING_CAP)} characters, marked where cut`)
  return parts.join('; ')
}

// What the trim moved without leaving anything out.
export function reshaped(t: TrimStats) {
  return [
    ...(t.hoisted > 0 ? [`fields with one value in every record are written once, under "${SAME}"`] : []),
    ...(t.unpacked > 0 ? [`${t.unpacked} text value${t.unpacked > 1 ? 's' : ''} holding JSON ${t.unpacked > 1 ? 'are' : 'is'} shown as JSON`] : []),
  ].join('; ')
}

// Where a piece of a long line ends, at most at `end` and past the middle of
// the piece: after a comma that ends a JSON element (`,"` `,{` `,[`), else
// after a blank, else after any comma, else at `end` (never inside a
// surrogate pair). None of these falls inside a number.
function breakAt(line: string, start: number, end: number) {
  if (end >= line.length) return line.length
  const floor = start + ((end - start) >> 1)
  let blank = -1
  let comma = -1
  for (let k = end - 1; k > floor; k--) {
    const c = line[k]
    if (c === ',') {
      const next = line[k + 1]
      if (next === '"' || next === '{' || next === '[') return k + 1
      if (comma < 0) comma = k + 1
    } else if (blank < 0 && (c === ' ' || c === '\t')) blank = k + 1
  }
  if (blank > 0) return blank
  if (comma > 0) return comma
  return safeEnd(line, end)
}

// Lines grouped into parts of at most `size` characters for the helper. A
// line longer than that is split at a value boundary, each piece its own part.
export function chunks(text: string, size: number) {
  const parts: string[] = []
  let part: string | undefined
  const flush = () => {
    if (part !== undefined && part !== '') parts.push(part)
    part = undefined
  }
  for (const line of text.split(NL)) {
    if (line.length > size) {
      flush()
      for (let i = 0; i < line.length; ) {
        const b = breakAt(line, i, i + size)
        parts.push(line.slice(i, b))
        i = b
      }
      continue
    }
    if (part !== undefined && part.length + 1 + line.length > size) flush()
    part = part === undefined ? line : `${part}${NL}${line}`
  }
  flush()
  return parts
}

// ---------- the helper prompt's tags ----------

const TAGS = ['data', 'task', 'call']
const isBlankAt = (s: string, i: number) => i < s.length && /\s/.test(s[i]!)

// Every `from` that opens or closes one of the prompt's own tags (`<data`,
// `</ task`, `< /CALL`), swapped for `to`. One pass: each blank run after a
// mark is read once, so a long run cannot make it slow.
function swapTags(s: string, from: string, to: string) {
  let out = ''
  let at = 0
  for (let i = s.indexOf(from); i >= 0; i = s.indexOf(from, i + 1)) {
    let j = i + 1
    while (isBlankAt(s, j)) j++
    if (s[j] === '/') {
      j++
      while (isBlankAt(s, j)) j++
    }
    if (TAGS.includes(s.slice(j, j + 4).toLowerCase()) && !/[A-Za-z0-9_]/.test(s[j + 4] ?? '')) {
      out += s.slice(at, i) + to
      at = i + 1
    }
  }
  return out + s.slice(at)
}

// Text going into the helper's prompt cannot open or close the prompt's own
// tags: their `<` is written `‹`.
export const MARK = '‹'
export const neutral = (s: string) => swapTags(s, '<', MARK)
// The helper's note with each such `‹` written `<` again.
export const restore = (s: string) => swapTags(s, MARK, '<')

// ---------- the note ----------

export type Note = {
  tool: string
  before: number
  how: 'trim' | 'text' | 'helper' | 'fallback'
  model?: string
  why?: string
  leftOut: string
  reshaped: string
  paging: string
  file: string
  body: string
}

function howLine(n: Note) {
  if (n.how === 'trim') return 'Trimmed by code, not summarised: every value below is as the tool returned it, except where a cut is marked.'
  if (n.how === 'text') return 'Trimmed by code, not summarised: only blanks at line ends and extra blank lines were removed.'
  if (n.how === 'helper') return `Condensed by ${n.model ?? 'the helper model'} for this task; its last line names what it left out.`
  return `Trimmed by code, not summarised (${n.why ?? 'the helper model failed'}).`
}

// The text Claude reads in place of the result: the header, then the body.
export function note(n: Note) {
  const build = (after: number) =>
    [
      `[Connector Trim] ${n.tool}: ${fmt(n.before)} → ${fmt(after)} characters (about ${fmt(tokens(n.before))} → ${fmt(tokens(after))} tokens). ${howLine(n)}`,
      `Left out by code (all of it is in the saved file): ${n.leftOut || 'nothing'}.${n.reshaped ? ` Also: ${n.reshaped}.` : ''}`,
      ...(n.paging ? [`Paging and counts, values as returned: ${n.paging}`] : []),
      `Full result: ${n.file}`,
      "Use this note as the tool's answer; open the file only for a field this note does not list.",
      '',
      n.body,
    ].join(NL)
  // The header states the note's own length, and writing that number can
  // lengthen the note: settle on a length that states itself.
  let len = n.body.length
  for (let i = 0; i < 4; i++) {
    const next = build(len).length
    if (next === len) break
    len = next
  }
  return build(len)
}

// ---------- names and retention ----------

// `mcp__server__tool` in its parts.
export function partsOf(tool: string) {
  const [, server = '', ...rest] = tool.split('__')
  return { server, name: rest.join('__') }
}

// Whether `text` fits a glob (`*` any run, `?` one character), any case. Two
// cursors and the last star: at worst pattern length times text length, never
// the backtracking a regex of many stars takes.
export function globMatch(pattern: string, text: string) {
  const p = pattern.toLowerCase()
  const t = text.toLowerCase()
  let i = 0
  let j = 0
  let star = -1
  let mark = 0
  while (i < t.length) {
    if (j < p.length && (p[j] === '?' || p[j] === t[i])) {
      i++
      j++
    } else if (j < p.length && p[j] === '*') {
      star = j++
      mark = i
    } else if (star >= 0) {
      j = star + 1
      i = ++mark
    } else return false
  }
  while (j < p.length && p[j] === '*') j++
  return j === p.length
}

// Whether an entry (a server, a tool's short or full name, `*` and `?` as
// wildcards, any case) names this tool.
export function matches(tool: string, entries: readonly string[]) {
  const { server, name } = partsOf(tool)
  return entries.some(raw => {
    const p = raw.trim()
    if (p === '') return false
    return globMatch(p, tool) || globMatch(p, server) || globMatch(p, name)
  })
}

export const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60) || 'x'
export const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)

// What a saved result is written over with once retention clears it: the
// engine's file system has no delete.
export const CLEARED =
  '[Connector Trim] This saved result was cleared: it was older than the keep time, or the folder was over its size cap.\n'

// The saved results to clear: every one older than `keepMs`, then the oldest
// until the rest fit in `capBytes`.
export function toClear(
  entries: readonly { name: string; kind: string; size: number; mtimeMs: number }[],
  now: number,
  keepMs: number,
  capBytes: number,
) {
  const live = entries.filter(f => f.kind === 'file' && f.size > CLEARED.length + 8).sort((a, b) => b.mtimeMs - a.mtimeMs)
  const out: string[] = []
  let sum = 0
  for (const f of live) {
    if (now - f.mtimeMs > keepMs) out.push(f.name)
    else if ((sum += f.size) > capBytes) out.push(f.name)
  }
  return out
}
export { Exact }
