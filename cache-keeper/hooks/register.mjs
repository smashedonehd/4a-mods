// Cache Keeper: watches this session's prompt cache, keeps big caches warm on
// request, refuses a cold send without asking first, and shows every local
// session on one board (/board).
//
// Why: each request re-reads the whole context. From the cache that costs about
// a tenth of normal input. Once the cache expires (1 hour idle on a subscription,
// 5 minutes on the default API TTL), the next message writes the whole context
// again at 1.25x to 2x input. A cache read also restarts the timer, so a tiny
// ping before expiry costs a fraction of a rewrite.

import { rewriteCost, requestCost, totalInput, cachedShare, priceFor } from './pricing.mjs'
import { tokens, minutes, clock, clip, basename, pad } from './fmt.mjs'
import { makeMasker } from './privacy.mjs'

const MIN = 60000
const HEARTBEAT_EVERY = 30000
const PANE = 'cache-board'

// This session
const S = {
  id: '',
  cwd: '',
  label: '',
  model: '',
  lastActivity: 0, // last main-loop request or keep-warm ping that touched the cache
  ctx: 0,
  window: 0,
  costUsd: 0,
  ttlMin: 60,
  ttlSource: 'default',
  coldRestarts: [],
  working: false,
  turnId: '', // the main loop's running (or last) turn
  waitingSince: 0,
  waitingFor: '',
  tool: '',
  lastTurnEnd: 0,
  keepWarm: false,
  keepWarmUntil: 0,
  pings: 0,
  pingUsd: 0,
  lastPingAt: 0,
  warnedFor: 0,
  agentsRunning: 0,
  rateLimits: [],
}

const settings = { bigTokens: 150000, guard: true, ttlMin: 0, alerts: true, keepWarmHours: 4 }
const names = { cache: 'cache', keepwarm: 'keepwarm', board: 'board', handoff: 'handoff' }

let now = 0
let home = ''
let lastHeartbeat = 0
let rec = { on: false, strict: false }
let mask = (s) => s
let fleet = [] // heartbeats of every session, this one included
const alerted = new Map() // sessionId -> state or warning key already announced
let paneOpen = false
let justCompacted = false
let handoffPending = false

// Skills "clear and continue" runs again in the fresh chat before the handoff,
// but only those this chat turned on: key -> { command, args }. Mirrored in
// $.state, which the host keeps for the session across a /reload-plugins.
const REVIVE_ORDER = ['caveman', 'jev', 'lsp']
const REVIVE_REF = { plugin: 'cache-keeper', key: 'revive' }
const revive = new Map()

// True when it may have changed what to revive
function noteSkill(name, args) {
  const n = String(name || '').replace(/^\//, '')
  const a = String(args || '').trim()
  if (/(^|:)caveman$/.test(n)) {
    if (/^off$/i.test(a)) return revive.delete('caveman')
    revive.set('caveman', { command: n, args: a })
  } else if (n === 'jev:on') revive.set('jev', { command: n, args: '' })
  else if (n === 'jev:off') return revive.delete('jev')
  else if (/(^|:)navigating-code-with-lsp$/.test(n)) revive.set('lsp', { command: n, args: '' })
  else return false
  return true
}

async function noteAndSave($, name, args) {
  if (noteSkill(name, args)) await saveRevive($)
}

async function saveRevive($) {
  try {
    await $.state.set(REVIVE_REF, [...revive])
  } catch {
    // not kept: a reload forgets it
  }
}

async function loadRevive($) {
  try {
    const { value } = await $.state.get(REVIVE_REF)
    if (Array.isArray(value)) for (const [k, s] of value) if (REVIVE_ORDER.includes(k) && s && s.command) revive.set(k, s)
  } catch {
    // nothing kept: start empty
  }
}

// Queues the skills one after another without waiting for them; the engine runs
// each once the session is idle, so a prompt submitted next comes after them all.
// Resolves when every run has settled.
async function reviveSkills($, list) {
  const listed = (await $.command.list()).map((c) => c.name)
  // The name as noted, else the same skill under or without a plugin prefix
  const find = (cmd) => {
    const bare = cmd.split(':').pop()
    return listed.find((n) => n === cmd) || listed.find((n) => (!cmd.includes(':') || !n.includes(':')) && n.split(':').pop() === bare)
  }
  const runs = list.map((s) => {
    const cmd = find(s.command)
    return cmd ? $.command.run({ command: cmd, args: s.args }).then(() => '', () => s.command) : Promise.resolve(s.command)
  })
  return async () => {
    const failed = (await Promise.all(runs)).filter(Boolean)
    if (failed.length) $.ui.toast('Could not turn on again: /' + failed.join(', /'), { timeoutMs: 8000 })
  }
}

// The handoff flow. When /session-handoff runs (the band's button, /handoff, a
// typed command, or Claude calling the skill), the answer of the turn it starts
// is captured and saved to a file. "clear and continue" then runs /clear and
// sends the handoff as the fresh chat's first prompt.
// The answer is also kept as the folder's "latest" handoff (latest-*.json), so
// "continue" still works after a restart for LATEST_HOURS. Using it, or sending a
// new message in the chat that made it, marks it as used.
const HANDOFF_SKILL = /(^|:)session-handoff$/
const HANDOFF_HEADING = '# Session Handoff'
const HEADING_LINE = new RegExp('^' + HANDOFF_HEADING, 'm')
const HANDOFF_MIN = 200 // characters: a shorter text cannot hold the skill's sections
const H = {
  armed: false,
  notTurn: '', // a turn already running when the handoff was queued: not the handoff's
  draft: '', // the last handoff a response of the armed turn ended with
  // once the handoff is in: 'ask' (/handoff) offers to clear and continue,
  // 'clear' (the band's button) does it, 'none' leaves the chat as it is
  after: 'none',
  text: '',
  path: '',
  fid: '', // id of the latest-*.json entry this handoff came from or went to
  at: 0, // when it was made
  fromDisk: false, // loaded from latest-*.json, not made in this chat
  continuing: false,
  clearDue: false, // the handoff is in and this chat clears and continues next
}

// Soft landing: a handoff asked for while Claude works waits for the turn to
// end. That turn is asked once, after its next batch of tools, to wind down at
// a safe point. It is never stopped on its own: a turn that runs long past the
// note gets a "stop now" on the band, for the person to press.
const LANDING_NOTE = 'Cache Keeper: the user asked for a session handoff. It runs as soon as this turn ends. Wind down now: finish or safely pause the current step, start no new work, leave nothing half-written (save or commit work in progress the way this project expects), then end this turn with a two-line status of where things stand.'
const LANDING_STEPS = 3 // model requests after the note before the band offers "stop now"
const LANDING_TOKENS = 40000 // or this much context growth since the press
const L = {
  at: 0,
  ctx0: 0, // context size at the press
  noted: false,
  steps: 0, // model requests since the note
}

// The handoff is queued behind the running turn (its notTurn), and still armed
function landing() {
  return H.armed && S.working && !!H.notTurn && S.turnId === H.notTurn
}

function startLanding() {
  Object.assign(L, { at: now, ctx0: S.ctx, noted: false, steps: 0 })
}

// How much the context grew since the press
function landingGrowth() {
  return Math.max(0, S.ctx - L.ctx0)
}

function landingOverdue() {
  return landing() && L.noted && (L.steps >= LANDING_STEPS || landingGrowth() >= LANDING_TOKENS)
}

// After a request of the landing turn: the band's figures and "stop now" redraw
// now, not at the next heartbeat
function landed($, result) {
  if (landing()) $.ui.invalidate('ui.render')
  return result
}

// Prompts that came while the chat was about to clear: a turn they started in
// this chat would keep /clear from running. They go on after the handoff.
const held = []

// Armed, it holds only while the handoff is queued or running: an arm left over
// from a handoff that never ran must not swallow every later message
function holdsPrompts() {
  return (H.armed && H.after === 'clear' && (handoffPending || S.working)) || H.clearDue
}

// What cannot be sent again as it came passes the hold: a command, attachments,
// @file mentions (a plugin's prompt does not expand them), and a prompt the
// person does not see as typed
function canHold(e) {
  if (!e.origin || e.origin.kind === 'plugin' || e.command || e.isMeta) return false
  if (e.attachments && e.attachments.length) return false
  return !/(^|\s)@\S/.test(String(e.text || ''))
}

// A notification delivered into the running turn starts no turn, so it cannot
// keep /clear from running. Only the handoff's own turn must not take one in.
// What the person typed over a turn may still wait for a turn of its own.
function joinsOtherTurn(e, fromUser) {
  return !fromUser && S.working && !!e.turnId && e.turnId === S.turnId && !isHandoffTurn(e.turnId)
}

// Sends the held prompts in the order they came; one that cannot be sent goes
// to the prompt box rather than being lost. Never throws.
async function releaseHeld($) {
  for (const p of held.splice(0)) {
    try {
      await $.prompt.submit(p)
    } catch {
      let filled = false
      try {
        filled = !!(await $.prompt.fill({ text: p.text, mode: 'append' })).isFilled
      } catch {
        filled = false
      }
      $.ui.toast(filled ? 'A held message is in the prompt box: press Enter to send it.' : 'A held message could not be sent: ' + clip(p.text, 80), { timeoutMs: 10000 })
    }
  }
}

// Every way out of a handoff or a clear ends here: what was held goes on once
// nothing holds it any more (a second handoff may still be on its way)
async function settleHold($) {
  if (!holdsPrompts() && held.length) await releaseHeld($)
}

// Armed again inside the turn the arm is for (the skill called twice in it), or
// the one the band's handoff queued behind, the arm keeps a clear it already
// had and the handoff this turn already wrote. Until its capture, an arm with
// no notTurn is for the running turn.
function armHandoff(insideTurn, after = 'none') {
  const again = insideTurn && H.armed && (H.notTurn === '' || H.notTurn === S.turnId)
  if (!(again && H.after === 'clear')) H.after = after
  if (!again) H.draft = ''
  H.armed = true
  H.notTurn = insideTurn ? '' : S.working ? S.turnId : ''
}

// The turn whose answer is the handoff: an armed one other than notTurn
function isHandoffTurn(turnId) {
  return H.armed && turnId !== H.notTurn
}

// The handoff without any preamble Claude put before its heading. The heading
// starts a line: one quoted inside a sentence is not it.
function handoffBody(answer) {
  const text = String(answer || '').trim()
  const m = HEADING_LINE.exec(text)
  return m ? text.slice(m.index) : text
}

// Only an answer with the skill's heading, long enough to hold its sections,
// is a handoff: a short reply that repeats the heading line is not
function isHandoff(body) {
  return body.startsWith(HANDOFF_HEADING) && body.length >= HANDOFF_MIN
}

// A Stop hook that blocks the turn makes Claude answer again in the same turn,
// and turn.complete carries only the last answer: keep the last handoff a
// response of the armed turn ended with (a reply without the heading leaves it,
// a rewritten handoff replaces it). A response cut off before its end
// (max_tokens, an interrupt) is no handoff.
function noteHandoffStep(e, result) {
  if (!isHandoffTurn(e.turnId) || result.stopReason !== 'end_turn') return
  const body = handoffBody(result.answer)
  if (isHandoff(body)) H.draft = body
}

function fileStamp(ms) {
  const d = new Date(ms)
  const two = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`
}

// How long a saved handoff stays eligible for "continue", also after a restart
const LATEST_HOURS = 12
const LATEST_MAX_AGE = LATEST_HOURS * 60 * MIN

function handoffProject() {
  return basename(S.cwd).replace(/[^A-Za-z0-9-]+/g, '-') || 'session'
}

function handoffFile(name) {
  return `${home || '.'}/.claude/mods-data/cache-keeper/handoffs/${name}`.replace(/\\/g, '/')
}

// One latest handoff per folder (keyed by the full cwd, so two folders called
// alike do not share one), overwritten on each save. '' without a cwd.
function latestPath() {
  const cwd = String(S.cwd || '').toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '')
  if (!cwd) return ''
  let h = 5381
  for (const ch of cwd) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0
  return handoffFile(`latest-${h.toString(16)}.json`)
}

// The dated file and the latest copy are written independently: one failing
// must not lose the other. Never throws.
async function saveHandoff($, text) {
  let path = handoffFile(`${fileStamp(now)}-${handoffProject()}-${S.id.slice(0, 8)}.md`)
  try {
    await $.fs.write(path, text + '\n')
  } catch {
    path = ''
  }
  const fid = `${S.id}:${now}`
  let latest = false
  const file = latestPath()
  if (file) {
    try {
      await $.fs.write(file, JSON.stringify({ at: now, fid, path, text }))
      latest = true
    } catch {
      latest = false
    }
  }
  return { path, fid: latest ? fid : '', latest }
}

// Marks the latest handoff as used. fid is the entry the caller holds: a newer
// handoff another chat saved since is left alone.
async function dropLatestHandoff($, fid) {
  try {
    const file = latestPath()
    if (!file || !(await $.fs.exists(file))) return
    let current = null
    try {
      current = JSON.parse(await $.fs.read(file))
    } catch {
      // unreadable: nothing worth keeping, mark it
    }
    if (current && current.fid !== fid) return
    await $.fs.write(file, JSON.stringify({ at: 0 }))
  } catch {
    $.ui.toast(`Could not mark the latest handoff as used: it may be offered again for up to ${LATEST_HOURS} hours.`, { timeoutMs: 8000 })
  }
}

// Makes H hold the folder's latest handoff when this chat made none of its own.
// Resolves to '' when a handoff is ready, else to the reason, as a sentence.
async function loadLatestHandoff($) {
  if (H.text && !H.fromDisk) return ''
  const file = latestPath()
  if (!file) return 'No folder is known for this chat, so there is no saved handoff.'
  let saved = null
  try {
    if (await $.fs.exists(file)) saved = JSON.parse(await $.fs.read(file))
  } catch {
    return 'The latest handoff file could not be read. The dated copies are in ~/.claude/mods-data/cache-keeper/handoffs.'
  }
  H.text = ''
  H.path = ''
  H.fid = ''
  H.fromDisk = false
  if (!saved) return 'No handoff is saved for this folder.'
  if (!saved.at) return 'The last handoff was already used or is out of date.'
  const where = saved.path ? ` It is saved at ${saved.path}.` : ''
  if (typeof saved.text !== 'string' || saved.text.length < HANDOFF_MIN) return 'The saved handoff is incomplete.' + where
  if (now - saved.at > LATEST_MAX_AGE) return `The last handoff is older than ${LATEST_HOURS} hours.` + where
  H.text = saved.text
  H.path = saved.path || ''
  H.fid = saved.fid || ''
  H.at = saved.at
  H.fromDisk = true
  return ''
}

async function captureHandoff($, e) {
  H.armed = false
  H.notTurn = ''
  const after = H.after
  H.after = 'none'
  // An interrupted turn keeps its handoff, but nothing follows on its own
  const ended = e.reason === 'answer'
  // The final answer counts when no step of the turn held a handoff
  const body = H.draft || (ended ? handoffBody(e.answer) : '')
  // An answer that is no handoff (a reply after a Stop hook, an ordinary turn
  // a leftover arm caught) never replaces a saved handoff
  if (!isHandoff(body)) {
    // A clear an earlier handoff made due still happens, with that handoff
    if (H.clearDue) {
      $.ui.toast('The handoff turn ended without a handoff. Clearing this chat and continuing with the earlier one.', { timeoutMs: 8000 })
      clearAndContinueLater($, 300, true)
      return
    }
    $.ui.toast('The handoff turn ended without a handoff, so nothing was saved.', { timeoutMs: 8000 })
    await settleHold($)
    return
  }
  const clearing = ended && after === 'clear'
  // Set before the first await: the hold must not lapse while the files are
  // written. A later /handoff decides too: one that only asks ends the hold.
  H.clearDue = clearing
  H.text = body
  H.fromDisk = false
  H.at = now
  const saved = await saveHandoff($, body)
  H.path = saved.path
  H.fid = saved.fid
  const where = saved.path ? `Handoff saved to ${saved.path}.` : 'Handoff captured (the backup file could not be written).'
  const lost = saved.latest ? '' : ' It will not survive a restart: the latest copy could not be written.'
  if (clearing) {
    // Off the hook too: /clear must not run inside the ending turn
    $.ui.toast(`${where}${lost} Clearing this chat and continuing with it.`, { timeoutMs: 8000 })
    clearAndContinueLater($, 300, true)
    return
  }
  // Nothing clears: what was held while the handoff ran goes on in this chat
  await settleHold($)
  $.ui.toast(`${where}${lost} Press c on the band or type /${names.handoff} continue to clear and continue.`, { timeoutMs: 15000 })
  // Off the hook: the turn is ending, and a dialog would hold it open. The
  // Desktop app shows no dialog asked between turns, so there the band's
  // "clear and continue" button is the way on.
  if (ended && after === 'ask' && !(await inApp($))) $.clock.after(300, () => offerContinue($).catch(() => {}))
}

async function inApp($) {
  try {
    // A terminal with a phone or Remote Control attached still shows the dialog
    return !(await $.session.surfaces()).includes('terminal')
  } catch {
    return false
  }
}

async function offerContinue($) {
  if (!H.text) return
  let answer = ''
  try {
    answer = await $.ui.ask('Handoff saved. Clear this chat and continue with it in a fresh context?', ['Clear and continue', 'Keep this chat'])
  } catch {
    return // dismissed: the band button and /handoff continue still work
  }
  if (answer === 'Clear and continue') await clearAndContinue($)
}

function continuationPrompt() {
  const where = H.path ? ` (saved at ${H.path})` : ''
  return `Handoff from my previous session${where}:\n\n${H.text}`
}

// Whether there is a handoff to send now; toasts why not. A handoff loaded from
// disk may have been used or aged out since: the band button comes here without
// going through continueRequest.
async function handoffReady($) {
  now = await $.clock.now()
  const why = await loadLatestHandoff($)
  if (why) {
    $.ui.invalidate('ui.render')
    $.ui.toast(why, { timeoutMs: 8000 })
    return false
  }
  if (!H.text) {
    $.ui.toast(`No handoff ready. Press h on the band or type /${names.handoff} first.`, { timeoutMs: 8000 })
    return false
  }
  if (S.working) {
    $.ui.toast('Claude is still working. Clear and continue once this turn ends.', { timeoutMs: 8000 })
    return false
  }
  return true
}

async function clearAndContinue($) {
  if (H.continuing) return
  // A turn began before the clear (one the hold could not stop): the clear
  // waits for it, and turn.complete calls again
  if (H.clearDue && S.working) {
    $.ui.toast('Clear and continue waits for this turn to end.', { timeoutMs: 8000 })
    return
  }
  // Claimed before the first await: two presses must not both get past the check
  H.continuing = true
  $.ui.invalidate('ui.render')
  try {
    await clearAndSend($)
  } finally {
    H.continuing = false
    H.clearDue = false
    $.ui.invalidate('ui.render')
    // After the handoff, so the fresh chat reads it first
    await settleHold($)
  }
}

// The clear and the send. Every way out, a throw too, goes through
// clearAndContinue's finally.
async function clearAndSend($) {
  if (!(await handoffReady($))) return
  const text = continuationPrompt()
  const path = H.path
  const fid = H.fid
  const again = REVIVE_ORDER.filter((k) => revive.has(k)).map((k) => revive.get(k))
  try {
    await $.command.run({ command: 'clear', args: '' })
  } catch (err) {
    $.ui.toast('Could not run /clear: ' + clip(String((err && err.message) || err), 100) + (path ? ` The handoff is saved at ${path}.` : ''), { timeoutMs: 10000 })
    return
  }
  H.text = ''
  H.path = ''
  H.fid = ''
  H.fromDisk = false
  try {
    const revived = again.length ? await reviveSkills($, again).catch(() => null) : null
    // Runs the plugin starts itself skip the command.run hook: note them here,
    // or the next "clear and continue" would turn nothing on again
    for (const s of again) noteSkill(s.command, s.args)
    await saveRevive($)
    await $.prompt.submit({ text, asUser: true })
    // Only a delivered handoff is used up: a failed send stays available
    await dropLatestHandoff($, fid)
    if (revived) revived().catch(() => {})
  } catch {
    // Not sent: leave it in the prompt box for one Enter
    let filled = false
    try {
      filled = !!(await $.prompt.fill({ text })).isFilled
    } catch {
      filled = false
    }
    $.ui.toast(filled ? 'Cleared. The handoff is in the prompt box: press Enter to send it.' : `Cleared, but the handoff could not be sent.${path ? ` It's saved at ${path}.` : ''}`, { timeoutMs: 10000 })
  }
}

function isClearArg(args) {
  return String(args || '').trim().toLowerCase() === 'clear'
}

function isContinueArg(args) {
  return /^(continue|go)$/.test(String(args || '').trim().toLowerCase())
}

// /handoff continue and /session-handoff continue: the reply says what will happen
async function continueRequest($) {
  if (H.continuing) return { text: 'Already clearing this chat.' }
  now = await $.clock.now()
  const why = await loadLatestHandoff($)
  if (why) return { text: `${why} Type /${names.handoff} to make one.` }
  if (S.working) return { text: 'Claude is still working. Run it again once this turn ends.' }
  clearAndContinueLater($, 50)
  return { text: 'Clearing this chat and continuing with the last handoff.' }
}

// Off the calling hook: /clear must not run inside it. due: the clear the
// handoff made due, which a run scheduled earlier may have done already.
function clearAndContinueLater($, ms, due = false) {
  $.clock.after(ms, () => {
    if (due && !H.clearDue) return
    clearAndContinue($).catch((err) => $.ui.toast('Could not clear and continue: ' + clip(String((err && err.message) || err), 100), { timeoutMs: 8000 }))
  })
}

// Runs the /session-handoff skill as if you typed it. The engine queues it
// until Claude finishes the current turn. after: what follows once the handoff
// is in (see H.after).
async function runHandoff($, after = 'none') {
  // One handoff at a time. The last press or /handoff decides what follows it.
  // An arm while idle is left over from a handoff that never ran: start anew.
  if (handoffPending || (H.armed && S.working)) {
    H.after = after
    $.ui.toast(`Session handoff is already ${handoffPending ? 'queued' : 'running'}.${after === 'clear' ? ' The chat clears and continues once it is in.' : ''}`)
    return
  }
  try {
    const commands = await $.command.list()
    const cmd = commands.find((c) => c.name === 'session-handoff') || commands.find((c) => HANDOFF_SKILL.test(c.name))
    if (!cmd) {
      $.ui.toast('No /session-handoff skill in this session.', { timeoutMs: 8000 })
      return
    }
    handoffPending = true
    armHandoff(false, after)
    now = await $.clock.now()
    startLanding()
    $.ui.invalidate('ui.render')
    $.ui.toast(S.working ? 'Session handoff queued: it runs when Claude finishes this turn.' : 'Running /session-handoff.')
    await $.command.run({ command: cmd.name, args: '' })
  } catch (err) {
    H.armed = false
    $.ui.toast('Could not start /session-handoff: ' + clip(String((err && err.message) || err), 100), { timeoutMs: 8000 })
    await settleHold($)
  } finally {
    handoffPending = false
    $.ui.invalidate('ui.render')
  }
}

// "stop now" on the band: the person ends the turn the handoff waits for
async function stopLanding($) {
  if (!landing()) return
  try {
    await $.turn.abort({ turnId: H.notTurn })
  } catch (err) {
    $.ui.toast('Could not stop this turn: ' + clip(String((err && err.message) || err), 100), { timeoutMs: 8000 })
  }
}

function ttlMin() {
  return settings.ttlMin || S.ttlMin
}

// Plan limit windows as the API reports them: five_hour, seven_day, spend_limit
const LIMIT_LABEL = { five_hour: '5h', seven_day: 'week', spend_limit: 'spend' }

function limitsText(limits) {
  return limits.map((l) => `${LIMIT_LABEL[l.kind] || l.kind} ${Math.round(l.percentUsed || 0)}%`).join(' · ')
}

function limitTone(limits, extra) {
  const top = Math.max(...limits.map((l) => l.percentUsed || 0))
  if (top >= 95) return { ...extra, color: 'red', bold: true }
  if (top >= 80) return { ...extra, color: 'yellow' }
  return { ...extra, dimColor: true }
}

// Context size colour: green to 200k, yellow to 400k, orange to 600k, red from 600k, bold red from 800k
function ctxLevel(n) {
  return n >= 800000 ? 4 : n >= 600000 ? 3 : n >= 400000 ? 2 : n >= 200000 ? 1 : 0
}
function ctxTone(n, extra = {}) {
  const level = ctxLevel(n)
  return { ...extra, color: ['green', 'yellow', '#ff8700', 'red', 'red'][level], ...(level === 4 ? { bold: true } : {}) }
}

// Desktop band: native text, each figure with a small gauge beside it, so a
// narrow window wraps the band instead of shrinking it to an unreadable strip
const HUE = { green: '#3fb950', yellow: '#d29922', orange: '#f0883e', red: '#f85149', cyan: '#39c5cf' }
const CTX_MAX = 1000000
function ctxHue(n) {
  return [HUE.green, HUE.yellow, HUE.orange, HUE.red, HUE.red][ctxLevel(n)]
}
function limitHue(p) {
  return p >= 95 ? HUE.red : p >= 80 ? HUE.yellow : p >= 50 ? HUE.cyan : HUE.green
}
function gaugeSvg(Svg, frac, fill, alt, ticks = []) {
  const w = 64, h = 8
  const f = Math.max(0, Math.min(1, frac))
  const out = [`<rect x="0" y="1" width="${w}" height="6" rx="3" fill="#8b949e" fill-opacity=".22"/>`]
  if (f > 0) out.push(`<rect x="0" y="1" width="${Math.max(6, w * f).toFixed(1)}" height="6" rx="3" fill="${fill}"/>`)
  for (const t of ticks) out.push(`<rect x="${(w * t).toFixed(1)}" y="0" width="1" height="8" fill="#8b949e" fill-opacity=".45"/>`)
  return Svg({ source: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${out.join('')}</svg>`, width: w, height: h, alt })
}

// The menu the band's cache chip opens: keep warm for a while, or stop it
let cacheMenu = false
const KEEP_WARM_PICKS = [1, 4, 8]

function setCacheMenu($, open) {
  cacheMenu = open
  $.ui.invalidate('ui.render')
}

// A band button that turns keep warm on or off; the menu shuts after it
const keepWarmPress = ($, fn) => async () => {
  now = await $.clock.now()
  fn()
  cacheMenu = false
  await heartbeat($, true)
  $.ui.invalidate('ui.render')
}

function cacheMenuRow($, { Box, Text, Button }) {
  const items = KEEP_WARM_PICKS.map((h, i) =>
    Button({ key: 'kw-' + h, label: `${S.keepWarm ? 'warm until' : 'keep warm'} ${h} h`, hotkey: String(i + 1), plain: true, onPress: keepWarmPress($, () => startKeepWarm($, h)) }),
  )
  if (S.keepWarm) items.push(Button({ key: 'kw-off', label: 'stop keep warm', hotkey: '0', plain: true, onPress: keepWarmPress($, () => stopKeepWarm($, 'turned off')) }))
  items.push(Text({ dimColor: true, children: [`window ${ttlMin()} min · a ping costs a cache read`] }))
  items.push(Button({ key: 'cache-close', label: 'close', plain: true, dimColor: true, onPress: () => setCacheMenu($, false) }))
  return Box({ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 3, children: items })
}

// What the band's handoff button does after the handoff: 'clear' or 'none'
let handoffAfter = 'clear'

// What a tag turns on in the fresh chat when this one never ran it; a tag
// turned off keeps its last run here for when it is turned on again
const REVIVE_DEFAULT = { caveman: { command: 'caveman', args: 'ultra' }, jev: { command: 'jev:on', args: '' }, lsp: { command: 'navigating-code-with-lsp', args: '' } }
const parked = new Map()

async function toggleRevive($, k) {
  if (revive.has(k)) {
    parked.set(k, revive.get(k))
    revive.delete(k)
  } else revive.set(k, parked.get(k) || REVIVE_DEFAULT[k])
  await saveRevive($)
  $.ui.invalidate('ui.render')
}

// Below this many columns the desktop band shortens its labels
const NARROW_COLUMNS = 96

// The band on a surface with Select (desktop, editor): row one is the cache and
// the limits, row two the rewrite cost and the handoff with what follows a clear
function deskBand($, e, { Box, Text, Button, Select, Svg }, { st, ttl, big, figure }) {
  const narrow = ((e.viewport && e.viewport.columns) || 200) < NARROW_COLUMNS
  const row = (key, children, gap = 3) => Box({ key, flexDirection: 'row', alignItems: 'center', columnGap: gap, children: children.filter(Boolean) })
  const line = (key, left, right) => Box({ key, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', width: '100%', columnGap: 3, rowGap: 1, children: [left, right] })

  let cache
  if (st.kind === 'kept') cache = Text({ color: 'cyan', children: [narrow ? `◆ until ${clock(S.keepWarmUntil)}` : `◆ kept warm until ${clock(S.keepWarmUntil)}`] })
  else if (st.kind === 'warm') cache = Text({ color: 'green', children: [narrow ? `● ${minutes(st.left)}` : `● cache warm ${minutes(st.left)}`] })
  else if (st.kind === 'cooling') cache = Text({ color: 'yellow', bold: true, children: [narrow ? `◐ ${minutes(st.left)}` : `◐ cache cools in ${minutes(st.left)}`] })
  else if (st.kind === 'cold') cache = Text({ ...(big ? { color: 'red', bold: true } : { dimColor: true }), children: [narrow ? `○ ${minutes(-st.left)}` : `○ cache cold ${minutes(-st.left)}`] })
  else cache = Text({ dimColor: true, children: ['○ cache'] })
  const keepWarm = Select({
    key: 'keep-warm',
    label: 'keep warm',
    value: S.keepWarm ? String(S.keepWarmHours) : 'off',
    // A run started elsewhere (the board, settings) may last hours the picks lack
    options: [{ value: 'off', label: 'off' }, ...[...new Set([...KEEP_WARM_PICKS, ...(S.keepWarm ? [S.keepWarmHours] : [])])].sort((a, b) => a - b).map((h) => ({ value: String(h), label: `${h} h` }))],
    onSelect: (v) => {
      // A ui.select hook above may hand over a value no option has
      const hours = Number(v)
      if (v === 'off' || (Number.isFinite(hours) && hours > 0)) keepWarmPress($, () => (v === 'off' ? stopKeepWarm($, 'turned off') : startKeepWarm($, hours)))()
    },
  })
  const figures = [figure(Text(ctxTone(S.ctx, { children: [`ctx ${tokens(S.ctx)}`] })), Svg && gaugeSvg(Svg, S.ctx / CTX_MAX, ctxHue(S.ctx), `context ${tokens(S.ctx)}`, [0.2, 0.4, 0.6, 0.8]))]
  for (const l of S.rateLimits) {
    const p = l.percentUsed || 0
    const name = LIMIT_LABEL[l.kind] || l.kind
    const shown = narrow && name === 'week' ? 'wk' : name
    figures.push(figure(Text(limitTone([l], { children: [`${shown} ${Math.round(p)}%`] })), Svg && gaugeSvg(Svg, p / 100, limitHue(p), `${name} limit ${Math.round(p)}% used`)))
  }

  const cost = money(rewriteCost(S.ctx, S.model, ttl), narrow)
  const rewrite = st.kind === 'cold' && big ? Text({ color: 'red', children: [`next send rewrites ≈ ${cost}`] }) : Text({ dimColor: true, children: [`rewrite ≈ ${cost}`] })
  const restarts = S.coldRestarts.length && Text({ dimColor: true, children: [`${S.coldRestarts.length} cold restart${S.coldRestarts.length === 1 ? '' : 's'} ${money(S.coldRestarts.reduce((a, c) => a + c.usd, 0), narrow)}`] })

  // Each tag says whether the fresh chat turns it on again; a click flips that.
  // A desktop draws a Button natively and drops its children's colors, so the
  // green dot stands beside the button, not inside it
  const tags = REVIVE_ORDER.map((k) => {
    const on = revive.has(k)
    const level = k === 'caveman' && on && revive.get(k).args
    const name = k === 'caveman' ? (narrow ? 'cave' : level ? `caveman ${level}` : 'caveman') : k
    return row('tag-group-' + k, [
      Text(on ? { color: 'green', children: ['●'] } : { dimColor: true, children: ['○'] }),
      Button({ key: 'tag-' + k, label: name, plain: true, dimColor: !on, onPress: () => toggleRevive($, k) }),
    ], 0)
  })
  // This chat's written handoff takes the split button's place, so the row keeps
  // its width and never wraps into a third line; the next message makes it stale
  // anyway. One loaded from an earlier chat stays for hours: it goes beside the
  // pair, which this chat still needs for a handoff of its own.
  const cont = (H.text || H.continuing) && Button({ key: 'continue', label: H.continuing ? 'clearing' : 'clear and continue', plain: true, onPress: () => clearAndContinue($) })
  let handoff
  if (cont && !H.fromDisk) handoff = cont
  else {
    const running = H.armed && S.working
    const label = landing() ? `handoff landing · ${minutes(now - L.at)} · +${tokens(landingGrowth())}` : handoffPending ? 'handoff queued' : running ? 'handoff running' : 'handoff'
    // No gap and stretched: the button and its Select read as one split button
    handoff = Box({ key: 'handoff-group', flexDirection: 'row', alignItems: 'stretch', columnGap: 0, children: [
      Button({ key: 'handoff', label, plain: true, dimColor: handoffPending || running, onPress: () => runHandoff($, handoffAfter) }),
      Select({
        key: 'handoff-after',
        value: handoffAfter,
        options: [{ value: 'clear', label: 'then clear' }, { value: 'none', label: 'keep chat' }],
        onSelect: (v) => {
          handoffAfter = v === 'none' ? 'none' : 'clear'
          // A handoff already queued or running follows the new pick, as a second press would
          if (handoffPending || running) H.after = handoffAfter
          $.ui.invalidate('ui.render')
        },
      }),
    ] })
  }
  const actions = row('actions', [
    row('tags', [!narrow && Text({ dimColor: true, children: ['after clear'] }), ...tags], 2),
    landingOverdue() && Button({ key: 'stop', plain: true, onPress: () => stopLanding($), children: [Text({ color: 'yellow', children: ['stop now'] })] }),
    handoff !== cont && cont,
    handoff,
  ])
  return [
    line('state', row('cache-group', [cache, keepWarm], 2), row('figures', figures)),
    line('handoff-line', row('costs', [rewrite, restarts]), actions),
  ]
}

// Dollars shown as plan-limit percent. The API reports only how full each limit
// window is; the session ledger only counts dollars. The percent-per-dollar rate
// is learned: what this machine's sessions spent while a window moved, kept in
// $.store so later sessions start calibrated. Spend elsewhere (claude.ai, another
// machine) moves the windows too, so the rate reads high rather than low.
const CAL_KEY = 'pctPerUsd'
const CAL_MIN_USD = 1 // spend and a whole point of movement before a sample counts
let cal = {} // window kind -> percent per dollar
const calAcc = {} // window kind -> { usd, pct, lastPct }
const seenCost = new Map() // session id -> last cost seen on the board

async function calibrate($) {
  let spent = 0
  for (const hb of fleet) {
    if (hb.stale || !hb.id) continue
    const cost = hb.costUsd || 0
    const prev = seenCost.get(hb.id)
    seenCost.set(hb.id, cost)
    if (prev !== undefined && cost > prev) spent += cost - prev
  }
  let changed = false
  for (const l of S.rateLimits) {
    const pct = l.percentUsed || 0
    const a = calAcc[l.kind]
    // a new window, or the first reading: start counting from here
    if (!a || pct < a.lastPct) {
      calAcc[l.kind] = { usd: 0, pct: 0, lastPct: pct }
      continue
    }
    a.usd += spent
    a.pct += pct - a.lastPct
    a.lastPct = pct
    if (a.usd >= CAL_MIN_USD && a.pct >= 1) {
      const sample = a.pct / a.usd
      cal[l.kind] = cal[l.kind] ? 0.7 * cal[l.kind] + 0.3 * sample : sample
      a.usd = 0
      a.pct = 0
      changed = true
    }
  }
  if (changed) await $.store.set(CAL_KEY, cal)
}

function pctOf(v, kind) {
  const p = (Number(v) || 0) * cal[kind]
  if (p === 0) return '0%'
  if (p < 0.1) return '<0.1%'
  return (p < 10 ? p.toFixed(1) : String(Math.round(p))) + '%'
}

// short: the 5-hour window alone (the board's narrow column)
function money(v, short) {
  if (rec.strict) return '•••%'
  const kinds = (short ? ['five_hour'] : ['five_hour', 'seven_day']).filter((k) => cal[k])
  if (kinds.length === 0) return '?%'
  return kinds.map((k) => `${pctOf(v, k)} ${LIMIT_LABEL[k] || k}`).join(' · ')
}

function calText() {
  const known = Object.keys(cal).filter((k) => cal[k])
  if (known.length === 0) return `Limit percent per dollar: still learning (needs $${CAL_MIN_USD} of spend while a window moves a whole point), so amounts show as ?%.`
  return `Limit percent per dollar (learned, approximate): ${known.map((k) => `${LIMIT_LABEL[k] || k} ${cal[k].toFixed(2)}%/$`).join(', ')}.`
}

function msLeft(lastActivity, ttl) {
  if (!lastActivity) return null
  return ttl * MIN - (now - lastActivity)
}

function cacheState(hb) {
  const left = msLeft(hb.lastActivity, hb.ttlMin)
  if (left === null) return { kind: 'unknown', left: 0 }
  if (hb.keepWarm) return { kind: 'kept', left }
  if (left <= 0) return { kind: 'cold', left }
  if (left <= 5 * MIN) return { kind: 'cooling', left }
  return { kind: 'warm', left }
}

function myHeartbeat() {
  const coldUsd = S.coldRestarts.reduce((a, c) => a + c.usd, 0)
  let state = 'idle'
  if (S.waitingSince && now - S.waitingSince > 5000) state = 'waiting'
  else if (S.working) state = 'working'
  return {
    id: S.id,
    label: S.label,
    cwd: S.cwd,
    model: S.model,
    state,
    waitingFor: S.waitingFor,
    tool: S.tool,
    ctx: S.ctx,
    window: S.window,
    ttlMin: ttlMin(),
    lastActivity: S.lastActivity,
    keepWarm: S.keepWarm,
    keepWarmUntil: S.keepWarmUntil,
    pings: S.pings,
    pingUsd: S.pingUsd,
    costUsd: S.costUsd,
    coldCount: S.coldRestarts.length,
    coldUsd,
    agentsRunning: S.agentsRunning,
    lastTurnEnd: S.lastTurnEnd,
    updatedAt: now,
  }
}

async function registerCommand($, name, description, argumentHint, immediate) {
  const spec = immediate ? { name, description, argumentHint, immediate: true } : { name, description, argumentHint }
  try {
    await $.command.register(spec)
    return name
  } catch {
    try {
      await $.command.register({ ...spec, name: 'ck-' + name })
      return 'ck-' + name
    } catch {
      return null
    }
  }
}

async function readRecording($) {
  try {
    const path = (home || '.') + '/.claude/mods-data/recording.json'
    if (!(await $.fs.exists(path))) {
      rec = { on: false, strict: false }
    } else {
      const flag = JSON.parse(await $.fs.read(path))
      rec = { on: !!flag.on, strict: !!flag.on && !!flag.strict }
    }
  } catch {
    rec = { on: false, strict: false }
  }
  mask = rec.on ? makeMasker({ strict: rec.strict }) : (s) => s
}

async function heartbeat($, force) {
  if (!S.id) return
  if (!force && now - lastHeartbeat < 5000) return
  lastHeartbeat = now
  try {
    const agents = await $.agent.list()
    S.agentsRunning = agents.filter((a) => a.status === 'running').length
  } catch {
    // agent list unavailable: keep the last count
  }
  await $.store.set('hb:' + S.id, myHeartbeat())
}

async function readFleet($) {
  const keys = (await $.store.keys()).filter((k) => k.startsWith('hb:'))
  const list = []
  for (const k of keys) {
    const hb = await $.store.get(k)
    if (!hb || typeof hb !== 'object') continue
    if (hb.id === S.id) continue
    // a session that stopped heartbeating an hour ago has ended or crashed
    if (now - (hb.updatedAt || 0) > 60 * MIN) {
      await $.store.delete(k)
      continue
    }
    list.push({ ...hb, stale: now - (hb.updatedAt || 0) > 3 * MIN })
  }
  list.push({ ...myHeartbeat(), self: true })
  fleet = list
}

// Commands another session's board sent this one, through the shared store
async function applyRemoteCommands($) {
  const c = await $.store.get('cmd:' + S.id)
  if (!c) return
  await $.store.delete('cmd:' + S.id)
  if (c.keepWarm === true) startKeepWarm($, settings.keepWarmHours)
  if (c.keepWarm === false) stopKeepWarm($, 'stopped from the board')
}

function startKeepWarm($, hours) {
  S.keepWarm = true
  S.keepWarmHours = hours
  S.keepWarmUntil = now + hours * 60 * MIN
  $.ui.toast(`Keeping this cache warm until ${clock(S.keepWarmUntil)}. A ping reads the cache before it expires.`)
}

function stopKeepWarm($, why) {
  if (!S.keepWarm) return
  S.keepWarm = false
  $.ui.toast(`Keep warm off (${why}). ${S.pings} ping(s), ${money(S.pingUsd)}.`, { timeoutMs: 8000 })
}

async function keepWarmStep($) {
  if (!S.keepWarm) return
  if (now >= S.keepWarmUntil) return stopKeepWarm($, 'time limit reached')
  if (S.working || !S.lastActivity) return
  const ttl = ttlMin()
  const margin = ttl >= 60 ? 8 * MIN : 90000
  if (now - S.lastActivity < ttl * MIN - margin) return
  let reply = null
  try {
    reply = await $.model.fork({ prompt: 'cache-keeper keep-alive ping. Reply with only: ok' })
  } catch {
    reply = null
  }
  if (!reply || !reply.usage) {
    return stopKeepWarm($, 'the ping got no answer, so the cache may already be cold')
  }
  const u = reply.usage
  S.pings += 1
  S.lastPingAt = now
  S.pingUsd += requestCost(u, S.model, ttl)
  // A ping that writes instead of reading did not hit the cache: stop paying for it
  if ((u.cache_creation_input_tokens || 0) > 0.1 * Math.max(1, u.cache_read_input_tokens || 0)) {
    return stopKeepWarm($, `the ping wrote ${tokens(u.cache_creation_input_tokens)} tokens instead of reading the cache`)
  }
  S.lastActivity = now
}

function warnStep($) {
  if (!settings.alerts) return
  for (const hb of fleet) {
    if (hb.stale || hb.keepWarm || (hb.ctx || 0) < settings.bigTokens) continue
    const st = cacheState(hb)
    if (st.kind !== 'cooling') continue
    const key = 'cool:' + hb.lastActivity
    if (alerted.get(hb.id) === key) continue
    alerted.set(hb.id, key)
    const cost = money(rewriteCost(hb.ctx, hb.model, hb.ttlMin))
    const who = hb.self ? 'This session' : `"${mask(hb.label)}"`
    const how = hb.self ? `type /${names.keepwarm} or press 1` : `open /${names.board} to keep it warm`
    $.ui.toast(`${who}: ${tokens(hb.ctx)}-token cache goes cold in ${minutes(st.left)}. Rewriting it costs about ${cost}. ${how}.`, { timeoutMs: 15000 })
  }
  // Another session started waiting on a permission or a question
  for (const hb of fleet) {
    if (hb.self || hb.stale) continue
    const prev = alerted.get('state:' + hb.id)
    alerted.set('state:' + hb.id, hb.state)
    if (hb.state === 'waiting' && prev && prev !== 'waiting') {
      $.ui.toast(`"${mask(hb.label)}" is waiting on you${hb.waitingFor ? ': ' + hb.waitingFor : ''}`, { timeoutMs: 10000 })
    }
  }
}

async function tick($) {
  now = await $.clock.now()
  // A handoff loaded from a previous chat ages out of the band too
  if (H.text && H.fromDisk && now - H.at > LATEST_MAX_AGE) {
    H.text = ''
    H.path = ''
    H.fid = ''
    H.fromDisk = false
    $.ui.invalidate('ui.render')
  }
  await readRecording($)
  await applyRemoteCommands($)
  await keepWarmStep($)
  await heartbeat($, true)
  await readFleet($)
  await calibrate($)
  warnStep($)
  $.ui.invalidate('ui.render')
}

async function loadSettings($) {
  const saved = await $.store.get('settings')
  if (saved && typeof saved === 'object') Object.assign(settings, saved)
  const rates = await $.store.get(CAL_KEY)
  if (rates && typeof rates === 'object') cal = { ...rates }
}

function statusText() {
  const st = cacheState(myHeartbeat())
  const ttl = ttlMin()
  const lines = []
  lines.push(`Cache Keeper: ${tokens(S.ctx)} tokens in context on ${priceFor(S.model).id}, cache window ${ttl} min (${settings.ttlMin ? 'set by you' : S.ttlSource}).`)
  if (st.kind === 'unknown') lines.push('No request yet this session, so the cache state is unknown.')
  if (st.kind === 'warm' || st.kind === 'cooling') lines.push(`Cache is warm for about ${minutes(st.left)} more.`)
  if (st.kind === 'cold') lines.push(`Cache went cold ${minutes(-st.left)} ago. The next message rewrites it for about ${money(rewriteCost(S.ctx, S.model, ttl))}.`)
  if (S.keepWarm) lines.push(`Keep warm is on until ${clock(S.keepWarmUntil)}: ${S.pings} ping(s), ${money(S.pingUsd)} so far.`)
  if (S.rateLimits.length) lines.push(`Plan limits used: ${limitsText(S.rateLimits)}.`)
  lines.push(`Session cost so far: ${money(S.costUsd)}. Cold restarts this session: ${S.coldRestarts.length} (${money(S.coldRestarts.reduce((a, c) => a + c.usd, 0))}).`)
  lines.push(calText())
  lines.push(`Cold-send guard: ${settings.guard ? 'on' : 'off'} for contexts over ${tokens(settings.bigTokens)} tokens. Alerts: ${settings.alerts ? 'on' : 'off'}.`)
  lines.push(`Settings: /${names.cache} ttl 5|60|auto, /${names.cache} guard on|off, /${names.cache} big 150k, /${names.cache} alerts on|off. Board: /${names.board}.`)
  return lines.join('\n')
}

function parseTokens(text) {
  const m = String(text || '').trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([km]?)$/)
  if (!m) return null
  return Math.round(Number(m[1]) * (m[2] === 'm' ? 1e6 : m[2] === 'k' ? 1e3 : 1))
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    now = await $.clock.now()
    home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
    S.id = await $.session.id()
    S.cwd = await $.session.cwd()
    S.label = basename(S.cwd)
    S.model = await $.session.model()
    // A handoff saved before a restart shows up on the band and in /handoff continue
    await loadLatestHandoff($)
    await loadSettings($)
    await loadRevive($)
    await readRecording($)
    names.cache = (await registerCommand($, 'cache', 'Cache Keeper status and settings', '[ttl 5|60|auto] [guard on|off] [big 150k] [alerts on|off]')) || names.cache
    names.keepwarm = (await registerCommand($, 'keepwarm', 'Keep this session\'s prompt cache warm (default 4 hours), or /keepwarm off', '[hours|off]', true)) || names.keepwarm
    names.board = (await registerCommand($, 'board', 'Every local Claude Code session: state, context, cache, cost', '', true)) || names.board
    names.handoff = (await registerCommand($, 'handoff', 'Session handoff, then clear this chat and continue with it (/handoff continue)', '[continue]')) || names.handoff
    $.clock.every(HEARTBEAT_EVERY, () => tick($).catch(() => {}))
    await heartbeat($, true)
    return next(e)
  })

  // /clear, /resume and /branch start from an unknown cache. The process goes
  // on under a new session id, and no session.start fires for it.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    S.lastActivity = 0
    S.keepWarm = false
    H.armed = false
    // A new chat: only what runs in it counts. Clear and continue notes its own
    // revived skills, so it keeps them.
    if (!H.continuing) {
      // Cleared another way: nothing is due, and what was held goes to this chat
      H.clearDue = false
      if (held.length) $.clock.after(300, () => settleHold($))
      parked.clear()
      if (revive.size) {
        revive.clear()
        await saveRevive($)
      }
    }
    try {
      S.id = (await $.session.id()) || S.id
    } catch {
      // keep the old id
    }
    S.label = basename(S.cwd)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (S.id) await $.store.delete('hb:' + S.id)
    return next(e)
  })

  // The first prompt names the session on the board
  on('prompt.submit', async ($, e, next) => {
    // Typed in the terminal, the Desktop app or over Remote Control alike; a
    // held prompt comes back as the plugin's, so this looks before the hold
    if (e.origin && e.origin.kind !== 'plugin' && /^\s*(stop caveman|normal mode)\b/i.test(String(e.text || ''))) await noteAndSave($, 'caveman', 'off')
    const fromUser = e.origin && (e.origin.kind === 'composer' || e.origin.kind === 'bridge')
    // Typed, not picked: the band's menu shuts so its digits stay out of the way
    if (cacheMenu && fromUser) setCacheMenu($, false)
    // Clear and continue is on its way: a prompt that would start a turn here
    // (typed while the handoff ran, a notification, a peer) waits and is sent
    // after the handoff. One that passes (see canHold) starts a turn, and the
    // clear waits for it.
    if (holdsPrompts() && canHold(e) && !joinsOtherTurn(e, fromUser)) {
      held.push(fromUser ? { text: e.text, asUser: true } : { text: e.text })
      $.ui.toast('Held until this chat clears: it is sent after the handoff.', { timeoutMs: 8000 })
      return { drop: 'Held by cache-keeper until clear and continue is done' }
    }
    now = await $.clock.now()
    if (S.label === basename(S.cwd) && e.origin && e.origin.kind === 'composer' && e.text) {
      S.label = basename(S.cwd) + ' · ' + clip(e.text, 40)
    }
    // A new message in the chat that made the handoff makes it out of date: the
    // dated file stays, the latest copy is marked used. A handoff loaded from a
    // previous chat waits for its "continue" instead, and so does one this chat
    // is about to clear for.
    if (H.text && !H.fromDisk && !H.continuing && !holdsPrompts() && e.origin && e.origin.kind === 'composer' && !String(e.text || '').trim().startsWith('/')) {
      const fid = H.fid
      H.text = ''
      H.path = ''
      H.fid = ''
      await dropLatestHandoff($, fid)
      $.ui.invalidate('ui.render')
    }
    const ttl = ttlMin()
    const left = msLeft(S.lastActivity, ttl)
    const isCold = left !== null && left <= 0
    if (!settings.guard || !fromUser || !isCold || S.ctx < settings.bigTokens || e.turnId) return next(e)
    const cost = money(rewriteCost(S.ctx, S.model, ttl))
    let answer = 'Send anyway'
    try {
      answer = await $.ui.ask(
        `Cache went cold ${minutes(-left)} ago. Sending now rewrites ${tokens(S.ctx)} tokens of context (about ${cost}). What should happen?`,
        ['Send anyway', 'Compact first, then send', 'Cancel'],
      )
    } catch {
      // nobody to ask (a -p run, or the dialog was dismissed): send as typed
      return next(e)
    }
    if (answer === 'Compact first, then send') {
      try {
        await $.session.compact()
      } catch {
        // compaction refused or failed: send anyway
      }
      return next(e)
    }
    if (answer === 'Send anyway') return next(e)
    $.ui.toast('Not sent. A fresh session with a short handoff avoids the rewrite entirely.', { timeoutMs: 8000 })
    return { drop: 'Cancelled by cache-keeper before a cold cache rewrite' }
  })

  on('turn.start', async ($, e, next) => {
    // A subagent's turn is not the main loop's, and its turn.complete is skipped too
    if (e.agentId) return next(e)
    now = await $.clock.now()
    S.working = true
    if (e.turnId) S.turnId = e.turnId
    await heartbeat($, true)
    return next(e)
  })

  // Each main-loop request: is its response the handoff (one turn.step hook per
  // module), and did it read the cache, or rewrite it?
  on('turn.step', async function* ($, e, next) {
    const startedAt = await $.clock.now()
    const result = yield* next(e)
    if (e.agentId || !result) return result
    noteHandoffStep(e, result)
    if (L.noted && landing()) L.steps++
    if (!result.usage) return landed($, result)
    now = await $.clock.now()
    const u = result.usage
    const total = totalInput(u)
    const written = u.cache_creation_input_tokens || 0
    const gap = S.lastActivity ? startedAt - S.lastActivity : 0
    S.model = u.model || S.model
    const afterCompact = justCompacted
    justCompacted = false
    if (afterCompact) {
      // the first request after a compaction writes the new, shorter context: expected
    } else if (S.lastActivity && total > 30000 && written / total > 0.5) {
      // A rewrite after 5-60 idle minutes means this session runs on the 5-minute TTL
      if (!settings.ttlMin && gap > 5.5 * MIN && gap < S.ttlMin * MIN) {
        S.ttlMin = 5
        S.ttlSource = 'measured'
      }
      S.coldRestarts.push({ at: now, tokens: written, usd: rewriteCost(written, S.model, ttlMin()), gapMin: Math.round(gap / MIN) })
    } else if (S.lastActivity && total > 30000 && gap > 5.5 * MIN && cachedShare(u) > 0.8) {
      // A hit after more than 5 idle minutes proves the 1-hour TTL
      if (!settings.ttlMin) {
        S.ttlMin = 60
        S.ttlSource = 'measured'
      }
    }
    S.ctx = total
    S.lastActivity = now
    return landed($, result)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    now = await $.clock.now()
    S.working = false
    S.waitingSince = 0
    S.tool = ''
    S.lastTurnEnd = now
    try {
      const usage = await $.session.usage()
      if (usage.context && usage.context.tokens) S.ctx = usage.context.tokens
      if (usage.context && usage.context.window) S.window = usage.context.window
      if (usage.cost) S.costUsd = usage.cost.usd
      if (Array.isArray(usage.rateLimits) && usage.rateLimits.length) S.rateLimits = usage.rateLimits
    } catch {
      // usage unavailable: keep the per-request figures
    }
    if (isHandoffTurn(e.turnId)) await captureHandoff($, e)
    else if (H.clearDue && !H.continuing) clearAndContinueLater($, 300, true)
    await heartbeat($, true)
    $.ui.invalidate('ui.render')
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    justCompacted = true
    return r
  })

  on('session.measure', async ($, e, next) => {
    if (e.context && e.context.tokens) S.ctx = e.context.tokens
    if (e.context && e.context.window) S.window = e.context.window
    if (e.cost) S.costUsd = e.cost.usd
    if (Array.isArray(e.rateLimits) && e.rateLimits.length) S.rateLimits = e.rateLimits
    return next(e)
  })

  // Soft landing: the turn a handoff waits for reads the note once, with the
  // results of its next batch of tools
  on('classic.PostToolBatch', async ($, e, next) => {
    const r = await next(e)
    if (e.agent_id || L.noted || !landing()) return r
    L.noted = true
    $.ui.invalidate('ui.render')
    return { ...r, additionalContext: [...((r && r.additionalContext) || []), LANDING_NOTE] }
  })

  // Waiting on the person: a permission prompt or a question
  on('tool.check', async ($, e, next) => {
    const d = await next(e)
    if (d && d.decision === 'ask' && !S.waitingSince) {
      now = await $.clock.now()
      S.waitingSince = now
      S.waitingFor = 'permission for ' + e.tool
    }
    return d
  })

  on('tool.call', async ($, e, next) => {
    if (!e.agentId) S.tool = e.tool
    if (!e.agentId && e.tool === 'Skill') {
      const args = e.args || (e.input && e.input.args)
      // Claude calling the handoff skill itself: this turn's answer is the
      // handoff. With args "clear" (the 250k Stop hook asks for it) the chat
      // then clears and continues, as with the band's button.
      if (HANDOFF_SKILL.test(String(e.skill || ''))) armHandoff(true, isClearArg(args) ? 'clear' : 'none')
      await noteAndSave($, e.skill, args)
    }
    if (e.tool === 'AskUserQuestion') {
      now = await $.clock.now()
      S.waitingSince = now
      S.waitingFor = 'a question'
    }
    try {
      return await next(e)
    } finally {
      if (S.waitingSince) {
        S.waitingSince = 0
        S.waitingFor = ''
      }
    }
  })

  // /session-handoff from anywhere (typed, the band, /handoff): watch for its answer
  on('command.run', async ($, e, next) => {
    if (HANDOFF_SKILL.test(String(e.command || ''))) {
      // /session-handoff continue: no new handoff, clear and continue with the last one
      if (isContinueArg(e.args)) return continueRequest($)
      armHandoff(false)
    }
    await noteAndSave($, e.command, e.args)
    return next(e)
  })

  // /handoff runs the handoff and then asks to clear and continue (in the
  // terminal; the Desktop app uses the band's button); /handoff continue does
  // the second half, with this chat's handoff or the folder's last one (also
  // after a restart).
  // Both run off the hook: a command started inside a hook the session is
  // waiting on is refused.
  on('command.run', { command: ['handoff', 'ck-handoff'] }, async ($, e) => {
    now = await $.clock.now()
    if (isContinueArg(e.args)) return continueRequest($)
    $.clock.after(50, () => runHandoff($, 'ask').catch(() => {}))
    return { text: 'Running the session handoff. When it finishes, you can clear this chat and continue with it.' }
  })

  on('command.run', { command: ['cache', 'ck-cache'] }, async ($, e) => {
    now = await $.clock.now()
    const [key, value] = String(e.args || '').trim().toLowerCase().split(/\s+/)
    if (key === 'ttl') {
      settings.ttlMin = value === '5' ? 5 : value === '60' ? 60 : 0
    } else if (key === 'guard' || key === 'alerts') {
      settings[key] = value !== 'off'
    } else if (key === 'big') {
      const n = parseTokens(value)
      if (n) settings.bigTokens = n
    }
    if (key) {
      await $.store.set('settings', settings)
      $.ui.invalidate('ui.render')
    }
    return { text: statusText() }
  })

  on('command.run', { command: ['keepwarm', 'ck-keepwarm'] }, async ($, e) => {
    now = await $.clock.now()
    const arg = String(e.args || '').trim().toLowerCase()
    if (arg === 'off' || (arg === '' && S.keepWarm)) {
      stopKeepWarm($, 'turned off')
    } else {
      const hours = Number(arg) > 0 ? Math.min(24, Number(arg)) : settings.keepWarmHours
      startKeepWarm($, hours)
    }
    await heartbeat($, true)
    $.ui.invalidate('ui.render')
    return {}
  })

  on('command.run', { command: ['board', 'ck-board'] }, async ($, e) => {
    now = await $.clock.now()
    await heartbeat($, true)
    await readFleet($)
    const surface = await $.session.surface()
    if (!surface) return { text: boardText() }
    paneOpen = true
    await $.ui.open({ id: PANE, title: 'Sessions', focus: true, closeOnEscape: true })
    return {}
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) paneOpen = false
    return next(e)
  })

  // The band above the prompt: this session's cache at a glance
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props && e.props.hasSurvey) return below
    if (!S.lastActivity && !S.keepWarm) return below
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    // The terminal has no Svg: there the figures go without gauges
    const Svg = e.surface !== 'terminal' ? els.Svg : null
    const hb = myHeartbeat()
    const st = cacheState(hb)
    const ttl = ttlMin()
    const big = S.ctx >= settings.bigTokens
    // A figure as text, with its gauge beside it where the surface draws one
    const figure = (text, gauge) => (gauge ? Box({ flexDirection: 'row', alignItems: 'center', columnGap: 1, children: [text, gauge] }) : text)
    let cache
    if (st.kind === 'kept') cache = Text({ color: 'cyan', children: [`◆ kept warm · ${S.pings} ping${S.pings === 1 ? '' : 's'} ${money(S.pingUsd)} · until ${clock(S.keepWarmUntil)}`] })
    else if (st.kind === 'warm') cache = Text({ color: 'green', children: [`● cache warm ${minutes(st.left)}`] })
    else if (st.kind === 'cooling') cache = Text({ color: 'yellow', bold: true, children: [`◐ cache cools in ${minutes(st.left)}`] })
    else if (st.kind === 'cold') cache = Text(big ? { color: 'red', bold: true, children: [`○ cache cold ${minutes(-st.left)}`] } : { dimColor: true, children: [`○ cache cold ${minutes(-st.left)}`] })
    else cache = Text({ dimColor: true, children: ['○ cache'] })
    // A desktop or editor band: two fixed rows, native Selects, no hotkeys
    if (e.surface !== 'terminal' && els.Select) return Box({ flexDirection: 'column', rowGap: 1, children: [...deskBand($, e, els, { st, ttl, big, figure }), below].filter(Boolean) })
    // The cache chip opens the keep-warm menu (w while the band has the focus)
    const parts = [Button({ key: 'cache', hotkey: 'w', plain: true, onPress: () => setCacheMenu($, !cacheMenu), children: [cache, Text({ dimColor: true, children: [cacheMenu ? ' ▴' : ' ▾'] })] })]
    parts.push(figure(Text(ctxTone(S.ctx, { children: [`ctx ${tokens(S.ctx)}`] })), Svg && gaugeSvg(Svg, S.ctx / CTX_MAX, ctxHue(S.ctx), `context ${tokens(S.ctx)}`, [0.2, 0.4, 0.6, 0.8])))
    if (st.kind === 'cold' && big) parts.push(Text({ color: 'red', children: [`next send rewrites it ≈ ${money(rewriteCost(S.ctx, S.model, ttl))}`] }))
    else parts.push(Text({ dimColor: true, children: [`rewrite ≈ ${money(rewriteCost(S.ctx, S.model, ttl))}`] }))
    if (Svg) {
      for (const l of S.rateLimits) {
        const p = l.percentUsed || 0
        const name = LIMIT_LABEL[l.kind] || l.kind
        parts.push(figure(Text(limitTone([l], { children: [limitsText([l])] })), gaugeSvg(Svg, p / 100, limitHue(p), `${name} limit ${Math.round(p)}% used`)))
      }
    } else if (S.rateLimits.length) parts.push(Text(limitTone(S.rateLimits, { children: [limitsText(S.rateLimits)] })))
    parts.push(Text({ dimColor: true, children: [`session ${money(S.costUsd)}`] }))
    if (S.coldRestarts.length) parts.push(Text({ dimColor: true, children: [`${S.coldRestarts.length} cold restart${S.coldRestarts.length === 1 ? '' : 's'} ${money(S.coldRestarts.reduce((a, c) => a + c.usd, 0))}`] }))
    // One-press shortcut while the menu is shut; its 1 is the menu's first pick otherwise
    if (!cacheMenu && st.kind === 'cooling' && big) {
      parts.push(Button({ key: 'keepwarm', label: 'keep warm', hotkey: '1', plain: true, onPress: keepWarmPress($, () => startKeepWarm($, settings.keepWarmHours)) }))
    }
    const left = Box({ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 3, flexShrink: 1, children: parts.map((x, i) => Box({ key: 'p' + i, flexShrink: 0, children: [x] })) })
    // Right edge: one click runs /session-handoff (h while the band has the focus;
    // a letter never fires from the prompt box, unlike a digit), then clears this
    // chat and sends the handoff as the fresh chat's first prompt. c does that
    // last step for a handoff made another way.
    // An arm while idle is left over from a handoff that never ran: not running
    const running = H.armed && S.working
    // Waiting for the turn to wind down: how long, and how much the context grew
    const label = landing() ? `handoff landing · ${minutes(now - L.at)} · +${tokens(landingGrowth())}` : handoffPending ? 'handoff queued' : running ? 'handoff running' : 'handoff'
    const handoff = Button({ key: 'handoff', label, hotkey: 'h', plain: true, dimColor: handoffPending || running, onPress: () => runHandoff($, 'clear') })
    const buttons = [
      landingOverdue() && Button({ key: 'stop', hotkey: 's', plain: true, onPress: () => stopLanding($), children: [Text({ color: 'yellow', children: ['stop now'] })] }),
      (H.text || H.continuing) && Button({ key: 'continue', label: H.continuing ? 'clearing' : 'clear and continue', hotkey: 'c', plain: true, onPress: () => clearAndContinue($) }),
      handoff,
    ].filter(Boolean)
    const right = buttons.length > 1 ? Box({ flexDirection: 'row', columnGap: 2, children: buttons }) : handoff
    const mine = Box({ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', width: '100%', columnGap: 2, children: [left, right] })
    const rows = [mine]
    if (cacheMenu) rows.push(cacheMenuRow($, els))
    if (below) rows.push(below)
    return Box({ flexDirection: 'column', children: rows })
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    return drawBoard($, e)
  })

  // The band is terminal-only. The footer also draws in the Desktop app, so it
  // carries a short label, only when there's something to act on.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const label = footerLabel()
    if (!label) return next(e)
    const modes = Array.isArray(e.props && e.props.modes) ? e.props.modes : []
    return next({ ...e, props: { ...e.props, modes: [...modes, label] } })
  })
}

function footerLabel() {
  const parts = []
  const st = cacheState(myHeartbeat())
  const big = S.ctx >= settings.bigTokens
  if (st.kind === 'kept') parts.push('cache kept warm')
  else if (st.kind === 'cooling' && big) parts.push(`cache cools in ${minutes(st.left)} · /keepwarm`)
  else if (st.kind === 'cold' && big) parts.push(`cache cold · rewrite ≈ ${money(rewriteCost(S.ctx, S.model, ttlMin()))}`)
  const high = S.rateLimits.filter((l) => (l.percentUsed || 0) >= 80)
  if (high.length) parts.push(limitsText(high))
  if (H.text) parts.push(`handoff ready · /${names.handoff} continue`)
  return parts.join(' · ')
}

function sortFleet(list) {
  const rank = { waiting: 0, working: 1, idle: 2 }
  return [...list].sort((a, b) => {
    const r = (rank[a.state] ?? 3) - (rank[b.state] ?? 3)
    if (r !== 0) return r
    const la = msLeft(a.lastActivity, a.ttlMin) ?? Infinity
    const lb = msLeft(b.lastActivity, b.ttlMin) ?? Infinity
    return la - lb
  })
}

function cacheCell(hb) {
  const st = cacheState(hb)
  if (st.kind === 'kept') return ['kept warm', 'cyan']
  if (st.kind === 'warm') return ['warm ' + minutes(st.left), 'green']
  if (st.kind === 'cooling') return ['cools in ' + minutes(st.left), 'yellow']
  if (st.kind === 'cold') return ['cold ' + minutes(-st.left), (hb.ctx || 0) >= settings.bigTokens ? 'red' : 'gray']
  return ['–', 'gray']
}

function stateCell(hb) {
  if (hb.stale) return ['? silent', 'gray']
  if (hb.state === 'waiting') return ['⏳ waiting', 'magenta']
  if (hb.state === 'working') return ['● working', 'cyan']
  return ['○ idle', 'gray']
}

// Text props for a colour name; 'gray' draws dim, which every theme has
function tone(color, extra = {}) {
  return color === 'gray' ? { ...extra, dimColor: true } : { ...extra, color }
}

function boardText() {
  const rows = sortFleet(fleet).map((hb) => {
    const [state] = stateCell(hb)
    const [cache] = cacheCell(hb)
    return `${pad(state, 11)} ${pad(clip(mask(hb.label), 40), 41)} ${pad(tokens(hb.ctx), 6)} ${pad(cache, 13)} ${money(hb.costUsd)}${hb.agentsRunning ? '  ' + hb.agentsRunning + ' agents' : ''}${hb.self ? '  (this one)' : ''}`
  })
  return ['Sessions on this machine:', ...rows].join('\n')
}

function drawBoard($, e) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const width = Math.max(60, (e.props && e.props.bodyColumns) || 100)
  const labelWidth = Math.max(16, Math.min(44, width - 62))
  const list = sortFleet(fleet)
  const header = Text({ dimColor: true, children: [`${pad('STATE', 11)} ${pad('SESSION', labelWidth + 1)} ${pad('CONTEXT', 8)} ${pad('CACHE', 14)} ${pad('LIMIT', 9)} AGENTS`] })
  const rows = list.map((hb, i) => {
    const [state, stateColor] = stateCell(hb)
    const [cache, cacheColor] = cacheCell(hb)
    const label = clip(mask(hb.label || hb.id), labelWidth) + (hb.self ? ' ◂' : '')
    const ctx = tokens(hb.ctx) + (hb.window ? ' ' + Math.round((100 * (hb.ctx || 0)) / hb.window) + '%' : '')
    const cells = [
      Text(tone(stateColor, { children: [pad(state, 11) + ' '] })),
      Text({ bold: !!hb.self, children: [pad(label, labelWidth + 1) + ' '] }),
      Text(ctxTone(hb.ctx || 0, { children: [pad(ctx, 8) + ' '] })),
      Text(tone(cacheColor, { children: [pad(cache, 14) + ' '] })),
      Text({ children: [pad(money(hb.costUsd, true), 9) + ' '] }),
      Text({ dimColor: !hb.agentsRunning, children: [String(hb.agentsRunning || 0) + '  '] }),
    ]
    const big = (hb.ctx || 0) >= settings.bigTokens
    if (big && !hb.stale && i < 9) {
      cells.push(
        Button({
          key: 'kw-' + hb.id,
          label: hb.keepWarm ? 'stop warm' : 'keep warm',
          hotkey: String(i + 1),
          plain: true,
          dimColor: !hb.keepWarm && cacheState(hb).kind !== 'cooling',
          onPress: async () => {
            now = await $.clock.now()
            if (hb.self) {
              if (S.keepWarm) stopKeepWarm($, 'turned off')
              else startKeepWarm($, settings.keepWarmHours)
              await heartbeat($, true)
            } else {
              await $.store.set('cmd:' + hb.id, { keepWarm: !hb.keepWarm, at: now })
              $.ui.toast(`Sent to "${mask(hb.label)}". It applies within 30 seconds.`)
            }
            await readFleet($)
            $.ui.invalidate('ui.render')
          },
        }),
      )
    }
    const line = Box({ flexDirection: 'row', children: cells })
    const detail = []
    if (hb.state === 'waiting' && hb.waitingFor) detail.push(`needs you: ${hb.waitingFor}`)
    else if (hb.state === 'working' && hb.tool) detail.push(`running ${hb.tool}`)
    if (hb.coldCount) detail.push(`${hb.coldCount} cold restart${hb.coldCount === 1 ? '' : 's'} ${money(hb.coldUsd)}`)
    if (hb.keepWarm) detail.push(`warm until ${clock(hb.keepWarmUntil)}, ${hb.pings} ping(s) ${money(hb.pingUsd)}`)
    if (detail.length === 0) return line
    return Box({ flexDirection: 'column', children: [line, Text({ dimColor: true, children: ['            └ ' + detail.join(' · ')] })] })
  })
  const totalCost = list.reduce((a, hb) => a + (hb.costUsd || 0), 0)
  const totalCold = list.reduce((a, hb) => a + (hb.coldUsd || 0), 0)
  const waiting = list.filter((hb) => hb.state === 'waiting').length
  const footer = Text({
    dimColor: true,
    children: [`${list.length} session${list.length === 1 ? '' : 's'} · ${money(totalCost)} total · ${waiting} waiting on you · cold restarts ${money(totalCold)} · keep warm reads the cache before it expires · Esc closes`],
  })
  return Box({ flexDirection: 'column', children: [header, ...rows, Text({ children: [' '] }), footer] })
}
