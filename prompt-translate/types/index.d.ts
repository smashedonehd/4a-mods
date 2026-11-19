export type Busy = boolean

declare module 'claude-code' {
  interface PluginState {
    'prompt-translate': { isBusy: Busy }
  }
}
