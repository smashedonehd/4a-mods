// Builds the private review page for Filip: every call where the two judges disagree, with both
// verdicts, the recommendation and buttons that store his ruling in the artifact's `rulings`
// collection (one document per call id: {tier, category, at}). The page holds prompt excerpts,
// so it is written to the private DATA directory and published only as a private artifact.
//
//   node model-router/eval/review-page.mjs

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { routableTiers } from '../hooks/route.mjs'
import { loadTable, readJsonl } from './io.mjs'
import { disagrees } from './lib.mjs'
import { agreement } from './metrics.mjs'
import { DATA, JUDGMENTS, SAMPLE } from './paths.mjs'

const table = loadTable()
const sample = new Map(readJsonl(SAMPLE).map((r) => [r.id, r]))
const judged = readJsonl(JUDGMENTS).filter((r) => r.A && r.B)
const items = judged
  .filter((r) => disagrees(table, r.A, r.B))
  .map((r) => {
    const c = sample.get(r.id)
    return { id: r.id, split: c.split, stratum: c.stratum, type: c.type || '(none)', description: c.description, prompt: String(c.prompt).slice(0, 1500), more: Math.max(0, String(c.prompt).length - 1500), A: r.A, B: r.B, R: r.R }
  })
const tiers = routableTiers(table).map((k) => ({ k, model: table.tiers[k].model, effort: table.tiers[k].effort }))
const a = judged.map((r) => r.A.tier)
const b = judged.map((r) => r.B.tier)
const summary = { rows: judged.length, ...agreement(a, b) }
const data = JSON.stringify({ items, tiers, categories: table.categories, critical: table.critical, summary }).replace(/</g, '\\u003c')

const html = `<title>Routing Gold Rulings</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
/* Layout: one working column of call cards under a sticky tally bar; verdicts side by side, stacking on phones */
:root {
  --bg: #f3f5f4; --surface: #ffffff; --ink: #18211e; --muted: #5d6b66; --line: #d5dcd9;
  --accent: #1f6f5c; --accent-ink: #ffffff; --rec: #fff4d6; --rec-line: #d9a520; --done: #e3f1ec;
  --crit: #a3331f;
  --font-body: "IBM Plex Sans", system-ui, sans-serif; --font-mono: "IBM Plex Mono", ui-monospace, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #111816; --surface: #19221f; --ink: #e4ebe8; --muted: #93a39d; --line: #2c3834;
  --accent: #4fb89b; --accent-ink: #0d1412; --rec: #2e2714; --rec-line: #c9962a; --done: #17302a; --crit: #e3836f; color-scheme: dark } }
:root[data-theme="dark"] {
  --bg: #111816; --surface: #19221f; --ink: #e4ebe8; --muted: #93a39d; --line: #2c3834;
  --accent: #4fb89b; --accent-ink: #0d1412; --rec: #2e2714; --rec-line: #c9962a; --done: #17302a; --crit: #e3836f; color-scheme: dark }
body { background: var(--bg); color: var(--ink); font: 15px/1.5 var(--font-body); }
body::before { content: ""; position: fixed; inset: 0 0 auto; height: env(safe-area-inset-top, 0px); z-index: 10; background: var(--surface); }
.wrap { max-width: 980px; margin: 0 auto; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 0 48px; }
header { position: sticky; top: env(safe-area-inset-top, 0px); z-index: 5; background: var(--surface); border-bottom: 1px solid var(--line); }
header .wrap { display: flex; flex-wrap: wrap; gap: 12px 20px; align-items: center; padding-block: 12px; }
h1 { font-size: 18px; margin: 0; text-wrap: balance; }
.tally { font-variant-numeric: tabular-nums; color: var(--muted); }
.tally b { color: var(--ink); }
.spacer { flex: 1; }
button, select { font: inherit; }
.btn { border: 1px solid var(--line); background: var(--surface); color: var(--ink); border-radius: 6px; padding: 6px 12px; cursor: pointer; }
.btn.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
.btn:focus-visible, select:focus-visible, .tier:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.btn[disabled] { opacity: .5; cursor: default; }
.intro { color: var(--muted); max-width: 70ch; margin: 20px 0; }
.list { display: grid; gap: 16px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 16px; display: grid; gap: 12px; min-width: 0; }
.card.done { background: var(--done); }
.meta { display: flex; flex-wrap: wrap; gap: 6px 12px; font: 12px/1.4 var(--font-mono); color: var(--muted); letter-spacing: .02em; }
.meta .status { margin-left: auto; color: var(--accent); font-weight: 600; }
.desc { font-weight: 600; font-size: 16px; margin: 0; }
details summary { cursor: pointer; color: var(--muted); font-size: 13px; }
pre { margin: 8px 0 0; padding: 12px; background: var(--bg); border-radius: 6px; font: 12.5px/1.5 var(--font-mono); white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow: auto; }
.verdicts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
@media (max-width: 720px) { .verdicts { grid-template-columns: 1fr; } }
.v { border: 1px solid var(--line); border-radius: 6px; padding: 10px; min-width: 0; }
.v.rec { background: var(--rec); border-color: var(--rec-line); }
.v h3 { margin: 0 0 4px; font: 600 11px/1.3 var(--font-mono); text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
.v .t { font: 600 15px/1.3 var(--font-mono); }
.v .t .crit { color: var(--crit); }
.v p { margin: 6px 0 0; font-size: 13.5px; }
.pick { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.tier { border: 1px solid var(--line); background: var(--surface); color: var(--ink); border-radius: 6px; padding: 6px 10px; cursor: pointer; display: grid; text-align: left; line-height: 1.2; }
.tier small { font: 11px var(--font-mono); color: var(--muted); }
.tier.on { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
.tier.on small { color: var(--accent-ink); }
.tier.r:not(.on) { border-color: var(--rec-line); }
select { border: 1px solid var(--line); background: var(--surface); color: var(--ink); border-radius: 6px; padding: 6px 8px; }
.note { font-size: 13px; color: var(--muted); }
.err { color: var(--crit); }
</style>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@400;600&display=swap">
<header><div class="wrap">
  <h1>Routing Gold Rulings</h1>
  <span class="tally" id="tally"></span>
  <span class="spacer"></span>
  <label class="note"><input type="checkbox" id="open-only"> jen nerozhodnuté</label>
  <button class="btn primary" id="accept-all" type="button">Přijmout všechna doporučení</button>
</div></header>
<main class="wrap">
  <p class="intro" id="intro"></p>
  <p class="note err" id="status" hidden></p>
  <div class="list" id="list"></div>
</main>
<script>
const DATA = ${data}
const $ = (s) => document.querySelector(s)
const rulings = new Map()
let db = null
const crit = (c) => DATA.critical.includes(c)

$('#intro').textContent = 'Soudci A a B se shodli na tieru u ' + Math.round(DATA.summary.raw * 1000) / 10 + ' % ze ' + DATA.summary.rows + ' volání (kappa ' + DATA.summary.kappa.toFixed(3) + '). Tady jsou zbylá volání, kde se liší tier nebo kritičnost kategorie. Žlutě je doporučení třetího soudce, který viděl oba verdikty. Vyber tier a kategorii; rozhodnutí se uloží hned.'

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
    else e.setAttribute(k, v)
  }
  for (const k of kids) if (k != null) e.append(k)
  return e
}

function verdict(label, v, rec) {
  if (!v) return el('div', { class: 'v' }, el('h3', {}, label), el('p', {}, 'chybí'))
  const t = el('div', { class: 't' }, v.tier + ' · ', crit(v.category) ? el('span', { class: 'crit' }, v.category) : v.category)
  return el('div', { class: 'v' + (rec ? ' rec' : '') }, el('h3', {}, label), t, el('p', {}, v.reason))
}

async function save(item, tier, category) {
  if (!db) return
  $('#status').hidden = true
  try {
    await db.collection('rulings').doc(item.id).set({ tier, category, at: new Date().toISOString() })
  } catch (e) {
    $('#status').textContent = 'Uložení selhalo (' + (e.code || e.message) + '). Zkus to znovu.'
    $('#status').hidden = false
  }
}

function card(item, i) {
  const r = rulings.get(item.id)
  const rec = item.R || item.A
  const chosenTier = r ? r.tier : null
  const sel = el('select', { id: 'cat-' + i, 'aria-label': 'Kategorie' }, ...DATA.categories.map((c) => el('option', { value: c }, c)))
  sel.value = r ? r.category : rec.category
  sel.addEventListener('change', () => { if (rulings.has(item.id)) save(item, rulings.get(item.id).tier, sel.value) })
  const pick = el('div', { class: 'pick' }, ...DATA.tiers.map((t) =>
    el('button', { type: 'button', class: 'tier' + (chosenTier === t.k ? ' on' : '') + (rec.tier === t.k ? ' r' : ''), 'aria-pressed': String(chosenTier === t.k), onclick: () => save(item, t.k, sel.value) },
      t.k, el('small', {}, t.model + ' / ' + t.effort))), sel)
  const meta = el('div', { class: 'meta' }, el('span', {}, '#' + (i + 1)), el('span', {}, item.stratum), el('span', {}, item.type), el('span', {}, item.split === 'heldout' ? 'held-out' : 'train'),
    el('span', { class: 'status' }, r ? 'rozhodnuto: ' + r.tier : ''))
  const prompt = el('details', {}, el('summary', {}, 'Prompt (' + (item.more ? 'prvních 1500 znaků, dalších ' + item.more + ' vynecháno' : 'celý') + ')'), el('pre', {}, item.prompt))
  return el('article', { class: 'card' + (r ? ' done' : '') }, meta, el('p', { class: 'desc' }, item.description || '(bez popisu)'), prompt,
    el('div', { class: 'verdicts' }, verdict('Soudce A', item.A), verdict('Soudce B', item.B), verdict('Doporučení', item.R, true)), pick)
}

function render() {
  const done = DATA.items.filter((x) => rulings.has(x.id)).length
  $('#tally').innerHTML = ''
  $('#tally').append(el('b', {}, String(done)), ' / ' + DATA.items.length + ' rozhodnuto')
  $('#accept-all').disabled = !db || done === DATA.items.length
  const openOnly = $('#open-only').checked
  const list = $('#list')
  list.replaceChildren(...DATA.items.map((x, i) => (openOnly && rulings.has(x.id) ? null : card(x, i))).filter(Boolean))
}

$('#open-only').addEventListener('change', render)
$('#accept-all').addEventListener('click', async () => {
  $('#accept-all').disabled = true
  for (const item of DATA.items) {
    if (rulings.has(item.id)) continue
    const rec = item.R || item.A
    await save(item, rec.tier, rec.category)
  }
})

render()
claude.use('db').then((d) => {
  if (!d) {
    $('#status').textContent = 'Úložiště rozhodnutí není dostupné. Otevři stránku přihlášený v claude.ai.'
    $('#status').hidden = false
    return
  }
  db = d
  db.collection('rulings').onSnapshot((snap) => {
    rulings.clear()
    for (const doc of snap.docs) rulings.set(doc.id, doc.data())
    render()
  }, (e) => {
    $('#status').textContent = 'Načtení rozhodnutí selhalo (' + e.code + '). Obnov stránku.'
    $('#status').hidden = false
  })
  render()
})
</script>
`
const out = join(DATA, 'review.html')
writeFileSync(out, html)
console.log(`${items.length} disagreements (${items.filter((x) => x.split === 'heldout').length} held-out) -> ${out}`)
