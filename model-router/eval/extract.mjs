// Builds the routing eval corpus: every Agent call Claude made in local transcripts, one JSON line each.
// The corpus holds private prompts, so it is written outside the repo (default
// ~/.claude/mods-data/model-router/eval/calls.jsonl) and never committed.
//
//   node model-router/eval/extract.mjs [projectsDir] [outFile]

import { createReadStream, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { createInterface } from 'node:readline'

const projects = process.argv[2] || join(homedir(), '.claude', 'projects')
const out = process.argv[3] || join(homedir(), '.claude', 'mods-data', 'model-router', 'eval', 'calls.jsonl')

function* jsonlFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const s = statSync(p)
    if (s.isDirectory()) yield* jsonlFiles(p)
    else if (name.endsWith('.jsonl')) yield p
  }
}

// One call as the corpus keeps it: what Claude asked for, what reached the host after hooks, and where
function callRecord(rec, block, file) {
  const input = block.input || {}
  const wire = rec.wireToolInputs && rec.wireToolInputs[block.id]
  const rel = relative(projects, file).split(sep)
  return {
    id: block.id,
    project: rel[0],
    session: rec.sessionId || '',
    sidechain: !!rec.isSidechain || rel.includes('subagents'),
    at: rec.timestamp || '',
    parentModel: (rec.message && rec.message.model) || '',
    parentEffort: rec.effort || '',
    type: String(input.subagent_type || ''),
    model: input.model || '',
    effort: input.effort || '',
    wire: wire && typeof wire === 'object' ? { type: wire.subagent_type || '', model: wire.model || '', effort: wire.effort || '' } : null,
    description: String(input.description || ''),
    prompt: String(input.prompt || ''),
  }
}

async function main() {
  const seen = new Set()
  const rows = []
  let files = 0
  for (const file of jsonlFiles(projects)) {
    files++
    const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
    for await (const line of lines) {
      if (!line.includes('"name":"Agent"')) continue
      let rec
      try {
        rec = JSON.parse(line)
      } catch {
        continue
      }
      const content = rec.type === 'assistant' && rec.message && Array.isArray(rec.message.content) ? rec.message.content : []
      for (const block of content) {
        if (block.type !== 'tool_use' || block.name !== 'Agent' || seen.has(block.id)) continue
        seen.add(block.id)
        rows.push(callRecord(rec, block, file))
      }
    }
  }
  rows.sort((a, b) => a.at.localeCompare(b.at))
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  console.log(`${rows.length} Agent calls from ${files} transcripts -> ${out}`)
}

main()
