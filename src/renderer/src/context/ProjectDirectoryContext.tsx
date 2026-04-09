import { createContext, useContext } from 'react'

const ProjectDirectoryContext = createContext<string>('')

export function ProjectDirectoryProvider({
  value,
  children,
}: {
  value: string
  children: React.ReactNode
}) {
  return (
    <ProjectDirectoryContext.Provider value={value}>
      {children}
    </ProjectDirectoryContext.Provider>
  )
}

export function useProjectDirectory(): string {
  return useContext(ProjectDirectoryContext)
}
