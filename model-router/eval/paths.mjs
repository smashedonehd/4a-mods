// Where the eval keeps its files. Prompts, judges' reasons and model replies are private,
// so they live outside the repo; the repo keeps only ids, tiers, categories and decisions.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DATA = process.env.MODEL_ROUTER_EVAL_DATA || join(homedir(), '.claude', 'mods-data', 'model-router', 'eval')
export const CALLS = join(DATA, 'calls.jsonl')
export const SAMPLE = join(DATA, 'sample.jsonl')
export const JUDGMENTS = join(DATA, 'judgments.jsonl')
export const RULINGS = join(DATA, 'rulings.json')
export const CACHE_DIR = join(DATA, 'cache')

// Committed eval files, next to this module
const here = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url))
export const TABLE = fileURLToPath(new URL('../routing.json', import.meta.url))
export const GOLD = here('gold.json')
export const DECISIONS = here('decisions.json')
export const RESULTS = here('results.json')
