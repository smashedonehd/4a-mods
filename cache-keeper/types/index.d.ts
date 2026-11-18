// Cache Keeper's session state, kept across a /reload-plugins: the prompts held
// for a clear, sent once it is done.
export type CacheKeeperHeld = { text: string; asUser?: true }[]

declare module 'claude-code' {
  interface PluginState {
    'cache-keeper': { held: CacheKeeperHeld }
  }
}
