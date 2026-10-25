// The eval's file formats: JSON Lines for the private data and the caches, JSON for the rest.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { TABLE } from './paths.mjs'

// One value per line; a blank line, or a line cut by a crashed run, is skipped
export function readJsonl(f) {
  const out = []
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // cut by a crashed run
    }
  }
  return out
}

export function writeJsonl(f, rows) {
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

export const readJson = (f, fallback) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : fallback)
export const writeJson = (f, v) => writeFileSync(f, JSON.stringify(v, null, 1) + '\n')

// The shipped routing.json
export const loadTable = () => JSON.parse(readFileSync(TABLE, 'utf8'))
