// Connector Trim's pure helpers: reading a tool result, redacting secrets,
// the deterministic trim, the task words, the note's header and retention.
// Nothing here calls the engine, so the tests reach every rule directly.

export const NL = '\n'
export const STRING_CAP = 1000
// Approximate tokens, the way the savings ledger counts them.
export const tokens = (chars: number) => Math.ceil(chars / 4)
export const fmt = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

type Json = Record<string, unknown>
export const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v)

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

// ---------- secrets ----------

// Conservative: formats with a fixed shape, and a value written beside a key
// that names a secret. A miss is possible; a false hit costs one value.
const SECRETS: [RegExp, string][] = [
  [/-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}[\s\S]*?-{5}END [A-Z ]*PRIVATE KEY-{5}/g, 'private key'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, 'bearer token'],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g, 'API key'],
  [/\bgh[opsu]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/g, 'GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AWS key'],
  [/\bAIza[0-9A-Za-z_-]{35}/g, 'Google API key'],
  [/\bya29\.[A-Za-z0-9._-]{20,}/g, 'Google access token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, 'Slack token'],
]
// `password=x`, `"api_key": "x"`: the key and its quotes stay, the value goes.
const PAIR =
  /(["']?)\b(password|passwd|pwd|secret|client_secret|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|private[_-]?key)\1(\s*[:=]\s*)(["']?)([^"'\s,;&}\][][^"'\s,;&}\]]{3,})/gi

export function redact(text: string) {
  const found: string[] = []
  let out = text
  for (const [re, kind] of SECRETS)
    out = out.replace(re, () => {
      found.push(kind)
      return `[REDACTED ${kind}]`
    })
  out = out.replace(PAIR, (_m, q: string, key: string, sep: string, vq: string) => {
    found.push(`${key.toLowerCase()} value`)
    return `${q}${key}${q}${sep}${vq}[REDACTED]`
  })
  return { text: out, found }
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
    'jo ja jj ano ok okay oki okej dobre dobra dobry super jasne fajn paráda parada pokracuj pokracujte ' +
    'pokracovat dal dalsi delej makej jed jedem hotovo souhlas souhlasim schvaleno tak teda ted tedy no a i ' +
    'prosim diky dik dekuji dekuju yes yep yeah sure ok continue proceed go next thanks thx fine good great ' +
    'nice cool perfect done approved lgtm do it that this please'
  )
    .split(' ')
    .map(fold),
)

export function isFiller(text: string) {
  const words = fold(text).match(/[\p{L}\p{N}]+/gu) ?? []
  return words.length <= 6 && words.every(w => FILLER.has(w))
}

// What the person and the assistant wrote, minus the reminders the engine
// puts into user rows.
const clean = (s: string) => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
const head = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
const tail = (s: string, n: number) => (s.length > n ? `…${s.slice(-n)}` : s)

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

const PAGING =
  /^(page|pages|pagenumber|pagesize|perpage|pagetoken|nextpagetoken|prevpagetoken|nextpage|hasnextpage|hasmore|more|total|totalcount|totalresults|totalrows|totalsize|count|rowcount|offset|limit|cursor|nextcursor|next|previous|startindex|itemsperpage|truncated)$/
export const isPaging = (key: string) => PAGING.test(key.toLowerCase().replace(/[^a-z]/g, ''))
const isScalar = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v)

// The paging and count fields outside the records, copied as the server wrote
// them: `page=2, total=1234, next_page_token="abc"`.
export function pagingOf(data: unknown) {
  const out: string[] = []
  const walk = (v: unknown, path: string, depth: number) => {
    if (!isObject(v) || depth > 2) return
    for (const [k, x] of Object.entries(v)) {
      if (isPaging(k) && isScalar(x)) out.push(`${path}${k}=${JSON.stringify(x)}`)
      else walk(x, `${path}${k}.`, depth + 1)
    }
  }
  walk(data, '', 0)
  return out.join(', ')
}

// ---------- the deterministic trim ----------

export type TrimStats = {
  empty: Set<string>
  blobs: Set<string>
  noise: Set<string>
  cut: number
  hoisted: number
  unpacked: number
}
export const newStats = (): TrimStats => ({
  empty: new Set(),
  blobs: new Set(),
  noise: new Set(),
  cut: 0,
  hoisted: 0,
  unpacked: 0,
})

export const SAME = 'same in every record'
const BLOB = /^(?:data:[\w/+.-]+;base64,)?[A-Za-z0-9+/_-]{200,}={0,2}$/
const DROPPED = Symbol('base64')
// Bookkeeping fields APIs add to every object.
const NOISE = /^(etag|__typename|_links|selfLink|@odata\.\w+)$/i

const isEmpty = (v: unknown) =>
  v === null ||
  v === undefined ||
  v === '' ||
  (Array.isArray(v) && v.length === 0) ||
  (isObject(v) && Object.keys(v).length === 0)

export function parseJson(text: string): unknown {
  const s = text.trim()
  if (!/^[[{]/.test(s)) return undefined
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

// One trimmed value. `inRecord` is true below an array: there a paging-like
// name (`count`) is data, not the response's paging.
function trimValue(v: unknown, words: ReadonlySet<string>, t: TrimStats, inRecord: boolean): unknown {
  if (typeof v === 'string') {
    const inner = v.length > 1 ? parseJson(v) : undefined
    if (inner !== undefined && typeof inner === 'object') {
      t.unpacked += 1
      return trimValue(inner, words, t, inRecord)
    }
    if (BLOB.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v)) return DROPPED
    if (v.length > STRING_CAP) {
      t.cut += 1
      return `${v.slice(0, STRING_CAP)} …[cut: ${fmt(v.length - STRING_CAP)} more characters in the saved file]`
    }
    return v
  }
  if (Array.isArray(v)) {
    const items = v.map(x => trimValue(x, words, t, true)).filter(x => x !== DROPPED && !isEmpty(x))
    return hoist(items, t)
  }
  if (!isObject(v)) return v
  const out: Json = {}
  for (const [k, x] of Object.entries(v)) {
    const named = isNamed(k, words)
    // Paging and counts travel exactly as written, whatever they hold.
    if (!inRecord && isPaging(k) && isScalar(x)) {
      out[k] = x
      continue
    }
    if (!named && NOISE.test(k)) {
      t.noise.add(k)
      continue
    }
    const y = trimValue(x, words, t, inRecord)
    if (y === DROPPED) {
      if (named) out[k] = '[base64 data: in the saved file]'
      else t.blobs.add(k)
    } else if (isEmpty(y) && !named) t.empty.add(k)
    else out[k] = y
  }
  return out
}

// Records of three or more whose field holds one value in all of them: the
// field is written once, beside the records.
function hoist(items: unknown[], t: TrimStats): unknown {
  if (items.length < 3 || !items.every(isObject)) return items
  const records = items as Json[]
  const same: Json = {}
  for (const k of Object.keys(records[0]!)) {
    const s = JSON.stringify(records[0]![k])
    if (records.every(r => k in r && JSON.stringify(r[k]) === s)) same[k] = records[0]![k]
  }
  const keys = Object.keys(same)
  if (keys.length === 0) return items
  t.hoisted += keys.length
  return {
    [SAME]: same,
    records: records.map(r => Object.fromEntries(Object.entries(r).filter(([k]) => !(k in same)))),
  }
}

// JSON with one record per line: compact, and still valid JSON.
export function layout(v: unknown, pad = ''): string {
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]'
    if (v.every(x => !isObject(x) && !Array.isArray(x))) return JSON.stringify(v)
    return `[${NL}${v.map(x => `${pad}  ${JSON.stringify(x)}`).join(`,${NL}`)}${NL}${pad}]`
  }
  if (isObject(v)) {
    const keys = Object.keys(v)
    if (keys.length === 0) return '{}'
    const lines = keys.map(k => `${pad}  ${JSON.stringify(k)}: ${layout(v[k], `${pad}  `)}`)
    return `{${NL}${lines.join(`,${NL}`)}${NL}${pad}}`
  }
  return JSON.stringify(v) ?? 'null'
}

// The trimmed text of the result's texts. JSON (also JSON carried inside a
// text block, or several blocks of it) is trimmed field by field; plain text
// only loses runs of blank space.
export function trimTexts(texts: readonly string[], words: ReadonlySet<string>) {
  const t = newStats()
  const parsed = texts.map(parseJson)
  if (parsed.every(p => p !== undefined)) {
    const data = parsed.length === 1 ? parsed[0] : parsed
    return { data, text: layout(trimValue(data, words, t, false)), stats: t }
  }
  const text = texts
    .join(`${NL}${NL}`)
    .replace(/[ \t]+$/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, `${NL}${NL}`)
  return { data: undefined, text, stats: t }
}

const listed = (s: ReadonlySet<string>) => {
  const a = [...s]
  return a.slice(0, 15).join(', ') + (a.length > 15 ? `, and ${a.length - 15} more` : '')
}

// What the trim left out, in words; '' for nothing.
export function leftOut(t: TrimStats) {
  const parts: string[] = []
  if (t.empty.size > 0) parts.push(`empty fields (${listed(t.empty)})`)
  if (t.blobs.size > 0) parts.push(`base64 data (${listed(t.blobs)})`)
  if (t.noise.size > 0) parts.push(`API bookkeeping fields (${listed(t.noise)})`)
  if (t.cut > 0) parts.push(`the rest of ${t.cut} text value${t.cut > 1 ? 's' : ''} over ${fmt(STRING_CAP)} characters`)
  return parts.join('; ')
}

// Lines of at most `size` characters each, grouped into parts for the helper.
export function chunks(text: string, size: number) {
  const parts: string[] = []
  let part = ''
  for (const line of text.split(NL)) {
    for (let i = 0; i < Math.max(line.length, 1); i += size) {
      const piece = line.slice(i, i + size)
      if (part.length > 0 && part.length + piece.length + 1 > size) {
        parts.push(part)
        part = ''
      }
      part = part === '' ? piece : `${part}${NL}${piece}`
    }
  }
  if (part !== '') parts.push(part)
  return parts
}

// ---------- the note ----------

export type Note = {
  tool: string
  before: number
  how: 'trim' | 'haiku' | 'fallback'
  why?: string
  leftOut: string
  hoisted: boolean
  redacted: readonly string[]
  paging: string
  file: string
  body: string
}

const HOW = {
  trim: 'Trimmed by code: nothing below is summarised, only the fields named here were left out.',
  haiku: 'Condensed by Haiku for this task; its last line names what it left out.',
  fallback: 'Trimmed by code',
}

// The text Claude reads in place of the result: the header, then the body.
export function note(n: Note) {
  const build = (after: number) =>
    [
      `[Connector Trim] ${n.tool}: ${fmt(n.before)} → ${fmt(after)} characters (about ${fmt(tokens(n.before))} → ${fmt(tokens(after))} tokens). ${
        n.how === 'fallback' ? `${HOW.fallback} (${n.why ?? 'the helper model failed'}).` : HOW[n.how]
      }`,
      `Left out: ${n.leftOut || 'nothing but blank space'}.${n.hoisted ? ` Fields with one value in every record are written once, under "${SAME}".` : ''}`,
      ...(n.redacted.length > 0 ? [`Redacted before saving and before any model saw it: ${counted(n.redacted)}.`] : []),
      ...(n.paging ? [`Paging (copied exactly): ${n.paging}`] : []),
      `Full result: ${n.file}`,
      'Use this note as the tool\'s answer; open the file only for a field this note does not list.',
      '',
      n.body,
    ].join(NL)
  let text = build(n.body.length)
  for (let i = 0; i < 2; i++) text = build(text.length)
  return text
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
