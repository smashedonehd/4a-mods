// Plan Keeper's session state, kept across a /reload-plugins: the active plan
// file and why it is the active one, the session's task list as the task-list
// tools last left it, and the completed steps already held against the plan.
export type PlanKeeperPlan = { path: string; why: 'named' | 'written' | 'folder' } | null
export type PlanKeeperTasks = { id?: string; text: string; status: string }[]
export type PlanKeeperUsed = string[]

declare module 'claude-code' {
  interface PluginState {
    'plan-keeper': { plan: PlanKeeperPlan; tasks: PlanKeeperTasks; used: PlanKeeperUsed }
  }
}
