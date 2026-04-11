import type { AgentRuntime } from "../../shared/agentRuntimes";
import type { ProjectBootstrapResult } from "../../shared/projectBootstrap";
import type {
  RunGraphOptions,
  RunGraphResult,
} from "../../shared/graphDispatch";
import type { ProjectSettings } from "./types";

interface FileEntry {
  name: string;
  isDirectory: boolean;
  path: string;
}

interface TerminalInfo {
  id: string;
  label: string;
  runtime: AgentRuntime;
}

interface OutputFile {
  name: string;
  content: string;
  mtime: number;
}

interface ElectronAPI {
  platform: string;
  readDir: (dirPath: string) => Promise<FileEntry[]>;
  readFile: (filePath: string) => Promise<string | null>;
  readOutputs: (outputsDir: string) => Promise<OutputFile[]>;
  getHomeDir: () => Promise<string>;
  openDirectory: () => Promise<string | null>;
  saveCanvas: (projectDir: string, data: string) => Promise<void>;
  loadCanvas: (projectDir: string) => Promise<string | null>;
  bootstrapProject: (
    projectDir: string,
    runtime: AgentRuntime,
  ) => Promise<ProjectBootstrapResult>;
  scanComponents: (dirPath: string) => Promise<unknown[]>;
  runGraph: (
    nodes: unknown[],
    edges: unknown[],
    cwd: string,
    settings: ProjectSettings,
    options?: RunGraphOptions,
  ) => Promise<RunGraphResult>;
  assistant: {
    start: (
      projectDir: string,
      contextMd: string,
      runtime: AgentRuntime,
    ) => Promise<TerminalInfo | null>;
    stop: () => void;
  };
  terminal: {
    input: (id: string, data: string) => void;
    resize: (id: string, cols: number, rows: number) => void;
    killAll: () => void;
    onData: (cb: (event: { id: string; data: string }) => void) => () => void;
    onExit: (
      cb: (event: { id: string; exitCode: number }) => void,
    ) => () => void;
    onNodeSessionSaved: (
      cb: (event: { nodeId: string; sessionId: string }) => void,
    ) => () => void;
  };
}

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}

export {};
