interface FileEntry {
  name: string
  isDirectory: boolean
  path: string
}

interface ElectronAPI {
  platform: string
  readDir: (dirPath: string) => Promise<FileEntry[]>
  getHomeDir: () => Promise<string>
  openDirectory: () => Promise<string | null>
}

declare global {
  interface Window {
    electron: ElectronAPI
  }
}

export {}
