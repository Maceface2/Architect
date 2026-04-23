import { createContext, useContext } from 'react'

const ProjectDirContext = createContext<string>('')

export function ProjectDirProvider({
  value,
  children,
}: {
  value: string
  children: React.ReactNode
}) {
  return (
    <ProjectDirContext.Provider value={value}>
      {children}
    </ProjectDirContext.Provider>
  )
}

export function useProjectDir(): string {
  return useContext(ProjectDirContext)
}
