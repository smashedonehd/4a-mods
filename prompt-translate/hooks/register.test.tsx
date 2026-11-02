import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'prompt-translate',
  component: 'AbovePrompt',
  surface: 'desktop',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, columns: 80, scroll: { offset: 0, bodyRows: 10 } },
} as any

// A prompt box holding `drafts` in turn (the last one stays), the fills it
// takes, the model asks it saw and the toasts shown.
const box = (on: any, drafts: string[], reply: any) => {
  const filled: string[] = []
  const asked: any[] = []
  const shown: string[] = []
  let i = 0
  // The engine's own band beneath the plugin.
  on('ui.render', ($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('prompt.read', (): any => ({ value: { text: drafts[Math.min(i++, drafts.length - 1)], cursor: 0 } }))
  on('prompt.fill', (_: unknown, e: any): any => {
    filled.push(e.text)
    // An event: answered by its own result.
    return { isFilled: true }
  })
  on('model.complete', (_: unknown, e: any): any => {
    asked.push(e)
    return { value: reply }
  })
  on('ui.toast', (_: unknown, e: any): any => {
    shown.push(String(e.text ?? e.message ?? JSON.stringify(e)))
    return { value: undefined }
  })
  return { filled, asked, shown }
}

const ok = (text: string) => ({ isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1 } })

test('EN translates the draft with Haiku and replaces it, unsent', async ($, on) => {
  const { filled, asked } = box(on, ['Oprav ten bug v `auth.ts`'], ok('  Fix that bug in `auth.ts`\n'))
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'translate' })
  expect(asked.length).toBe(1)
  expect(asked[0].model).toBe('haiku')
  expect(asked[0].prompt).toBe('Oprav ten bug v `auth.ts`')
  expect(filled).toEqual(['Fix that bug in `auth.ts`'])
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

test('a draft typed on while translating is kept', async ($, on) => {
  const { filled, shown } = box(on, ['Ahoj', 'Ahoj světe'], ok('Hello'))
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'translate' })
  expect(filled).toEqual([])
  expect(shown.join(' ')).toMatch(/changed/)
  await ui.unmount()
})

test('the band yields to a survey', async ($, on) => {
  box(on, ['Ahoj'], ok('Hello'))
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true } })
  expect(await ui.find({ type: 'Button', key: 'translate' })).toBeFalsy()
  await ui.unmount()
})
