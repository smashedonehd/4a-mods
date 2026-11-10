// Connector Trim's pure helpers: reading a tool result, redacting secrets,
// the deterministic trim, the task words, the note's header and retention.
// Nothing here calls the engine, so the tests reach every rule directly.
import { Exact, isObject, isScalar, parseJson, put, readJson, ser } from './json.ts'
import type { Frame, Json } from './json.ts'

export { isObject, parseJson, ser }
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
//
// A key is read as words: `nextPageToken`, `next_page_token` and
// `NEXT-PAGE-TOKEN` are next, page, token; a word glued to `token` or `key`
// is split when its parts are known words (`$skiptoken`: skip, token;
// `apikey`: api, key). Each key is in one class:
//   strong secret: a credential by its whole name; any text under it goes.
//   weak secret: a name that often holds a credential; only a token-shaped
//     value under it goes (no blanks, 8 characters or more, not all digits,
//     not a date, a time or a URL).
//   paging: the way to the next page; kept as returned when its value is
//     paging-shaped.
//   group: every field under it is paging, when the whole is paging-shaped.
//   none.

const norm = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '')

// Words that make `<word>_token` a page's token.
const PAGE_WORDS = new Set(
  'next prev previous page paging pagination continuation sync skip resume start scroll cursor delta bookmark marker offset after before'.split(
    ' ',
  ),
)
// Words that make `<word>_token` or `<word>_key` a credential.
const CREDENTIAL_WORDS = new Set(
  'private oauth bot csrf auth personal access github security session bearer api signing webhook app client secret encryption ssh subscription master deploy consumer'.split(
    ' ',
  ),
)
const GLUED = [...PAGE_WORDS, ...CREDENTIAL_WORDS].sort((a, b) => b.length - a.length)

// `skiptoken` in skip, token; a glued word with an unknown part stays whole.
function unglue(word: string): string[] {
  const tail = word.endsWith('token') ? 'token' : word.endsWith('key') ? 'key' : ''
  if (tail === '' || word === tail) return [word]
  const out: string[] = []
  let head = word.slice(0, -tail.length)
  while (head !== '') {
    const w = GLUED.find(g => head.startsWith(g))
    if (!w) return [word]
    out.push(w)
    head = head.slice(w.length)
  }
  return [...out, tail]
}

export function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .flatMap(unglue)
}

// Credentials by their whole name, any case and separators.
const STRONG = new Set(
  (
    'password passwd passphrase secret clientsecret apikey xapikey apisecret accesskey secretkey privatekey ' +
    'accesstoken refreshtoken idtoken authorization proxyauthorization cookie setcookie connectionstring dsn pwd'
  ).split(' '),
)
// Words that make any key a weak secret: `password_hash`, `x-auth-token`.
const WEAK_WORDS = /^(?:secrets?|passwords?|credentials?|cookies?|signatures?|auth|jwts?)$/
// Short names that are a weak secret on their own: Azure's `sig`.
const WEAK_NAMES = new Set(['token', 'sig'])

export type SecretKind = 'strong' | 'weak'
const secretCache = new Map<string, SecretKind | 'none'>()
// The secret class of a key by its name alone (`pwd` is strong here; a path
// under it is no secret, see `isSecretValue`).
export function secretKind(key: string): SecretKind | undefined {
  let hit = secretCache.get(key)
  if (hit === undefined) {
    const n = norm(key)
    const w = keyWords(key)
    const last = w[w.length - 1]
    const before = w[w.length - 2]
    hit = STRONG.has(n)
      ? 'strong'
      : WEAK_NAMES.has(n) ||
          w.some(x => WEAK_WORDS.test(x)) ||
          ((last === 'token' || last === 'key') && before !== undefined && CREDENTIAL_WORDS.has(before))
        ? 'weak'
        : 'none'
    if (secretCache.size < 10_000) secretCache.set(key, hit)
  }
  return hit === 'none' ? undefined : hit
}

// A value that is a file path, as `pwd` holds in a shell's output.
const isPath = (v: string) => /^(?:[A-Za-z]:[\\/]|[\\/~]|\.{1,2}[\\/])/.test(v)
const DATE = /^(?:\d{4}-\d\d-\d\d|\d{1,2}:\d\d)/
const URL_START = /^[a-z][a-z0-9+.-]*:\/\//i
// A value shaped like a credential: no blanks, 8 characters or more, not all
// digits, not a date, a time or a URL.
export const isTokenShaped = (v: string) =>
  v.length >= 8 && !/\s/.test(v) && !/^\d+$/.test(v) && !DATE.test(v) && !URL_START.test(v)

// Whether this value under this key is a secret: any text under a strong key
// (`pwd` unless a path), a token-shaped value under a weak one. The caller
// skips empty and already redacted values.
export function isSecretValue(key: string, value: string) {
  const kind = secretKind(key)
  if (kind === 'strong') return norm(key) !== 'pwd' || !isPath(value)
  return kind === 'weak' && isTokenShaped(value)
}

// Paging by name. A paging token is `<page word>_token`.
const PAGING_NAMES = new Set(
  (
    'page pages pagenumber pagesize perpage pagecount nextpage hasnextpage haspreviouspage hasmore more total totalcount ' +
    'totalresults totalrows totalsize totalitems totalpages count rowcount offset limit skip cursor next prev previous ' +
    'after before startindex startat maxresults itemsperpage truncated istruncated islast scrollid marker bookmark ' +
    'continuation odatacount lastevaluatedkey exclusivestartkey startingafter endingbefore searchafter pitid sinceid maxid'
  ).split(' '),
)
// `next_link`, `prevPageToken`, `@odata.deltaLink`, `last_page`, `nextRecordsUrl`.
const LINK_FIRST = new Set(['next', 'prev', 'previous', 'first', 'last', 'delta'])
const LINK_LAST = new Set(['link', 'url', 'uri', 'href', 'page', 'token', 'cursor', 'key', 'marker', 'offset', 'id'])
// Words that make any key paging: `endCursor`, `KeyMarker`, `pageBookmark`, `resumePoint`.
const PAGING_WORDS = new Set(['cursor', 'marker', 'bookmark', 'continuation', 'resume', 'scroll'])
// Objects whose fields are all paging.
const GROUP_NAMES = new Set(['pageinfo', 'pagination', 'paging', 'links'])

const pagingCache = new Map<string, boolean>()
export function isPagingName(key: string) {
  let hit = pagingCache.get(key)
  if (hit === undefined) {
    let w = keyWords(key)
    if (w[0] === 'odata') w = w.slice(1)
    const first = w[0]
    const last = w[w.length - 1]
    const before = w[w.length - 2]
    hit =
      secretKind(key) === undefined &&
      w.length > 0 &&
      (PAGING_NAMES.has(norm(key)) ||
        (w.length >= 2 && LINK_FIRST.has(first!) && LINK_LAST.has(last!)) ||
        w.some(x => PAGING_WORDS.has(x)) ||
        (last === 'token' && before !== undefined && PAGE_WORDS.has(before)))
    if (pagingCache.size < 10_000) pagingCache.set(key, hit)
  }
  return hit
}
const isGroupName = (key: string) => GROUP_NAMES.has(norm(key)) || isPagingName(key)

export type KeyClass = SecretKind | 'paging' | 'group' | 'none'
// The class of a key by its name, for the rules above and their tests.
export function keyClass(key: string): KeyClass {
  return secretKind(key) ?? (isPagingName(key) ? 'paging' : GROUP_NAMES.has(norm(key)) ? 'group' : 'none')
}

// A value paging can hold: a number, a boolean, null, a string without
// blanks (a cursor or a URL), or an object or list of at most 20 such values
// all told. Prose, or a list of records, under a paging name is data.
export function isPagingShaped(v: unknown) {
  let left = 20
  const ok = (x: unknown, depth: number): boolean => {
    if (typeof x === 'string') return !/\s/.test(x)
    if (isScalar(x)) return true
    const xs = Array.isArray(x) ? x : isObject(x) ? Object.values(x) : undefined
    if (!xs || depth > 4 || (left -= xs.length) < 0) return false
    return xs.every(y => ok(y, depth + 1))
  }
  return ok(v, 0)
}
// A field that is paging: by its name and the shape of its value.
const isPagingField = (key: string, v: unknown) => isPagingName(key) && isPagingShaped(v)
const isPagingGroup = (key: string, v: unknown) => isGroupName(key) && isPagingShaped(v)

// ---------- secrets in text ----------

// Fixed shapes, all linear. Most succeed on any run long enough to read, so
// a start inside a run never reads it again. The JWT can fail after a long
// run (no second dot), so it starts only where none of its own characters
// stands before it: each run is read once, not once per start.
const PATTERNS: [RegExp, string][] = [
  [/(?<![\w.~+/-])bearer[ \t]{1,8}[A-Za-z0-9._~+/-]{16,}=*/gi, 'bearer token'],
  // `sk-ant-…` and `sk-proj-…`, or one unbroken run with a digit in it: a
  // slug such as `sk-suche-zachody` is no key.
  [/\bsk-(?:ant|proj)-[A-Za-z0-9_-]{20,}|\bsk-(?=[A-Za-z]*\d)[A-Za-z0-9]{32,}(?![\w-])/g, 'API key'],
  [/(?<!\w)(?:sk|rk)_live_[A-Za-z0-9]{20,}/g, 'Stripe key'],
  [/(?<!\w)gh[opsu]_[A-Za-z0-9]{30,}|(?<!\w)github_pat_[A-Za-z0-9_]{30,}/g, 'GitHub token'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, 'GitLab token'],
  [/(?<!\w)npm_[A-Za-z0-9]{36}(?!\w)/g, 'npm token'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AWS key'],
  [/\bAIza[0-9A-Za-z_-]{35}/g, 'Google API key'],
  [/\bya29\.[A-Za-z0-9._-]{20,}/g, 'Google access token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, 'Slack token'],
  [/(?<![\w.-])eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g, 'JWT'],
]
// `Authorization: Basic …`, any case, any scheme: the scheme and credentials go.
const AUTH = /\b(authorization["']?[ \t]{0,8}[:=][ \t]{0,8}["']?)(?:basic|digest|token|bearer)[ \t]{1,8}[^\s"',;]+/gi
// `postgres://user:password@host`, `redis://:password@host`: the password goes.
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@"']{0,256}:)(?!\[REDACTED)[^\s/@"']{1,256}@/gi
// A name a value is written beside: whole, not the tail of a longer word.
const NAME = String.raw`(?<![\w.-])([A-Za-z_][\w.-]{0,63})`
// `password="…"`, `"password": '…'`, `password := "…"`: the value to its matching quote.
const QUOTED = new RegExp(`${NAME}(["']?[ \\t]{0,8}(?::=|=>|[:=])[ \\t]{0,8})(?:"([^"\\n]*)"|'([^'\\n]*)')`, 'g')
// `password=…`, `PASSWORD = …`: one `=`, a value up to a blank, quote,
// bracket, comma or semicolon.
const EQUALS = new RegExp(`${NAME}([ \\t]{0,8}=[ \\t]{0,8})(?![=>])([^\\s"',;&<>()\\[\\]{}]+)`, 'g')
// `x-api-key: abc123…`: header style, one word.
const COLON = new RegExp(`${NAME}(["']?:[ \\t]{0,8})(?!["'\\[])([^\\s"',;]+)`, 'g')
// Values beside a secret name that are code, not secrets. (`None`, `null`,
// `true` and `false` are shorter than any value the rules take.)
const NOT_A_VALUE = /^undefined$/i
const CAPS_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$|^[A-Z]+$/
const DOTTED_NAME = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/
const isCode = (v: string, next: string | undefined) =>
  next === '(' || NOT_A_VALUE.test(v) || CAPS_NAME.test(v) || DOTTED_NAME.test(v) || DATE.test(v)

// Whether `value`, written beside `name` in text, is a secret. A strong name
// takes any value of 6 characters or more; a weak one a token-shaped value
// with a digit in it. In a paging value a bare `token` is the page's token.
function textSecret(name: string, value: string, next: string | undefined, paging: boolean) {
  if (value.startsWith('[REDACTED') || isCode(value, next)) return false
  if (paging && norm(name) === 'token') return false
  const kind = secretKind(name)
  if (kind === 'strong') return value.length >= 6 && (norm(name) !== 'pwd' || !isPath(value))
  return kind === 'weak' && isTokenShaped(value) && /\d/.test(value)
}

// A private key block, found by index: a header with no END marker after it
// is cut through the whole base64 lines that follow (a blank line or a line
// with any other character ends it). Linear in the text.
const PEM_HEAD = /-{5}BEGIN (?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?-{5}/y
const PEM_TAIL = /-{5}END (?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?-{5}/y
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

// Secrets in plain text. In a paging value (a cursor or a next-page URL)
// only `name=value` pairs with a credential name are redacted: a cursor is
// opaque and may look like any key.
export function redactText(text: string, paging = false) {
  const found: string[] = []
  const hit = (name: string) => {
    found.push(`${norm(name)} value`)
    return '[REDACTED]'
  }
  let out = text
  if (!paging) {
    out = redactPem(out, found)
    for (const [re, kind] of PATTERNS)
      out = out.replace(re, () => {
        found.push(kind)
        return `[REDACTED ${kind}]`
      })
    out = out.replace(AUTH, (_m, head: string) => {
      found.push('authorization value')
      return `${head}[REDACTED]`
    })
  }
  out = out.replace(URL_PASSWORD, (_m, head: string) => {
    found.push('URL password')
    return `${head}[REDACTED]@`
  })
  if (!paging)
    out = out.replace(QUOTED, (m, name: string, sep: string, dq: string | undefined, sq: string | undefined) => {
      const value = dq ?? sq ?? ''
      const q = dq === undefined ? "'" : '"'
      return textSecret(name, value, undefined, false) ? `${name}${sep}${q}${hit(name)}${q}` : m
    })
  out = out.replace(EQUALS, (m, name: string, sep: string, value: string, at: number, all: string) =>
    textSecret(name, value, all[at + m.length], paging) ? `${name}${sep}${hit(name)}` : m,
  )
  if (!paging)
    out = out.replace(COLON, (m, name: string, sep: string, value: string, at: number, all: string) =>
      textSecret(name, value, all[at + m.length], false) ? `${name}${sep}${hit(name)}` : m,
    )
  return { text: out, found }
}

// ---------- secrets in JSON ----------

type Context = { paging: boolean; secret: boolean }
const TOP: Context = { paging: false, secret: false }

// What a container's place says about the strings in it: under a paging
// group (every value paging), under a secret-named key (token-shaped values
// are secrets), or neither.
function contextOf(frame: Frame | undefined, memo: Map<Frame, Context>): Context {
  if (!frame) return TOP
  let ctx = memo.get(frame)
  if (!ctx) {
    const up = contextOf(frame.parent, memo)
    const key = frame.key
    ctx = {
      paging: up.paging || (key !== undefined && isPagingGroup(key, frame.holder)),
      secret: up.secret || (key !== undefined && secretKind(key) !== undefined),
    }
    memo.set(frame, ctx)
  }
  return ctx
}

// A `{name, value}` or `{key, value}` pair, as HTTP header lists are written:
// the value is judged by the name beside it.
function nameBeside(key: string | undefined, frame: Frame | undefined) {
  if (key !== 'value' || !frame || !isObject(frame.holder)) return undefined
  const n = frame.holder.name ?? frame.holder.key ?? frame.holder.header
  return typeof n === 'string' ? n : undefined
}

// Secrets in a JSON text, which stays valid JSON; undefined when it is not
// JSON. Only strings change; each one by these rules, in order:
//   under a strong key: any text goes; under a weak key: a token-shaped value;
//   beside a `name` that is a secret's: judged by that name;
//   under a secret-named object or list, at any depth: a token-shaped value;
//   in a paging group or a paging field: only credential `name=value` pairs;
//   anything else: the text patterns, and JSON inside it the same way.
// Under a paging group a weak name (a bare `token`) is the page's, not a secret.
export function redactJson(text: string): { text: string; found: string[] } | undefined {
  const strings: [number, number, string, string | undefined, Frame | undefined][] = []
  try {
    readJson(text, (start, end, value, key, frame) => strings.push([start, end, value, key, frame]))
  } catch {
    return undefined
  }
  const memo = new Map<Frame, Context>()
  const found: string[] = []
  let out = ''
  let at = 0
  for (const [start, end, value, key, frame] of strings) {
    if (value === '' || value.startsWith('[REDACTED')) continue
    const ctx = contextOf(frame, memo)
    const kind = key === undefined ? undefined : secretKind(key)
    const beside = nameBeside(key, frame)
    // The name that makes this value a secret, if one does.
    const by =
      key !== undefined && (kind === 'strong' || (kind === 'weak' && !ctx.paging)) && isSecretValue(key, value)
        ? key
        : beside !== undefined && isSecretValue(beside, value)
          ? beside
          : ctx.secret && !ctx.paging && isTokenShaped(value)
            ? (key ?? 'secret')
            : undefined
    let next: string | undefined
    if (by !== undefined) {
      next = '[REDACTED]'
      found.push(`${norm(by)} value`)
    } else {
      const paging = ctx.paging || (key !== undefined && isPagingField(key, value))
      const r = (!paging && /^\s*[[{]/.test(value) && redactJson(value)) || redactText(value, paging)
      if (r.text !== value) {
        next = r.text
        found.push(...r.found)
      }
    }
    if (next === undefined) continue
    out += text.slice(at, start) + JSON.stringify(next)
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
// puts into user rows (only when one is closed: an open tag alone is text).
const clean = (s: string) =>
  (s.includes('</system-reminder>') ? s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '') : s).trim()
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

// The paging and count fields outside the records, as [name, value as
// returned]: `page`, `2`; `data.pageInfo.endCursor`, `"abc"`.
export function pagingOf(data: unknown, prefix = '') {
  const out: [string, string][] = []
  const walk = (v: unknown, path: string, group: boolean) => {
    if (!isObject(v)) return
    for (const [k, x] of Object.entries(v)) {
      if ((group || isPagingField(k, x)) && isScalar(x)) out.push([`${prefix}${path}${k}`, ser(x)])
      else walk(x, `${path}${k}.`, group || isPagingGroup(k, x))
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

// JSON in a text value that is shown as JSON: an object of two fields or
// more, or a list of such objects. `"[12]"` or `"{}"` stays text.
const isRecord = (v: unknown) => isObject(v) && Object.keys(v).length >= 2
const isUnpackable = (v: unknown) => isRecord(v) || (Array.isArray(v) && v.length > 0 && v.every(isRecord))

// A text value: JSON in it is shown as JSON; inside a list, base64 is left out
// and a long value is cut. Beside the records, a value is kept whole up to
// HEAD_CAP characters, so a cursor or link under an unknown name survives.
function trimString(v: string, words: ReadonlySet<string>, t: TrimStats, inList: boolean): unknown {
  const inner = v.length > 1 ? parseJson(v) : undefined
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
    const paging = group || isPagingField(k, x)
    // Paging, cursors and single values the task names travel as returned.
    if ((paging || named) && isScalar(x)) {
      put(out, k, x)
      continue
    }
    if (!named && !paging && NOISE.test(k)) {
      t.noise.add(k)
      continue
    }
    const y = trimValue(x, words, t, group || isPagingGroup(k, x), inList)
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

// Whether a value nests deeper than `limit`; it stops at the limit.
function tooDeep(v: unknown, limit: number): boolean {
  if (limit < 0) return true
  const xs = Array.isArray(v) ? v : isObject(v) ? Object.values(v) : undefined
  return xs !== undefined && xs.some(x => tooDeep(x, limit - 1))
}

// JSON blocks trimmed field by field, each block on its own: paging at the
// top of the second block is still the top. Undefined when a block is not an
// object or a list, or nests deeper than MAX_DEPTH.
export function trimJson(texts: readonly string[], words: ReadonlySet<string>) {
  const data = texts.map(parseJson)
  if (data.some(d => d === undefined || tooDeep(d, MAX_DEPTH))) return undefined
  try {
    const t = newStats()
    const many = data.length > 1
    const text = data
      .map((d, i) => `${many ? `Block ${i + 1} of ${data.length}:${NL}` : ''}${layout(trimValue(d, words, t, false, false))}`)
      .join(`${NL}${NL}`)
    const paging = pagingLine(data.flatMap((d, i) => pagingOf(d, many ? `block ${i + 1}: ` : '')))
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
