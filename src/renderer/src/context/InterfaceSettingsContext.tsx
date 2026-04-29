import { createContext, useContext, useEffect } from 'react'
import { DEFAULT_INTERFACE_SETTINGS } from '../lib/canvas'
import type { InterfaceSettings } from '../types'

const InterfaceSettingsContext = createContext<InterfaceSettings>(DEFAULT_INTERFACE_SETTINGS)

export function InterfaceSettingsProvider({
  value,
  children,
}: {
  value: InterfaceSettings
  children: React.ReactNode
}) {
  // Theme is applied via a single data-attribute write so a switch is one
  // paint cycle. CSS variables defined in index.css pick up the change.
  useEffect(() => {
    document.documentElement.dataset.theme = value.theme
  }, [value.theme])

  return (
    <InterfaceSettingsContext.Provider value={value}>
      {children}
    </InterfaceSettingsContext.Provider>
  )
}

export function useInterfaceSettings(): InterfaceSettings {
  return useContext(InterfaceSettingsContext)
}
