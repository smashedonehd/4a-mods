// Run: claude plugin test plan-keeper
// The band and the pane drawn by the engine's own validator, on every surface.
// What the mod decides is covered by test/plan-keeper.mjs against a fake host;
// here the trees must be ones the engine accepts.
import { expect, mock, test } from 'claude-code/testing'

const PLAN = '/work/app/docs/plans/p.md'
const TEXT = '# P\n\n### Task 1: Parser\n- [ ] Write the parser\n- [x] Test the parser\n\n### Task 2: Docs\n- [ ] Write the README\n'

const BAND = { plugin: 'plan-keeper', component: 'AbovePrompt', props: { isWorking: false, hasSurvey: false } } as never
const PANE = {
  plugin: 'plan-keeper',
  component: 'Pane',
  requestId: 'plan-keeper',
  props: { title: 'Plan', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as never

// The engine hands a path on in the machine's own form, with a drive and
// backslashes on Windows: the files here are named without either
const posix = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

// Stands in for the engine beneath the mod: one plan file, an empty state
function host(on: Parameters<Parameters<typeof test>[1]>[1]) {
  const files: Record<string, string> = { [PLAN]: TEXT }
  const state: Record<string, unknown> = {}
  const panes = new Set<string>()
  mock.clock(on, { now: 1_000_000 })
  on('session.start', async (_, e) => ({ cwd: e.cwd }) as never)
  on('command.register', async () => ({ value: { command: 'plan-keeper' } }) as never)
  on('env.get', async () => ({ value: '' }) as never)
  on('session.cwd', async () => ({ value: '/work/app' }) as never)
  // The engine names the key as `key`, or as `ref.key` in older releases
  const keyOf = (e: unknown) => {
    const { key, ref } = e as { key?: string; ref?: { key: string } }
    return (key ?? ref?.key) as string
  }
  on('state.get', async (_, e) => ({ value: { value: state[keyOf(e)] } }) as never)
  on('state.set', async (_, e) => {
    state[keyOf(e)] = (e as { value: unknown }).value
    return { value: undefined } as never
  })
  on('fs.read', async (_, e) => {
    const text = files[posix((e as { path: string }).path)]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text } as never
  })
  on('fs.exists', async (_, e) => ({ value: posix((e as { path: string }).path) in files }) as never)
  on('fs.list', async () => ({ value: [] }) as never)
  on('ui.open', async (_, e) => {
    panes.add((e as { id: string }).id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', async (_, e) => {
    panes.delete((e as { id: string }).id)
    return { value: undefined } as never
  })
  on('ui.panes', async () => ({ value: [...panes].map((id) => ({ id, isPlaced: true })) }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  return { files, panes }
}

for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
  test(`the band and the pane draw a tracked plan (${surface})`, async ($, on) => {
    const h = host(on)
    await $.session.start({ cwd: '/work/app', surface, isInteractive: true } as never)

    // The engine's own placeholder beneath the band is handed on untouched, and
    // never nested in the band (see hooks/register.mjs)
    let band = await $.ui.mount({ ...BAND, surface })
    expect(await band.drawn(), 'no plan: the placeholder alone').toMatchObject({ type: 'engine' })
    await band.unmount()

    const said = await $.command.run({ command: 'plan-keeper', args: 'docs/plans/p.md' } as never)
    expect((said as { text: string }).text).toBe(`Plan Keeper tracks ${PLAN}: 2 of 3 items open.`)

    band = await $.ui.mount({ ...BAND, surface })
    expect(JSON.stringify(await band.drawn())).not.toContain('"engine"')
    if (surface === 'terminal') {
      expect((await band.find({ type: 'Text', text: /1\/3/ }))?.text).toBe('1/3')
      expect((await band.find({ type: 'Text', text: /next:/ }))?.text).toBe('· next: Write the parser')
    } else {
      // Elsewhere the row is one picture: the figures are its texts
      const row = await band.find({ type: 'Svg' })
      const texts = String(row?.props.source).match(/[^<>]+(?=<\/text>)/g)
      expect(texts).toEqual(['P', '1/3', 'Write the parser', '33%'])
    }
    await band.press({ key: 'pane' })
    expect([...h.panes]).toEqual(['plan-keeper'])
    await band.unmount()

    const pane = await $.ui.mount({ ...PANE, surface })
    expect((await pane.find({ type: 'Text', text: /^Plan Keeper/ }))?.text).toBe('Plan Keeper  1/3')
    expect(await pane.find({ type: 'Text', text: /Task 1: Parser/ })).toBeDefined()
    expect((await pane.find({ type: 'Text', text: /Write the README/ }))?.text).toBe('    ○ Write the README')
    expect(await pane.find({ key: 'switch' })).toBeDefined()
    await pane.press({ key: 'stop' })
    await pane.unmount()

    band = await $.ui.mount({ ...BAND, surface })
    expect(await band.find({ key: 'pane' }), 'tracking stopped: no band').toBeUndefined()
    await band.unmount()
  })
}

