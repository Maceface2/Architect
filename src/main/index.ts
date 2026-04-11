import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  dialog,
  nativeImage,
} from "electron";
import { join } from "path";
import fs from "fs";
import path from "path";
import {
  runGraph,
  writeToTerminal,
  resizeTerminal,
  killAll,
  startAssistant,
  stopAssistant,
} from "./terminals";
import { bootstrapProjectCanvas } from "./projectAnalyzer";
import type { AgentRuntime } from "../shared/agentRuntimes";
import type { RunGraphOptions } from "../shared/graphDispatch";

app.name = "Architect";
app.setName("Architect");
process.title = "Architect";

const iconPath = join(__dirname, "../../resources/icon.png");

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  const icon = nativeImage.createFromPath(iconPath);

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: "#111111",
    icon,
    title: "Architect",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(icon);
  }

  mainWindow.on("ready-to-show", () => mainWindow!.show());
  mainWindow.on("closed", () => {
    killAll();
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (!app.isPackaged && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

// ── File system IPC ────────────────────────────────────────────────────────

ipcMain.handle("get-home-dir", () => app.getPath("home"));

ipcMain.handle("read-file", (_event, filePath: string) => {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
});

ipcMain.handle("read-outputs", (_event, outputsDir: string) => {
  try {
    const files = fs
      .readdirSync(outputsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => {
        const full = path.join(outputsDir, f);
        const stat = fs.statSync(full);
        return {
          name: f.replace(".md", ""),
          content: fs.readFileSync(full, "utf-8"),
          mtime: stat.mtimeMs,
        };
      })
      .sort((a, b) => {
        // Overseer always first, rest by name
        if (a.name === "Architect") return -1;
        if (b.name === "Architect") return 1;
        return a.name.localeCompare(b.name);
      });
    return files;
  } catch {
    return [];
  }
});

ipcMain.handle("read-dir", (_event, dirPath: string) => {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => !e.name.startsWith("."))
      .map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        path: path.join(dirPath, entry.name),
      }))
      .sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });
  } catch {
    return [];
  }
});

ipcMain.handle("open-directory", async () => {
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    properties: ["openDirectory", "createDirectory"],
  });
  return result.filePaths[0] ?? null;
});

ipcMain.handle("save-canvas", (_event, projectDir: string, data: string) => {
  fs.writeFileSync(
    path.join(projectDir, "architect-canvas.json"),
    data,
    "utf-8",
  );
});

ipcMain.handle("load-canvas", (_event, projectDir: string) => {
  try {
    return fs.readFileSync(
      path.join(projectDir, "architect-canvas.json"),
      "utf-8",
    );
  } catch {
    return null;
  }
});

ipcMain.handle(
  "bootstrap-project",
  (_event, projectDir: string, runtime: AgentRuntime | undefined) => {
    return bootstrapProjectCanvas(projectDir, runtime);
  },
);

ipcMain.handle("scan-components", (_event, dirPath: string) => {
  const results: unknown[] = [];
  const walk = (d: string) => {
    let entries: import("fs").Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(path.join(d, entry.name));
      else if (entry.name === "architect-component.json") {
        try {
          results.push(
            ...JSON.parse(fs.readFileSync(path.join(d, entry.name), "utf-8")),
          );
        } catch {}
      }
    }
  };
  walk(dirPath);
  return results;
});

// ── Terminal IPC ───────────────────────────────────────────────────────────

ipcMain.handle(
  "run-graph",
  (
    _event,
    nodes,
    edges,
    cwd,
    settings,
    options: RunGraphOptions | undefined,
  ) => {
    if (!mainWindow)
      return {
        sessions: [],
        preflight: {
          generatedAt: new Date().toISOString(),
          counts: {
            missing: 0,
            adopted: 0,
            needs_delta: 0,
            blocked_by_upstream: 0,
            unchanged: 0,
          },
          nodes: [],
        },
      };
    return runGraph(
      mainWindow,
      nodes,
      edges,
      cwd ?? app.getPath("home"),
      settings,
      options,
    );
  },
);

ipcMain.handle(
  "start-assistant",
  (_event, projectDir: string, contextMd: string, runtime: AgentRuntime) => {
    if (!mainWindow) return null;
    return startAssistant(mainWindow, projectDir, contextMd, runtime);
  },
);

ipcMain.on("stop-assistant", () => {
  stopAssistant();
});

ipcMain.on("terminal:input", (_event, id: string, data: string) => {
  writeToTerminal(id, data);
});

ipcMain.on(
  "terminal:resize",
  (_event, id: string, cols: number, rows: number) => {
    resizeTerminal(id, cols, rows);
  },
);

ipcMain.on("terminal:kill-all", () => {
  killAll();
});

// ── App lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
