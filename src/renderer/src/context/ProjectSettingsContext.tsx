import { createContext, useContext } from "react";
import { createDefaultProjectSettings } from "../lib/canvas";
import type { ProjectSettings } from "../types";

const ProjectSettingsContext = createContext<ProjectSettings>(
  createDefaultProjectSettings(),
);

export function ProjectSettingsProvider({
  value,
  children,
}: {
  value: ProjectSettings;
  children: React.ReactNode;
}) {
  return (
    <ProjectSettingsContext.Provider value={value}>
      {children}
    </ProjectSettingsContext.Provider>
  );
}

export function useProjectSettings(): ProjectSettings {
  return useContext(ProjectSettingsContext);
}
