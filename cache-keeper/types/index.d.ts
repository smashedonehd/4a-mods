// Cache Keeper's session state, kept across a /reload-plugins: the skills
// "clear and continue" turns on again in the fresh chat, and the prompts held
// for a clear, sent once it is done.
export type CacheKeeperRevive = [key: 'caveman' | 'jev' | 'lsp', skill: { command: string; args: string }][]
export type CacheKeeperHeld = { text: string; asUser?: true }[]

declare module 'claude-code' {
  interface PluginState {
    'cache-keeper': { revive: CacheKeeperRevive; held: CacheKeeperHeld }
  }
}
