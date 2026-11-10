// A JSON reader for tool results: it keeps every number exactly as written
// and reports where each string value sits in the text, so redaction can
// replace a value in place and leave every other byte as the server sent it.

// A number JavaScript cannot hold as written (past 2^53, `1.50`, `1e5`):
// kept as its text and written back as it came.
export class Exact {
  constructor(readonly raw: string) {}
}

// Thrown when a result's time budget runs out: the caller passes the result
// whole. Every catch on the way up lets it through.
export class TooSlow extends Error {
  constructor() {
    super('took too long')
  }
}

export type Json = Record<string, unknown>
export const isObject = (v: unknown): v is Json =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Exact)
export const isScalar = (v: unknown) =>
  v === null || v instanceof Exact || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'

// An own property, `__proto__` included.
export function put(o: Json, k: string, v: unknown) {
  if (k === '__proto__') Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true })
  else o[k] = v
}

// The object or list a string stands in, and where that container stands: the
// key it is under (a list's elements take the list's key) and its parent. The
// container is complete once the whole text has been read.
export type Frame = { key: string | undefined; holder: Json | unknown[]; parent: Frame | undefined }

// Called for each string value: its span in the text (quotes included), its
// value, the key it stands under (an array's elements take the array's), and
// the container it is in.
export type Visit = (start: number, end: number, value: string, key: string | undefined, frame: Frame | undefined) => void

const NUM = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y
const WS = /[ \t\n\r]*/y
// A string's text that JSON.parse would change or refuse: an escape or a
// control character.
const NOT_PLAIN = /[\\\u0000-\u001f]/

// Thrown for text that is not JSON: one object, since building an error and
// its stack for each of many small strings costs more than reading them.
const NOT_JSON = new SyntaxError('not JSON')

// The value of `text`, which must be one JSON value; throws when it is not.
// `tick` is called once per value, so a caller can stop a long read.
export function readJson(text: string, visit?: Visit, tick?: () => void): unknown {
  let i = 0
  let frame: Frame | undefined
  const fail = (): never => {
    throw NOT_JSON
  }
  const ws = () => {
    WS.lastIndex = i
    WS.exec(text)
    i = WS.lastIndex
  }
  // A string token from its opening quote: the value and where it began.
  const str = (): [string, number] => {
    const start = i
    let j = i + 1
    for (;;) {
      j = text.indexOf('"', j)
      if (j < 0) fail()
      let slashes = 0
      while (text.charCodeAt(j - 1 - slashes) === 92) slashes++
      if (slashes % 2 === 0) break
      j++
    }
    i = j + 1
    const inner = text.slice(start + 1, j)
    return [NOT_PLAIN.test(inner) ? (JSON.parse(text.slice(start, i)) as string) : inner, start]
  }
  const value = (key: string | undefined): unknown => {
    tick?.()
    ws()
    const c = text[i]
    if (c === '{') {
      i++
      const o: Json = {}
      const outer = frame
      if (visit) frame = { key, holder: o, parent: outer }
      ws()
      if (text[i] === '}') return (i++, (frame = outer), o)
      for (;;) {
        ws()
        if (text[i] !== '"') fail()
        const [k] = str()
        ws()
        if (text[i] !== ':') fail()
        i++
        put(o, k, value(k))
        ws()
        if (text[i] === ',') i++
        else if (text[i] === '}') return (i++, (frame = outer), o)
        else fail()
      }
    }
    if (c === '[') {
      i++
      const a: unknown[] = []
      const outer = frame
      if (visit) frame = { key, holder: a, parent: outer }
      ws()
      if (text[i] === ']') return (i++, (frame = outer), a)
      for (;;) {
        a.push(value(key))
        ws()
        if (text[i] === ',') i++
        else if (text[i] === ']') return (i++, (frame = outer), a)
        else fail()
      }
    }
    if (c === '"') {
      const [s, start] = str()
      visit?.(start, i, s, key, frame)
      return s
    }
    if (text.startsWith('true', i)) return ((i += 4), true)
    if (text.startsWith('false', i)) return ((i += 5), false)
    if (text.startsWith('null', i)) return ((i += 4), null)
    NUM.lastIndex = i
    const m = NUM.exec(text)
    if (!m) fail()
    i = NUM.lastIndex
    const raw = m![0]
    const n = Number(raw)
    return String(n) === raw ? n : new Exact(raw)
  }
  const v = value(undefined)
  ws()
  if (i !== text.length) fail()
  return v
}

// The object or array a text holds, or undefined for anything else. A
// TooSlow from `tick` goes through.
export function parseJson(text: string, tick?: () => void): unknown {
  if (!/^\s*[[{]/.test(text)) return undefined
  try {
    return readJson(text, undefined, tick)
  } catch (e) {
    if (e instanceof TooSlow) throw e
    return undefined
  }
}

// Compact JSON, exact numbers written as they came. Written into one list of
// parts and joined once, so a deep chain is not copied once per level.
export function ser(v: unknown): string {
  const out: string[] = []
  const write = (x: unknown) => {
    if (x instanceof Exact) out.push(x.raw)
    else if (Array.isArray(x)) {
      out.push('[')
      for (let i = 0; i < x.length; i++) {
        if (i > 0) out.push(',')
        write(x[i])
      }
      out.push(']')
    } else if (isObject(x)) {
      out.push('{')
      let first = true
      for (const k of Object.keys(x)) {
        if (!first) out.push(',')
        first = false
        out.push(JSON.stringify(k), ':')
        write(x[k])
      }
      out.push('}')
    } else out.push(JSON.stringify(x) ?? 'null')
  }
  write(v)
  return out.join('')
}
