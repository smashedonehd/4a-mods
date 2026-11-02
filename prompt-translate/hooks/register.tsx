import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

const isBusy = atom({ plugin: 'prompt-translate', key: 'isBusy' } as const, false)

export const SYSTEM = [
  "Translate the user's message into English.",
  'Output ONLY the translation: no preamble, no quotes, no explanation.',
  'Keep verbatim: code blocks, inline code, file paths, @-mentions, slash commands, URLs and identifiers.',
  'If the text is already in English, return it unchanged.',
].join(' ')

// Reads the draft, has Haiku translate it, and puts the translation back in
// the prompt box. Nothing is sent: Enter stays the person's.
async function translateDraft($: any) {
  if (await read($, isBusy)) return
  const { text } = await $.prompt.read()
  if (text.trim() === '') {
    $.ui.toast('Type a prompt first, then press EN.')
    return
  }
  await update($, isBusy, () => true)
  try {
    const r = await $.model.complete({
      model: 'haiku',
      system: SYSTEM,
      prompt: text,
      maxTokens: 4096,
      effort: 'low',
      timeoutMs: 30000,
    })
    if (!r.isAnswered || r.text.trim() === '') {
      $.ui.toast(`Translation failed (${r.isAnswered ? 'empty reply' : r.reason}). The draft is unchanged.`)
      return
    }
    // The person may have typed on while Haiku worked: keep that draft.
    const now = await $.prompt.read()
    if (now.text !== text) {
      $.ui.toast('The draft changed while translating, so it was left as it is.')
      return
    }
    const filled = await $.prompt.fill({ text: r.text.trim(), mode: 'replace' })
    if (!filled.isFilled) $.ui.toast('Could not put the translation in the prompt box.')
  } finally {
    await update($, isBusy, () => false)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'translate',
      description: 'Translate the draft in the prompt box into English',
    })
    return next(e)
  })

  on('command.run', { command: 'translate' }, async $ => {
    await translateDraft($)
    return { text: '' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button } = $.ui.resolve(e)
    const busy = await read($, isBusy)
    return (
      <Box>
        {await next(e)}
        <Button
          key="translate"
          label={busy ? '🌐 Translating…' : '🌐 EN'}
          dimColor={busy}
          onPress={() => translateDraft($)}
        />
      </Box>
    )
  })
}
