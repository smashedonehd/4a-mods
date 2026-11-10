declare module 'claude-code' {
  interface PluginState {
    'connector-trim': {
      totals: Shaped<Totals>
      full: Shaped<boolean>
    }
  }
}
// This chat's sums: results changed, their size before and after in
// estimated tokens, and the helper model's calls and tokens.
export type Totals = {
  results: number
  before: number
  after: number
  helperCalls: number
  helperIn: number
  helperOut: number
}
