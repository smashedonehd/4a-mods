import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

const PANE = 'plugin-toggles'
const NL = String.fromCharCode(10)
const BS = String.fromCharCode(92)
const norm = (p: string) => p.split(BS).join('/')
const query = atom({ plugin: 'plugin-toggles', key: 'q' } as const, '', {
  shape: 'q-1',
})
const TABS = ['profiles', 'plugins', 'skills', 'mcp', 'mods'] as const
const TAB_LABEL: Record<string, string> = {
  profiles: 'Profiles',
  plugins: 'Plugins',
  skills: 'Skills',
  mcp: 'MCP',
  mods: 'Mods',
}
const TAB_HELP: Record<string, string> = {
  profiles: 'Saved sets of plugins and skills. Apply switches the whole set in one click.',
  plugins: 'Switch a plugin on or off. Point at one to see what it adds.',
  skills:
    'On lists a skill with its description, Name by its name alone. User hides it from Claude but keeps /name for you. Off hides it from both.',
  mcp: 'Switch an MCP server on or off for this project. Reconnect with /mcp. The desktop app switches the servers it supplies.',
}
// The positions of a switch: the four values the engine reads from
// skillOverrides, in that order. No entry means on.
const MODES = ['on', 'name-only', 'user-invocable-only', 'off'] as const
type Mode = (typeof MODES)[number]
const TWO: readonly Mode[] = ['on', 'off']
const MODE_LABEL: Record<Mode, string> = {
  on: 'On',
  'name-only': 'Name',
  'user-invocable-only': 'User',
  off: 'Off',
}
// A no-break space: room a desktop button keeps, where a plain space is trimmed.
const NBSP = String.fromCharCode(160)
const MODE_SAYS: Record<Mode, string> = {
  on: 'on',
  'name-only': 'name only',
  'user-invocable-only': 'user only',
  off: 'off',
}
// The fill under a switch's current position: the brand accent for On and
// quieter ones for the rest, so a column of switches lights where Claude sees.
const MODE_FILL: Record<Mode, string> = {
  on: 'claude',
  'name-only': 'suggestion',
  'user-invocable-only': 'inactive',
  off: 'subtle',
}
// Whether Claude sees the item in every turn.
const inContext = (m: Mode) => m === 'on' || m === 'name-only'
// Bar segments and the dots on the rows that match them: mid tones that
// read on a light and on a dark theme.
const PALETTE = [
  '#D97757',
  '#6A9BCC',
  '#7FB77E',
  '#D4A72C',
  '#A07CC5',
  '#4FB0AE',
  '#D9789F',
  '#7E8CE0',
  '#C08A5B',
  '#8C9BB0',
]
// A switched-on mod's On and Shown.
const GOOD = '#16a34a'
// What a switch drawn as a picture is coloured by: its position's own colour
// where Claude sees the item, a grey that reads on a light and a dark theme
// where it does not.
const INK: Record<Mode, string> = {
  on: '#D97757',
  'name-only': '#6A9BCC',
  'user-invocable-only': '#8E8E93',
  off: '#8E8E93',
}
const TRACK = '#8E8E93'
const SVG = 'xmlns="http://www.w3.org/2000/svg"'
// The knob's edge, in place of a shadow filter: a picture's markup counts
// against the size of the tree a desktop takes.
const EDGE = 'stroke="#000" stroke-opacity=".18"'
// A pill switch, coloured with the knob right when on: the Mods tab's in
// green, a plugin's or a server's in the brand colour.
const pill = (lit: boolean, colour = GOOD) =>
  `<svg ${SVG} width="44" height="26" viewBox="0 0 44 26"><rect x="1" y="1" width="42" height="24" rx="12" fill="${lit ? colour : TRACK}" fill-opacity="${lit ? 1 : 0.45}"/><circle cx="${lit ? 30 : 14}" cy="13" r="10" fill="#fff" ${EDGE}/></svg>`
// One stop of a skill's four-stop slider, `at` the stop the knob is on. The
// rail runs through each cell edge to edge, so four cells side by side draw
// one rail, coloured from the left up to the knob.
const STOP = 26
const stop = (j: number, at: number, colour: string) => {
  const rail = (x1: number, x2: number, lit: boolean) =>
    `<line x1="${x1}" y1="13" x2="${x2}" y2="13" stroke="${lit ? colour : TRACK}" stroke-opacity="${lit ? 1 : 0.45}" stroke-width="4"/>`
  const mark =
    j === at
      ? `<circle cx="13" cy="13" r="9" fill="#fff" stroke="${colour}" stroke-width="2"/>`
      : `<circle cx="13" cy="13" r="4" fill="${j < at ? colour : TRACK}" fill-opacity="${j < at ? 1 : 0.6}"/>`
  return `<svg ${SVG} width="${STOP}" height="26" viewBox="0 0 ${STOP} 26">${j > 0 ? rail(0, 13, j <= at) : ''}${j < 3 ? rail(13, STOP, j < at) : ''}${mark}</svg>`
}
// A desktop Button is as wide as its label, and a Box around it does not
// press. So a pressable picture lies under a Box cut to its edges, holding a
// plain Button whose blank label is wider than any picture here: a click
// anywhere on the picture lands on the Button. Em spaces, as a desktop keeps
// them where it folds plain spaces away.
const BLANK = String.fromCharCode(0x2003).repeat(8)
// Rows drawn at most; the filter narrows the rest.
const SHOWN = 200
// A desktop draws no Pane tree of 2000 nodes or more (each element, and
// each string among an element's children) or past 262144 characters of
// prop names and text: it keeps the old drawing, and the press that asked
// for the new one seems to do nothing. Rows go in, heaviest first, while the
// whole tree stays inside these, which keep room for the rest of the pane.
// Characters are counted here as JSON, which runs near twice the desktop's
// own count. The terminal sets no such bounds.
const MAX_NODES = 1900
const MAX_CHARS = 400_000
// What a drawn tree weighs against those bounds, counted as a desktop counts.
// The runtime stamps each Button with where its press goes, which no
// stringify here sees: PRESS characters apiece.
const PRESS = 64
function weigh(tree: unknown) {
  let nodes = 0
  let presses = 0
  const walk = (v: unknown, child: boolean) => {
    if (typeof v === 'string') {
      if (child) nodes++
      return
    }
    if (!v || typeof v !== 'object') return
    if (Array.isArray(v)) {
      for (const c of v) walk(c, true)
      return
    }
    const type = (v as { type?: unknown }).type
    if (typeof type === 'string') nodes++
    if (type === 'Button') presses++
    for (const c of Object.values(v)) walk(c, false)
  }
  walk(tree, false)
  return { nodes, chars: (JSON.stringify(tree)?.length ?? 0) + presses * PRESS }
}
// A row's card holds this much of its description.
const DESC = 240
// Bumped after each write so the pane redraws.
const rev = atom({ plugin: 'plugin-toggles', key: 'rev' } as const, 0, {
  shape: 'rev-1',
})
// Changes written to settings that the running session has not picked up yet.
const dirty = atom({ plugin: 'plugin-toggles', key: 'dirty' } as const, 0, {
  shape: 'dirty-1',
})
const tab = atom({ plugin: 'plugin-toggles', key: 'tab' } as const, 'plugins', {
  shape: 'tab-1',
})
// The name typed for a new profile, apart from the filter.
const draft = atom({ plugin: 'plugin-toggles', key: 'name' } as const, '', {
  shape: 'name-1',
})

// JSON as a Windows editor may save it, a byte order mark first.
const parse = (text: string) => JSON.parse(text.replace(/^\uFEFF/, '')) as Record<string, any>
const isObject = (v: unknown): v is Record<string, any> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

// A JSON file's object, {} for an empty file; undefined when it does not read
// or parse, or holds no object.
async function readObject($: any, path: string) {
  try {
    const text = String(await $.fs.read(path))
    const json = text.trim() === '' ? {} : parse(text)
    return isObject(json) ? json : undefined
  } catch {
    return undefined
  }
}

async function readJson($: any, path: string) {
  return (await readObject($, path)) ?? {}
}

// A file a press writes from: {} when it is missing. One that is there but
// does not read or parse, or holds no object, gives undefined and the press
// says so: written over, it would keep only the key changed.
async function readStrict($: any, path: string) {
  const json = await readObject($, path)
  if (json !== undefined) return json
  if (!(await $.fs.exists(path))) return {}
  $.ui.toast(`Could not read ${path}, so nothing was changed. Fix the file and try again.`)
  return undefined
}

// Claude Code's own folder, its settings.json and the global config, where
// the engine finds them: under CLAUDE_CONFIG_DIR when set, else at home. A
// USERPROFILE that is no Windows path, as WSL hands one over, is not the
// home the engine reads there.
async function paths($: any) {
  const [profileVar, homeVar, config] = await Promise.all([
    $.env.get('USERPROFILE'),
    $.env.get('HOME'),
    $.env.get('CLAUDE_CONFIG_DIR'),
  ])
  const profile = String(profileVar || '')
  const home = norm(/^[A-Za-z]:[\\/]/.test(profile) ? profile : String(homeVar || profile))
  const dir = config ? norm(String(config)).replace(/\/+$/, '') : `${home}/.claude`
  return {
    home,
    dir,
    // Mods look for their switch file here whatever CLAUDE_CONFIG_DIR says.
    mods: `${home}/.claude/mods`,
    settings: `${dir}/settings.json`,
    global: config ? `${dir}/.claude.json` : `${home}/.claude.json`,
  }
}

// Rewrites a JSON file through `change`, unless readStrict refuses it or
// `change` returns false.
async function rewrite($: any, path: string, change: (json: Record<string, any>) => void | false) {
  const json = await readStrict($, path)
  if (json === undefined) return false
  if (change(json) === false) return false
  await $.fs.write(path, JSON.stringify(json, null, 2) + NL)
  return true
}

// The sources the engine ranks above settings.json, lowest first, and where
// each is set.
const ABOVE = ['project', 'local', 'flag', 'policy'] as const
const ABOVE_SAYS: Record<string, string> = {
  project: "the project's .claude/settings.json",
  local: "the project's .claude/settings.local.json",
  flag: '--settings',
  policy: 'managed settings',
}

async function aboveNow($: any) {
  return Promise.all(
    ABOVE.map(async source => ((await $.settings.read({ source })) ?? {}) as Record<string, any>),
  )
}

// Where the switches stand now. The engine's settings pick up a write to
// settings.json about a second late, so the file the switches write is read
// as it is, then the sources ranked above it as the engine has them.
async function switchesNow($: any) {
  const [own, above] = await Promise.all([readJson($, (await paths($)).settings), aboveNow($)])
  const merged = (key: string) =>
    Object.assign({}, own[key], ...above.map(s => s[key])) as Record<string, any>
  return { enabledPlugins: merged('enabledPlugins'), skillOverrides: merged('skillOverrides') }
}

// The highest source above settings.json that sets `name` under `key`: a
// switch written to settings.json would not move it.
async function outranking($: any, key: string, name: string) {
  const above = await aboveNow($)
  for (let i = ABOVE.length - 1; i >= 0; i--)
    if (above[i]?.[key]?.[name] !== undefined) return ABOVE[i]
  return undefined
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)
const fmt = (n: number) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`)
// A cost, `~` before one estimated from the files.
const tag = (n: number, exact: boolean) => `${exact ? '' : '~'}${fmt(n)}`
// What one line of a skill or agent listing costs, by the usual four characters a token.
const lineCost = (name: string, desc: string) => Math.ceil((name.length + desc.length + 4) / 4)

// Reads name and description from a markdown file's YAML frontmatter.
function frontmatter(text: string) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const out: Record<string, string> = {}
  if (!m) return out
  const lines = (m[1] ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[i] ?? '')
    if (!kv?.[1]) continue
    let v = (kv[2] ?? '').trim()
    if (/^[>|][+-]?$/.test(v)) {
      const parts: string[] = []
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1] ?? ''))
        parts.push((lines[++i] ?? '').trim())
      v = parts.join(' ')
    }
    out[kv[1]] = v.replace(/^(["'])([\s\S]*)\1$/, '$2')
  }
  return out
}

async function listSafe($: any, path: string) {
  try {
    return (await $.fs.list(path)) as { name: string; kind: string }[]
  } catch {
    return []
  }
}

async function readSafe($: any, path: string) {
  try {
    return String(await $.fs.read(path))
  } catch {
    return ''
  }
}

type Item = { name: string; desc: string }
type Info = {
  desc: string
  version: string
  author: string
  skills: Item[]
  commands: Item[]
  agents: Item[]
  mcp: string[]
  // Each server's config, by its key in the plugin.
  servers: Record<string, any>
  hooks: string[]
}
const infoCache = new Map<string, Info | null>()

// Where each installed plugin sits, by id.
async function installRoots($: any) {
  const reg = await readJson($, `${(await paths($)).dir}/plugins/installed_plugins.json`)
  const roots = new Map<string, string>()
  for (const id of Object.keys(reg.plugins ?? {})) {
    const path = (reg.plugins[id] ?? [])[0]?.installPath
    if (path) roots.set(id, norm(String(path)))
  }
  return roots
}

async function pluginInfo($: any, id: string): Promise<Info | null> {
  if (infoCache.has(id)) return infoCache.get(id) ?? null
  const reg = await readJson($, `${(await paths($)).dir}/plugins/installed_plugins.json`)
  const entry = (reg.plugins?.[id] ?? [])[0]
  if (!entry?.installPath) {
    infoCache.set(id, null)
    return null
  }
  const root = norm(String(entry.installPath))
  const items = async (dir: string, file: (n: string) => string | null) => {
    const found = (await listSafe($, `${root}/${dir}`)).flatMap(f => {
      const rel = file(f.name)
      return rel ? [{ f, rel }] : []
    })
    const out: Item[] = await Promise.all(
      found.map(async ({ f, rel }) => {
        const fm = frontmatter(await readSafe($, `${root}/${dir}/${rel}`))
        return { name: fm.name || f.name.replace(/\.md$/, ''), desc: fm.description ?? '' }
      }),
    )
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }
  const [manifest, mcpJson, hooksJson, skills, commands, agents] = await Promise.all([
    readJson($, `${root}/.claude-plugin/plugin.json`),
    readJson($, `${root}/.mcp.json`),
    readJson($, `${root}/hooks/hooks.json`),
    items('skills', n => `${n}/SKILL.md`),
    items('commands', n => (n.endsWith('.md') ? n : null)),
    items('agents', n => (n.endsWith('.md') ? n : null)),
  ])
  // A plugin names its servers in .mcp.json, in its manifest's mcpServers,
  // or in the files that names, the jev plugin in its manifest.
  const servers: Record<string, any> = { ...(mcpJson.mcpServers ?? mcpJson) }
  for (const ref of [manifest.mcpServers].flat()) {
    if (isObject(ref)) Object.assign(servers, ref.mcpServers ?? ref)
    else if (typeof ref === 'string' && ref.endsWith('.json')) {
      const json = await readJson($, `${root}/${norm(ref).replace(/^\.\//, '')}`)
      Object.assign(servers, json.mcpServers ?? json)
    }
  }
  let desc = String(manifest.description ?? '')
  if (desc === '') {
    const readme = await readSafe($, `${root}/README.md`)
    desc =
      readme
        .split(/\r?\n\r?\n/)
        .map(s => s.replace(/^#+\s*/, '').trim())
        .find(s => s !== '' && !s.startsWith('#')) ?? ''
  }
  const info: Info = {
    desc,
    version: String(manifest.version ?? entry.version ?? ''),
    author: String(manifest.author?.name ?? manifest.author ?? ''),
    skills,
    commands,
    agents,
    mcp: Object.keys(servers),
    servers,
    hooks: Object.keys(hooksJson.hooks ?? {}),
  }
  infoCache.set(id, info)
  return info
}

// What this session's context holds, counted the way /context counts it.
type Loaded = {
  byPlugin: Map<string, number>
  skills: Map<string, number>
  servers: Map<string, number>
  // Every server with a tool in this chat, its schemas loaded or not.
  live: Set<string>
  fit: { included: number; total: number } | null
}

async function loadedNow($: any): Promise<Loaded | null> {
  try {
    const b = (await $.session.usage({ breakdown: 'summary' })).context.breakdown
    if (!b) return null
    const add = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n)
    const out: Loaded = { byPlugin: new Map(), skills: new Map(), servers: new Map(), live: new Set(), fit: null }
    for (const s of b.skills?.skillFrontmatter ?? []) {
      out.skills.set(s.name, s.tokens)
      if (s.pluginName) add(out.byPlugin, s.pluginName.split('@')[0], s.tokens)
    }
    if (b.skills) out.fit = { included: b.skills.includedSkills, total: b.skills.totalSkills }
    for (const a of b.agents ?? []) {
      const at = a.agentType.indexOf(':')
      if (a.source === 'plugin' && at > 0) add(out.byPlugin, a.agentType.slice(0, at), a.tokens)
    }
    for (const t of b.mcpTools ?? []) {
      out.live.add(t.serverName)
      if (t.isLoaded) add(out.servers, t.serverName, t.tokens)
    }
    return out
  } catch {
    return null
  }
}

// One row on a board: a plugin, a skill or an MCP server.
type Row = {
  name: string
  label: string
  mode: Mode
  // The positions its switch offers.
  modes: readonly Mode[]
  // Set for a plugin's skill, which that plugin switches: the row offers a
  // way to it instead of a switch.
  plugin?: string
  // What it costs in its current position.
  tokens: number
  // Counted by the engine for this session; otherwise estimated from the files.
  exact: boolean
  // What it costs switched on: the order of the rows, which a switch leaves be.
  weight: number
  // What the bar colours by: the plugin itself, or the plugin a skill comes from.
  group: string
  meta: string
  desc: string
  more: string
  // The skills a plugin's row stands for, which the count and the filter
  // take one by one.
  skills?: string[]
  // An MCP server's source: the section of the MCP tab it is listed in.
  source?: Source
  // Set where another tab switches it: the row offers a way there instead of a switch.
  goto?: { tab: string; label: string }
}

const heavy = (a: Row, b: Row) => b.weight - a.weight || a.label.localeCompare(b.label)
// MCP server names as the engine spells them: `plugin_jev_jev` for the jev
// plugin's jev server, `nexus-brain` as configured.
const wire = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_')

function measuredFor(now: Loaded, label: string) {
  let n = now.byPlugin.get(label)
  const prefix = `plugin_${wire(label)}_`
  for (const [server, tokens] of now.servers) if (server.startsWith(prefix)) n = (n ?? 0) + tokens
  return n
}

async function pluginRow($: any, id: string, isOn: boolean, now: Loaded | null): Promise<Row> {
  const at = id.indexOf('@')
  const label = at > 0 ? id.slice(0, at) : id
  const inf = await pluginInfo($, id)
  const measured = now ? measuredFor(now, label) : undefined
  const listed = inf ? [...inf.skills, ...inf.commands, ...inf.agents] : []
  const counts = inf
    ? [
        inf.skills.length && `${inf.skills.length} skills`,
        inf.commands.length && `${inf.commands.length} commands`,
        inf.agents.length && `${inf.agents.length} agents`,
        inf.mcp.length && `${inf.mcp.length} MCP`,
        inf.hooks.length && 'hooks',
      ].filter(Boolean)
    : []
  const names = (title: string, list: string[]) =>
    list.length > 0 ? `${title}: ${list.join(', ')}` : ''
  const tokens = measured ?? listed.reduce((n, i) => n + lineCost(i.name, i.desc), 0)
  return {
    name: id,
    label,
    mode: isOn ? 'on' : 'off',
    modes: TWO,
    tokens,
    exact: measured !== undefined,
    weight: tokens,
    group: label,
    meta: [at > 0 ? id.slice(at + 1) : '', counts.join(', ')].filter(Boolean).join(' · '),
    desc: inf ? clip(inf.desc, 300) || 'No description.' : 'Local or dev plugin, no install info.',
    more: inf
      ? [
          names('Skills', inf.skills.map(i => i.name)),
          names('Commands', inf.commands.map(i => i.name)),
          names('Agents', inf.agents.map(i => i.name)),
          names('MCP', inf.mcp),
        ]
          .filter(Boolean)
          .join(' · ')
      : '',
  }
}

// The stacked bar as an SVG strip stretched to the pane's width: one segment
// per group, in the order and colours the chips use.
function barSvg(segs: { tokens: number; colour: string }[], total: number) {
  const W = 1000
  const H = 8
  const gap = 6
  const room = W - gap * Math.max(0, segs.length - 1)
  let x = 0
  const rects = segs.map(s => {
    const w = Math.max(4, (s.tokens / total) * room)
    const r = `<rect x="${x.toFixed(1)}" width="${w.toFixed(1)}" height="${H}" fill="${s.colour}"/>`
    x += w + gap
    return r
  })
  const track = segs.length === 0 ? `<rect width="${W}" height="${H}" fill="#8884"/>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${track}${rects.join('')}</svg>`
}

function gauge(
  $: any,
  e: any,
  segs: { group: string; tokens: number; colour: string }[],
  total: number,
  caption: string,
  note: string,
  warn: boolean,
) {
  const ui = $.ui.resolve(e) as any
  const { Box, Text } = ui
  const alt =
    segs.length === 0
      ? 'Nothing loaded'
      : `Share of ${fmt(total)} tokens: ${segs.map(s => `${s.group} ${fmt(s.tokens)}`).join(', ')}`
  // The terminal draws no Svg (its table answers a stand-in that draws
  // nothing): the same bar in block characters.
  const width = Math.max(10, Math.min(48, (e.props?.bodyColumns ?? 60) - 4))
  const cells = segs.map(s => Math.max(1, Math.round((s.tokens / Math.max(total, 1)) * width)))
  return (
    <Box key="gauge" flexDirection="column" gap={0}>
      <Box gap={1} alignItems="flex-end">
        <Text bold color="claude">
          {fmt(total)}
        </Text>
        <Text dimColor>{caption}</Text>
      </Box>
      {ui.Svg && e.surface !== 'terminal' ? (
        <ui.Svg source={barSvg(segs, total)} alt={alt} height={8} />
      ) : segs.length === 0 ? (
        <Text dimColor>{'░'.repeat(width)}</Text>
      ) : (
        <Text>
          {segs.map((s, i) => (
            <Text color={s.colour}>{'█'.repeat(cells[i] ?? 1)}</Text>
          ))}
        </Text>
      )}
      {note !== '' && (
        <Text {...(warn ? { color: 'warning' } : { dimColor: true })}>{note}</Text>
      )}
    </Box>
  )
}

// A fixed three-row slot. At rest it shows the tab's help; pointing at a chip
// reveals that chip's card above the help, which the slot's height then clips,
// so nothing below moves.
function inspector($: any, e: any, rows: Row[], scopeOf: Map<string, string>, help: string) {
  const { Box, Text } = $.ui.resolve(e)
  return (
    <Box flexDirection="column" height={3} overflow="hidden">
      {rows.map(r => card($, e, r, scopeOf.get(r.name)))}
      <Text dimColor>{help}</Text>
    </Box>
  )
}

// A row's card in the inspector, shown while the pointer is on the row.
function card($: any, e: any, r: Row, scope: string | undefined) {
  const { Box, Text } = $.ui.resolve(e)
  const meta = [MODE_SAYS[r.mode], r.meta, r.tokens > 0 && `${tag(r.tokens, r.exact)} tokens`]
    .filter(Boolean)
    .join(' · ')
  return (
    <Box display="none" hover={{ scope, display: 'flex' }} flexDirection="column" minHeight={3}>
      <Text wrap="truncate-end" bold>{`${r.label}  ${meta}`}</Text>
      <Text wrap="truncate-end">{clip(r.desc, DESC)}</Text>
      <Text wrap="truncate-end" dimColor>
        {r.more || ' '}
      </Text>
    </Box>
  )
}

// Where pictures draw, a pill switch for On or Off and a four-stop slider
// for a skill. The terminal would draw a bordered Box three rows high, so
// there they are bracketed Buttons, one a position, the current one in the
// accent. An engine without Svg gets them chromeless in one rounded capsule,
// the current one on its fill. Older engines take only a plain label on a
// Button: 2.1.282 refuses the whole tree otherwise.
// A desktop presses only on the button itself, never on the Box around it,
// so the capsule's fill has no padding of its own: the label carries the
// room as no-break spaces, and a click anywhere on the fill lands on it.
function toggle($: any, e: any, kind: string, r: Row) {
  const { Box, Button, Svg, Text } = $.ui.resolve(e) as any
  const terminal = e.surface === 'terminal'
  const to = (m: Mode) => () => {
    // The position it is at already: nothing to write or count.
    if (m !== r.mode) return setMode($, kind, r.name, m)
  }
  if (Svg && !terminal) {
    const lit = inContext(r.mode)
    // On or Off: one switch, which a press flips. Its Button is named by
    // where the press moves it.
    if (r.modes.length === 2) {
      const next = r.mode === 'on' ? 'off' : 'on'
      return pressable(
        $,
        e,
        `${kind}:${r.name}:${next}`,
        pill(r.mode === 'on', INK.on),
        `${r.label} ${MODE_LABEL[r.mode]}`,
        44,
        to(next),
      )
    }
    // Four stops, On to Off, the knob on the current one and its name beside.
    const at = r.modes.indexOf(r.mode)
    return (
      <Box alignItems="center" gap={0} flexShrink={0}>
        <Box width={5}>
          <Text dimColor={!lit}>{MODE_LABEL[r.mode]}</Text>
        </Box>
        {r.modes.map((m, j) =>
          pressable(
            $,
            e,
            `${kind}:${r.name}:${m}`,
            stop(j, at, INK[r.mode]),
            `${r.label} ${MODE_LABEL[m]}`,
            STOP,
            to(m),
            m !== r.mode,
          ),
        )}
      </Box>
    )
  }
  const buttons = r.modes.map(m => {
    const on = m === r.mode
    const button = (
      <Button
        key={`${kind}:${r.name}:${m}`}
        label={terminal ? MODE_LABEL[m] : `${NBSP}${MODE_LABEL[m]}${NBSP}`}
        {...(terminal ? { variant: on ? 'primary' : 'secondary' } : { plain: true })}
        dimColor={!on}
        onPress={to(m)}
      />
    )
    if (terminal) return button
    return (
      <Box {...(on ? { backgroundColor: MODE_FILL[m] } : {})}>
        {button}
      </Box>
    )
  })
  if (terminal) return <Box flexShrink={0}>{buttons}</Box>
  return (
    <Box borderStyle="round" borderDimColor padding={0} gap={0} overflow="hidden" flexShrink={0}>
      {buttons}
    </Box>
  )
}

// A picture pressed anywhere on it: see BLANK. The Button's own name is
// blank, as a Button takes no name apart from its label; the picture's alt
// names the item and the position.
function pressable(
  $: any,
  e: any,
  key: string,
  source: string,
  alt: string,
  width: number,
  press: () => unknown,
  dim = false,
) {
  const { Box, Button, Svg } = $.ui.resolve(e) as any
  return (
    <Box key={`${key}-pic`} flexShrink={0} overflow="hidden">
      <Svg source={source} alt={alt} width={width} height={26} />
      <Box position="absolute" top={0} bottom={0} left={0}>
        <Button key={key} label={BLANK} plain dimColor={dim} onPress={press} />
      </Box>
    </Box>
  )
}

// The dot that ties a row to its bar segment, the name and what it costs now,
// then the switch. The name takes the room left and is cut short, never the
// switch. No size, weight or tabular Text props: 2.1.282 refuses them.
function row($: any, e: any, kind: string, r: Row, scope: string, colour: string | undefined) {
  const { Box, Button, Text } = $.ui.resolve(e)
  const lit = inContext(r.mode)
  const cost = r.tokens > 0 ? tag(r.tokens, r.exact) : ''
  return (
    <Box key={`${kind}-row:${r.name}`} hover={{ scope }} alignItems="center" gap={1}>
      <Box alignItems="center" gap={1} flexGrow={1} flexShrink={1} minWidth={0}>
        {lit ? <Text color={colour ?? 'inactive'}>●</Text> : <Text dimColor>○</Text>}
        <Text wrap="truncate-end" bold={lit} dimColor={!lit}>
          {r.label}
        </Text>
        {cost !== '' && <Text dimColor>{cost}</Text>}
      </Box>
      {r.goto ? (
        <Button
          key={`${kind}:${r.name}:goto`}
          label={`${r.goto.label} ›`}
          {...(e.surface === 'terminal' ? { variant: 'secondary' } : { plain: true })}
          dimColor
          onPress={() => goTo($, r.goto?.tab ?? 'plugins', '')}
        />
      ) : r.plugin !== undefined ? (
        <Button
          key={`${kind}:${r.name}:plugin`}
          label={`${r.plugin || 'Plugins'} ›`}
          {...(e.surface === 'terminal' ? { variant: 'secondary' } : { plain: true })}
          dimColor
          onPress={() => goTo($, 'plugins', r.plugin ?? '')}
        />
      ) : r.modes.length === 0 ? (
        <Text dimColor>no switch</Text>
      ) : (
        toggle($, e, kind, r)
      )}
    </Box>
  )
}

function section(
  $: any,
  e: any,
  kind: string,
  title: string,
  list: Row[],
  scopeOf: Map<string, string>,
  colour: Map<string, string>,
) {
  const { Box, Text } = $.ui.resolve(e)
  if (list.length === 0) return null
  return (
    <Box flexDirection="column" gap={0}>
      <Text bold dimColor>
        {`${title} · ${list.length}`}
      </Text>
      {list.map(r => row($, e, kind, r, scopeOf.get(r.name) ?? 'tg', colour.get(r.group)))}
    </Box>
  )
}

function tabs($: any, e: any, current: string) {
  const { Box, Button } = $.ui.resolve(e)
  return (
    <Box gap={1}>
      {TABS.map(t => (
        <Button
          key={`tab-${t}`}
          label={TAB_LABEL[t]}
          variant={t === current ? 'primary' : 'secondary'}
          onPress={() => update($, tab, () => t)}
        />
      ))}
    </Box>
  )
}

async function markDirty($: any) {
  await update($, dirty, n => n + 1)
}

// By value: a setting may hold a list, which two reads give as two arrays.
const same = (a: Record<string, any> = {}, b: Record<string, any> = {}) =>
  [...Object.keys(a), ...Object.keys(b)].every(k => JSON.stringify(a[k]) === JSON.stringify(b[k]))

// Whether the engine has the switches settings.json holds. It picks a write
// up about a second late, and a reload before then loads the old ones.
async function engineHasSwitches($: any) {
  const want = await readJson($, (await paths($)).settings)
  for (let waited = 0; ; waited += 100) {
    const has = ((await $.settings.read({ source: 'user' })) ?? {}) as Record<string, any>
    if (same(want.enabledPlugins, has.enabledPlugins) && same(want.skillOverrides, has.skillOverrides))
      return true
    if (waited >= 3000) return false
    await $.clock.sleep(100)
  }
}

async function applyNow($: any) {
  if (!(await engineHasSwitches($))) {
    $.ui.toast('Settings have not been read in yet. Press Apply now again in a moment.')
    return
  }
  try {
    // A session the app drives (desktop, Remote Control) reloads only for a
    // /reload-plugins the person typed: a plugin's run gets that refusal as
    // its text, not as an error, and nothing is reloaded. Claude Code 2.1.321
    // words it "/reload-plugins isn't available over a remote connection in
    // this session."; recheck the match when that wording changes.
    const res = await $.command.run({ command: 'reload-plugins' })
    if (/isn't available/i.test(res?.text ?? '')) {
      $.ui.toast('Type /reload-plugins in this chat to load them. The changes are saved.')
      return
    }
    await update($, dirty, () => 0)
    $.ui.toast('Plugins and skills reloaded.')
  } catch {
    $.ui.toast('Could not reload here. The changes take effect in a new chat.')
  }
}

const hasReload = (commands: { name: string }[]) => commands.some(c => c.name === 'reload-plugins')

// Writes one switch to settings.json: a plugin's true or false, a skill's
// position, where On is no entry at all. The pending count it bumps redraws
// the pane.
async function writeSwitch($: any, key: 'enabledPlugins' | 'skillOverrides', name: string, value: boolean | Mode) {
  const wrote = await rewrite($, (await paths($)).settings, json => {
    const next = { ...(json[key] ?? {}) }
    if (value === 'on') delete next[name]
    else next[name] = value
    json[key] = next
  })
  if (wrote) await markDirty($)
}

// The engine keys a project in ~/.claude.json by where its session started,
// which a shell cd does not move.
async function projectKey($: any) {
  return norm(String(await $.session.root()))
}

// Where an MCP server comes from, in the order the MCP tab lists them.
const SOURCES = ['user', 'project', 'plugin', 'claudeai', 'builtin', 'mod'] as const
type Source = (typeof SOURCES)[number]
const SOURCE_TITLE: Record<Source, string> = {
  user: 'USER',
  project: 'PROJECT AND LOCAL',
  plugin: 'FROM PLUGINS',
  claudeai: 'CLAUDE.AI CONNECTORS',
  builtin: 'BUILT IN',
  mod: 'FROM MODS',
}
// Claude Code's own servers, which /mcp switches by these names: always
// listed, as a chat has them only while they are on.
const BUILTIN = ['claude-in-chrome', 'claude-artifacts', 'computer-use']
// The one Claude Code keeps off until the project's enabledMcpServers lists it.
const OPT_IN = 'computer-use'
// How /mcp names a connector of the claude.ai account.
const CONNECTOR = 'claude.ai '
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

type Found = { source: Source; meta: string; cfg?: any; desc?: string; more?: string; goto?: Row['goto']; fixed?: boolean }

// Every MCP server this project's switch reaches, by source. The engine
// gives a mod no list of servers with their source: they are read from the
// files Claude Code reads them from, and the chat's own tools add the
// connectors and built-in servers it has loaded. A mod's tools are listed
// with a way to the Mods tab. Servers the desktop app supplies to its chats
// (its connectors, its own tools) are left out: the app switches those.
async function mcpRows($: any, now: Loaded | null): Promise<Row[]> {
  const { global, dir } = await paths($)
  const key = await projectKey($)
  const [user, mcpJson, needsAuth, switches] = await Promise.all([
    readJson($, global),
    readJson($, `${key}/.mcp.json`),
    readJson($, `${dir}/mcp-needs-auth-cache.json`),
    switchesNow($),
  ])
  const project = isObject(user.projects?.[key]) ? user.projects[key] : {}
  const off = new Set(strings(project.disabledMcpServers))
  const optedIn = new Set(strings(project.enabledMcpServers))
  const rejected = new Set(strings(project.disabledMcpjsonServers))
  const live = new Set([...(now?.live ?? [])].map(wire))
  const found = new Map<string, Found>()
  const add = (name: string, f: Found) => {
    if (!found.has(name)) found.set(name, f)
  }
  const servers = (json: any) => (isObject(json?.mcpServers) ? json.mcpServers : {}) as Record<string, any>
  for (const [n, cfg] of Object.entries(servers(project)))
    add(n, { source: 'project', meta: 'local server, this project only', cfg })
  for (const [n, cfg] of Object.entries(servers(mcpJson)))
    add(n, {
      source: 'project',
      meta: "project server, the project's .mcp.json",
      cfg,
      more: rejected.has(n) ? 'Not approved for this project: approve it in /mcp.' : '',
    })
  for (const [n, cfg] of Object.entries(servers(user))) add(n, { source: 'user', meta: 'user server, every project', cfg })
  const plugins = Object.keys(switches.enabledPlugins).filter(id => switches.enabledPlugins[id] === true)
  for (const [id, inf] of await Promise.all(plugins.map(async id => [id, await pluginInfo($, id)] as const))) {
    const label = id.split('@')[0] ?? id
    for (const s of inf?.mcp ?? [])
      add(`plugin:${label}:${s}`, { source: 'plugin', meta: `from the ${label} plugin`, cfg: inf?.servers[s] })
  }
  const connectors = [
    ...strings(user.claudeAiMcpEverConnected),
    ...Object.keys(needsAuth),
    ...off,
    ...(now?.live ?? []),
  ].filter(n => n.startsWith(CONNECTOR))
  for (const n of connectors)
    add(n, {
      source: 'claudeai',
      meta: 'claude.ai connector',
      desc: n in needsAuth ? 'Needs you to sign in: run /mcp.' : 'A connector of your claude.ai account.',
    })
  for (const n of BUILTIN) {
    const loaded = live.has(wire(n))
    // On with no opt-in: the app running this chat supplies it, and a switch
    // here would not move it.
    const fixed = n === OPT_IN && loaded && !optedIn.has(n)
    add(n, {
      source: 'builtin',
      meta: 'built into Claude Code',
      desc: n === OPT_IN ? 'Off until you switch it on for this project.' : 'On unless you switch it off for this project.',
      more: fixed ? 'On here because the app running this chat supplies it: switch it in the app.' : '',
      fixed,
    })
  }
  // Names switched off whose server is configured nowhere here now.
  for (const n of off)
    add(n, {
      source: n.startsWith('plugin:') ? 'plugin' : 'project',
      meta: '',
      desc: 'Not configured here, only listed as disabled.',
    })
  // A mod's tools: what is left of the chat's servers, matched to a mod by name.
  const known = new Set([...found.keys()].map(wire))
  if ([...live].some(w => !known.has(w)))
    for (const m of await modsNow($).catch(() => [] as ModInfo[]))
      if (live.has(wire(m.name)) && !known.has(wire(m.name)))
        add(m.name, {
          source: 'mod',
          meta: `tools of the ${m.title} mod`,
          desc: m.desc || 'A mod that gives Claude tools of its own.',
          more: 'A mod registers these tools: switch the mod off on the Mods tab.',
          goto: { tab: 'mods', label: 'Mods' },
        })
  const tokens = new Map<string, number>()
  for (const [s, n] of now?.servers ?? []) tokens.set(wire(s), (tokens.get(wire(s)) ?? 0) + n)
  return [...found].map(([name, f]): Row => {
    const measured = tokens.get(wire(name))
    const switchless = f.goto !== undefined || f.fixed === true
    const on = switchless || (name === OPT_IN ? optedIn.has(name) : !off.has(name))
    const cfg = f.cfg
    return {
      name,
      label: name,
      mode: on ? 'on' : 'off',
      modes: switchless ? [] : TWO,
      tokens: measured ?? 0,
      exact: measured !== undefined,
      weight: measured ?? 0,
      group: name,
      meta: f.meta,
      desc: isObject(cfg)
        ? cfg.url
          ? String(cfg.url)
          : [cfg.command, ...strings(cfg.args)].filter(Boolean).join(' ') || 'No command or URL.'
        : (f.desc ?? ''),
      more: f.more ?? '',
      source: f.source,
      ...(f.goto ? { goto: f.goto } : {}),
    }
  })
}

async function toggleMcp($: any, name: string, isOn: boolean) {
  const key = await projectKey($)
  await rewrite($, (await paths($)).global, json => {
    const projects = json.projects ?? {}
    const project = projects[key] ?? {}
    // computer-use is the one server Claude Code keeps off until
    // enabledMcpServers lists it; every other one is on until
    // disabledMcpServers does.
    const list = name === OPT_IN ? 'enabledMcpServers' : 'disabledMcpServers'
    const named = new Set<string>(strings(project[list]))
    if (isOn === (name === OPT_IN)) named.add(name)
    else named.delete(name)
    projects[key] = { ...project, [list]: [...named] }
    json.projects = projects
  })
  await update($, rev, n => n + 1)
}

async function profilesPath($: any) {
  return `${(await paths($)).dir}/mods-data/plugin-toggles-profiles.json`
}

async function saveProfile($: any, name: string) {
  const clean = name.trim()
  if (clean === '') return
  const cur = await readStrict($, (await paths($)).settings)
  if (cur === undefined) return
  // Every skill of your files, an On one by name: applied, the profile moves
  // the switches it names and no other.
  const skills: Record<string, string> = {}
  for (const c of await $.command.list())
    if (c.source === 'user' && c.name !== 'toggles') skills[c.name] = 'on'
  Object.assign(skills, cur.skillOverrides)
  const wrote = await rewrite($, await profilesPath($), all => {
    all[clean] = { plugins: cur.enabledPlugins ?? {}, skills }
  })
  if (!wrote) return
  await update($, draft, () => '')
  await update($, rev, n => n + 1)
}

async function applyProfile($: any, name: string) {
  const all = await readJson($, await profilesPath($))
  const picked = all[name]
  if (!isObject(picked)) return
  const wrote = await rewrite($, (await paths($)).settings, json => {
    json.enabledPlugins = { ...(json.enabledPlugins ?? {}), ...picked.plugins }
    const skills = { ...(json.skillOverrides ?? {}), ...picked.skills }
    for (const name of Object.keys(skills)) if (skills[name] === 'on') delete skills[name]
    json.skillOverrides = skills
  })
  if (!wrote) return
  await markDirty($)
  if (hasReload(await $.command.list())) await applyNow($)
  await update($, rev, n => n + 1)
}

async function deleteProfile($: any, name: string) {
  await rewrite($, await profilesPath($), all => {
    delete all[name]
  })
  await update($, rev, n => n + 1)
}

// ---- Mods ----
// The switch file other mods read on their own, every few seconds: `"<name>":
// false` stops a mod, `"<name>:hidden": true` keeps it working without its
// pane or band. No key means on and shown. It lives under the home folder's
// .claude whatever CLAUDE_CONFIG_DIR says, as those mods look for it there.
async function switchesFile($: any) {
  return `${(await paths($)).mods}/switches.json`
}

type ModInfo = {
  name: string
  // The name in words: `cache-clock` is Cache Clock.
  title: string
  desc: string
  // Its slash commands, as its code registers them.
  tip: string
  // Its hooks code reads switches.json, so the switch moves it.
  switchable: boolean
  // Its hooks code reads a `:hidden` key.
  hideable: boolean
  // Its code looks for an `.open-<name>-<session>` request: it has a pane to open.
  pane: boolean
  // The plugin id when it was installed from a marketplace.
  id: string
  dir: string
}

// Folders directly inside dir, a link to one counted as one.
async function dirsIn($: any, dir: string) {
  return (await listSafe($, dir))
    .filter(x => !x.name.startsWith('.') && (x.kind === 'dir' || (x as any).isLink))
    .map(x => `${dir}/${x.name}`)
}

// CLAUDE_CODE_PLUGIN_DIRS: a Windows list is split at ';', any other at ':',
// where a lone drive letter joins the path after it (`C:/x`). `~` is home.
async function envDirs($: any, home: string) {
  const raw = String((await $.env.get('CLAUDE_CODE_PLUGIN_DIRS')) || '')
  let parts = raw.split(';')
  if (parts.length === 1) {
    parts = []
    for (const piece of raw.split(':')) {
      const last = parts[parts.length - 1]
      if (last !== undefined && /^[A-Za-z]$/.test(last.trim()) && /^[\\/]/.test(piece))
        parts[parts.length - 1] = `${last.trim()}:${piece}`
      else parts.push(piece)
    }
  }
  return parts
    .map(x => norm(x.trim()).replace(/\/+$/, ''))
    .filter(x => x !== '')
    .map(x => (x === '~' ? home : x.startsWith('~/') ? home + x.slice(1) : x))
}

// The hooks code of a plugin folder, tests left out, or undefined when it is
// no mod: a mod has a hooks.json naming modules. Read: the code files in
// hooks/, and each module hooks.json names wherever it sits.
const isCode = (name: string) => /\.(tsx?|jsx?|[mc][jt]s)$/.test(name) && !/\.test\./.test(name)
async function hooksCode($: any, dir: string) {
  const hooks = await readObject($, `${dir}/hooks/hooks.json`)
  if (!Array.isArray(hooks?.modules) || hooks.modules.length === 0) return undefined
  const files = new Set<string>(
    (await listSafe($, `${dir}/hooks`))
      .filter(x => x.kind === 'file' && isCode(x.name))
      .map(x => `${dir}/hooks/${x.name}`),
  )
  for (const mod of hooks.modules)
    if (typeof mod === 'string' && isCode(mod)) {
      const parts = `${dir}/hooks`.split('/')
      for (const step of norm(mod).split('/'))
        if (step === '..') parts.pop()
        else if (step !== '.' && step !== '') parts.push(step)
      files.add(parts.join('/'))
    }
  const texts = await Promise.all([...files].map(f => readSafe($, f)))
  return texts.join(NL)
}

async function inspectMod($: any, dir: string, id: string): Promise<ModInfo | undefined> {
  const manifest = await readObject($, `${dir}/.claude-plugin/plugin.json`)
  if (manifest === undefined) return undefined
  const name = String(manifest.name || dir.split('/').pop() || '')
  if (name === '' || name === 'plugin-toggles') return undefined
  const code = await hooksCode($, dir)
  if (code === undefined) return undefined
  const commands = [
    ...new Set(
      [...code.matchAll(/command\.register\(\s*\{\s*name:\s*['"`]([^'"`]+)['"`]/g)].map(m => `/${m[1]}`),
    ),
  ]
  return {
    name,
    title: name
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' '),
    desc: String(manifest.description ?? ''),
    tip: commands.join(', '),
    switchable: code.includes('switches.json'),
    hideable: code.includes(':hidden'),
    pane: code.includes('.open-'),
    id,
    dir,
  }
}

// The last change, said under the list.
const modNote = atom({ plugin: 'plugin-toggles', key: 'modNote' } as const, '', {
  shape: 'modNote-1',
})

// Asks the mod, in this chat, to open its pane: it looks for the file every few seconds.
async function openMod($: any, m: ModInfo) {
  const { mods } = await paths($)
  const json = await readJson($, `${mods}/switches.json`)
  if (json[m.name] === false || json[`${m.name}:hidden`] === true) {
    await update($, modNote, () => `${m.title} is ${json[m.name] === false ? 'off' : 'hidden'}. Turn it on and show it first.`)
    return
  }
  const sid = String(await $.session.id())
  await $.fs.write(`${mods}/.open-${m.name}-${sid}`, '')
  await update($, modNote, () => `${m.title} opens in this chat within a few seconds.`)
}

// Flips the mod's On or Shown key: a set key is deleted, a missing one set.
async function flipMod($: any, m: ModInfo, hide: boolean) {
  const key = hide ? `${m.name}:hidden` : m.name
  let was = false
  let isOff = false
  const wrote = await rewrite($, await switchesFile($), json => {
    // Shown means nothing while the mod is off.
    if (hide && json[m.name] === false) {
      isOff = true
      return false
    }
    was = hide ? json[key] === true : json[key] === false
    if (was) delete json[key]
    else json[key] = hide
  })
  if (isOff) await update($, modNote, () => `${m.title} is off. Turn it on first.`)
  if (!wrote) return
  await update($, rev, n => n + 1)
  const now = hide ? (was ? 'shown' : 'hidden') : was ? 'on' : 'off'
  await update($, modNote, () => `${m.title} is ${now} in every chat.`)
}

// Every mod on this computer: those installed from a marketplace, those in
// ~/.claude/mods and those CLAUDE_CODE_PLUGIN_DIRS names, switchable ones
// first, A to Z within each part. Kept ten seconds, as drawing the pane reads
// it again on each change; draws that overlap share one scan.
let modsCache: { at: number; list: Promise<ModInfo[]> } | undefined
async function modsNow($: any) {
  const at = Number(await $.clock.now())
  // A clock that went back counts as stale too.
  if (modsCache && at >= modsCache.at && at - modsCache.at < 10_000) return modsCache.list
  const list = scanMods($)
  modsCache = { at, list }
  // A scan that failed is not kept.
  list.catch(() => {
    if (modsCache?.list === list) modsCache = undefined
  })
  return list
}

async function scanMods($: any) {
  const { home, mods } = await paths($)
  const [roots, local, env] = await Promise.all([installRoots($), dirsIn($, mods), envDirs($, home)])
  const found: [string, string][] = [
    ...[...roots].map(([id, d]): [string, string] => [d, id]),
    ...[...local, ...env].map((d): [string, string] => [d, '']),
  ]
  const seen = new Set<string>()
  const list: ModInfo[] = []
  for (const mod of await Promise.all(found.map(([d, id]) => inspectMod($, d, id))))
    if (mod && !seen.has(mod.name)) {
      seen.add(mod.name)
      list.push(mod)
    }
  return list.sort((a, b) => Number(b.switchable) - Number(a.switchable) || a.name.localeCompare(b.name))
}

async function setMode($: any, kind: string, name: string, mode: Mode) {
  if (kind === 'mcp') return toggleMcp($, name, mode === 'on')
  const source = await outranking($, kind === 'plugins' ? 'enabledPlugins' : 'skillOverrides', name)
  if (source !== undefined) {
    $.ui.toast(`${name} is set in ${ABOVE_SAYS[source]}, which outranks settings.json. Change it there.`)
    return
  }
  if (kind === 'plugins') await writeSwitch($, 'enabledPlugins', name, mode === 'on')
  else await writeSwitch($, 'skillOverrides', name, mode)
}

// From a row to the tab that switches it: a plugin's skill to its plugin,
// a mod's tools to the Mods tab.
async function goTo($: any, to: string, filter: string) {
  await update($, query, () => filter)
  await update($, tab, () => to)
}

function pendingBanner($: any, e: any, count: number, canReload: boolean) {
  const { Box, Text, Button } = $.ui.resolve(e)
  if (count === 0) return null
  return (
    <Box key="pending" justifyContent="space-between" alignItems="center" paddingX={1}>
      <Box flexDirection="column">
        <Text bold>
          {count} change{count === 1 ? '' : 's'} saved
        </Text>
        <Text dimColor>
          {canReload
            ? 'Written to settings. Apply now reloads plugins so they take effect here.'
            : 'Written to settings. They take effect in a new session.'}
        </Text>
      </Box>
      {canReload && (
        <Button key="apply" label="Apply now" variant="primary" onPress={() => applyNow($)} />
      )}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'toggles',
      description: 'Switch plugins, skills, MCP servers and mods on and off',
    })
    return next(e)
  })

  on('command.run', { command: 'toggles' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Toggles' })
    return { text: 'Toggles pane opened.' }
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { Box, Button } = $.ui.resolve(e)
    const hint = await next(e)
    const pending = await read($, dirty)
    return (
      <Box>
        {hint}
        <Button
          key="open"
          label={pending > 0 ? `⚙ Toggles · ${pending} pending` : '⚙ Toggles'}
          onPress={() => $.ui.open({ id: PANE, title: 'Toggles' })}
        />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // Independent reads, at once: each is a trip through the host.
    const [, pending, commands, current, now, typed] = await Promise.all([
      read($, rev),
      read($, dirty),
      $.command.list(),
      read($, tab),
      loadedNow($),
      read($, query),
    ])
    const canReload = hasReload(commands)
    const { Box, Text, Button, Input, Svg } = $.ui.resolve(e) as any
    if (current === 'profiles') {
      const all = await readJson($, await profilesPath($))
      const named = await read($, draft)
      // An entry edited by hand into something else is no profile.
      const names = Object.keys(all)
        .filter(n => isObject(all[n]))
        .sort()
      const weights = await Promise.all(
        names.map(async n => {
          const plugins = (all[n].plugins ?? {}) as Record<string, boolean>
          const rows = await Promise.all(
            Object.keys(plugins)
              .filter(id => plugins[id])
              .map(id => pluginRow($, id, true, now)),
          )
          return rows.reduce((sum, r) => sum + r.tokens, 0)
        }),
      )
      return (
        <Box flexDirection="column" gap={1} padding={1}>
          {tabs($, e, current)}
          <Text dimColor>{TAB_HELP[current]}</Text>
          {pendingBanner($, e, pending, canReload)}
          <Text bold>New profile</Text>
          <Text dimColor>
            1. Set plugins and skills the way you want them. 2. Type a name. 3. Save. The profile
            remembers which plugins are on and where each skill's switch is right now.
          </Text>
          {Input && (
            <Input
              key="name"
              placeholder="Profile name, e.g. Work or Minimal"
              value={named}
              onInput={(v: string) => update($, draft, () => v)}
              onSubmit={(v: string) => saveProfile($, v)}
            />
          )}
          <Button
            key="save"
            label="Save current as profile"
            variant="primary"
            onPress={() => saveProfile($, named)}
          />
          <Text bold>Saved profiles</Text>
          {names.length === 0 && (
            <Text dimColor>None yet. Save one above to switch setups with a single click.</Text>
          )}
          {names.map((n, i) => {
            const plugOn = Object.values(all[n].plugins ?? {}).filter(Boolean).length
            const set = Object.values(all[n].skills ?? {}) as string[]
            const count = (m: Mode) => set.filter(v => v === m).length
            const skillOff = count('off')
            const trimmed = (['name-only', 'user-invocable-only'] as const)
              .filter(m => count(m) > 0)
              .map(m => `, ${count(m)} ${MODE_SAYS[m]}`)
              .join('')
            const weight = weights[i] ?? 0
            const cost = weight > 0 ? ` · ≈${fmt(weight)} tokens a turn` : ''
            return (
              <Box
                key={n}
                justifyContent="space-between"
                alignItems="center"
                borderStyle="round"
                borderDimColor
                paddingX={1}
              >
                <Box flexDirection="column">
                  <Text bold>{n}</Text>
                  <Text dimColor>
                    {plugOn} plugins on, {skillOff} skills off{trimmed}{cost}. Apply sets the
                    switches it names and leaves the rest.
                  </Text>
                </Box>
                <Box gap={1}>
                  <Button
                    key={`a-${n}`}
                    label="Apply profile"
                    variant="primary"
                    onPress={() => applyProfile($, n)}
                  />
                  <Button
                    key={`d-${n}`}
                    label="Delete"
                    variant="secondary"
                    onPress={() => deleteProfile($, n)}
                  />
                </Box>
              </Box>
            )
          })}
        </Box>
      )
    }
    if (current === 'mods') {
      const [mods, switches, plugins, said] = await Promise.all([
        modsNow($),
        switchesFile($).then(p => readJson($, p)),
        switchesNow($).then(s => s.enabledPlugins as Record<string, boolean>),
        read($, modNote),
      ])
      const chrome = e.surface === 'terminal' ? { variant: 'secondary' as const } : {}
      // Where pictures draw, a switch is a green pill under a blank plain
      // button (the engine has no Switch element) and `glyph` is a one-glyph
      // button. Elsewhere, a button with a green dot when lit. A control that
      // is not live is a dim word or glyph; the On switch always is live.
      const pictures = Boolean(Svg) && e.surface !== 'terminal'
      const control = (
        key: string,
        label: string,
        live: boolean,
        lit: boolean,
        press: () => unknown,
        glyph?: string,
      ) => {
        if (pictures && glyph !== undefined)
          return live ? (
            <Button key={key} label={glyph} plain dimColor={!lit} onPress={press} />
          ) : (
            <Text key={key} dimColor>
              {glyph}
            </Text>
          )
        if (pictures)
          return pressable($, e, key, pill(lit), label, 44, press)
        return !live ? (
          <Text key={key} dimColor>
            {label}
          </Text>
        ) : (
          <Box key={`${key}-box`} alignItems="center" gap={0}>
            {lit && <Text color={GOOD}>●</Text>}
            <Button key={key} label={label} dimColor={!lit} {...chrome} onPress={press} />
          </Box>
        )
      }
      return (
        <Box flexDirection="column" gap={1} padding={1}>
          {tabs($, e, current)}
          {mods.length === 0 && <Text dimColor>No mods found.</Text>}
          {mods.map(m => {
            const off = m.switchable && switches[m.name] === false
            const hidden = switches[`${m.name}:hidden`] === true
            const pluginOff = m.id !== '' && plugins[m.id] === false
            return (
              <Box key={`mod:${m.name}`} alignItems="flex-start" justifyContent="space-between" gap={1}>
                <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
                  <Text bold dimColor={off} wrap="truncate-end">
                    {m.title}
                  </Text>
                  {m.desc !== '' && (
                    <Text dimColor wrap="truncate-end">
                      {m.desc}
                    </Text>
                  )}
                  {m.tip !== '' && (
                    <Text dimColor italic wrap="truncate-end">
                      {m.tip}
                    </Text>
                  )}
                  {pluginOff && (
                    <Text color="warning" wrap="truncate-end">
                      Plugin off in the Plugins tab, so it does not run.
                    </Text>
                  )}
                  {!m.switchable && (
                    <Text dimColor wrap="wrap">
                      {m.id !== ''
                        ? 'No switch: its code does not read switches.json. Turn it off in the Plugins tab.'
                        : `No switch: its code does not read switches.json. Remove its folder to stop it: ${m.dir}`}
                    </Text>
                  )}
                </Box>
                {m.switchable && (
                  <Box gap={1} flexShrink={0}>
                    {m.pane &&
                      (off || hidden ? (
                        <Text dimColor>Open</Text>
                      ) : (
                        <Button key={`mods-open:${m.name}`} label="Open" {...chrome} onPress={() => openMod($, m)} />
                      ))}
                    {m.hideable &&
                      control(
                        `mods-shown:${m.name}`,
                        hidden ? 'Hidden' : 'Shown',
                        !off,
                        !hidden,
                        () => flipMod($, m, true),
                        '\u{1F441}',
                      )}
                    {control(`mods:${m.name}`, off ? 'Off' : 'On', true, !off, () => flipMod($, m, false))}
                  </Box>
                )}
              </Box>
            )
          })}
          <Box flexDirection="column">
            {said !== '' && (
              <Text color={GOOD} wrap="truncate-end">
                {said}
              </Text>
            )}
            <Text dimColor wrap="wrap">
              Off means off in every chat. Hidden keeps it on but out of sight. Changes apply within a few seconds.
            </Text>
            <Text dimColor wrap="wrap">
              New mods show up the next time you open this tab.
            </Text>
          </Box>
        </Box>
      )
    }
    let rows: Row[] = []
    let noun = ''
    let note = ''
    let warn = false

    if (current === 'plugins') {
      const map = (await switchesNow($)).enabledPlugins as Record<string, boolean>
      rows = await Promise.all(
        Object.keys(map)
          .sort()
          .map(id => pluginRow($, id, map[id] !== false, now)),
      )
      noun = 'plugins'
    } else if (current === 'skills') {
      const overrides = (await switchesNow($)).skillOverrides as Record<string, string>
      const modeOf = (name: string): Mode =>
        MODES.find(m => m === overrides[name]) ?? 'on'
      // A plugin's commands come in the list with its skills. The engine's
      // count names the skills alone, so where there is one, a plugin entry it
      // does not name is a command and gets no row.
      const listed = commands.filter(
        c =>
          c.name !== 'toggles' &&
          (c.source === 'user' ||
            (c.source === 'plugin' && (now === null || now.skills.has(c.name)))),
      )
      const seen = new Set(listed.map(c => c.name))
      rows = listed.map((c): Row => {
        const measured = now?.skills.get(c.name)
        const desc = String(c.description ?? '')
        const full = lineCost(c.name, desc)
        // The engine reads no skillOverrides entry for a plugin's skill: the
        // plugin switches it, so the row leads there.
        if (c.source === 'plugin')
          return {
            name: c.name,
            label: c.name,
            mode: 'on',
            modes: [],
            plugin: c.plugin ?? '',
            tokens: measured ?? full,
            exact: measured !== undefined,
            weight: measured ?? full,
            group: c.plugin || 'plugins',
            meta: c.plugin ? `from ${c.plugin}` : 'from a plugin',
            desc: desc || 'No description.',
            more: 'Switched with its plugin: Claude Code has no per-skill switch for a plugin’s skills.',
          }
        const mode = modeOf(c.name)
        const bare = lineCost(c.name, '')
        // A count near the bare name's was taken while the skill was listed by
        // name alone, and says nothing of what its description costs.
        const short = measured !== undefined && measured * 2 < full + bare
        const onCost = short ? full : (measured ?? full)
        const onExact = !short && measured !== undefined
        const nameCost = short ? (measured ?? bare) : bare
        return {
          name: c.name,
          label: c.name,
          mode,
          modes: MODES,
          tokens: mode === 'on' ? onCost : mode === 'name-only' ? nameCost : 0,
          exact: mode === 'on' ? onExact : mode === 'name-only' ? short : true,
          weight: onCost,
          group: 'your files',
          meta: 'from your files',
          desc: desc || 'No description.',
          more: `On ${tag(onCost, onExact)} · Name ${tag(nameCost, short)} · User and Off 0 tokens`,
        }
      })
      // A skill switched off drops out of the command list: keep its row so it
      // can be switched back.
      for (const name of Object.keys(overrides)) {
        const mode = modeOf(name)
        if (mode === 'on' || seen.has(name)) continue
        rows.push({
          name,
          label: name,
          mode,
          modes: MODES,
          tokens: 0,
          exact: false,
          weight: 0,
          group: '',
          meta: '',
          desc: 'Not in the command list now. Its description shows again once it is back.',
          more: '',
        })
      }
      // A plugin's skills share one row, as the plugin switches them all. A
      // row apiece made a list too long for a desktop to draw: it drops a
      // tree over 262144 characters, and the tab would not open.
      const from = new Map<string, Row[]>()
      for (const r of rows) if (r.plugin !== undefined) from.set(r.plugin, [...(from.get(r.plugin) ?? []), r])
      rows = [
        ...rows.filter(r => r.plugin === undefined),
        ...[...from].map(([plugin, list]): Row => {
          const tokens = list.reduce((n, r) => n + r.tokens, 0)
          return {
            name: `plugin:${plugin}`,
            label: plugin || 'Plugins',
            mode: 'on',
            modes: [],
            plugin,
            tokens,
            exact: list.every(r => r.exact),
            weight: tokens,
            group: plugin || 'plugins',
            meta: `${list.length} skill${list.length === 1 ? '' : 's'} ${plugin ? `from ${plugin}` : 'from plugins'}`,
            desc: list.length > 20
              ? `${list.slice(0, 20).map(r => r.name).join(', ')} and ${list.length - 20} more`
              : list.map(r => r.name).join(', '),
            more: 'Switched with its plugin: Claude Code has no per-skill switch for a plugin’s skills.',
            skills: list.map(r => r.name),
          }
        }),
      ]
      noun = 'skills'
      const fit = now?.fit
      if (fit && fit.included < fit.total) {
        const left = fit.total - fit.included
        note = `${left} skill${left === 1 ? '' : 's'} don't fit the listing budget, so Claude can't see them. Switch some off.`
        warn = true
      }
    } else {
      rows = await mcpRows($, now)
      noun = 'servers'
      note = 'Tools that load on demand are not counted until Claude loads them.'
    }

    // The bar shows everything Claude sees, whatever the filter hides.
    const lit = rows.filter(r => inContext(r.mode))
    const count = (list: Row[]) => list.reduce((n, r) => n + (r.skills?.length ?? 1), 0)
    const total = lit.reduce((n, r) => n + r.tokens, 0)
    const byGroup = new Map<string, number>()
    for (const r of lit) if (r.tokens > 0) byGroup.set(r.group, (byGroup.get(r.group) ?? 0) + r.tokens)
    const segs = [...byGroup]
      .sort((a, b) => b[1] - a[1])
      .map(([group, tokens], i) => ({ group, tokens, colour: PALETTE[i % PALETTE.length] ?? '#8C9BB0' }))
    const colour = new Map(segs.map(s => [s.group, s.colour]))
    if (current === 'plugins' && pending > 0 && now) {
      const loaded = rows.reduce((n, r) => n + (r.exact ? r.tokens : 0), 0)
      if (loaded !== total) note = `${fmt(loaded)} loaded now, ${fmt(total)} after a reload.`
    }
    const caption =
      current === 'mcp'
        ? `tokens of tool schemas · ${lit.length} of ${rows.length} ${noun} on`
        : `tokens in every turn · ${count(lit)} of ${count(rows)} ${noun} ${current === 'skills' ? 'listed' : 'on'}`

    // Rows keep their place when switched, heaviest first: the user's own
    // skills, which have the full switch, above those plugins bring.
    const needle = typed.toLowerCase()
    const shown = rows.filter(r => [r.name, ...(r.skills ?? [])].some(n => n.toLowerCase().includes(needle)))
    // The MCP tab lists by source, heaviest first within each.
    const bySource = (a: Row, b: Row) =>
      SOURCES.indexOf(a.source ?? 'user') - SOURCES.indexOf(b.source ?? 'user') || heavy(a, b)
    const candidates = [
      ...shown.filter(r => r.plugin === undefined).sort(current === 'mcp' ? bySource : heavy),
      ...shown.filter(r => r.plugin !== undefined).sort(heavy),
    ].slice(0, SHOWN)
    const title =
      current === 'skills' ? 'YOUR SKILLS' : 'PLUGINS'
    const draw = (visible: Row[]) => {
      const scopeOf = new Map(visible.map((r, i) => [r.name, `tg-${i}`]))
      const own = visible.filter(r => r.plugin === undefined)
      const borrowed = visible.filter(r => r.plugin !== undefined)
      return (
        <Box flexDirection="column" gap={1} padding={1}>
          {tabs($, e, current)}
          {pendingBanner($, e, pending, canReload)}
          {gauge($, e, segs, total, caption, note, warn)}
          {inspector($, e, visible, scopeOf, TAB_HELP[current] ?? '')}
          {Input && (
            <Input
              key="q"
              placeholder="Filter by name"
              value={typed}
              onInput={(v: string) => update($, query, () => v)}
              onSubmit={(v: string) => update($, query, () => v)}
            />
          )}
          {shown.length === 0 && <Text dimColor>Nothing found.</Text>}
          {current === 'mcp'
            ? SOURCES.map(src =>
                section($, e, current, SOURCE_TITLE[src], own.filter(r => r.source === src), scopeOf, colour),
              )
            : [
                section($, e, current, title, own, scopeOf, colour),
                section($, e, current, 'FROM PLUGINS', borrowed, scopeOf, colour),
              ]}
          {shown.length > visible.length && (
            <Text dimColor>... {count(shown) - count(visible)} more, narrow the filter</Text>
          )}
        </Box>
      )
    }
    // The base: all but the rows, and the two section headers an empty list
    // leaves out (a Box, a Text and its string each).
    const used = weigh(draw([]))
    used.nodes += 3 * (current === 'mcp' ? SOURCES.length : 2)
    const visible: Row[] = []
    for (const r of candidates) {
      if (e.surface === 'terminal') {
        visible.push(r)
        continue
      }
      const scope = `tg-${visible.length}`
      const w = weigh([row($, e, current, r, scope, colour.get(r.group)), card($, e, r, scope)])
      if (used.nodes + w.nodes > MAX_NODES || used.chars + w.chars > MAX_CHARS) break
      used.nodes += w.nodes
      used.chars += w.chars
      visible.push(r)
    }
    return draw(visible)
  })
}
