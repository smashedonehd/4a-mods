// Cache Keeper's session state: the skills "clear and continue" turns on again
// in the fresh chat, kept across a /reload-plugins.
export type CacheKeeperRevive = [key: 'caveman' | 'jev' | 'lsp', skill: { command: string; args: string }][]

declare module 'claude-code' {
  interface PluginState {
    'cache-keeper': { revive: CacheKeeperRevive }
  }
}
