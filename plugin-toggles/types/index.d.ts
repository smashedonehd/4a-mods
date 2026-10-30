declare module 'claude-code' {
  interface PluginState {
    'plugin-toggles': { rev: Shaped<number>; tab: Shaped<string>; q: Shaped<string>; dirty: Shaped<number> }
  }
}
export type Rev = number
