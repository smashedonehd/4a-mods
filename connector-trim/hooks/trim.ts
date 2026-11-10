// Connector Trim's pure helpers: reading a tool result, redacting secrets,
// the deterministic trim, the task words, the note's header and retention.
// Nothing here calls the engine, so the tests reach every rule directly.
import { Exact, isObject, isScalar, parseJson, put, readJson, ser } from './json.ts'
import type { Json } from './json.ts'

export { isObject, parseJson, ser }
export const NL = '\n'
// A text value inside a list is cut past this many characters.
export const STRING_CAP = 1000
// A text value outside every list (beside the records) is kept whole up to this.
export const HEAD_CAP = 4000
// Approximate tokens, the way the savings ledger counts them.
export const tokens = (chars: number) => Math.ceil(chars / 4)
export const fmt = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

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

const norm = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '')

// A token that pages rather than signs in: `next_token`, `pageToken`,
// `$skiptoken`, `continuationToken`, `syncToken`, `scroll_token`.
const PAGE_TOKEN = /(?:next|page|continuation|sync|skip|resume|start|scroll)token/
// Fields about a token rather than the token itself: `token_type`, `token_expires_in`.
const TOKEN_META = /token(?:type|count|usage|limit|expiry|expires[a-z]*|ttl|length|lifetime)$/
const SECRET_WORDS =
  /secret|password|passwd|passphrase|credential|cookie|apikey|accesskey|privatekey|connectionstring|authorization|signature|jwt/
// Short names that are a credential only as the whole key.
const SECRET_NAMES = new Set(['auth', 'sessionid', 'sessionkey', 'dsn'])
// A value that is a file path, as `pwd` holds in a shell's output.
const isPath = (v: string) => /^(?:[A-Za-z]:[\\/]|[\\/~]|\.{1,2}[\\/])/.test(v)

// Keys whose value is a credential: a key with a secret word in it, and a key
// with `token` in it that is no paging token. `pwd` is a password unless its
// value is a path.
export function isSecretKey(key: string, value?: string) {
  const n = norm(key)
  if (n === 'pwd') return typeof value === 'string' && !isPath(value)
  if (SECRET_WORDS.test(n) || SECRET_NAMES.has(n)) return true
  return n.includes('token') && !PAGE_TOKEN.test(n) && !TOKEN_META.test(n)
}

// Keys of paging and counts: kept as returned and listed in the header.
const PAGING = new Set(
  (
    'page pages pagenumber pagesize perpage nextpage hasnextpage haspreviouspage hasmore more total totalcount ' +
    'totalresults totalrows totalsize totalitems count rowcount offset limit skip cursor next prev previous after ' +
    'before startindex itemsperpage truncated scrollid marker bookmark odatacount lastevaluatedkey ' +
    'exclusivestartkey startingafter endingbefore'
  ).split(' '),
)
// Links that are a record's own address, not the way to another page.
const OWN_LINKS = new Set(['selflink', 'editlink', 'odataeditlink'])
const pagingCache = new Map<string, boolean>()
export function isPaging(key: string) {
  let hit = pagingCache.get(key)
  if (hit === undefined) {
    const n = norm(key)
    hit =
      !isSecretKey(key) &&
      (PAGING.has(n.replace(/[0-9]/g, '')) ||
        n.startsWith('next') ||
        (/links?$/.test(n) && !OWN_LINKS.has(n)) ||
        /cursor|continuation|marker|bookmark/.test(n) ||
        PAGE_TOKEN.test(n))
    if (pagingCache.size < 10_000) pagingCache.set(key, hit)
  }
  return hit
}
// Objects whose every field is paging, whatever its name: GraphQL `pageInfo`,
// and the object under any paging key (HAL `_links`, DynamoDB `LastEvaluatedKey`).
const isPagingGroup = (key: string) => isPaging(key) || ['pageinfo', 'pagination', 'paging'].includes(norm(key))

// ---------- secrets ----------

// Conservative: formats with a fixed shape, and a value written beside a key
// that names a secret. A miss is possible; a false hit costs one value.
const PATTERNS: [RegExp, string][] = [
  [/\bbearer[ \t]{1,8}[A-Za-z0-9._~+/-]{16,}=*/gi, 'bearer token'],
  // `sk-ant-…` and `sk-proj-…`, or one unbroken run with a digit in it: a
  // slug such as `sk-suche-zachody` is no key.
  [/\bsk-(?:ant|proj)-[A-Za-z0-9_-]{20,}|\bsk-(?=[A-Za-z]*\d)[A-Za-z0-9]{32,}(?![\w-])/g, 'API key'],
  [/\bgh[opsu]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/g, 'GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AWS key'],
  [/\bAIza[0-9A-Za-z_-]{35}/g, 'Google API key'],
  [/\bya29\.[A-Za-z0-9._-]{20,}/g, 'Google access token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, 'Slack token'],
  [/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g, 'JWT'],
]
// `Authorization: Basic …`, any case: the scheme and credentials go.
const AUTH = /\b(authorization["']?[ \t]{0,8}[:=][ \t]{0,8}["']?)(?:basic|digest|token|bearer)[ \t]{1,8}[^\s"',;]+/gi
// `postgres://user:password@host`: the password goes.
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@"']{1,256}:)(?!\[REDACTED)[^\s/@"']{1,256}@/gi
// A name a value is written beside: whole, not the tail of a longer word.
const NAME = String.raw`(?<![\w.-])([A-Za-z_][\w.-]{0,63})`
// `password="…"` or `"password": '…'`: the value to its closing quote.
const QUOTED = new RegExp(`${NAME}(["']?[ \\t]{0,8}[:=][ \\t]{0,8})(["'])(?!\\[REDACTED)([^"'\\n]+)\\3`, 'g')
// `password=…` unquoted: one `=`, the value right after it.
const EQUALS = new RegExp(`${NAME}=(?!=)([^\\s"',;&<>]+)`, 'g')
// `x-api-key: abc123…` header style: one word of 8 or more with a digit in it,
// so "password: reset it in settings" stays.
const COLON = new RegExp(`${NAME}(["']?:[ \\t]{0,8})(?!["'\\[])([^\\s"',;]{8,})`, 'g')
// Values a name may stand beside without being a secret: code and empties.
const NOT_A_VALUE = /^(?:none|null|nil|undefined|true|false|\d{4}-\d\d-\d\d.*)$/i

// A private key block, found by index: a header with no END marker after it
// is cut through the whole base64 lines that follow (a blank line or a line
// with any other character ends it). Linear in the text.
const PEM_HEAD = /-{5}BEGIN (?:[A-Z]+ ){0,4}PRIVATE KEY-{5}/y
const PEM_TAIL = /-{5}END (?:[A-Z]+ ){0,4}PRIVATE KEY-{5}/y
function redactPem(text: string, found: string[]) {
  let out = ''
  let at = 0
  let noEnd = false
  for (let i = text.indexOf('-----BEGIN ', 0); i >= 0; i = text.indexOf('-----BEGIN ', Math.max(i + 1, at))) {
    PEM_HEAD.lastIndex = i
    if (!PEM_HEAD.test(text)) continue
    let end = -1
    for (let j = noEnd ? -1 : text.indexOf('-----END ', PEM_HEAD.lastIndex); j >= 0; j = text.indexOf('-----END ', j + 1)) {
      PEM_TAIL.lastIndex = j
      if (PEM_TAIL.test(text)) {
        end = PEM_TAIL.lastIndex
        break
      }
    }
    if (end < 0) {
      noEnd = true
      end = PEM_HEAD.lastIndex
      for (let first = true; end < text.length; first = false) {
        const eol = text.indexOf(NL, end)
        const line = text.slice(end, eol < 0 ? text.length : eol)
        if (!/^[A-Za-z0-9+/=]*\r?$/.test(line) || (!first && line.trim() === '')) break
        end = eol < 0 ? text.length : eol + 1
      }
    }
    found.push('private key')
    out += `${text.slice(at, i)}[REDACTED private key]`
    at = end
  }
  return out + text.slice(at)
}

// Secrets in plain text. Under a paging key, a bare `token=` is the page's
// token and stays; a credential named as one (`access_token=`) still goes.
export function redactText(text: string, paging = false) {
  const found: string[] = []
  const secret = (name: string, value: string) => isSecretKey(name, value) && !(paging && norm(name) === 'token')
  let out = redactPem(text, found)
  for (const [re, kind] of PATTERNS)
    out = out.replace(re, () => {
      found.push(kind)
      return `[REDACTED ${kind}]`
    })
  out = out.replace(AUTH, (_m, head: string) => {
    found.push('authorization value')
    return `${head}[REDACTED]`
  })
  out = out.replace(URL_PASSWORD, (_m, head: string) => {
    found.push('URL password')
    return `${head}[REDACTED]@`
  })
  out = out.replace(QUOTED, (m, name: string, sep: string, q: string, value: string) => {
    if (!secret(name, value)) return m
    found.push(`${norm(name)} value`)
    return `${name}${sep}${q}[REDACTED]${q}`
  })
  out = out.replace(EQUALS, (m, name: string, value: string) => {
    if (value.length < 6 || value.startsWith('[') || NOT_A_VALUE.test(value) || !secret(name, value)) return m
    found.push(`${norm(name)} value`)
    return `${name}=[REDACTED]`
  })
  out = out.replace(COLON, (m, name: string, sep: string, value: string) => {
    if (!/\d/.test(value) || NOT_A_VALUE.test(value) || !secret(name, value)) return m
    found.push(`${norm(name)} value`)
    return `${name}${sep}[REDACTED]`
  })
  return { text: out, found }
}

// Secrets in a JSON text, which stays valid JSON: a string under a secret key
// is replaced whole, other strings are redacted by pattern, and JSON written
// inside a string is redacted the same way. Numbers, booleans and null under
// a secret key are left as they are. Undefined when the text is not JSON.
export function redactJson(text: string): { text: string; found: string[] } | undefined {
  const edits: [number, number, string][] = []
  const found: string[] = []
  try {
    readJson(text, (start, end, value, path) => {
      const key = path[path.length - 1]
      let out: string | undefined
      if (key !== undefined && isSecretKey(key, value) && value !== '' && !value.startsWith('[REDACTED')) {
        out = '[REDACTED]'
        found.push(`${norm(key)} value`)
      } else {
        const paging = path.some(isPagingGroup)
        const r = (/^\s*[[{]/.test(value) && redactJson(value)) || redactText(value, paging)
        if (r.text !== value) {
          out = r.text
          found.push(...r.found)
        }
      }
      if (out !== undefined) edits.push([start, end, JSON.stringify(out)])
    })
  } catch {
    return undefined
  }
  let out = ''
  let at = 0
  for (const [start, end, s] of edits) {
    out += text.slice(at, start) + s
    at = end
  }
  return { text: out + text.slice(at), found }
}

// "2 bearer token, 1 password value"
export function counted(found: readonly string[]) {
  const n = new Map<string, number>()
  for (const f of found) n.set(f, (n.get(f) ?? 0) + 1)
  return [...n].map(([k, c]) => `${c} ${k}`).join(', ')
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

// What the person and the assistant wrote, minus the reminders the engine
// puts into user rows.
const clean = (s: string) => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
const head = (s: string, n: number) => (s.length > n ? `${clip(s, n)}…` : s)
const tail = (s: string, n: number) => (s.length > n ? `…${clipEnd(s, n)}` : s)

export type Row = { role: string; text: string; toolUses?: readonly { tool_use_id: string }[] }

// The last real request before the call (approvals skipped) and what the
// assistant said between it and the call.
export function taskOf(rows: readonly Row[], toolUseId?: string) {
  const at = toolUseId ? rows.findIndex(r => r.toolUses?.some(u => u.tool_use_id === toolUseId)) : -1
  const end = at >= 0 ? at + 1 : rows.length
  let ask = -1
  for (let i = end - 1; i >= 0; i--) {
    const r = rows[i]!
    if (r.role === 'user' && clean(r.text) !== '' && !isFiller(clean(r.text))) {
      ask = i
      break
    }
  }
  const said = rows
    .slice(ask + 1, end)
    .filter(r => r.role === 'assistant' && r.text.trim() !== '')
    .map(r => r.text.trim())
  return { user: ask >= 0 ? head(clean(rows[ask]!.text), 2000) : '', assistant: tail(said.join(NL), 1500) }
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
// (`costMicros`, `cost_micros`: `cost`).
export function isNamed(key: string, words: ReadonlySet<string>) {
  if (words.has(fold(key).replace(/[^\p{L}\p{N}]+/gu, ''))) return true
  const parts = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^\p{L}\p{N}]+/u)
  return parts.some(p => p.length >= 3 && words.has(fold(p)))
}

// ---------- paging ----------

// The paging and count fields outside the records, values as returned:
// `page=2, total=1234, data.pageInfo.endCursor="abc"`.
export function pagingOf(data: unknown, prefix = '') {
  const out: string[] = []
  const walk = (v: unknown, path: string, group: boolean) => {
    if (!isObject(v)) return
    for (const [k, x] of Object.entries(v)) {
      if ((group || isPaging(k)) && isScalar(x)) out.push(`${prefix}${path}${k}=${ser(x)}`)
      else walk(x, `${path}${k}.`, group || isPagingGroup(k))
    }
  }
  walk(data, '', false)
  return out.join(', ')
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
  BLOB.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v) && (/[G-Zg-z+/_]/.test(v) || v.endsWith('=') || v.length >= 1000)
const DROPPED = Symbol('base64')
// Bookkeeping fields APIs add to every object. Paging fields are never here.
const NOISE = /^(?:etag|__typename|selfLink|@odata\.(?:etag|type|id|editLink|context))$/i

const isEmpty = (v: unknown) =>
  v === null ||
  v === undefined ||
  v === '' ||
  (Array.isArray(v) && v.length === 0) ||
  (isObject(v) && Object.keys(v).length === 0)

// A text value: JSON in it is shown as JSON; inside a list, base64 is left out
// and a long value is cut. Beside the records, a value is kept whole up to
// HEAD_CAP characters, so a cursor or link under an unknown name survives.
function trimString(v: string, words: ReadonlySet<string>, t: TrimStats, inList: boolean): unknown {
  const inner = v.length > 1 ? parseJson(v) : undefined
  if (inner !== undefined && !isEmpty(inner)) {
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
  if (typeof v === 'string') return group ? v : trimString(v, words, t, inList)
  if (Array.isArray(v)) {
    const items = v.map(x => {
      const y = trimValue(x, words, t, group, true)
      if (y !== DROPPED) return y
      t.blobItems += 1
      return BLOB_MARK
    })
    return hoist(items, t)
  }
  if (!isObject(v)) return v
  const out: Json = {}
  for (const [k, x] of Object.entries(v)) {
    const named = isNamed(k, words)
    const paging = group || isPaging(k)
    // Paging, cursors and single values the task names travel as returned.
    if ((paging || named) && isScalar(x)) {
      put(out, k, x)
      continue
    }
    if (!named && !paging && NOISE.test(k)) {
      t.noise.add(k)
      continue
    }
    const y = trimValue(x, words, t, group || isPagingGroup(k), inList)
    if (y === DROPPED) t.blobs.add(k)
    else if (isEmpty(y) && !named) t.empty.add(k)
    else put(out, k, y)
  }
  return out
}

// Records of three or more whose field holds one value in all of them: the
// field is written once, beside the records.
function hoist(items: unknown[], t: TrimStats): unknown {
  if (items.length < 3 || !items.every(isObject)) return items
  const records = items as Json[]
  const first = records[0]!
  const same: Json = {}
  for (const k of Object.keys(first)) {
    const s = ser(first[k])
    if (records.every(r => Object.hasOwn(r, k) && ser(r[k]) === s)) put(same, k, first[k])
  }
  if (Object.keys(same).length === 0) return items
  t.hoisted += Object.keys(same).length
  const out: Json = {}
  put(out, SAME, same)
  put(
    out,
    'records',
    records.map(r => {
      const o: Json = {}
      for (const k of Object.keys(r)) if (!Object.hasOwn(same, k)) put(o, k, r[k])
      return o
    }),
  )
  return out
}

// JSON with one record per line: compact, and still valid JSON.
export function layout(v: unknown, pad = ''): string {
  const flat = (xs: unknown[]) => xs.every(x => !isObject(x) && !Array.isArray(x))
  if (Array.isArray(v)) {
    if (flat(v)) return ser(v)
    return `[${NL}${v.map(x => `${pad}  ${ser(x)}`).join(`,${NL}`)}${NL}${pad}]`
  }
  if (isObject(v)) {
    const keys = Object.keys(v)
    if (flat(Object.values(v))) return ser(v)
    const lines = keys.map(k => `${pad}  ${JSON.stringify(k)}: ${layout(v[k], `${pad}  `)}`)
    return `{${NL}${lines.join(`,${NL}`)}${NL}${pad}}`
  }
  return ser(v)
}

// JSON blocks trimmed field by field, each block on its own: paging at the
// top of the second block is still the top. Undefined when a block is not an
// object or a list, or nests too deep to walk.
export function trimJson(texts: readonly string[], words: ReadonlySet<string>) {
  const data = texts.map(parseJson)
  if (data.some(d => d === undefined)) return undefined
  try {
    const t = newStats()
    const many = data.length > 1
    const text = data
      .map((d, i) => `${many ? `Block ${i + 1} of ${data.length}:${NL}` : ''}${layout(trimValue(d, words, t, false, false))}`)
      .join(`${NL}${NL}`)
    const paging = data
      .map((d, i) => pagingOf(d, many ? `block ${i + 1}: ` : ''))
      .filter(Boolean)
      .join(', ')
    return { text, paging, stats: t }
  } catch {
    return undefined
  }
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
  redacted: readonly string[]
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
      ...(n.redacted.length > 0 ? [`Redacted before saving and before any model saw it: ${counted(n.redacted)}.`] : []),
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

const glob = (p: string) =>
  new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i')

// Whether an entry (a server, a tool's short or full name, `*` and `?` as
// wildcards, any case) names this tool.
export function matches(tool: string, entries: readonly string[]) {
  const { server, name } = partsOf(tool)
  return entries.some(raw => {
    const p = raw.trim()
    if (p === '') return false
    const re = glob(p)
    return re.test(tool) || re.test(server) || re.test(name)
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
