import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'prompt-translate',
  component: 'AbovePrompt',
  surface: 'desktop',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, columns: 80, scroll: { offset: 0, bodyRows: 10 } },
} as any

// A prompt box holding `drafts` in turn (the last one stays), the fills it
// takes, the model asks it saw and the toasts shown. `reply` answers each ask,
// a function of it when the answer depends on the ask.
const box = (on: any, drafts: string[], reply: any) => {
  const filled: { text: string; mode: string }[] = []
  const asked: any[] = []
  const shown: string[] = []
  let i = 0
  // The engine's own band beneath the plugin.
  on('ui.render', ($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('session.start', (_: unknown, e: any): any => ({ cwd: e.cwd }))
  on('command.register', (_: unknown, e: any): any => ({ value: { command: e.name } }))
  on('prompt.read', (): any => ({ value: { text: drafts[Math.min(i++, drafts.length - 1)], cursor: 0 } }))
  on('prompt.fill', (_: unknown, e: any): any => {
    filled.push({ text: e.text, mode: e.mode })
    // An event: answered by its own result.
    return { isFilled: true }
  })
  on('model.complete', async (_: unknown, e: any): Promise<any> => {
    asked.push(e)
    return { value: typeof reply === 'function' ? await reply(e) : reply }
  })
  on('ui.toast', (_: unknown, e: any): any => {
    shown.push(String(e.text ?? e.message ?? JSON.stringify(e)))
    return { value: undefined }
  })
  return { filled, asked, shown }
}

const ok = (text: string, output_tokens = 1) => ({ isAnswered: true, text, usage: { input_tokens: 1, output_tokens } })

for (const surface of ['desktop', 'terminal'] as const)
  test(`EN translates the draft with Haiku and replaces it, unsent (${surface})`, async ($, on) => {
    const { filled, asked } = box(on, ['Oprav ten bug v `auth.ts`'], ok('  Fix that bug in `auth.ts`\n'))
    const ui = await $.ui.mount({ ...BAND, surface })
    await ui.press({ key: 'translate' })
    expect(asked.length).toBe(1)
    expect(asked[0].model).toBe('haiku')
    expect(asked[0].prompt).toBe('<draft>\nOprav ten bug v `auth.ts`\n</draft>')
    expect(asked[0].system).toMatch(/do not answer it/)
    expect(filled).toEqual([{ text: 'Fix that bug in `auth.ts`', mode: 'replace' }])
    await ui.unmount()
  })

test('a reply that keeps the draft tags has them taken off', async ($, on) => {
  const { filled } = box(on, ['Ahoj'], ok('<draft>\nHello\n</draft>'))
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'translate' })
  expect(filled.map(f => f.text)).toEqual(['Hello'])
  await ui.unmount()
})

test('an empty draft asks nothing of the model', async ($, on) => {
  const { filled, asked, shown } = box(on, ['   '], ok('x'))
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'translate' })
  expect(asked.length).toBe(0)
  expect(filled).toEqual([])
  expect(shown.join(' ')).toMatch(/Type a prompt/)
  await ui.unmount()
})

test('a failed call leaves the draft and says why', async ($, on) => {
  const { filled, shown } = box(on, ['Ahoj'], { isAnswered: false, reason: 'api-error', status: 529, usage: {} })
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'translate' })
  expect(filled).toEqual([])
  expect(shown.join(' ')).toMatch(/api-error/)
  await ui.unmount()
})

test('a reply cut off at its cap leaves the draft', async ($, on) => {
  const { filled, shown } = box(on, ['Ahoj'], (e: any) => ok('Hel', e.maxTokens))
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'translate' })
  expect(filled).toEqual([])
  expect(shown.join(' ')).toMatch(/cut short/)
  await ui.unmount()
})

test('a draft typed on while translating is kept', async ($, on) => {
  const { filled, shown } = box(on, ['Ahoj', 'Ahoj světe'], ok('Hello'))
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'translate' })
  expect(filled).toEqual([])
  expect(shown.join(' ')).toMatch(/changed/)
  await ui.unmount()
})

test('a second press while one runs starts nothing, and the button comes back after', async ($, on) => {
  let release = () => {}
  const held = new Promise<void>(r => (release = r))
  const { asked, filled } = box(on, ['Ahoj'], async () => {
    await held
    return ok('Hello')
  })
  const ui = await $.ui.mount(BAND)
  const first = ui.press({ key: 'translate' })
  await ui.press({ key: 'translate' })
  release()
  await first
  expect(asked.length).toBe(1)
  expect(filled.map(f => f.text)).toEqual(['Hello'])
  await ui.press({ key: 'translate' })
  expect(asked.length).toBe(2)
  await ui.unmount()
})

test('/translate translates the text after it into the box', async ($, on) => {
  const { filled, asked } = box(on, [''], ok('Hello world'))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'translate', args: ' Ahoj světe ' })
  expect(asked[0]?.prompt).toBe('<draft>\nAhoj světe\n</draft>')
  expect(filled).toEqual([{ text: 'Hello world', mode: 'replace' }])
})

test('/translate with nothing after it says how to use it', async ($, on) => {
  const { asked } = box(on, [''], ok('x'))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const r = await $.command.run({ command: 'translate', args: '' })
  expect(asked.length).toBe(0)
  expect(r.text).toMatch(/after \/translate/)
})

test('the band yields to a survey', async ($, on) => {
  box(on, ['Ahoj'], ok('Hello'))
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true } })
  expect(await ui.find({ type: 'Button', key: 'translate' })).toBeFalsy()
  await ui.unmount()
})
