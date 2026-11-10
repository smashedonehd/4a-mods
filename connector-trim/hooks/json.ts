// A JSON reader for tool results: it keeps every number exactly as written
// and reports where each string value sits in the text, so redaction can
// replace a value in place and leave every other byte as the server sent it.

// A number JavaScript cannot hold as written (past 2^53, `1.50`, `1e5`):
// kept as its text and written back as it came.
export class Exact {
  constructor(readonly raw: string) {}
}

export type Json = Record<string, unknown>
export const isObject = (v: unknown): v is Json =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Exact)
export const isScalar = (v: unknown) => v === null || v instanceof Exact || ['string', 'number', 'boolean'].includes(typeof v)

// An own property, `__proto__` included.
export function put(o: Json, k: string, v: unknown) {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true })
}

// Called for each string value: its span in the text (quotes included), its
// value, and the key it stands under (an array's elements take the array's).
export type Visit = (start: number, end: number, value: string, key: string | undefined) => void

const NUM = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y
const WS = /[ \t\n\r]*/y

// The value of `text`, which must be one JSON value; throws when it is not.
export function readJson(text: string, visit?: Visit): unknown {
  let i = 0
  const fail = (): never => {
    throw new SyntaxError(`not JSON at ${i}`)
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
    return [JSON.parse(text.slice(start, i)) as string, start]
  }
  const value = (key: string | undefined): unknown => {
    ws()
    const c = text[i]
    if (c === '{') {
      i++
      const o: Json = {}
      ws()
      if (text[i] === '}') return (i++, o)
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
        else if (text[i] === '}') return (i++, o)
        else fail()
      }
    }
    if (c === '[') {
      i++
      const a: unknown[] = []
      ws()
      if (text[i] === ']') return (i++, a)
      for (;;) {
        a.push(value(key))
        ws()
        if (text[i] === ',') i++
        else if (text[i] === ']') return (i++, a)
        else fail()
      }
    }
    if (c === '"') {
      const [s, start] = str()
      visit?.(start, i, s, key)
      return s
    }
    for (const [word, v] of [['true', true], ['false', false], ['null', null]] as const)
      if (text.startsWith(word, i)) return ((i += word.length), v)
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

// The object or array a text holds, or undefined for anything else.
export function parseJson(text: string): unknown {
  if (!/^\s*[[{]/.test(text)) return undefined
  try {
    return readJson(text)
  } catch {
    return undefined
  }
}

// Compact JSON, exact numbers written as they came.
export function ser(v: unknown): string {
  if (v instanceof Exact) return v.raw
  if (Array.isArray(v)) return `[${v.map(ser).join(',')}]`
  if (isObject(v)) return `{${Object.keys(v).map(k => `${JSON.stringify(k)}:${ser(v[k])}`).join(',')}}`
  return JSON.stringify(v) ?? 'null'
}
