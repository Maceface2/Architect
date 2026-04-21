import { createContext, useContext } from 'react'

export interface CanvasActions {
  deleteNode: (id: string) => void
}

const CanvasActionsContext = createContext<CanvasActions | null>(null)

export function CanvasActionsProvider({
  value,
  children,
}: {
  value: CanvasActions
  children: React.ReactNode
}) {
  return (
    <CanvasActionsContext.Provider value={value}>
      {children}
    </CanvasActionsContext.Provider>
  )
}

export function useCanvasActions(): CanvasActions {
  const ctx = useContext(CanvasActionsContext)
  if (!ctx) throw new Error('useCanvasActions must be used inside CanvasActionsProvider')
  return ctx
}
