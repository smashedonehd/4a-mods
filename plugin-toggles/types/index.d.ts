declare module 'claude-code' {
  interface PluginState {
    'plugin-toggles': {
      rev: Shaped<number>
      tab: Shaped<string>
      q: Shaped<string>
      name: Shaped<string>
      dirty: Shaped<number>
      modNote: Shaped<string>
    }
  }
}
export type Rev = number
