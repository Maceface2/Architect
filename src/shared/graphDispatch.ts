export interface DispatchContext {
  isRedispatch: boolean
  changedNodeLabels: string[]
}

export type LaunchScopeMode = 'all' | 'selected' | 'single'

export interface LaunchScope {
  mode: LaunchScopeMode
  nodeIds: string[]
}

export interface RunGraphOptions {
  launchScope?: LaunchScope
  dispatchContext?: DispatchContext
}
