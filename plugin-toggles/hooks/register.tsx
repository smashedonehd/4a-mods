import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

const PANE = 'plugin-toggles'
const NL = String.fromCharCode(10)
const BS = String.fromCharCode(92)
const norm = (p: string) => p.split(BS).join('/')
const query = atom({ plugin: 'plugin-toggles', key: 'q' } as const, '', {
  shape: 'q-1',
})
const TABS = ['profiles', 'plugins', 'skills', 'mcp'] as const
const TAB_LABEL: Record<string, string> = {
  profiles: 'Profiles',
  plugins: 'Plugins',
  skills: 'Skills',
  mcp: 'MCP',
}
const TAB_HELP: Record<string, string> = {
  profiles: 'Saved sets of plugins and skills. Apply switches the whole set in one click.',
  plugins: 'Switch a plugin on or off. Point at one to see what it adds.',
  skills:
    'On lists a skill with its description, Name by its name alone. User hides it from Claude but keeps /name for you. Off hides it from both.',
  mcp: 'Switch an MCP server on or off for this project. Reconnect with /mcp.',
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
// Chips drawn at most; the filter narrows the rest.
const SHOWN = 200
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

async function readJson($: any, path: string) {
  try {
    return parse(String(await $.fs.read(path)))
  } catch {
    return {} as Record<string, any>
  }
}

// Claude Code's own folder, its settings.json and the global config, where
// the engine finds them: under CLAUDE_CONFIG_DIR when set, else at home.
async function paths($: any) {
  const home = norm(String((await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''))
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  const dir = config ? norm(String(config)).replace(/\/+$/, '') : `${home}/.claude`
  return {
    dir,
    settings: `${dir}/settings.json`,
    global: config ? `${dir}/.claude.json` : `${home}/.claude.json`,
  }
}

// Rewrites a JSON file through `change`. One that is there but does not read
// or parse is left whole and the press says so: written over, it would keep
// only the key changed.
async function rewrite($: any, path: string, change: (json: Record<string, any>) => void) {
  let json: Record<string, any>
  try {
    json = (await $.fs.exists(path)) ? parse(String(await $.fs.read(path))) : {}
    if (json === null || typeof json !== 'object' || Array.isArray(json)) throw new Error('not an object')
  } catch {
    $.ui.toast(`Could not read ${path}, so nothing was changed. Fix the file and try again.`)
    return false
  }
  change(json)
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
  const own = await readJson($, (await paths($)).settings)
  const above = await aboveNow($)
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
  hooks: string[]
}
const infoCache = new Map<string, Info | null>()

async function pluginInfo($: any, id: string): Promise<Info | null> {
  if (infoCache.has(id)) return infoCache.get(id) ?? null
  const reg = await readJson($, `${(await paths($)).dir}/plugins/installed_plugins.json`)
  const entry = (reg.plugins?.[id] ?? [])[0]
  if (!entry?.installPath) {
    infoCache.set(id, null)
    return null
  }
  const root = norm(String(entry.installPath))
  const manifest = await readJson($, `${root}/.claude-plugin/plugin.json`)
  const items = async (dir: string, file: (n: string) => string | null) => {
    const out: Item[] = []
    for (const f of await listSafe($, `${root}/${dir}`)) {
      const rel = file(f.name)
      if (!rel) continue
      const fm = frontmatter(await readSafe($, `${root}/${dir}/${rel}`))
      out.push({ name: fm.name || f.name.replace(/\.md$/, ''), desc: fm.description ?? '' })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }
  const mcpJson = await readJson($, `${root}/.mcp.json`)
  const hooksJson = await readJson($, `${root}/hooks/hooks.json`)
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
    skills: await items('skills', n => `${n}/SKILL.md`),
    commands: await items('commands', n => (n.endsWith('.md') ? n : null)),
    agents: await items('agents', n => (n.endsWith('.md') ? n : null)),
    mcp: Object.keys(mcpJson.mcpServers ?? mcpJson),
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
  fit: { included: number; total: number } | null
}

async function loadedNow($: any): Promise<Loaded | null> {
  try {
    const b = (await $.session.usage({ breakdown: 'summary' })).context.breakdown
    if (!b) return null
    const add = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n)
    const out: Loaded = { byPlugin: new Map(), skills: new Map(), servers: new Map(), fit: null }
    for (const s of b.skills?.skillFrontmatter ?? []) {
      out.skills.set(s.name, s.tokens)
      if (s.pluginName) add(out.byPlugin, s.pluginName.split('@')[0], s.tokens)
    }
    if (b.skills) out.fit = { included: b.skills.includedSkills, total: b.skills.totalSkills }
    for (const a of b.agents ?? []) {
      const at = a.agentType.indexOf(':')
      if (a.source === 'plugin' && at > 0) add(out.byPlugin, a.agentType.slice(0, at), a.tokens)
    }
    for (const t of b.mcpTools ?? []) if (t.isLoaded) add(out.servers, t.serverName, t.tokens)
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
      {note !== '' &&
        (warn ? (
          <Text color="warning">
            {note}
          </Text>
        ) : (
          <Text dimColor>
            {note}
          </Text>
        ))}
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
      {rows.map(r => {
        const meta = [
          MODE_SAYS[r.mode],
          r.meta,
          r.tokens > 0 && `${r.exact ? '' : '~'}${fmt(r.tokens)} tokens`,
        ]
          .filter(Boolean)
          .join(' · ')
        return (
          <Box
            display="none"
            hover={{ scope: scopeOf.get(r.name), display: 'flex' }}
            flexDirection="column"
            minHeight={3}
          >
            <Text wrap="truncate-end">
              <Text bold>{r.label}</Text>
              <Text dimColor>{`  ${meta}`}</Text>
            </Text>
            <Text wrap="truncate-end">{r.desc}</Text>
            <Text wrap="truncate-end" dimColor>
              {r.more || ' '}
            </Text>
          </Box>
        )
      })}
      <Text dimColor>{help}</Text>
    </Box>
  )
}

// One Button a position. The terminal would draw a bordered Box three rows
// high, so there they are bracketed Buttons, the current one in the accent.
// Elsewhere they sit chromeless in one rounded capsule, the current one on
// its fill. Older engines take only a plain label on a Button: 2.1.282
// refuses the whole tree otherwise.
function toggle($: any, e: any, kind: string, r: Row) {
  const { Box, Button } = $.ui.resolve(e)
  const terminal = e.surface === 'terminal'
  const buttons = r.modes.map(m => {
    const on = m === r.mode
    const button = (
      <Button
        key={`${kind}:${r.name}:${m}`}
        label={MODE_LABEL[m]}
        {...(terminal ? { variant: on ? 'primary' : 'secondary' } : { plain: true })}
        dimColor={!on}
        onPress={() => setMode($, kind, r.name, m)}
      />
    )
    if (terminal) return button
    return (
      <Box paddingX={1} {...(on ? { backgroundColor: MODE_FILL[m] } : {})}>
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

// The dot that ties a row to its bar segment, the name and what it costs now,
// then the switch. The name takes the room left and is cut short, never the
// switch. No size, weight or tabular Text props: 2.1.282 refuses them.
function row($: any, e: any, kind: string, r: Row, scope: string, colour: string | undefined) {
  const { Box, Button, Text } = $.ui.resolve(e)
  const lit = inContext(r.mode)
  const cost = r.tokens > 0 ? `${r.exact ? '' : '~'}${fmt(r.tokens)}` : ''
  return (
    <Box key={`${kind}-row:${r.name}`} hover={{ scope }} alignItems="center" gap={1}>
      <Box alignItems="center" gap={1} flexGrow={1} flexShrink={1} minWidth={0}>
        {lit ? <Text color={colour ?? 'inactive'}>●</Text> : <Text dimColor>○</Text>}
        <Text wrap="truncate-end" bold={lit} dimColor={!lit}>
          {r.label}
        </Text>
        {cost !== '' && <Text dimColor>{cost}</Text>}
      </Box>
      {r.plugin !== undefined ? (
        <Button
          key={`${kind}:${r.name}:plugin`}
          label={`${r.plugin || 'Plugins'} ›`}
          {...(e.surface === 'terminal' ? { variant: 'secondary' } : { plain: true })}
          dimColor
          onPress={() => showPlugin($, r.plugin ?? '')}
        />
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

async function applyNow($: any) {
  try {
    await $.command.run({ command: 'reload-plugins' })
    await update($, dirty, () => 0)
    $.ui.toast('Plugins and skills reloaded.')
  } catch {
    $.ui.toast('Could not reload here. The changes take effect in a new chat.')
  }
}

async function reloadable($: any) {
  return (await $.command.list()).some((c: { name: string }) => c.name === 'reload-plugins')
}

async function togglePlugin($: any, id: string, isOn: boolean) {
  const wrote = await rewrite($, (await paths($)).settings, json => {
    json.enabledPlugins = { ...(json.enabledPlugins ?? {}), [id]: isOn }
  })
  if (!wrote) return
  await markDirty($)
  await update($, rev, n => n + 1)
}

async function setSkillMode($: any, name: string, mode: Mode) {
  const wrote = await rewrite($, (await paths($)).settings, json => {
    const next = { ...(json.skillOverrides ?? {}) }
    if (mode === 'on') delete next[name]
    else next[name] = mode
    json.skillOverrides = next
  })
  if (!wrote) return
  await markDirty($)
  await update($, rev, n => n + 1)
}

// The engine keys a project in ~/.claude.json by where its session started,
// which a shell cd does not move.
async function projectKey($: any) {
  return norm(String(await $.session.root()))
}

async function toggleMcp($: any, name: string, isOn: boolean) {
  const key = await projectKey($)
  await rewrite($, (await paths($)).global, json => {
    const projects = json.projects ?? {}
    const project = projects[key] ?? {}
    const off = new Set<string>(project.disabledMcpServers ?? [])
    if (isOn) off.delete(name)
    else off.add(name)
    projects[key] = { ...project, disabledMcpServers: [...off] }
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
  const cur = await readJson($, (await paths($)).settings)
  const wrote = await rewrite($, await profilesPath($), all => {
    all[clean] = {
      plugins: cur.enabledPlugins ?? {},
      skills: cur.skillOverrides ?? {},
    }
  })
  if (!wrote) return
  await update($, draft, () => '')
  await update($, rev, n => n + 1)
}

async function applyProfile($: any, name: string) {
  const all = await readJson($, await profilesPath($))
  const picked = all[name]
  if (!picked) return
  const wrote = await rewrite($, (await paths($)).settings, json => {
    json.enabledPlugins = { ...(json.enabledPlugins ?? {}), ...picked.plugins }
    json.skillOverrides = picked.skills ?? {}
  })
  if (!wrote) return
  await markDirty($)
  if (await reloadable($)) await applyNow($)
  await update($, rev, n => n + 1)
}

async function deleteProfile($: any, name: string) {
  await rewrite($, await profilesPath($), all => {
    delete all[name]
  })
  await update($, rev, n => n + 1)
}

async function setMode($: any, kind: string, name: string, mode: Mode) {
  if (kind === 'mcp') return toggleMcp($, name, mode === 'on')
  const source = await outranking($, kind === 'plugins' ? 'enabledPlugins' : 'skillOverrides', name)
  if (source !== undefined) {
    $.ui.toast(`${name} is set in ${ABOVE_SAYS[source]}, which outranks settings.json. Change it there.`)
    return
  }
  if (kind === 'plugins') await togglePlugin($, name, mode === 'on')
  else await setSkillMode($, name, mode)
}

// From a plugin's skill to the plugin that switches it.
async function showPlugin($: any, plugin: string) {
  await update($, query, () => plugin)
  await update($, tab, () => 'plugins')
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
      description: 'Switch plugins, skills and MCP servers on and off',
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
    await read($, rev)
    const pending = await read($, dirty)
    const commands = await $.command.list()
    const canReload = commands.some(c => c.name === 'reload-plugins')
    const current = await read($, tab)
    const { Box, Text, Button } = $.ui.resolve(e)
    const Input = ($.ui.resolve(e) as any).Input
    const now = await loadedNow($)
    if (current === 'profiles') {
      const all = (await readJson($, await profilesPath($))) as Record<string, any>
      const named = await read($, draft)
      const names = Object.keys(all).sort()
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
                    {plugOn} plugins on, {skillOff} skills off{trimmed}{cost}. Apply sets every
                    switch exactly so.
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
    const settings = await switchesNow($)
    let rows: Row[] = []
    let noun = ''
    let note = ''
    let warn = false

    if (current === 'plugins') {
      const map = (settings.enabledPlugins ?? {}) as Record<string, boolean>
      rows = await Promise.all(
        Object.keys(map)
          .sort()
          .map(id => pluginRow($, id, map[id] !== false, now)),
      )
      noun = 'plugins'
    } else if (current === 'skills') {
      const overrides = (settings.skillOverrides ?? {}) as Record<string, string>
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
      const tag = (n: number, exact: boolean) => `${exact ? '' : '~'}${fmt(n)}`
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
      noun = 'skills'
      const fit = now?.fit
      if (fit && fit.included < fit.total) {
        const left = fit.total - fit.included
        note = `${left} skill${left === 1 ? '' : 's'} don't fit the listing budget, so Claude can't see them. Switch some off.`
        warn = true
      }
    } else {
      const user = await readJson($, (await paths($)).global)
      const project = user.projects?.[await projectKey($)] ?? {}
      const off = new Set<string>(project.disabledMcpServers ?? [])
      const names = new Set<string>([
        ...Object.keys(user.mcpServers ?? {}),
        ...Object.keys(project.mcpServers ?? {}),
        ...off,
      ])
      rows = [...names].map((name): Row => {
        const own = project.mcpServers?.[name]
        const cfg = own ?? user.mcpServers?.[name]
        const measured = now?.servers.get(name) ?? now?.servers.get(wire(name))
        return {
          name,
          label: name,
          mode: off.has(name) ? 'off' : 'on',
          modes: TWO,
          tokens: measured ?? 0,
          exact: measured !== undefined,
          weight: measured ?? 0,
          group: name,
          meta: cfg ? `${own ? 'project' : 'global'} server` : '',
          desc: !cfg
            ? 'Not configured here, only listed as disabled.'
            : cfg.url
              ? String(cfg.url)
              : [cfg.command, ...(cfg.args ?? [])].join(' '),
          more: '',
        }
      })
      noun = 'servers'
      note = 'Tools that load on demand are not counted until Claude loads them.'
    }

    // The bar shows everything Claude sees, whatever the filter hides.
    const lit = rows.filter(r => inContext(r.mode))
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
        : `tokens in every turn · ${lit.length} of ${rows.length} ${noun} ${current === 'skills' ? 'listed' : 'on'}`

    // Rows keep their place when switched, heaviest first: the user's own
    // skills, which have the full switch, above those plugins bring.
    const typed = await read($, query)
    const needle = typed.toLowerCase()
    const shown = rows.filter(r => r.name.toLowerCase().includes(needle))
    const own = shown.filter(r => r.plugin === undefined).sort(heavy).slice(0, SHOWN)
    const borrowed = shown
      .filter(r => r.plugin !== undefined)
      .sort(heavy)
      .slice(0, Math.max(0, SHOWN - own.length))
    const visible = [...own, ...borrowed]
    const scopeOf = new Map(visible.map((r, i) => [r.name, `tg-${i}`]))
    const title =
      current === 'skills' ? 'YOUR SKILLS' : current === 'mcp' ? 'SERVERS' : 'PLUGINS'

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
        {section($, e, current, title, own, scopeOf, colour)}
        {section($, e, current, 'FROM PLUGINS', borrowed, scopeOf, colour)}
        {shown.length > visible.length && (
          <Text dimColor>... {shown.length - visible.length} more, narrow the filter</Text>
        )}
      </Box>
    )
  })
}
