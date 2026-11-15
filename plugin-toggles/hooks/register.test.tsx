import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'plugin-toggles',
  component: 'Pane',
  requestId: 'plugin-toggles',
  surface: 'desktop',
  props: {
    title: 'Toggles',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

// Answers env.get from `vars`, every other variable unset.
const env =
  (vars: Record<string, string>) =>
  (_: unknown, e: any): any => ({ value: vars[e.name] })

// A file system holding `files` by path, spelled with forward slashes as the
// kit's own are not; writes land in it.
const disk = (on: any, files: Record<string, string>) => {
  const at = (e: any) => String(e.path).split('\\').join('/')
  on('fs.exists', (_: unknown, e: any): any => ({ value: at(e) in files }))
  on('fs.read', (_: unknown, e: any): any => {
    if (!(at(e) in files)) throw new Error(`ENOENT ${at(e)}`)
    return { value: files[at(e)] }
  })
  on('fs.write', (_: unknown, e: any): any => {
    files[at(e)] = e.text
    return { value: undefined }
  })
  return files
}

// The toasts shown, in order.
const toasts = (on: any) => {
  const shown: string[] = []
  on('ui.toast', (_: unknown, e: any): any => {
    shown.push(e.text)
    return { value: undefined }
  })
  return shown
}

// The engine's settings: the user source as settings.json holds it, once it
// has read it in, every other source empty.
const engine = (on: any, files: Record<string, string>) =>
  on('settings.read', (_: unknown, e: any): any => ({
    value: e?.source === 'user' ? JSON.parse(files[SETTINGS] ?? '{}') : {},
  }))

// The commands run, in order.
const runs = (on: any) => {
  const ran: string[] = []
  on('command.run', (_: unknown, e: any): any => {
    ran.push(e.command)
    return { value: { text: '' } }
  })
  return ran
}

const SETTINGS = 'C:/Users/x/.claude/settings.json'
const GLOBAL = 'C:/Users/x/.claude.json'
const PROFILES = 'C:/Users/x/.claude/mods-data/plugin-toggles-profiles.json'
const FOUR = ['on', 'name-only', 'user-invocable-only', 'off']
const GREG = { name: 'greg', source: 'user', description: 'Makes photos' }

// Answers state.get with one stored value and every other key unset.
const stored =
  (key: string, shape: string, value: unknown) =>
  (_: unknown, e: unknown): any => ({
    value: JSON.stringify(e).includes(`"${key}"`) ? { value: { shape, value }, version: 1 } : {},
  })

// The /context breakdown as $.session.usage({ breakdown }) answers it.
const usage =
  (breakdown: Record<string, unknown>) =>
  (): any => ({
    value: {
      startedAt: 0,
      context: {
        window: 200000,
        breakdown: { agents: [], mcpTools: [], memoryFiles: [], ...breakdown },
      },
      rateLimits: [],
    },
  })

// The positions a switch is at: those of its Buttons drawn at full ink. On
// the desktop an On or Off switch is one Button, named by where a press moves
// it, so there the position with no Button is the one it is at.
const at = async (ui: any, key: string, modes: string[]) => {
  const drawn: [string, any][] = []
  for (const m of modes) drawn.push([m, await ui.find({ type: 'Button', key: `${key}:${m}` })])
  const named = drawn.filter(([, b]) => b)
  if (modes.length === 2 && named.length === 1) return drawn.filter(([, b]) => !b).map(([m]) => m)
  return named.filter(([, b]) => b.props.dimColor !== true).map(([m]) => m)
}

// The switches drawn as pictures, top to bottom: what each says and whether
// it is lit in the brand colour. The gauge's bar is no switch.
const pictures = async (ui: any) =>
  (await ui.findAll({ type: 'Svg' }))
    .filter((s: any) => s.props.height === 26)
    .map((s: any) => [s.props.alt, s.props.source.includes('#D97757')])

// The blank label a picture's Button carries, wider than the picture.
const BLANK = String.fromCharCode(0x2003).repeat(8)

const fooSkills = (pluginName: string, tokens: number) => ({
  skills: {
    totalSkills: 1,
    includedSkills: 1,
    tokens,
    skillFrontmatter: [{ name: `${pluginName}:x`, source: 'plugin', pluginName, tokens }],
  },
})

const fooFiles = (_: unknown, e: unknown): any => {
  const p = JSON.stringify(e).split('\\').join('/')
  if (p.includes('installed_plugins'))
    return { value: JSON.stringify({ plugins: { 'foo@bar': [{ installPath: 'C:/p/foo' }] } }) }
  if (p.includes('plugin.json'))
    return { value: JSON.stringify({ description: 'Does foo things', version: '1.2.3' }) }
  if (p.includes('SKILL.md'))
    return { value: '---\nname: fooskill\ndescription: Makes foo happen\n---\nbody' }
  throw new Error('missing')
}

const fooDirs = (_: unknown, e: unknown): any => ({
  value: JSON.stringify(e).split('\\').join('/').includes('/skills')
    ? [{ name: 'fooskill', kind: 'dir', size: 0 }]
    : [],
})

test('profiles tab offers saving and lists a saved profile with its cost', async ($, on) => {
  on('state.get', stored('tab', 'tab-1', 'profiles'))
  on('command.list', () => ({ value: [{ name: 'reload-plugins', source: 'builtin' }] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  on('fs.read', () => ({
    value: JSON.stringify({
      Lisa: { plugins: { 'a@b': true, 'c@d': false }, skills: { s: 'off', t: 'name-only' } },
    }),
  }))
  on('settings.read', () => ({ value: {} }))
  on('session.usage', usage(fooSkills('a', 1200)))

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /Lisa/ }))?.text).toBe('Lisa')
  expect(
    (await ui.find({ type: 'Text', text: /1 plugins on, 1 skills off/ }))?.text,
  ).toMatch(/1 plugins on, 1 skills off, 1 name only · ≈1\.2k tokens a turn/)
  expect(await ui.find({ type: 'Button', key: 'save' })).toBeTruthy()
  await ui.unmount()
})

test('an enabled plugin is lit and sized by the engine count, as a bar on desktop and blocks on the terminal', async ($, on) => {
  on('state.get', (): any => ({ value: {} }))
  on('command.list', () => ({ value: [{ name: 'reload-plugins', source: 'builtin' }] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  on('settings.read', () => ({ value: { enabledPlugins: { 'foo@bar': true } } }))
  on(
    'session.usage',
    usage({
      ...fooSkills('foo', 1200),
      agents: [{ agentType: 'foo:rev', source: 'plugin', tokens: 300 }],
      mcpTools: [
        { name: 'mcp__plugin_foo_srv__a', serverName: 'plugin_foo_srv', tokens: 200, isLoaded: true },
        { name: 'mcp__plugin_foo_srv__b', serverName: 'plugin_foo_srv', tokens: 900, isLoaded: false },
      ],
    }),
  )

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await at(ui, 'plugins:foo@bar', ['on', 'off'])).toEqual(['on'])
    expect(await ui.find({ type: 'Button', key: 'plugins:foo@bar:name-only' })).toBeFalsy()
    if (surface === 'desktop') expect(await pictures(ui)).toEqual([['foo On', true]])
    else
      expect((await ui.find({ type: 'Button', key: 'plugins:foo@bar:on' }))?.props.variant).toBe('primary')
    // The total above the bar and the row's own cost.
    expect(await ui.findAll({ type: 'Text', text: /^1\.7k$/ })).toHaveLength(2)
    expect(await ui.find({ type: 'Text', text: /1 of 1 plugins on/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^PLUGINS · 1$/ })).toBeTruthy()
    if (surface === 'desktop') expect(await ui.find({ type: 'Svg' })).toBeTruthy()
    else expect(await ui.find({ type: 'Text', text: /█/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('an off plugin has its switch at Off and a cost estimated from its files', async ($, on) => {
  on('state.get', (): any => ({ value: {} }))
  on('command.list', () => ({ value: [] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  on('settings.read', () => ({ value: { enabledPlugins: { 'foo@bar': false } } }))
  on('fs.read', fooFiles)
  on('fs.list', fooDirs)

  const ui = await $.ui.mount(PANE)
  expect(await at(ui, 'plugins:foo@bar', ['on', 'off'])).toEqual(['off'])
  expect(await pictures(ui)).toEqual([['foo Off', false]])
  expect(await ui.find({ type: 'Text', text: /^~7$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /0 of 1 plugins on/ })).toBeTruthy()
  await ui.unmount()
})

test('pressing On on an off plugin writes it on to settings.json', async ($, on) => {
  on('command.list', () => ({ value: [] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  on('settings.read', () => ({ value: {} }))
  const files = disk(on, { [SETTINGS]: JSON.stringify({ enabledPlugins: { 'foo@bar': false } }) })

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'plugins:foo@bar:on' })
  expect(JSON.parse(files[SETTINGS] ?? '{}').enabledPlugins['foo@bar']).toBe(true)
  await ui.press({ key: 'plugins:foo@bar:off' })
  expect(JSON.parse(files[SETTINGS] ?? '{}').enabledPlugins['foo@bar']).toBe(false)
  await ui.unmount()
})

test('pressing the position a switch is at writes and counts nothing', async ($, on) => {
  on('command.list', () => ({ value: [] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  on('settings.read', () => ({ value: {} }))
  const before = JSON.stringify({ enabledPlugins: { 'foo@bar': true } })
  const files = disk(on, { [SETTINGS]: before })

  // The terminal draws a Button for each position, the current one too.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'plugins:foo@bar:on' })
  expect(files[SETTINGS]).toBe(before)
  expect(await ui.find({ type: 'Text', text: /change saved/ })).toBeFalsy()
  await ui.unmount()
})

test('an empty settings.json is switched as an empty object', async ($, on) => {
  on('command.list', () => ({ value: [GREG] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  on('settings.read', () => ({ value: {} }))
  const files = disk(on, { [SETTINGS]: '' })

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-skills' })
  await ui.press({ key: 'skills:greg:off' })
  expect(JSON.parse(files[SETTINGS] ?? '{}')).toEqual({ skillOverrides: { greg: 'off' } })
  await ui.unmount()
})

test('plugins tab shows pending banner with Apply now after a change', async ($, on) => {
  on('state.get', stored('dirty', 'dirty-1', 2))
  on('command.list', () => ({ value: [{ name: 'reload-plugins', source: 'builtin' }] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  on('settings.read', () => ({ value: { enabledPlugins: { 'foo@bar': false } } }))

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /2 changes saved/ }))?.text).toMatch(/2 changes saved/)
  expect(await ui.find({ type: 'Button', key: 'apply' })).toBeTruthy()
  await ui.unmount()
})

test('pending banner hides Apply now when reload-plugins is unavailable', async ($, on) => {
  on('state.get', stored('dirty', 'dirty-1', 1))
  on('command.list', () => ({ value: [] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  on('settings.read', () => ({ value: { enabledPlugins: { 'foo@bar': false } } }))

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /take effect in a new session/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'apply' })).toBeFalsy()
  await ui.unmount()
})

test('a pending plugin change shows what is loaded now against after a reload', async ($, on) => {
  on('state.get', stored('dirty', 'dirty-1', 1))
  on('command.list', () => ({ value: [] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  on('settings.read', () => ({ value: { enabledPlugins: { 'foo@bar': false } } }))
  on('session.usage', usage(fooSkills('foo', 1200)))

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /1\.2k loaded now, 0 after a reload/ })).toBeTruthy()
  await ui.unmount()
})

test('pointing at a row reveals what the plugin adds in the inspector', async ($, on) => {
  on('state.get', (): any => ({ value: {} }))
  on('command.list', () => ({ value: [] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  on('settings.read', () => ({ value: { enabledPlugins: { 'foo@bar': true } } }))
  on('fs.read', fooFiles)
  on('fs.list', fooDirs)

  // The kit hands back no hover props, so this checks the card is there and
  // hidden at rest; the row and its card share one scopeOf entry.
  const ui = await $.ui.mount(PANE)
  const cards = (await ui.findAll({ type: 'Box' })).filter(b => b.props.display === 'none')
  expect(cards).toHaveLength(1)
  expect(cards[0]?.text).toMatch(/^foo {2}on · bar · 1 skills · ~7 tokens/)
  expect(cards[0]?.text).toMatch(/Does foo things/)
  expect(await ui.find({ type: 'Text', text: /^Skills: fooskill$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Switch a plugin on or off/ })).toBeTruthy()
  await ui.unmount()
})

test('a plugin skill leads to its plugin instead of a switch, and sizes the listing', async ($, on) => {
  on('state.get', stored('tab', 'tab-1', 'skills'))
  on('command.list', () => ({
    value: [
      { name: 'brainstorm', source: 'plugin', plugin: 'superpowers', description: 'Explore ideas before building' },
    ],
  }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  on('settings.read', () => ({ value: {} }))
  on(
    'session.usage',
    usage({
      skills: {
        totalSkills: 5,
        includedSkills: 3,
        tokens: 40,
        skillFrontmatter: [{ name: 'brainstorm', source: 'plugin', pluginName: 'superpowers', tokens: 40 }],
      },
    }),
  )

  const sets: string[] = []
  on('state.set', (_, e): any => {
    sets.push(JSON.stringify(e))
    return { value: { isSet: true, version: 2 } }
  })

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Button', key: 'skills:plugin:superpowers:plugin' }))?.text).toBe('superpowers ›')
  expect(await ui.find({ type: 'Button', key: 'skills:brainstorm:on' })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /^FROM PLUGINS · 1$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^40$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /On lists a skill with its description/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^brainstorm$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /2 skills don't fit the listing budget/ })).toBeTruthy()
  await ui.press({ key: 'skills:plugin:superpowers:plugin' })
  expect(sets.some(s => s.includes('"q"') && s.includes('"superpowers"'))).toBe(true)
  expect(sets.some(s => s.includes('"tab"') && s.includes('"plugins"'))).toBe(true)
  await ui.unmount()
})

test('a skill of your own gets a four-way switch and costs what its position does', async ($, on) => {
  on('state.get', stored('tab', 'tab-1', 'skills'))
  on('command.list', () => ({ value: [{ name: 'greg', source: 'user', description: 'Makes photos' }] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  on('settings.read', () => ({ value: { skillOverrides: { greg: 'name-only' } } }))

  const ui = await $.ui.mount(PANE)
  const modes = FOUR
  // A slider of four stops, each a picture under its own Button, the knob on Name.
  for (const m of modes)
    expect((await ui.find({ type: 'Button', key: `skills:greg:${m}` }))?.props.label).toBe(BLANK)
  expect(await at(ui, 'skills:greg', modes)).toEqual(['name-only'])
  expect(await pictures(ui)).toEqual(['On', 'Name', 'User', 'Off'].map(a => [`greg ${a}`, false]))
  const stops = (await ui.findAll({ type: 'Svg' })).filter((s: any) => s.props.height === 26)
  expect(stops.map((s: any) => s.props.source.includes('r="9"'))).toEqual([false, true, false, false])
  expect(stops[1]?.props.source).toContain('#6A9BCC')
  // The rail is lit up to the knob and grey past it.
  const lit = (s: any) => /<line[^>]*stroke="#6A9BCC"/.test(s.props.source)
  expect(stops.map(lit)).toEqual([true, true, false, false])
  // Each stop's Button lies over its whole picture, cut to the picture's edges.
  const boxes = await ui.findAll({ type: 'Box' })
  const cell = boxes.find((b: any) => b.props.key === 'skills:greg:off-pic')
  expect(cell?.props.overflow).toBe('hidden')
  const over = (cell?.children ?? []).find((c: any) => c?.type === 'Box')
  expect([over?.props.position, over?.props.top, over?.props.bottom, over?.props.left]).toEqual(['absolute', 0, 0, 0])
  expect(over?.children?.[0]?.props.key).toBe('skills:greg:off')
  expect(await ui.find({ type: 'Text', text: /^Name$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^YOUR SKILLS · 1$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^~2$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /1 of 1 skills listed/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^On ~5 · Name ~2 · User and Off 0 tokens$/ })).toBeTruthy()
  await ui.unmount()
  // The terminal brackets its buttons and keeps the labels bare.
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(String((await term.find({ type: 'Button', key: 'skills:greg:on' }))?.text)).toBe('On')
  expect(await at(term, 'skills:greg', modes)).toEqual(['name-only'])
  await term.unmount()
})

test('a count taken while a skill was name-only does not pass for its full cost', async ($, on) => {
  on('state.get', stored('tab', 'tab-1', 'skills'))
  on('command.list', () => ({ value: [{ name: 'greg', source: 'user', description: 'Makes photos' }] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  on('settings.read', () => ({ value: {} }))
  on(
    'session.usage',
    usage({
      skills: {
        totalSkills: 1,
        includedSkills: 1,
        tokens: 2,
        skillFrontmatter: [{ name: 'greg', source: 'userSettings', tokens: 2 }],
      },
    }),
  )

  const ui = await $.ui.mount(PANE)
  expect(await at(ui, 'skills:greg', FOUR)).toEqual(['on'])
  expect(await ui.find({ type: 'Text', text: /^~5$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^On ~5 · Name 2 · User and Off 0 tokens$/ })).toBeTruthy()
  await ui.unmount()
})

test('a switch position is written to skillOverrides, and On clears the entry', async ($, on) => {
  let written = ''
  on('state.get', stored('tab', 'tab-1', 'skills'))
  on('command.list', () => ({ value: [{ name: 'greg', source: 'user', description: 'Makes photos' }] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  on('settings.read', () => ({ value: {} }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: JSON.stringify({ skillOverrides: { greg: 'name-only', other: 'off' } }) }))
  on('fs.write', (_, e): any => {
    written = e.text
    return { value: undefined }
  })

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'skills:greg:user-invocable-only' })
  expect(JSON.parse(written).skillOverrides).toEqual({ greg: 'user-invocable-only', other: 'off' })
  await ui.press({ key: 'skills:greg:on' })
  expect(JSON.parse(written).skillOverrides).toEqual({ other: 'off' })
  await ui.unmount()
})

// settings.json as a file the presses write, while the engine's settings
// snapshot still holds `stale`: it picks a write up about a second late.
const lagging = (on: any, initial: Record<string, unknown>) => {
  disk(on, { [SETTINGS]: JSON.stringify(initial) })
  on('settings.read', (_: unknown, e: any): any => ({ value: e?.source === 'user' || !e?.source ? initial : {} }))
}

test('a pressed skill switch moves at once, before the engine rereads settings', async ($, on) => {
  on('command.list', () => ({ value: [{ name: 'greg', source: 'user', description: 'Makes photos' }] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  lagging(on, { skillOverrides: { greg: 'name-only' } })

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-skills' })
  const modes = FOUR
  expect(await at(ui, 'skills:greg', modes)).toEqual(['name-only'])
  await ui.press({ key: 'skills:greg:off' })
  expect(await at(ui, 'skills:greg', modes)).toEqual(['off'])
  await ui.press({ key: 'skills:greg:on' })
  expect(await at(ui, 'skills:greg', modes)).toEqual(['on'])
  await ui.unmount()
})

test('a pressed plugin switch moves at once, before the engine rereads settings', async ($, on) => {
  on('command.list', () => ({ value: [] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  lagging(on, { enabledPlugins: { 'foo@bar': true } })

  const ui = await $.ui.mount(PANE)
  expect(await at(ui, 'plugins:foo@bar', ['on', 'off'])).toEqual(['on'])
  await ui.press({ key: 'plugins:foo@bar:off' })
  expect(await at(ui, 'plugins:foo@bar', ['on', 'off'])).toEqual(['off'])
  await ui.unmount()
})

test('a project setting outranks settings.json, as the engine merges them', async ($, on) => {
  on('command.list', () => ({ value: [] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  on('fs.read', () => ({ value: JSON.stringify({ enabledPlugins: { 'foo@bar': true } }) }))
  on('settings.read', (_, e: any): any => ({
    value: e?.source === 'project' ? { enabledPlugins: { 'foo@bar': false } } : {},
  }))

  const ui = await $.ui.mount(PANE)
  expect(await at(ui, 'plugins:foo@bar', ['on', 'off'])).toEqual(['off'])
  await ui.unmount()
})

test('a skill switched off and gone from the command list keeps its row', async ($, on) => {
  on('state.get', stored('tab', 'tab-1', 'skills'))
  on('command.list', () => ({ value: [] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  on('settings.read', () => ({ value: { skillOverrides: { ghost: 'off', back: 'on' } } }))

  const ui = await $.ui.mount(PANE)
  expect(await at(ui, 'skills:ghost', FOUR)).toEqual(['off'])
  expect(await ui.find({ type: 'Button', key: 'skills:back:on' })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /^YOUR SKILLS · 1$/ })).toBeTruthy()
  await ui.unmount()
})

test('mcp tab sizes a server by its loaded tool schemas only', async ($, on) => {
  on('state.get', stored('tab', 'tab-1', 'mcp'))
  on('command.list', () => ({ value: [] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  on('session.root', () => ({ value: 'C:/proj' }) as any)
  on('settings.read', () => ({ value: {} }))
  on('fs.read', () => ({ value: JSON.stringify({ mcpServers: { linear: { url: 'https://x' } } }) }))
  on(
    'session.usage',
    usage({
      mcpTools: [
        { name: 'mcp__linear__a', serverName: 'linear', tokens: 900, isLoaded: true },
        { name: 'mcp__linear__b', serverName: 'linear', tokens: 500, isLoaded: false },
      ],
    }),
  )

  const ui = await $.ui.mount(PANE)
  expect(await at(ui, 'mcp:linear', ['on', 'off'])).toEqual(['on'])
  expect(await ui.find({ type: 'Button', key: 'mcp:linear:user-invocable-only' })).toBeFalsy()
  expect(await ui.findAll({ type: 'Text', text: /^900$/ })).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: /^SERVERS · 1$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^https:\/\/x$/ })).toBeTruthy()
  await ui.unmount()
})

for (const [what, broken] of [
  ['does not parse', '{ "permissions": { "allow": ["Bash"] }, }'],
  ['holds no object', '[]'],
] as const)
  test(`a settings.json that ${what} is left whole, and the press says so`, async ($, on) => {
    on('command.list', () => ({ value: [GREG] }) as any)
    on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
    on('settings.read', (): any => ({ value: {} }))
    const files = disk(on, { [SETTINGS]: broken })
    const shown = toasts(on)

    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'tab-skills' })
    await ui.press({ key: 'skills:greg:off' })
    expect(files[SETTINGS]).toBe(broken)
    expect(shown.join(' ')).toMatch(/settings\.json/)
    expect(await ui.find({ type: 'Text', text: /change saved/ })).toBeFalsy()
    await ui.unmount()
  })

test('a ~/.claude.json that fails to read mid-press is left whole', async ($, on) => {
  const config = JSON.stringify({ oauthAccount: { id: 1 }, mcpServers: { linear: { url: 'https://x' } } })
  let reads = 0
  on('command.list', () => ({ value: [] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  on('session.root', () => ({ value: 'C:/proj' }) as any)
  on('settings.read', (): any => ({ value: {} }))
  on('state.get', stored('tab', 'tab-1', 'mcp'))
  on('fs.exists', (): any => ({ value: true }))
  on('fs.read', (_: unknown, e: any): any => {
    if (String(e.path).split('\\').join('/') !== GLOBAL) throw new Error('ENOENT')
    // The engine is writing it as the press reads it.
    if (++reads > 1) return { value: config.slice(0, 20) }
    return { value: config }
  })
  let written = ''
  on('fs.write', (_: unknown, e: any): any => {
    written = e.text
    return { value: undefined }
  })
  toasts(on)

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'mcp:linear:off' })
  expect(written).toBe('')
  await ui.unmount()
})

test('a settings.json with a byte order mark keeps its other keys', async ($, on) => {
  on('command.list', () => ({ value: [GREG] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  on('settings.read', (): any => ({ value: {} }))
  const files = disk(on, { [SETTINGS]: '\uFEFF{ "model": "opus", "skillOverrides": { "greg": "name-only" } }' })

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-skills' })
  expect(await at(ui, 'skills:greg', FOUR)).toEqual(['name-only'])
  await ui.press({ key: 'skills:greg:off' })
  expect(JSON.parse(files[SETTINGS] ?? '{}')).toEqual({ model: 'opus', skillOverrides: { greg: 'off' } })
  await ui.unmount()
})

test('without USERPROFILE the files are found under HOME', async ($, on) => {
  on('command.list', () => ({ value: [GREG] }) as any)
  on('env.get', env({ HOME: '/home/x' }))
  on('settings.read', (): any => ({ value: {} }))
  const files = disk(on, {})

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-skills' })
  await ui.press({ key: 'skills:greg:off' })
  // On Windows the kit puts a path from the root on the current drive.
  const written = Object.keys(files)
  expect(written).toHaveLength(1)
  expect(written[0]).toMatch(/^([A-Za-z]:)?\/home\/x\/\.claude\/settings\.json$/)
  expect(JSON.parse(files[written[0] ?? ''] ?? '{}').skillOverrides).toEqual({ greg: 'off' })
  await ui.unmount()
})

for (const [what, vars, home] of [
  ['a Windows USERPROFILE wins over HOME', { USERPROFILE: 'C:\\Users\\x', HOME: '/c/Users/x' }, /^C:\/Users\/x\//],
  ['a USERPROFILE WSL hands over gives way to HOME', { USERPROFILE: '/mnt/c/Users/x', HOME: '/home/x' }, /^([A-Za-z]:)?\/home\/x\//],
] as const)
  test(`${what}`, async ($, on) => {
    on('command.list', () => ({ value: [GREG] }) as any)
    on('env.get', env(vars))
    on('settings.read', (): any => ({ value: {} }))
    const files = disk(on, {})

    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'tab-skills' })
    await ui.press({ key: 'skills:greg:off' })
    const written = Object.keys(files)
    expect(written).toHaveLength(1)
    expect(written[0]).toMatch(home)
    await ui.unmount()
  })

test('CLAUDE_CONFIG_DIR moves settings.json and ~/.claude.json with it', async ($, on) => {
  on('command.list', () => ({ value: [GREG] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x', CLAUDE_CONFIG_DIR: 'C:\\cfg' }))
  on('session.root', () => ({ value: 'C:/proj' }) as any)
  on('settings.read', (): any => ({ value: {} }))
  const files = disk(on, {
    'C:/cfg/settings.json': '{}',
    'C:/cfg/.claude.json': JSON.stringify({ mcpServers: { linear: { url: 'https://x' } } }),
  })

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-skills' })
  await ui.press({ key: 'skills:greg:off' })
  await ui.press({ key: 'tab-mcp' })
  await ui.press({ key: 'mcp:linear:off' })
  expect(Object.keys(files).sort()).toEqual(['C:/cfg/.claude.json', 'C:/cfg/settings.json'])
  expect(JSON.parse(files['C:/cfg/settings.json'] ?? '{}').skillOverrides).toEqual({ greg: 'off' })
  expect(JSON.parse(files['C:/cfg/.claude.json'] ?? '{}').projects['C:/proj'].disabledMcpServers).toEqual(['linear'])
  await ui.unmount()
})

test("a plugin's command that the skill count does not name gets no skill row", async ($, on) => {
  on('state.get', stored('tab', 'tab-1', 'skills'))
  on('command.list', () => ({
    value: [
      { name: 'superpowers:brainstorming', source: 'plugin', plugin: 'superpowers', description: 'Explore ideas' },
      { name: 'cache', source: 'plugin', plugin: 'cache-keeper', description: 'Cache status' },
      { name: 'jev:calibrate', source: 'plugin', plugin: 'jev', description: 'Calibrate' },
    ],
  }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  on('settings.read', () => ({ value: {} }))
  on(
    'session.usage',
    usage({
      skills: {
        totalSkills: 1,
        includedSkills: 1,
        tokens: 30,
        skillFrontmatter: [
          { name: 'superpowers:brainstorming', source: 'plugin', pluginName: 'superpowers', tokens: 30 },
        ],
      },
    }),
  )

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^FROM PLUGINS · 1$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'skills:plugin:superpowers:plugin' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'skills:plugin:cache-keeper:plugin' })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'skills:plugin:jev:plugin' })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /1 of 1 skills listed/ })).toBeTruthy()
  await ui.unmount()
})

test('the MCP tab keys the project by where the session started, whatever a shell cd did', async ($, on) => {
  on('command.list', () => ({ value: [] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  on('session.root', () => ({ value: 'C:\\proj' }) as any)
  on('session.cwd', () => ({ value: 'C:\\proj\\sub' }) as any)
  on('settings.read', (): any => ({ value: {} }))
  const files = disk(on, {
    [GLOBAL]: JSON.stringify({ projects: { 'C:/proj': { mcpServers: { local: { command: 'srv' } } } } }),
  })

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-mcp' })
  expect(await at(ui, 'mcp:local', ['on', 'off'])).toEqual(['on'])
  await ui.press({ key: 'mcp:local:off' })
  expect(JSON.parse(files[GLOBAL] ?? '{}').projects['C:/proj'].disabledMcpServers).toEqual(['local'])
  expect(await at(ui, 'mcp:local', ['on', 'off'])).toEqual(['off'])
  await ui.press({ key: 'mcp:local:on' })
  expect(JSON.parse(files[GLOBAL] ?? '{}').projects['C:/proj'].disabledMcpServers).toEqual([])
  await ui.unmount()
})

test('the profile name and the filter are kept apart, and the filter keeps its capitals', async ($, on) => {
  on('command.list', () => ({ value: [] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  on('settings.read', (): any => ({ value: {} }))
  disk(on, { [SETTINGS]: JSON.stringify({ enabledPlugins: { 'foo@bar': true } }) })

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-profiles' })
  await ui.input({ key: 'name', text: 'Work', kind: 'change' })
  await ui.press({ key: 'tab-plugins' })
  expect(await ui.find({ type: 'Button', key: 'plugins:foo@bar:off' })).toBeTruthy()
  await ui.input({ key: 'q', text: 'FOO', kind: 'change' })
  expect((await ui.find({ type: 'Input', key: 'q' }))?.props.value).toBe('FOO')
  expect(await ui.find({ type: 'Button', key: 'plugins:foo@bar:off' })).toBeTruthy()
  await ui.press({ key: 'tab-profiles' })
  expect((await ui.find({ type: 'Input', key: 'name' }))?.props.value).toBe('Work')
  await ui.unmount()
})

test('a switch a higher source sets is not written, and the press says where it is set', async ($, on) => {
  on('command.list', () => ({ value: [] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  on('settings.read', (_, e: any): any => ({
    value: e?.source === 'project' ? { enabledPlugins: { 'foo@bar': false } } : {},
  }))
  const before = JSON.stringify({ enabledPlugins: { 'foo@bar': true } })
  const files = disk(on, { [SETTINGS]: before })
  const shown = toasts(on)

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'plugins:foo@bar:on' })
  expect(files[SETTINGS]).toBe(before)
  expect(shown.join(' ')).toMatch(/project/)
  expect(await ui.find({ type: 'Text', text: /change saved/ })).toBeFalsy()
  await ui.unmount()
})

for (const [what, sources, says] of [
  ['local over project', { project: 'on', local: 'off' }, /settings\.local\.json/],
  ['managed settings over all', { project: 'on', local: 'off', policy: 'off' }, /managed settings/],
] as const)
  test(`a skill switch set higher up is not written, and the press names ${what}`, async ($, on) => {
    on('command.list', () => ({ value: [GREG] }) as any)
    on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
    on('settings.read', (_, e: any): any => {
      const mode = (sources as Record<string, string>)[e?.source]
      return { value: mode ? { skillOverrides: { greg: mode } } : {} }
    })
    const files = disk(on, { [SETTINGS]: '{}' })
    const shown = toasts(on)

    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'tab-skills' })
    await ui.press({ key: 'skills:greg:name-only' })
    expect(files[SETTINGS]).toBe('{}')
    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatch(says)
    await ui.unmount()
  })

test('local settings outrank project settings', async ($, on) => {
  on('command.list', () => ({ value: [] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  on('settings.read', (_, e: any): any => ({
    value:
      e?.source === 'project'
        ? { enabledPlugins: { 'foo@bar': true } }
        : e?.source === 'local'
          ? { enabledPlugins: { 'foo@bar': false } }
          : {},
  }))
  disk(on, { [SETTINGS]: '{}' })

  const ui = await $.ui.mount(PANE)
  expect(await at(ui, 'plugins:foo@bar', ['on', 'off'])).toEqual(['off'])
  await ui.unmount()
})

test('saving a profile keeps the switches, and applying it sets the ones it names', async ($, on) => {
  on(
    'command.list',
    () =>
      ({
        value: [
          { name: 'reload-plugins', source: 'builtin' },
          { name: 'u', source: 'user' },
          { name: 'p', source: 'plugin', plugin: 'a@b' },
        ],
      }) as any,
  )
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  const ran = runs(on)
  const files = disk(on, {
    [SETTINGS]: JSON.stringify({ model: 'opus', enabledPlugins: { 'a@b': true }, skillOverrides: { s: 'off' } }),
  })
  engine(on, files)

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-profiles' })
  await ui.input({ key: 'name', text: 'Work', kind: 'change' })
  await ui.press({ key: 'save' })
  expect(JSON.parse(files[PROFILES] ?? '{}')).toEqual({
    Work: { plugins: { 'a@b': true }, skills: { s: 'off', u: 'on' } },
  })
  expect((await ui.find({ type: 'Input', key: 'name' }))?.props.value).toBe('')
  files[SETTINGS] = JSON.stringify({
    model: 'opus',
    enabledPlugins: { 'a@b': false, 'c@d': true },
    skillOverrides: { t: 'name-only', u: 'off' },
  })
  await ui.press({ key: 'a-Work' })
  expect(JSON.parse(files[SETTINGS] ?? '{}')).toEqual({
    model: 'opus',
    enabledPlugins: { 'a@b': true, 'c@d': true },
    skillOverrides: { t: 'name-only', s: 'off' },
  })
  expect(ran).toEqual(['reload-plugins'])
  await ui.unmount()
})

test('a profile that names no skills leaves their switches as they are', async ($, on) => {
  on('state.get', stored('tab', 'tab-1', 'profiles'))
  on('command.list', () => ({ value: [] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  const files = disk(on, {
    [SETTINGS]: JSON.stringify({ enabledPlugins: { 'a@b': true }, skillOverrides: { s: 'off', t: 'name-only' } }),
    [PROFILES]: JSON.stringify({ Old: { plugins: { 'a@b': false }, skills: {} } }),
  })
  engine(on, files)

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'a-Old' })
  expect(JSON.parse(files[SETTINGS] ?? '{}')).toEqual({
    enabledPlugins: { 'a@b': false },
    skillOverrides: { s: 'off', t: 'name-only' },
  })
  await ui.unmount()
})

test('a profile is not saved from a settings.json that does not parse', async ($, on) => {
  on('command.list', () => ({ value: [] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  on('settings.read', (): any => ({ value: {} }))
  const files = disk(on, { [SETTINGS]: '{ "enabledPlugins": { "a@b": true }, }' })
  const shown = toasts(on)

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-profiles' })
  await ui.input({ key: 'name', text: 'Work', kind: 'change' })
  await ui.press({ key: 'save' })
  expect(files[PROFILES]).toBeUndefined()
  expect(shown.join(' ')).toMatch(/settings\.json/)
  expect((await ui.find({ type: 'Input', key: 'name' }))?.props.value).toBe('Work')
  await ui.unmount()
})

test('a profile entry edited into no object is passed over', async ($, on) => {
  on('state.get', stored('tab', 'tab-1', 'profiles'))
  on('command.list', () => ({ value: [] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  on('settings.read', (): any => ({ value: {} }))
  disk(on, { [PROFILES]: JSON.stringify({ Broken: null, Odd: 'x', Work: { plugins: {}, skills: {} } }) })

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^Work$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^Broken$/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /^Odd$/ })).toBeFalsy()
  await ui.unmount()
})

test('a profiles file that holds no object reads as no profiles', async ($, on) => {
  on('state.get', stored('tab', 'tab-1', 'profiles'))
  on('command.list', () => ({ value: [] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  on('settings.read', (): any => ({ value: {} }))
  disk(on, { [PROFILES]: 'null' })

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^None yet/ })).toBeTruthy()
  await ui.unmount()
})

test('Apply now reloads plugins and clears the pending count', async ($, on) => {
  on('command.list', () => ({ value: [{ name: 'reload-plugins', source: 'builtin' }] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  const ran = runs(on)
  engine(on, disk(on, { [SETTINGS]: JSON.stringify({ enabledPlugins: { 'foo@bar': true } }) }))
  toasts(on)

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'plugins:foo@bar:off' })
  expect(await ui.find({ type: 'Text', text: /1 change saved/ })).toBeTruthy()
  await ui.press({ key: 'apply' })
  expect(ran).toEqual(['reload-plugins'])
  expect(await ui.find({ type: 'Text', text: /change saved/ })).toBeFalsy()
  await ui.unmount()
})

test('a reload the session refuses to a plugin keeps the pending count and says to type it', async ($, on) => {
  on('command.list', () => ({ value: [{ name: 'reload-plugins', source: 'builtin' }] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  on('command.run', (): any => ({ text: "/reload-plugins isn't available over a remote connection in this session." }))
  engine(on, disk(on, { [SETTINGS]: JSON.stringify({ enabledPlugins: { 'foo@bar': true } }) }))
  const shown = toasts(on)

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'plugins:foo@bar:off' })
  expect(await ui.find({ type: 'Text', text: /1 change saved/ })).toBeTruthy()
  await ui.press({ key: 'apply' })
  expect(await ui.find({ type: 'Text', text: /1 change saved/ })).toBeTruthy()
  expect(shown.join(' ')).toMatch(/type \/reload-plugins yourself/)
  expect(shown.join(' ')).not.toMatch(/reloaded\./)
  await ui.unmount()
})

test('Apply now reloads when a setting holds a list the engine has read in', async ($, on) => {
  on('command.list', () => ({ value: [{ name: 'reload-plugins', source: 'builtin' }] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  const ran = runs(on)
  engine(on, disk(on, { [SETTINGS]: JSON.stringify({ enabledPlugins: { 'foo@bar': true, 'x@y': ['a'] } }) }))
  toasts(on)

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'plugins:foo@bar:off' })
  await ui.press({ key: 'apply' })
  expect(ran).toEqual(['reload-plugins'])
  await ui.unmount()
})

test('Apply now waits for the engine to read the switches in before it reloads', async ($, on) => {
  on('command.list', () => ({ value: [{ name: 'reload-plugins', source: 'builtin' }] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  const log: string[] = []
  const files = disk(on, { [SETTINGS]: JSON.stringify({ enabledPlugins: { 'foo@bar': true } }) })
  // The engine reads settings.json in on the second wait.
  let seen = files[SETTINGS] ?? '{}'
  let waits = 0
  on('clock.sleep', (): any => {
    log.push('wait')
    if (++waits === 2) seen = files[SETTINGS] ?? '{}'
    return { value: undefined }
  })
  on('settings.read', (_: unknown, e: any): any => ({ value: e?.source === 'user' ? JSON.parse(seen) : {} }))
  on('command.run', (_: unknown, e: any): any => {
    log.push(e.command)
    return { value: { text: '' } }
  })
  toasts(on)

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'plugins:foo@bar:off' })
  await ui.press({ key: 'apply' })
  expect(log).toEqual(['wait', 'wait', 'reload-plugins'])
  await ui.unmount()
})

test('Apply now does not reload while the engine still holds the old switches', async ($, on) => {
  on('command.list', () => ({ value: [{ name: 'reload-plugins', source: 'builtin' }] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  const ran = runs(on)
  disk(on, { [SETTINGS]: JSON.stringify({ enabledPlugins: { 'foo@bar': true } }) })
  on('settings.read', (_: unknown, e: any): any => ({
    value: e?.source === 'user' ? { enabledPlugins: { 'foo@bar': true } } : {},
  }))
  on('clock.sleep', (): any => ({ value: undefined }))
  const shown = toasts(on)

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'plugins:foo@bar:off' })
  await ui.press({ key: 'apply' })
  expect(ran).toEqual([])
  expect(shown.join(' ')).toMatch(/again in a moment/)
  expect(await ui.find({ type: 'Text', text: /1 change saved/ })).toBeTruthy()
  await ui.unmount()
})

test('a skill switched back On is not reloaded while the engine still holds it off', async ($, on) => {
  on('command.list', () => ({ value: [{ name: 'reload-plugins', source: 'builtin' }, GREG] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  const ran = runs(on)
  disk(on, { [SETTINGS]: JSON.stringify({ skillOverrides: { greg: 'off' } }) })
  on('settings.read', (_: unknown, e: any): any => ({
    value: e?.source === 'user' ? { skillOverrides: { greg: 'off' } } : {},
  }))
  on('clock.sleep', (): any => ({ value: undefined }))
  toasts(on)

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-skills' })
  await ui.press({ key: 'skills:greg:on' })
  await ui.press({ key: 'apply' })
  expect(ran).toEqual([])
  await ui.unmount()
})

test('without reload-plugins an applied profile waits for a new chat', async ($, on) => {
  on('command.list', () => ({ value: [] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  on('settings.read', (): any => ({ value: {} }))
  const ran: string[] = []
  on('command.run', (_: unknown, e: any): any => {
    ran.push(e.command)
    return { value: { text: '' } }
  })
  disk(on, {
    [SETTINGS]: '{}',
    [PROFILES]: JSON.stringify({ Work: { plugins: { 'a@b': true }, skills: {} } }),
  })
  const shown = toasts(on)

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-profiles' })
  await ui.press({ key: 'a-Work' })
  expect(ran).toEqual([])
  expect(shown.join(' ')).not.toMatch(/reload-plugins/)
  expect(await ui.find({ type: 'Text', text: /take effect in a new session/ })).toBeTruthy()
  await ui.unmount()
})

// ---- Mods tab ----
const SWITCHES = 'C:/Users/x/.claude/mods/switches.json'
const INSTALLED = 'C:/Users/x/.claude/plugins/installed_plugins.json'

// Three mods: clock reads switches.json and a :hidden key, plain reads none,
// and dev sits in ~/.claude/mods with a switch but no hidden key.
// A mod folder: its manifest, a hooks.json naming one module, and that module.
const modAt = (dir: string, name: string, code = "'switches.json'", module = 'register.tsx') => ({
  [`${dir}/.claude-plugin/plugin.json`]: JSON.stringify({ name }),
  [`${dir}/hooks/hooks.json`]: JSON.stringify({ modules: [`./${module}`] }),
  [`${dir}/hooks/${module}`]: code,
})

const modFiles = (): Record<string, string> => ({
  [INSTALLED]: JSON.stringify({
    plugins: {
      'clock@m': [{ installPath: 'C:\\p\\clock' }],
      'plain@m': [{ installPath: 'C:/p/plain' }],
      'plugin-toggles@4a-mods': [{ installPath: 'C:/p/toggles' }],
    },
  }),
  'C:/p/clock/.claude-plugin/plugin.json': JSON.stringify({ name: 'clock', description: 'Counts down' }),
  'C:/p/clock/hooks/hooks.json': JSON.stringify({ modules: ['./register.tsx'] }),
  'C:/p/clock/hooks/register.tsx': "const f = 'switches.json'; const k = `${NAME}:hidden`",
  'C:/p/clock/hooks/register.test.tsx': 'nothing',
  'C:/p/plain/.claude-plugin/plugin.json': JSON.stringify({ name: 'plain' }),
  'C:/p/plain/hooks/hooks.json': JSON.stringify({ modules: ['./register.ts'] }),
  'C:/p/plain/hooks/register.ts': 'export const register = () => {}',
  'C:/p/toggles/.claude-plugin/plugin.json': JSON.stringify({ name: 'plugin-toggles' }),
  'C:/p/toggles/hooks/hooks.json': JSON.stringify({ modules: ['./register.tsx'] }),
  'C:/p/toggles/hooks/register.tsx': 'switches.json',
  ...modAt('C:/Users/x/.claude/mods/dev', 'dev', 'switches.json', 'register.mts'),
})

// fs.list over the files: the entries directly inside a folder.
const listing = (on: any, files: Record<string, string>) =>
  on('fs.list', (_: unknown, e: any): any => {
    const dir = String(e.path).split('\\').join('/').replace(/\/$/, '') + '/'
    const names = new Map<string, string>()
    for (const p of Object.keys(files))
      if (p.startsWith(dir)) {
        const rest = p.slice(dir.length)
        const i = rest.indexOf('/')
        names.set(i < 0 ? rest : rest.slice(0, i), i < 0 ? 'file' : 'dir')
      }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 1, mtimeMs: 0, isLink: false })) }
  })

// The clock moves a minute a read, so no test sees another's kept scan.
let tick = 0
const modsSetup = (
  on: any,
  extra: Record<string, string> = {},
  enabledPlugins = {},
  vars: Record<string, string> = {},
  clock = () => (tick += 60_000),
) => {
  on('command.list', () => ({ value: [] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x', ...vars }))
  on('settings.read', () => ({ value: { enabledPlugins } }))
  on('clock.now', (): any => ({ value: clock() }))
  const files = disk(on, { ...modFiles(), ...extra })
  listing(on, files)
  return files
}

test('mods tab draws a card per mod and switches the ones that read switches.json', async ($, on) => {
  const files = modsSetup(on, {
    [SWITCHES]: JSON.stringify({ dev: false, keep: 1 }),
    'C:/p/clock/hooks/register.tsx':
      "const f = 'switches.json'; const k = `${NAME}:hidden`; const o = '.open-'; $.command.register({ name: 'cacheclock' })",
  })
  on('session.id', (): any => ({ value: 'S1' }))

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-mods' })
  expect(await ui.find({ type: 'Text', text: /^Clock$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^Counts down$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^\/cacheclock$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'mods:clock' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'mods-shown:clock' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'mods-open:clock' })).toBeTruthy()
  // dev is off: no Shown or Open of its own, and its On reads Off.
  expect(await ui.find({ type: 'Button', key: 'mods-shown:dev' })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'mods:dev' })).toBeTruthy()
  // plain has no switch and says why; toggles itself is never listed.
  expect(await ui.find({ type: 'Button', key: 'mods:plain' })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /^No switch: its code does not read switches\.json/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^Plugin Toggles$/ })).toBeFalsy()

  await ui.press({ key: 'mods-shown:clock' })
  await ui.press({ key: 'mods:clock' })
  await ui.press({ key: 'mods:dev' })
  expect(JSON.parse(files[SWITCHES] ?? '{}')).toEqual({ keep: 1, clock: false, 'clock:hidden': true })
  expect(await ui.find({ type: 'Text', text: /^Dev is on in every chat\.$/ })).toBeTruthy()
  await ui.press({ key: 'mods:clock' })
  await ui.press({ key: 'mods-shown:clock' })
  expect(JSON.parse(files[SWITCHES] ?? '{}')).toEqual({ keep: 1 })
  await ui.press({ key: 'mods-open:clock' })
  expect(files['C:/Users/x/.claude/mods/.open-clock-S1']).toBe('')
  await ui.unmount()
})

test('mods tab writes a missing switches.json and leaves a broken one alone', async ($, on) => {
  const files = modsSetup(on)
  const shown = toasts(on)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-mods' })
  await ui.press({ key: 'mods:dev' })
  expect(JSON.parse(files[SWITCHES] ?? '{}')).toEqual({ dev: false })
  files[SWITCHES] = '{ broken'
  await ui.press({ key: 'mods:clock' })
  expect(files[SWITCHES]).toBe('{ broken')
  expect(shown.join(' ')).toMatch(/Could not read/)
  await ui.unmount()
})

test('a switchable mod whose plugin is off says so', async ($, on) => {
  modsSetup(on, {}, { 'clock@m': false })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-mods' })
  expect(await ui.find({ type: 'Text', text: /Plugin off in the Plugins tab/ })).toBeTruthy()
  await ui.unmount()
})

test('a refused write leaves no note, and Shown or Open on an off mod writes nothing', async ($, on) => {
  const files = modsSetup(on, { [SWITCHES]: JSON.stringify({ clock: false }) })
  on('session.id', (): any => ({ value: 'S1' }))
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-mods' })
  // Off: Shown and Open are words, not buttons.
  expect(await ui.find({ type: 'Button', key: 'mods-shown:clock' })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'mods-open:clock' })).toBeFalsy()
  await ui.press({ key: 'mods:dev' })
  expect(await ui.find({ type: 'Text', text: /^Dev is off in every chat\.$/ })).toBeTruthy()
  files[SWITCHES] = '{ broken'
  await ui.press({ key: 'mods:clock' })
  expect(files[SWITCHES]).toBe('{ broken')
  // The note from the last write that landed stays; Clock gets none.
  expect(await ui.find({ type: 'Text', text: /^Clock is/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /^Dev is off in every chat\.$/ })).toBeTruthy()
  await ui.unmount()
})

test('Shown and Open refuse a mod switched off or hidden since the pane drew', async ($, on) => {
  const files = modsSetup(on, {
    'C:/p/clock/hooks/register.tsx': "'switches.json' + ':hidden' + '.open-'",
  })
  on('session.id', (): any => ({ value: 'S1' }))
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-mods' })
  // Another chat hides it while this pane still shows it: Open asks nothing.
  files[SWITCHES] = JSON.stringify({ 'clock:hidden': true })
  await ui.press({ key: 'mods-open:clock' })
  expect(files['C:/Users/x/.claude/mods/.open-clock-S1']).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Clock is hidden\. Turn it on and show it first\.$/ })).toBeTruthy()
  // Then turns it off: Shown changes nothing.
  files[SWITCHES] = JSON.stringify({ clock: false })
  await ui.press({ key: 'mods-shown:clock' })
  expect(JSON.parse(files[SWITCHES] ?? '{}')).toEqual({ clock: false })
  expect(await ui.find({ type: 'Text', text: /^Clock is off\. Turn it on first\.$/ })).toBeTruthy()
  await ui.unmount()
})

test('a mod is switchable by its code, not its tests, and listed once', async ($, on) => {
  modsSetup(on, {
    // plain's test mentions switches.json; its code does not.
    'C:/p/plain/hooks/register.test.tsx': "'switches.json'",
    // dev is also installed from a marketplace: one card.
    [INSTALLED]: JSON.stringify({
      plugins: {
        'clock@m': [{ installPath: 'C:/p/clock' }],
        'plain@m': [{ installPath: 'C:/p/plain' }],
        'dev@m': [{ installPath: 'C:/Users/x/.claude/mods/dev' }],
      },
    }),
  })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-mods' })
  expect(await ui.find({ type: 'Button', key: 'mods:plain' })).toBeFalsy()
  expect(await ui.findAll({ type: 'Text', text: /^Dev$/ })).toHaveLength(1)
  await ui.unmount()
})

test('a module hooks.json names outside hooks/ counts as the mod code', async ($, on) => {
  modsSetup(on, {
    'C:/p/plain/hooks/hooks.json': JSON.stringify({ modules: ['../dist/index.js'] }),
    'C:/p/plain/dist/index.js': "'switches.json'",
  })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-mods' })
  expect(await ui.find({ type: 'Button', key: 'mods:plain' })).toBeTruthy()
  await ui.unmount()
})

// The POSIX list starts at `~`: the engine gives a bare `/env` the host's
// drive on Windows, so an absolute POSIX path would not match the disk here.
for (const [label, list] of [
  ['Windows', 'C:/env/one;C:\\env\\two'],
  ['POSIX', '~/env/one:~/env/two'],
  ['drive-letter', 'C:/env/one:C:\\env\\two'],
] as const)
  test(`CLAUDE_CODE_PLUGIN_DIRS is split as a ${label} list`, async ($, on) => {
    const root = label === 'POSIX' ? 'C:/Users/x/env' : 'C:/env'
    const extra = { ...modAt(`${root}/one`, 'env-one'), ...modAt(`${root}/two`, 'env-two') }
    modsSetup(on, extra, {}, { CLAUDE_CODE_PLUGIN_DIRS: list })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'tab-mods' })
    expect(await ui.find({ type: 'Button', key: 'mods:env-one' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'mods:env-two' })).toBeTruthy()
    await ui.unmount()
  })

test('the mod list is kept ten seconds, and a clock that went back reads it again', async ($, on) => {
  let now = 1_000_000
  const files = modsSetup(on, {}, {}, {}, () => now)
  const fresh = (n: string) => Object.assign(files, modAt(`C:/Users/x/.claude/mods/${n}`, n))
  const reopen = async (ui: any) => {
    await ui.press({ key: 'tab-skills' })
    await ui.press({ key: 'tab-mods' })
  }
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-mods' })
  fresh('one')
  now += 5_000
  await reopen(ui)
  expect(await ui.find({ type: 'Button', key: 'mods:one' })).toBeFalsy()
  now += 6_000
  await reopen(ui)
  expect(await ui.find({ type: 'Button', key: 'mods:one' })).toBeTruthy()
  fresh('two')
  now -= 1_000
  await reopen(ui)
  expect(await ui.find({ type: 'Button', key: 'mods:two' })).toBeTruthy()
  await ui.unmount()
})

test('switches.json stays under home when CLAUDE_CONFIG_DIR moves the config', async ($, on) => {
  const files = modsSetup(on, {}, {}, { CLAUDE_CONFIG_DIR: 'C:/cfg' })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-mods' })
  await ui.press({ key: 'mods:dev' })
  expect(JSON.parse(files[SWITCHES] ?? '{}')).toEqual({ dev: false })
  expect(files['C:/cfg/mods/switches.json']).toBeUndefined()
  await ui.unmount()
})

test('on the desktop a switch is a pill and Shown an eye; the terminal keeps words', async ($, on) => {
  modsSetup(on, {
    [SWITCHES]: JSON.stringify({ 'clock:hidden': true, dev: false }),
  })
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab-mods' })
    const power = await ui.find({ type: 'Button', key: 'mods:clock' })
    const shown = await ui.find({ type: 'Button', key: 'mods-shown:clock' })
    if (surface === 'desktop') {
      // Clock is on: green, knob right. Dev is off: grey, knob left.
      const pills = (await ui.findAll({ type: 'Svg' })).map((s: any) => [
        s.props.alt,
        s.props.source.includes('#16a34a'),
        s.props.source.includes('cx="30"'),
      ])
      expect(pills).toEqual([
        ['On', true, true],
        ['Off', false, false],
      ])
      expect(power?.props.label).toBe(BLANK)
      expect(power?.props.plain).toBe(true)
      expect(shown?.props.label).toBe('\u{1F441}')
      expect(shown?.props.dimColor).toBe(true)
    } else {
      expect(await ui.find({ type: 'Svg' })).toBeFalsy()
      expect(power?.props.label).toBe('On')
      expect(shown?.props.label).toBe('Hidden')
    }
    await ui.unmount()
  }
})

// What a desktop asks of a Pane tree before it draws it, as its renderer
// checks: fewer than 2000 nodes (each element and each string among
// children) and 32 levels; characters taken as JSON, past what it counts.
const drawable = (tree: unknown) => {
  const json = JSON.stringify(tree)
  if (json.length > 262144) return `${json.length} characters`
  const stack: { value: unknown; depth: number; nesting: number; child: boolean }[] = [
    { value: JSON.parse(json), depth: 0, nesting: 0, child: true },
  ]
  let nodes = 0
  for (let it = stack.pop(); it; it = stack.pop()) {
    const v = it.value
    const isObj = typeof v === 'object' && v !== null
    const typed = isObj && 'type' in (v as object)
    const depth = typed ? it.depth + 1 : it.depth
    const nesting = isObj ? it.nesting + 1 : it.nesting
    if (typed || (it.child && typeof v === 'string')) nodes++
    if (nodes >= 2000 || depth > 32 || nesting > 66) return `${nodes} nodes, depth ${depth}, nesting ${nesting}`
    if (isObj) {
      const list = Array.isArray(v)
      for (const c of Object.values(v as object)) stack.push({ value: c, depth, nesting, child: list })
    }
  }
  return 'ok'
}

test('a long skill list stays drawable on a desktop, a plugin to a row', async ($, on) => {
  // Long descriptions, as a skill may carry 1024 characters.
  const long = 'Says at length what the skill does and when to reach for it. '.repeat(17)
  const own = Array.from({ length: 75 }, (_, i) => ({ name: `own-${i}`, source: 'user', description: long }))
  const borrowed = Array.from({ length: 320 }, (_, i) => ({
    name: `p${i}:skill`,
    source: 'plugin',
    plugin: `plug${i % 40}`,
    description: long,
  }))
  on('command.list', () => ({ value: [...own, ...borrowed] }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  on('settings.read', () => ({ value: { skillOverrides: { 'own-1': 'name-only', 'own-2': 'off' } } }))

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-skills' })
  const { text: _, ...tree } = (await ui.find({ type: 'Box' })) as any
  expect(drawable(tree)).toBe('ok')
  expect(await ui.find({ type: 'Text', text: /more, narrow the filter/ })).toBeTruthy()
  // The count is of skills, not rows; the filter finds a skill by its own name.
  expect(await ui.find({ type: 'Text', text: /394 of 395 skills listed/ })).toBeTruthy()
  await ui.input({ key: 'q', text: 'p43:', kind: 'change' })
  expect(await ui.find({ type: 'Button', key: 'skills:plugin:plug3:plugin' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'skills:plugin:plug4:plugin' })).toBeFalsy()
  // A few skills draw whole, a plugin's skills to one row.
  await ui.input({ key: 'q', text: 'own-1', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /more, narrow the filter/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /^YOUR SKILLS · 11$/ })).toBeTruthy()
  await ui.input({ key: 'q', text: 'p', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /^FROM PLUGINS · 40$/ })).toBeTruthy()
  await ui.unmount()
})

// A Skills tab of `own` skills of yours and `borrowed` plugin skills spread
// over `plugins` plugins, each described by `desc`.
const skillsTab = async ($: any, on: any, own: number, borrowed: number, plugins: number, desc: string) => {
  on('command.list', () => ({
    value: [
      ...Array.from({ length: own }, (_, i) => ({ name: `own-${i}`, source: 'user', description: desc })),
      ...Array.from({ length: borrowed }, (_, i) => ({
        name: `p${i}:skill`,
        source: 'plugin',
        plugin: `plug${i % plugins}`,
        description: desc,
      })),
    ],
  }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  on('settings.read', () => ({ value: {} }))
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-skills' })
  const { text: _, ...tree } = (await ui.find({ type: 'Box' })) as any
  return { ui, tree }
}

test('many short skills stop at the node bound a desktop draws to', async ($, on) => {
  const { ui, tree } = await skillsTab($, on, 0, 200, 200, 'x')
  expect(drawable(tree)).toBe('ok')
  expect(await ui.find({ type: 'Text', text: /more, narrow the filter/ })).toBeTruthy()
  await ui.unmount()
})

test('some 30 skills of yours and 37 plugins draw whole, long descriptions and all', async ($, on) => {
  const long = 'Says at length what the skill does and when to reach for it. '.repeat(17)
  const { ui, tree } = await skillsTab($, on, 33, 300, 37, long)
  expect(drawable(tree)).toBe('ok')
  expect(await ui.find({ type: 'Text', text: /^YOUR SKILLS · 33$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^FROM PLUGINS · 37$/ })).toBeTruthy()
  await ui.unmount()
})

test('the terminal draws every row: the desktop bounds are not its own', async ($, on) => {
  const long = 'Says at length what the skill does and when to reach for it. '.repeat(17)
  on('command.list', () => ({
    value: Array.from({ length: 120 }, (_, i) => ({ name: `own-${i}`, source: 'user', description: long })),
  }) as any)
  on('env.get', env({ USERPROFILE: 'C:/Users/x' }))
  on('settings.read', () => ({ value: {} }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-skills' })
  expect(await ui.find({ type: 'Text', text: /^YOUR SKILLS · 120$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /more, narrow the filter/ })).toBeFalsy()
  await ui.unmount()
})

test('some 45 skills of yours leave room for the plugins, counted by skill', async ($, on) => {
  const long = 'Says at length what the skill does and when to reach for it. '.repeat(17)
  const { ui, tree } = await skillsTab($, on, 45, 300, 37, long)
  expect(drawable(tree)).toBe('ok')
  expect(await ui.find({ type: 'Text', text: /^YOUR SKILLS · 45$/ })).toBeTruthy()
  const from = (await ui.find({ type: 'Text', text: /^FROM PLUGINS · \d+$/ })) as any
  const drawn = Number(String(from?.text).split('· ')[1])
  expect(drawn).toBeGreaterThan(10)
  // What is left is told in skills: about eight to a plugin here.
  const left = (await ui.find({ type: 'Text', text: /more, narrow the filter/ })) as any
  if (drawn < 37) expect(Number(String(left?.text).match(/(\d+) more/)?.[1])).toBeGreaterThan(37 - drawn)
  await ui.unmount()
})
