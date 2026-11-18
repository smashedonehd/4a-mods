export type Phase = 'plan' | 'design' | 'delegate' | 'review' | 'close'

export type PlannedTask = {
  title: string
  tier: string
  after: number[]
}

export type Flow = {
  title: string
  total: number
  done: number
  running: number
  phase: Phase
  isFinished: boolean
  tasks: PlannedTask[]
  /** Worked out at the drawing, never stored: the subagents' own parts of the bar when it counts their steps. */
  parts?: BarPart[]
  /** Some part has steps a worker reported: the label says Steps, not Tasks. */
  isSteps?: boolean
}

export type BarPart = {
  done: number
  total: number
  color: string
}

export type AgentStatus = 'running' | 'done' | 'failed'

export type AgentRun = {
  id: string
  agentId?: string
  type: string
  description: string
  model: string
  effort?: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  contextTokens: number
  contextMax: number
  tokens: number
  costUsd: number
  steps: number
  round: number
  /** Self-reported by the worker through the `step` tool. */
  stepDone?: number
  stepTotal?: number
  stepNote?: string
}

export type Panel = {
  isCompact: boolean
  isDoneCollapsed: boolean
  autoOpenedFor: string
}

declare module 'claude-code' {
  interface PluginState {
    'savvy-progress': {
      flow: Flow | null
      kept: Flow | null
      agents: AgentRun[]
      panel: Panel
      now: number
      dismissed: string
      pose: 'think' | 'write' | 'wait' | 'delegate'
    }
  }
}
