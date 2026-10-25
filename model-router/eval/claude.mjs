// Runs one model request through `claude -p` on Filip's subscription, plus a resumable cache and a
// small worker pool. Eval calls must not leave transcripts (they would pollute the corpus) or pick
// up hooks, CLAUDE.md, plugins or MCP servers, so every spawn gets the same isolating flags.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { CACHE_DIR } from './paths.mjs'

export const CLAUDE_BIN = process.env.CLAUDE_BIN || (process.platform === 'win32' ? join(homedir(), '.local', 'bin', 'claude.exe') : 'claude')

// MODEL_ROUTER_EVAL_ACCOUNT=2 runs on Filip's second account, as claude2.cmd does: its OAuth token
// from CLAUDE_TOKEN_UCET2, with the API key variables cleared because they would win over it
function accountEnv() {
  if (process.env.MODEL_ROUTER_EVAL_ACCOUNT !== '2') return process.env
  const token = process.env.CLAUDE_TOKEN_UCET2
  if (!token) throw new Error('MODEL_ROUTER_EVAL_ACCOUNT=2 needs CLAUDE_TOKEN_UCET2')
  const env = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token }
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.ANTHROPIC_API_KEY
  return env
}

const ISOLATE =['--safe-mode', '--setting-sources', '', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'json']

// req: {model: alias, effort, system, prompt, timeoutMs?}. Resolves to {text, usage, costUsd}.
export function complete(table, req) {
  const m = table.models[req.model]
  if (!m) return Promise.reject(new Error(`unknown model alias: ${req.model}`))
  let env
  try {
    env = accountEnv()
  } catch (e) {
    return Promise.reject(e)
  }
  const dir = mkdtempSync(join(tmpdir(), 'mr-eval-'))
  const sys = join(dir, 'system.txt')
  writeFileSync(sys, req.system || '')
  const args = ['-p', ...ISOLATE, '--model', m.id, '--effort', req.effort, '--system-prompt-file', sys]
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, { cwd: dir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill(), req.timeoutMs || 600000)
    const done = (fn) => {
      clearTimeout(timer)
      rmSync(dir, { recursive: true, force: true })
      fn()
    }
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => done(() => reject(e)))
    child.on('close', (code, signal) =>
      done(() => {
        let reply
        try {
          reply = JSON.parse(out)
        } catch {
          return reject(new Error(`claude -p exit ${code}${signal ? ` (${signal})` : ''}: ${(err || out).trim().slice(0, 500)}`))
        }
        if (reply.is_error || code !== 0) return reject(new Error(`claude -p error: ${String(reply.result || err).slice(0, 500)}`))
        resolve({ text: String(reply.result ?? ''), usage: reply.usage || {}, costUsd: Number(reply.total_cost_usd) || 0 })
      }),
    )
    child.stdin.end(req.prompt || '')
  })
}

// Runs fn over items with at most n in flight; results keep the input order
export async function pool(items, n, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker))
  return out
}

const caches = new Map()

function cacheOf(name) {
  if (caches.has(name)) return caches.get(name)
  const file = join(CACHE_DIR, `${name}.jsonl`)
  const map = new Map()
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line)
        map.set(row.key, row.value)
      } catch {
        // A line cut by a crashed run is skipped; its request runs again
      }
    }
  }
  const c = { file, map }
  caches.set(name, c)
  return c
}

// Returns run(req) once per distinct request, kept in CACHE_DIR/<name>.jsonl so a crashed run resumes.
// read: false still records the reply but always runs the request (fresh live samples).
export async function cached(name, req, run, { read = true } = {}) {
  const c = cacheOf(name)
  const key = createHash('sha256').update(JSON.stringify(req)).digest('hex')
  if (read && c.map.has(key)) return c.map.get(key)
  const value = await run(req)
  mkdirSync(CACHE_DIR, { recursive: true })
  appendFileSync(c.file, JSON.stringify({ key, value }) + '\n')
  c.map.set(key, value)
  return value
}

// Whether a request already has a cached reply, without running it (cost estimates before a run)
export function isCached(name, req) {
  return cacheOf(name).map.has(createHash('sha256').update(JSON.stringify(req)).digest('hex'))
}
