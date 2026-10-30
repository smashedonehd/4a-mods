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

// The positions a switch is at: those of its Buttons drawn at full ink.
const at = async (ui: any, key: string, modes: string[]) => {
  const lit: string[] = []
  for (const m of modes) {
    const b = await ui.find({ type: 'Button', key: `${key}:${m}` })
    if (b && b.props.dimColor !== true) lit.push(m)
  }
  return lit
}

// The fills under the switches' current positions, top to bottom.
const fills = async (ui: any) =>
  (await ui.findAll({ type: 'Box' })).map((b: any) => b.props.backgroundColor).filter(Boolean)

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
  on('env.get', () => ({ value: 'C:/Users/x' }))
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
  on('env.get', () => ({ value: 'C:/Users/x' }))
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
    if (surface === 'desktop') expect(await fills(ui)).toEqual(['claude'])
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
  on('env.get', () => ({ value: 'C:/Users/x' }))
  on('settings.read', () => ({ value: { enabledPlugins: { 'foo@bar': false } } }))
  on('fs.read', fooFiles)
  on('fs.list', fooDirs)

  const ui = await $.ui.mount(PANE)
  expect(await at(ui, 'plugins:foo@bar', ['on', 'off'])).toEqual(['off'])
  expect(await fills(ui)).toEqual(['subtle'])
  expect(await ui.find({ type: 'Text', text: /^~7$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /0 of 1 plugins on/ })).toBeTruthy()
  await ui.unmount()
})

test('pressing On on an off plugin writes it on to settings.json', async ($, on) => {
  let written = ''
  on('state.get', (): any => ({ value: {} }))
  on('command.list', () => ({ value: [] }) as any)
  on('env.get', () => ({ value: 'C:/Users/x' }))
  on('settings.read', () => ({ value: { enabledPlugins: { 'foo@bar': false } } }))
  on('fs.read', () => ({ value: JSON.stringify({ enabledPlugins: { 'foo@bar': false } }) }))
  on('fs.write', (_, e): any => {
    written = e.text
    return { value: undefined }
  })

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'plugins:foo@bar:on' })
  expect(JSON.parse(written).enabledPlugins['foo@bar']).toBe(true)
  await ui.press({ key: 'plugins:foo@bar:off' })
  expect(JSON.parse(written).enabledPlugins['foo@bar']).toBe(false)
  await ui.unmount()
})

test('plugins tab shows pending banner with Apply now after a change', async ($, on) => {
  on('state.get', stored('dirty', 'dirty-1', 2))
  on('command.list', () => ({ value: [{ name: 'reload-plugins', source: 'builtin' }] }) as any)
  on('env.get', () => ({ value: 'C:/Users/x' }))
  on('settings.read', () => ({ value: { enabledPlugins: { 'foo@bar': false } } }))

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /2 changes saved/ }))?.text).toMatch(/2 changes saved/)
  expect(await ui.find({ type: 'Button', key: 'apply' })).toBeTruthy()
  await ui.unmount()
})

test('pending banner hides Apply now when reload-plugins is unavailable', async ($, on) => {
  on('state.get', stored('dirty', 'dirty-1', 1))
  on('command.list', () => ({ value: [] }) as any)
  on('env.get', () => ({ value: 'C:/Users/x' }))
  on('settings.read', () => ({ value: { enabledPlugins: { 'foo@bar': false } } }))

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /take effect in a new session/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'apply' })).toBeFalsy()
  await ui.unmount()
})

test('a pending plugin change shows what is loaded now against after a reload', async ($, on) => {
  on('state.get', stored('dirty', 'dirty-1', 1))
  on('command.list', () => ({ value: [] }) as any)
  on('env.get', () => ({ value: 'C:/Users/x' }))
  on('settings.read', () => ({ value: { enabledPlugins: { 'foo@bar': false } } }))
  on('session.usage', usage(fooSkills('foo', 1200)))

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /1\.2k loaded now, 0 after a reload/ })).toBeTruthy()
  await ui.unmount()
})

test('pointing at a row reveals what the plugin adds in the inspector', async ($, on) => {
  on('state.get', (): any => ({ value: {} }))
  on('command.list', () => ({ value: [] }) as any)
  on('env.get', () => ({ value: 'C:/Users/x' }))
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
  on('env.get', () => ({ value: 'C:/Users/x' }))
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
  expect((await ui.find({ type: 'Button', key: 'skills:brainstorm:plugin' }))?.text).toBe('superpowers ›')
  expect(await ui.find({ type: 'Button', key: 'skills:brainstorm:on' })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /^FROM PLUGINS · 1$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^40$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /On lists a skill with its description/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^Explore ideas before building$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /2 skills don't fit the listing budget/ })).toBeTruthy()
  await ui.press({ key: 'skills:brainstorm:plugin' })
  expect(sets.some(s => s.includes('"q"') && s.includes('"superpowers"'))).toBe(true)
  expect(sets.some(s => s.includes('"tab"') && s.includes('"plugins"'))).toBe(true)
  await ui.unmount()
})

test('a skill of your own gets a four-way switch and costs what its position does', async ($, on) => {
  on('state.get', stored('tab', 'tab-1', 'skills'))
  on('command.list', () => ({ value: [{ name: 'greg', source: 'user', description: 'Makes photos' }] }) as any)
  on('env.get', () => ({ value: 'C:/Users/x' }))
  on('settings.read', () => ({ value: { skillOverrides: { greg: 'name-only' } } }))

  const ui = await $.ui.mount(PANE)
  const modes = ['on', 'name-only', 'user-invocable-only', 'off']
  const labels: string[] = []
  for (const m of modes) labels.push(String((await ui.find({ type: 'Button', key: `skills:greg:${m}` }))?.text))
  expect(labels).toEqual(['On', 'Name', 'User', 'Off'])
  expect(await at(ui, 'skills:greg', modes)).toEqual(['name-only'])
  expect(await fills(ui)).toEqual(['suggestion'])
  expect(await ui.find({ type: 'Text', text: /^YOUR SKILLS · 1$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^~2$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /1 of 1 skills listed/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^On ~5 · Name ~2 · User and Off 0 tokens$/ })).toBeTruthy()
  await ui.unmount()
})

test('a count taken while a skill was name-only does not pass for its full cost', async ($, on) => {
  on('state.get', stored('tab', 'tab-1', 'skills'))
  on('command.list', () => ({ value: [{ name: 'greg', source: 'user', description: 'Makes photos' }] }) as any)
  on('env.get', () => ({ value: 'C:/Users/x' }))
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
  expect(await at(ui, 'skills:greg', ['on', 'name-only', 'user-invocable-only', 'off'])).toEqual(['on'])
  expect(await ui.find({ type: 'Text', text: /^~5$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^On ~5 · Name 2 · User and Off 0 tokens$/ })).toBeTruthy()
  await ui.unmount()
})

test('a switch position is written to skillOverrides, and On clears the entry', async ($, on) => {
  let written = ''
  on('state.get', stored('tab', 'tab-1', 'skills'))
  on('command.list', () => ({ value: [{ name: 'greg', source: 'user', description: 'Makes photos' }] }) as any)
  on('env.get', () => ({ value: 'C:/Users/x' }))
  on('settings.read', () => ({ value: { skillOverrides: { greg: 'name-only' } } }))
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
const lagging = (on: any, initial: Record<string, unknown>, stale: Record<string, unknown>) => {
  let file = JSON.stringify(initial)
  on('fs.read', (): any => ({ value: file }))
  on('fs.write', (_: unknown, e: any): any => {
    file = e.text
    return { value: undefined }
  })
  on('settings.read', (_: unknown, e: any): any => ({ value: e?.source ? {} : stale }))
}

test('a pressed skill switch moves at once, before the engine rereads settings', async ($, on) => {
  on('command.list', () => ({ value: [{ name: 'greg', source: 'user', description: 'Makes photos' }] }) as any)
  on('env.get', () => ({ value: 'C:/Users/x' }))
  lagging(on, { skillOverrides: { greg: 'name-only' } }, { skillOverrides: { greg: 'name-only' } })

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-skills' })
  const modes = ['on', 'name-only', 'user-invocable-only', 'off']
  expect(await at(ui, 'skills:greg', modes)).toEqual(['name-only'])
  await ui.press({ key: 'skills:greg:off' })
  expect(await at(ui, 'skills:greg', modes)).toEqual(['off'])
  await ui.press({ key: 'skills:greg:on' })
  expect(await at(ui, 'skills:greg', modes)).toEqual(['on'])
  await ui.unmount()
})

test('a pressed plugin switch moves at once, before the engine rereads settings', async ($, on) => {
  on('command.list', () => ({ value: [] }) as any)
  on('env.get', () => ({ value: 'C:/Users/x' }))
  lagging(on, { enabledPlugins: { 'foo@bar': true } }, { enabledPlugins: { 'foo@bar': true } })

  const ui = await $.ui.mount(PANE)
  expect(await at(ui, 'plugins:foo@bar', ['on', 'off'])).toEqual(['on'])
  await ui.press({ key: 'plugins:foo@bar:off' })
  expect(await at(ui, 'plugins:foo@bar', ['on', 'off'])).toEqual(['off'])
  await ui.unmount()
})

test('a project setting outranks settings.json, as the engine merges them', async ($, on) => {
  on('command.list', () => ({ value: [] }) as any)
  on('env.get', () => ({ value: 'C:/Users/x' }))
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
  on('env.get', () => ({ value: 'C:/Users/x' }))
  on('settings.read', () => ({ value: { skillOverrides: { ghost: 'off', back: 'on' } } }))

  const ui = await $.ui.mount(PANE)
  expect(await at(ui, 'skills:ghost', ['on', 'name-only', 'user-invocable-only', 'off'])).toEqual(['off'])
  expect(await ui.find({ type: 'Button', key: 'skills:back:on' })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /^YOUR SKILLS · 1$/ })).toBeTruthy()
  await ui.unmount()
})

test('mcp tab sizes a server by its loaded tool schemas only', async ($, on) => {
  on('state.get', stored('tab', 'tab-1', 'mcp'))
  on('command.list', () => ({ value: [] }) as any)
  on('env.get', () => ({ value: 'C:/Users/x' }))
  on('session.cwd', () => ({ value: 'C:/proj' }) as any)
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
