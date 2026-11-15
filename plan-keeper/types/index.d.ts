// Plan Keeper's session state, kept across a /reload-plugins: the active plan
// file and why it is the active one, the session's task list as the task-list
// tools last left it, the completed steps already held against the plan, the
// completed steps that named no single item of it, and what the person chose
// for this chat (the band hidden, tracking stopped) with the last tick's time
// and the finished task list the closing note last went out for.
export type PlanKeeperPlan = { path: string; why: 'named' | 'written' | 'folder' | 'generated' } | null
export type PlanKeeperTasks = { id?: string; text: string; status: string }[]
export type PlanKeeperUsed = string[]
export type PlanKeeperUnmatched = string[]
export type PlanKeeperPrefs = { hidden: boolean; off: boolean; tickedAt: number; noted: string }

declare module 'claude-code' {
  interface PluginState {
    'plan-keeper': { plan: PlanKeeperPlan; tasks: PlanKeeperTasks; used: PlanKeeperUsed; unmatched: PlanKeeperUnmatched; prefs: PlanKeeperPrefs }
  }
}
