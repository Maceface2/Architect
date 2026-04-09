import { createContext, useContext } from 'react'
import type { LaunchScopeMode } from '../../../shared/graphDispatch'

interface DispatchActionsContextValue {
  dispatching: boolean
  launchRevision: number
  launchNodes: (nodeIds: string[], mode: Exclude<LaunchScopeMode, 'all'>) => Promise<void>
}

const DispatchActionsContext = createContext<DispatchActionsContextValue>({
  dispatching: false,
  launchRevision: 0,
  launchNodes: async () => {},
})

export function DispatchActionsProvider({
  value,
  children,
}: {
  value: DispatchActionsContextValue
  children: React.ReactNode
}) {
  return (
    <DispatchActionsContext.Provider value={value}>
      {children}
    </DispatchActionsContext.Provider>
  )
}

export function useDispatchActions(): DispatchActionsContextValue {
  return useContext(DispatchActionsContext)
}
