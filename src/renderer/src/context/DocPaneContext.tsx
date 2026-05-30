import { createContext, useContext } from 'react'

export type DocPaneTarget =
  | { kind: 'zone'; nodeId: string }
  | { kind: 'component'; nodeId: string }
  | null

interface DocPaneContextValue {
  target: DocPaneTarget
  openZone: (nodeId: string) => void
  openComponent: (nodeId: string) => void
  close: () => void
}

const DocPaneContext = createContext<DocPaneContextValue | null>(null)

export function DocPaneProvider({
  value,
  children,
}: {
  value: DocPaneContextValue
  children: React.ReactNode
}) {
  return (
    <DocPaneContext.Provider value={value}>
      {children}
    </DocPaneContext.Provider>
  )
}

export function useDocPane(): DocPaneContextValue {
  const value = useContext(DocPaneContext)
  if (!value) {
    throw new Error('useDocPane must be used within a DocPaneProvider')
  }
  return value
}
