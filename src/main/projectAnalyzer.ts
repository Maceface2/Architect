import fs from "fs";
import { basename, join } from "path";
import {
  DEFAULT_AGENT_RUNTIME,
  DEFAULT_MODEL_BY_RUNTIME,
  type AgentRuntime,
} from "../shared/agentRuntimes";
import type {
  ImportedNodeCategory,
  ImportedProjectEdge,
  ImportedProjectNode,
  ProjectBootstrapConfidence,
  ProjectBootstrapResult,
  ProjectStructureSummary,
  RepresentativeSample,
  StructureCandidateBoundary,
} from "../shared/projectBootstrap";
import { runOneShotAgentPrompt, stripAnsi } from "./agentCli";

const IGNORED_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  ".yarn",
  ".pnpm-store",
  "ARCHITECT",
  "coverage",
  "dist",
  "build",
  "out",
  "node_modules",
  "vendor",
  "tmp",
  "temp",
]);

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".go",
  ".rs",
  ".py",
  ".rb",
  ".java",
  ".kt",
  ".swift",
  ".sql",
  ".prisma",
  ".mdx",
  ".vue",
  ".svelte",
  ".html",
  ".css",
  ".scss",
  ".sqlite",
  ".sqlite3",
  ".db",
]);

const TEXT_SAMPLE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".go",
  ".rs",
  ".py",
  ".rb",
  ".java",
  ".kt",
  ".swift",
  ".sql",
  ".prisma",
  ".md",
  ".mdx",
  ".vue",
  ".svelte",
  ".html",
  ".css",
  ".scss",
  ".yml",
  ".yaml",
]);

const TOP_LEVEL_PRIORITY = [
  "apps",
  "packages",
  "services",
  "server",
  "api",
  "backend",
  "web",
  "app",
  "client",
  "frontend",
  "src",
  "db",
  "database",
  "prisma",
];
const REPRESENTATIVE_FILES = [
  "package.json",
  "README.md",
  "index.ts",
  "index.tsx",
  "main.ts",
  "main.tsx",
  "server.ts",
  "server.js",
  "app.ts",
  "app.tsx",
  "index.html",
  "schema.prisma",
  "__init__.py",
  "db.py",
];
const ALLOWED_ICON_NAMES = new Set([
  "Monitor",
  "Shield",
  "Lock",
  "Network",
  "Globe",
  "ArrowLeftRight",
  "GitBranch",
  "Webhook",
  "Settings2",
  "Brain",
  "Layers",
  "Cpu",
  "Clock",
  "Mail",
  "Bell",
  "CreditCard",
  "Search",
  "Activity",
  "BarChart2",
  "ToggleLeft",
  "Database",
  "Zap",
  "Archive",
  "Table",
  "Boxes",
  "Share2",
  "TrendingUp",
  "Wrench",
]);
const IMPORT_BLOCK_START = "ARCHITECT_PROJECT_IMPORT";
const IMPORT_BLOCK_END = "END_ARCHITECT_PROJECT_IMPORT";
const IMPORT_COMPLETION_TOKEN = "ARCHITECT_IMPORT_COMPLETE";

interface RoleDefinition {
  key: string;
  label: string;
  category: ImportedNodeCategory;
  iconName: string;
  color: string;
  tag: string;
  description: string;
  contracts: string;
  prompt: string;
  reviewHints: string;
  filePatterns: RegExp[];
}

const PACKAGE_ROLE_DEFINITIONS: RoleDefinition[] = [
  {
    key: "api",
    label: "API Gateway",
    category: "infrastructure",
    iconName: "Shield",
    color: "#fb923c",
    tag: "API",
    description: "Owns API, HTTP, or MCP server endpoints for this package.",
    contracts:
      "Routes, MCP tools, request/response shapes, websocket APIs, and server lifecycle boundaries.",
    prompt:
      "Continue from the existing server and API implementation. Inspect request flows, preserve contracts, and only plan or apply the next required delta.",
    reviewHints:
      "Inspect exposed endpoints, websocket handlers, MCP tools, and server bootstrap paths before editing.",
    filePatterns: [
      /(^|\/)(api|server|web_server|mcp_server|gateway|routes?)\.py$/i,
    ],
  },
  {
    key: "workflow",
    label: "Worker",
    category: "services",
    iconName: "Cpu",
    color: "#94a3b8",
    tag: "WORKER",
    description:
      "Owns automation, replay, background execution, or workflow orchestration for this package.",
    contracts:
      "Execution flow, task orchestration, Playwright/runtime behavior, and transformation boundaries.",
    prompt:
      "Continue from the existing workflow and automation implementation. Inspect the current execution path first, then make only the next required delta.",
    reviewHints:
      "Inspect orchestration, replay flow, capture/summarize steps, and CLI entrypoints before editing.",
    filePatterns: [
      /(^|\/)(record|runner|playwright|capture|summarize|template|worker|jobs?)\.py$/i,
    ],
  },
  {
    key: "storage",
    label: "Database",
    category: "storage",
    iconName: "Database",
    color: "#60a5fa",
    tag: "DB",
    description: "Owns persistence and schema access for this package.",
    contracts:
      "Database schema, storage adapters, repositories, and persistence contracts.",
    prompt:
      "Continue from the existing persistence layer. Inspect current schema and storage boundaries before making changes.",
    reviewHints:
      "Inspect schema creation, query helpers, repositories, and data access patterns before editing.",
    filePatterns: [
      /(^|\/)(db|database|storage|store|schema|models?|repositories?)\.py$/i,
    ],
  },
];

function sanitizeId(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "node"
  );
}

function titleCase(value: string) {
  return value
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function safeReadDir(dirPath: string) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function truncate(value: string, max = 240) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function isIgnoredDirectory(name: string) {
  return IGNORED_DIRS.has(name) || name.startsWith(".");
}

function isTestDirectory(name: string) {
  return /^(test|tests|__tests__)$/i.test(name);
}

function isImplementationFile(name: string) {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  return name === "package.json" || CODE_EXTENSIONS.has(ext);
}

function isSampleableTextFile(relPath: string) {
  const name = relPath.split("/").pop() || relPath;
  if (name === "package.json" || name === "README.md") return true;
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  return TEXT_SAMPLE_EXTENSIONS.has(ext);
}

function hasCodeFiles(dirPath: string, depth = 0): boolean {
  if (depth > 2) return false;

  for (const entry of safeReadDir(dirPath)) {
    const absPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (isIgnoredDirectory(entry.name)) continue;
      if (hasCodeFiles(absPath, depth + 1)) return true;
      continue;
    }

    if (isImplementationFile(entry.name)) return true;
  }

  return false;
}

function collectRepresentativeFiles(
  projectDir: string,
  relDir: string,
  limit = 4,
): string[] {
  const absDir = relDir === "." ? projectDir : join(projectDir, relDir);
  const files: string[] = [];

  for (const fileName of REPRESENTATIVE_FILES) {
    const absPath = join(absDir, fileName);
    if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
      files.push(relDir === "." ? fileName : `${relDir}/${fileName}`);
      if (files.length >= limit) return files;
    }
  }

  const walk = (currentAbs: string, currentRel: string, depth: number) => {
    if (files.length >= limit || depth > 2) return;

    const entries = safeReadDir(currentAbs)
      .filter((entry) => !entry.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (files.length >= limit) return;
      const absPath = join(currentAbs, entry.name);
      const relPath = currentRel ? `${currentRel}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (isIgnoredDirectory(entry.name)) continue;
        walk(absPath, relPath, depth + 1);
        continue;
      }

      if (!isImplementationFile(entry.name)) continue;
      files.push(relDir === "." ? relPath : `${relDir}/${relPath}`);
    }
  };

  walk(absDir, "", 0);
  return [...new Set(files)].slice(0, limit);
}

function inferCategory(pathFragment: string): ImportedNodeCategory {
  if (
    /(db|database|prisma|migrations?|schema|postgres|mysql|mongo|redis|cache)/i.test(
      pathFragment,
    )
  )
    return "storage";
  if (
    /(api|server|backend|service|worker|queue|auth|gateway)/i.test(pathFragment)
  )
    return "services";
  if (
    /(web|client|frontend|ui|renderer|desktop|mobile|app)/i.test(pathFragment)
  )
    return "infrastructure";
  return "custom";
}

function inferVisuals(relPath: string, category: ImportedNodeCategory) {
  if (category === "storage")
    return { iconName: "Database", color: "#60a5fa", tag: "DATA" };
  if (/auth/i.test(relPath))
    return { iconName: "Lock", color: "#34d399", tag: "AUTH" };
  if (/(api|gateway)/i.test(relPath))
    return { iconName: "Shield", color: "#fb923c", tag: "API" };
  if (/(web|client|frontend|ui|renderer|desktop)/i.test(relPath))
    return { iconName: "Monitor", color: "#f472b6", tag: "UI" };
  if (/(worker|queue|jobs?)/i.test(relPath))
    return { iconName: "Cpu", color: "#a78bfa", tag: "JOB" };
  if (category === "services")
    return { iconName: "Globe", color: "#34d399", tag: "SVC" };
  return { iconName: "Layers", color: "#facc15", tag: "MOD" };
}

function inferDescription(relPath: string, category: ImportedNodeCategory) {
  if (category === "storage")
    return `Owns the existing persistence layer under ${relPath}.`;
  if (category === "services")
    return `Owns the existing service implementation under ${relPath}.`;
  if (category === "infrastructure")
    return `Owns the existing application surface under ${relPath}.`;
  return `Owns the existing project area under ${relPath}.`;
}

function inferContracts(relPath: string, category: ImportedNodeCategory) {
  if (category === "storage")
    return `Schema, migrations, repositories, and data access boundaries rooted in ${relPath}.`;
  if (category === "services")
    return `Endpoints, handlers, service interfaces, and integration contracts rooted in ${relPath}.`;
  if (category === "infrastructure")
    return `Routes, UI/state boundaries, and integration points owned under ${relPath}.`;
  return `Exports, file boundaries, and integration surfaces under ${relPath}.`;
}

function inferPrompt(relPath: string) {
  return `Continue from the existing implementation in ${relPath}. Inspect current code first, preserve working behavior, and only plan or apply the next delta that is actually needed.`;
}

function readTopLevelFiles(projectDir: string, relDir: string) {
  const absDir = relDir === "." ? projectDir : join(projectDir, relDir);
  return safeReadDir(absDir)
    .filter((entry) => entry.isFile() && isImplementationFile(entry.name))
    .map((entry) => `${relDir === "." ? "" : `${relDir}/`}${entry.name}`);
}

function makeRoleNode(
  packageName: string,
  packageRelPath: string,
  role: RoleDefinition,
  ownedPaths: string[],
  expectedFiles: string[],
): ImportedProjectNode {
  return {
    id: sanitizeId(`${packageRelPath}-${role.key}`),
    label: `${titleCase(packageName)} ${role.label}`,
    description: role.description,
    category: role.category,
    iconName: role.iconName,
    color: role.color,
    tag: role.tag,
    prompt: role.prompt,
    ownedPaths,
    expectedFiles: expectedFiles.slice(0, 6),
    contracts: role.contracts,
    reviewHints: role.reviewHints,
  };
}

function buildPackageRoleNodes(
  projectDir: string,
  packageRelPath: string,
): ImportedProjectNode[] {
  const packageName = packageRelPath.split("/").pop() || packageRelPath;
  const files = readTopLevelFiles(projectDir, packageRelPath);
  const grouped = PACKAGE_ROLE_DEFINITIONS.map((role) => ({
    role,
    files: files.filter((file) =>
      role.filePatterns.some((pattern) => pattern.test(file)),
    ),
  })).filter((group) => group.files.length > 0);

  if (grouped.length <= 1) return [];

  return grouped.map((group) =>
    makeRoleNode(
      packageName,
      packageRelPath,
      group.role,
      group.files,
      group.files,
    ),
  );
}

function makeNode(projectDir: string, relPath: string): ImportedProjectNode {
  const baseName =
    relPath === "." ? "workspace" : relPath.split("/").pop() || relPath;
  const category = inferCategory(relPath);
  const { iconName, color, tag } = inferVisuals(relPath, category);
  const expectedFiles = collectRepresentativeFiles(projectDir, relPath);

  return {
    id: sanitizeId(relPath === "." ? "workspace-root" : relPath),
    label: titleCase(baseName),
    description: inferDescription(relPath, category),
    category,
    iconName,
    color,
    tag,
    prompt: inferPrompt(relPath),
    ownedPaths: [relPath],
    expectedFiles,
    contracts: inferContracts(relPath, category),
    reviewHints:
      "Inspect the current implementation before editing. Preserve existing structure and only make deltas inside owned paths unless the task explicitly requires a contract change.",
  };
}

function mergeNodeData(
  base: ImportedProjectNode,
  extra: ImportedProjectNode,
): ImportedProjectNode {
  return {
    ...base,
    ownedPaths: [...new Set([...base.ownedPaths, ...extra.ownedPaths])],
    expectedFiles: [
      ...new Set([...base.expectedFiles, ...extra.expectedFiles]),
    ].slice(0, 6),
    contracts: [base.contracts, extra.contracts].filter(Boolean).join(" "),
    reviewHints: [base.reviewHints, extra.reviewHints]
      .filter(Boolean)
      .join(" "),
  };
}

function consolidateStorageNodes(nodes: ImportedProjectNode[]) {
  const roleStorageNodes = nodes.filter((node) => node.tag === "DB");
  const genericStorageNodes = nodes.filter(
    (node) =>
      node.category === "storage" &&
      node.tag !== "DB" &&
      node.ownedPaths.some((path) => /^(db|database|prisma)$/i.test(path)),
  );

  if (roleStorageNodes.length !== 1 || genericStorageNodes.length === 0)
    return nodes;

  let merged = roleStorageNodes[0];
  const mergedIds = new Set<string>([merged.id]);

  for (const generic of genericStorageNodes) {
    merged = mergeNodeData(merged, generic);
    mergedIds.add(generic.id);
  }

  return nodes.filter((node) => !mergedIds.has(node.id)).concat(merged);
}

function dedupeNodes(nodes: ImportedProjectNode[]) {
  const byId = new Map<string, ImportedProjectNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) continue;
    byId.set(node.id, {
      ...node,
      ownedPaths: [...new Set(node.ownedPaths)],
      expectedFiles: [...new Set(node.expectedFiles)],
    });
  }
  return consolidateStorageNodes([...byId.values()]);
}

function detectCandidateNodes(projectDir: string): ImportedProjectNode[] {
  const topLevelEntries = safeReadDir(projectDir).filter(
    (entry) => entry.isDirectory() && !isIgnoredDirectory(entry.name),
  );
  const topLevelNames = new Set(topLevelEntries.map((entry) => entry.name));
  const nodes: ImportedProjectNode[] = [];
  const genericCandidates: string[] = [];

  for (const groupName of ["apps", "packages"]) {
    if (!topLevelNames.has(groupName)) continue;
    for (const entry of safeReadDir(join(projectDir, groupName))) {
      if (!entry.isDirectory() || isIgnoredDirectory(entry.name)) continue;
      const relPath = `${groupName}/${entry.name}`;
      if (hasCodeFiles(join(projectDir, relPath)))
        genericCandidates.push(relPath);
    }
  }

  for (const dirName of TOP_LEVEL_PRIORITY) {
    if (!topLevelNames.has(dirName)) continue;
    if (dirName === "apps" || dirName === "packages") continue;
    const relPath = dirName;
    if (hasCodeFiles(join(projectDir, relPath)))
      genericCandidates.push(relPath);
  }

  for (const entry of topLevelEntries) {
    if (isTestDirectory(entry.name)) continue;
    const relPath = entry.name;
    const absPath = join(projectDir, relPath);
    const isPythonPackage = fs.existsSync(join(absPath, "__init__.py"));
    if (isPythonPackage || hasCodeFiles(absPath)) {
      genericCandidates.push(relPath);
    }
  }

  if (genericCandidates.length === 0) {
    for (const entry of topLevelEntries) {
      if (isTestDirectory(entry.name)) continue;
      if (hasCodeFiles(join(projectDir, entry.name)))
        genericCandidates.push(entry.name);
    }
  }

  for (const relPath of [...new Set(genericCandidates)]) {
    if (isTestDirectory(relPath)) continue;
    const absPath = join(projectDir, relPath);
    const isPythonPackage = fs.existsSync(join(absPath, "__init__.py"));
    if (isPythonPackage) {
      const roleNodes = buildPackageRoleNodes(projectDir, relPath);
      if (roleNodes.length > 0) {
        nodes.push(...roleNodes);
        continue;
      }
    }
    nodes.push(makeNode(projectDir, relPath));
  }

  if (nodes.length === 0 && fs.existsSync(join(projectDir, "package.json"))) {
    nodes.push(makeNode(projectDir, "."));
  }

  if (nodes.length === 0) {
    for (const entry of topLevelEntries) {
      if (hasCodeFiles(join(projectDir, entry.name))) {
        nodes.push(makeNode(projectDir, entry.name));
      }
    }
  }

  if (nodes.length > 0) {
    const testsEntry = topLevelEntries.find((entry) =>
      isTestDirectory(entry.name),
    );
    if (testsEntry && hasCodeFiles(join(projectDir, testsEntry.name))) {
      nodes.push({
        id: sanitizeId(testsEntry.name),
        label: "Tests",
        description:
          "Owns test coverage and verification for the existing implementation.",
        category: "services",
        iconName: "Activity",
        color: "#22c55e",
        tag: "TEST",
        prompt: `Continue from the existing tests in ${testsEntry.name}. Inspect coverage gaps against the imported components and only add or update the tests needed for the current delta.`,
        ownedPaths: [testsEntry.name],
        expectedFiles: collectRepresentativeFiles(projectDir, testsEntry.name),
        contracts:
          "Verification coverage, regression checks, and executable examples for the existing system.",
        reviewHints:
          "Treat tests as downstream verification. Align them to the imported implementation nodes instead of defining the architecture from tests outward.",
      });
    }
  }

  return dedupeNodes(nodes).slice(0, 12);
}

function buildEdges(nodes: ImportedProjectNode[]): ImportedProjectEdge[] {
  const frontends = nodes.filter(
    (node) =>
      node.tag === "UI" ||
      /web|client|frontend|renderer|desktop/i.test(node.id),
  );
  const services = nodes.filter(
    (node) =>
      (node.category === "services" ||
        node.tag === "API" ||
        node.tag === "AUTH" ||
        node.tag === "WORKER") &&
      node.tag !== "TEST",
  );
  const storage = nodes.filter((node) => node.category === "storage");
  const tests = nodes.filter((node) => node.tag === "TEST");
  const edges: ImportedProjectEdge[] = [];
  const edgeKeys = new Set<string>();
  let counter = 0;

  const preferredService =
    services.find((node) => node.tag === "API") || services[0];
  const preferredStorage = storage[0];
  const primaryExecutionNode =
    services.find((node) => node.tag === "WORKER") ||
    preferredService ||
    frontends[0];

  const pushEdge = (source: string, target: string) => {
    if (source === target) return;
    const key = `${source}->${target}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ id: `import-edge-${counter++}`, source, target });
  };

  for (const frontend of frontends) {
    if (!preferredService || frontend.id === preferredService.id) continue;
    pushEdge(frontend.id, preferredService.id);
  }

  for (const service of services) {
    if (!preferredStorage || service.id === preferredStorage.id) continue;
    pushEdge(service.id, preferredStorage.id);
  }

  for (const testNode of tests) {
    for (const candidate of nodes.filter(
      (node) => node.id !== testNode.id && node.tag !== "TEST",
    )) {
      if (candidate.tag === "DB" && primaryExecutionNode) continue;
      pushEdge(candidate.id, testNode.id);
    }
  }

  return edges;
}

function normalizeRelativePaths(values: string[] | undefined) {
  return [
    ...new Set(
      (values ?? [])
        .map((value) =>
          value
            .trim()
            .replace(/^\.?\//, "")
            .replace(/\/+$/, ""),
        )
        .filter(Boolean),
    ),
  ];
}

function deriveOwnedPaths(expectedFiles: string[]) {
  const derived = expectedFiles.map((file) => {
    if (!file.includes("/")) return ".";
    return file.slice(0, file.lastIndexOf("/"));
  });
  return normalizeRelativePaths(derived).slice(0, 4);
}

function readSampleExcerpt(projectDir: string, relPath: string) {
  if (!isSampleableTextFile(relPath)) return "";
  try {
    const content = fs.readFileSync(join(projectDir, relPath), "utf-8");
    const excerpt = content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 4)
      .join(" | ");
    return truncate(excerpt, 280);
  } catch {
    return "";
  }
}

function detectLanguages(paths: string[]) {
  const languages = new Set<string>();
  for (const relPath of paths) {
    const lower = relPath.toLowerCase();
    if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(lower)) languages.add("javascript");
    else if (/\.(py)$/.test(lower)) languages.add("python");
    else if (/\.(go)$/.test(lower)) languages.add("go");
    else if (/\.(rs)$/.test(lower)) languages.add("rust");
    else if (/\.(rb)$/.test(lower)) languages.add("ruby");
    else if (/\.(java|kt)$/.test(lower)) languages.add("jvm");
    else if (/\.(swift)$/.test(lower)) languages.add("swift");
    else if (/\.(sql|prisma|db|sqlite|sqlite3)$/.test(lower))
      languages.add("storage");
  }
  return languages;
}

function buildBoundaryReasons(node: ImportedProjectNode) {
  const reasons: string[] = [];
  if (node.tag === "UI") reasons.push("frontend or UI naming");
  if (node.tag === "API") reasons.push("API or gateway entrypoints");
  if (node.tag === "WORKER") reasons.push("worker or automation filenames");
  if (node.tag === "DB" || node.category === "storage")
    reasons.push("storage, schema, or database markers");
  if (node.expectedFiles.some((file) => file.endsWith("package.json")))
    reasons.push("package manifest");
  if (reasons.length === 0) reasons.push("directory and file naming signals");
  return reasons;
}

function collectRepresentativeSamples(
  projectDir: string,
  nodes: ImportedProjectNode[],
): RepresentativeSample[] {
  const samples: RepresentativeSample[] = [];
  const seen = new Set<string>();

  for (const node of nodes) {
    for (const file of node.expectedFiles) {
      if (seen.has(file) || samples.length >= 8) continue;
      const excerpt = readSampleExcerpt(projectDir, file);
      if (!excerpt) continue;
      seen.add(file);
      samples.push({
        path: file,
        reason: `${node.label} representative file`,
        excerpt,
      });
    }
  }

  return samples;
}

function collectDirectoryTree(
  projectDir: string,
  maxDepth = 4,
  maxEntries = 220,
) {
  const lines = [`${basename(projectDir)}/`];
  let total = 1;

  const walk = (absDir: string, depth: number, prefix: string) => {
    if (depth > maxDepth || total >= maxEntries) return;

    const entries = safeReadDir(absDir)
      .filter((entry) =>
        entry.isDirectory()
          ? !isIgnoredDirectory(entry.name)
          : isImplementationFile(entry.name),
      )
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    const visible = entries.slice(0, depth === 0 ? 30 : 18);

    visible.forEach((entry, index) => {
      if (total >= maxEntries) return;
      const last = index === visible.length - 1;
      const marker = last ? "└─ " : "├─ ";
      const nextPrefix = prefix + (last ? "   " : "│  ");
      const label = entry.isDirectory() ? `${entry.name}/` : entry.name;
      lines.push(`${prefix}${marker}${label}`);
      total += 1;
      if (entry.isDirectory()) {
        walk(join(absDir, entry.name), depth + 1, nextPrefix);
      }
    });

    if (entries.length > visible.length && total < maxEntries) {
      lines.push(`${prefix}└─ … +${entries.length - visible.length} more`);
      total += 1;
    }
  };

  walk(projectDir, 0, "");

  if (total >= maxEntries) {
    lines.push("… tree truncated");
  }

  return lines.join("\n");
}

function buildStructureSummary(
  projectDir: string,
  nodes: ImportedProjectNode[],
): ProjectStructureSummary {
  const topLevelEntries = safeReadDir(projectDir).filter(
    (entry) => !isIgnoredDirectory(entry.name),
  );
  const topLevelFiles = topLevelEntries
    .filter((entry) => entry.isFile() && isImplementationFile(entry.name))
    .map((entry) => entry.name)
    .slice(0, 12);
  const candidateBoundaries: StructureCandidateBoundary[] = nodes.map(
    (node) => ({
      path: node.ownedPaths[0] ?? ".",
      labelHint: node.label,
      categoryHint: node.category,
      reasons: buildBoundaryReasons(node),
      expectedFiles: node.expectedFiles.slice(0, 4),
    }),
  );
  const representativeSamples = collectRepresentativeSamples(projectDir, nodes);
  const allFiles = nodes.flatMap((node) => node.expectedFiles);
  const languages = [...detectLanguages(allFiles)];
  const rootImplementationFileCount = topLevelFiles.length;
  const notes: string[] = [];
  let score = 0;

  if (nodes.length >= 2 && nodes.length <= 8) score += 2;
  else if (nodes.length === 1) {
    score -= 2;
    notes.push("Only one broad component boundary was detected.");
  } else if (nodes.length > 8) {
    score -= 1;
    notes.push(
      "The repository likely contains many boundaries or noisy folders.",
    );
  }

  if (rootImplementationFileCount >= 8) {
    score -= 2;
    notes.push(
      "The repository has many implementation files at the root, so folder boundaries may be weak.",
    );
  }

  if (nodes.some((node) => node.tag === "TEST")) {
    notes.push(
      "Tests were treated as downstream verification instead of primary architecture.",
    );
  }

  const storageCandidates = nodes.filter(
    (node) => node.category === "storage" || node.tag === "DB",
  );
  if (storageCandidates.length > 1) {
    score -= 1;
    notes.push(
      "Multiple storage markers were detected and may need consolidation.",
    );
  }

  if (languages.length > 1) {
    score -= 1;
    notes.push(`Mixed-language repository detected (${languages.join(", ")}).`);
  }

  if (nodes.some((node) => ["API", "WORKER", "UI"].includes(node.tag)))
    score += 1;
  if (representativeSamples.length >= 3) score += 1;

  const confidence: ProjectBootstrapConfidence =
    score >= 3 ? "high" : score >= 1 ? "medium" : "low";

  return {
    projectName: basename(projectDir),
    tree: collectDirectoryTree(projectDir),
    topLevelFiles,
    candidateBoundaries,
    representativeSamples,
    notes,
    confidence,
  };
}

function shouldUseAgentImport(
  summary: ProjectStructureSummary,
  nodes: ImportedProjectNode[],
) {
  if (nodes.length === 0) return false;
  if (summary.confidence === "low") return true;
  if (summary.confidence === "medium") return true;
  return summary.notes.some((note) =>
    /weak|mixed-language|consolidation|noisy folders/i.test(note),
  );
}

function buildResultSummary(
  nodes: ImportedProjectNode[],
  source: ProjectBootstrapResult["source"],
) {
  const base =
    nodes.length > 0
      ? `Imported ${nodes.length} node${nodes.length === 1 ? "" : "s"} from the existing project. Review owned paths and contracts before launching.`
      : "No obvious component boundaries were detected. Start by creating nodes manually or add owned paths after import.";

  if (source === "agent")
    return `${base} Architecture was synthesized from the repo structure with the import agent.`;
  if (source === "fallback")
    return `${base} Agent synthesis fell back to deterministic structure analysis.`;
  return `${base} Architecture was imported from deterministic structure analysis.`;
}

function isImportedCategory(value: unknown): value is ImportedNodeCategory {
  return (
    value === "infrastructure" ||
    value === "services" ||
    value === "storage" ||
    value === "custom"
  );
}

function isValidHexColor(value: string) {
  return /^#[0-9a-f]{6}$/i.test(value);
}

function normalizeTag(value: string, fallback: string) {
  const normalized = value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
  return normalized || fallback;
}

function findFallbackNode(
  raw: Record<string, unknown>,
  fallbackNodes: ImportedProjectNode[],
) {
  const rawId = sanitizeId(String(raw.id ?? ""));
  const rawLabel = String(raw.label ?? "")
    .trim()
    .toLowerCase();
  const rawPaths = normalizeRelativePaths(
    Array.isArray(raw.ownedPaths)
      ? raw.ownedPaths.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  );
  return fallbackNodes.find(
    (node) =>
      node.id === rawId ||
      node.label.toLowerCase() === rawLabel ||
      node.ownedPaths.some((path) => rawPaths.includes(path)),
  );
}

function normalizeImportedNode(
  raw: Record<string, unknown>,
  index: number,
  fallbackNodes: ImportedProjectNode[],
): ImportedProjectNode | null {
  const fallback = findFallbackNode(raw, fallbackNodes);
  const expectedFiles = normalizeRelativePaths(
    Array.isArray(raw.expectedFiles)
      ? raw.expectedFiles.filter(
          (value): value is string => typeof value === "string",
        )
      : fallback?.expectedFiles,
  );
  const ownedPaths = normalizeRelativePaths(
    Array.isArray(raw.ownedPaths)
      ? raw.ownedPaths.filter(
          (value): value is string => typeof value === "string",
        )
      : fallback?.ownedPaths,
  );
  const effectiveOwnedPaths =
    ownedPaths.length > 0 ? ownedPaths : deriveOwnedPaths(expectedFiles);
  const subject =
    effectiveOwnedPaths[0] ||
    expectedFiles[0] ||
    String(raw.label ?? fallback?.label ?? `node-${index}`);
  const category = isImportedCategory(raw.category)
    ? raw.category
    : (fallback?.category ?? inferCategory(subject));
  const visuals = inferVisuals(subject, category);
  const id = sanitizeId(
    String(raw.id ?? fallback?.id ?? raw.label ?? `imported-node-${index}`),
  );
  const label = truncate(
    String(
      raw.label ?? fallback?.label ?? titleCase(subject.replace(/\/.*/, "")),
    ),
    48,
  );

  if (!label) return null;

  return {
    id,
    label,
    description: truncate(
      String(
        raw.description ??
          fallback?.description ??
          inferDescription(subject, category),
      ),
      180,
    ),
    category,
    iconName:
      typeof raw.iconName === "string" && ALLOWED_ICON_NAMES.has(raw.iconName)
        ? raw.iconName
        : (fallback?.iconName ?? visuals.iconName),
    color:
      typeof raw.color === "string" && isValidHexColor(raw.color)
        ? raw.color
        : (fallback?.color ?? visuals.color),
    tag: normalizeTag(
      String(raw.tag ?? fallback?.tag ?? visuals.tag),
      fallback?.tag ?? visuals.tag,
    ),
    prompt: truncate(
      String(raw.prompt ?? fallback?.prompt ?? inferPrompt(subject)),
      420,
    ),
    ownedPaths:
      effectiveOwnedPaths.length > 0
        ? effectiveOwnedPaths.slice(0, 6)
        : (fallback?.ownedPaths ?? ["."]),
    expectedFiles:
      expectedFiles.length > 0
        ? expectedFiles.slice(0, 6)
        : (fallback?.expectedFiles ?? []),
    contracts: truncate(
      String(
        raw.contracts ??
          fallback?.contracts ??
          inferContracts(subject, category),
      ),
      320,
    ),
    reviewHints: truncate(
      String(
        raw.reviewHints ??
          fallback?.reviewHints ??
          "Inspect the current implementation before editing. Preserve existing structure and only make deltas inside owned paths unless the task explicitly requires a contract change.",
      ),
      320,
    ),
  };
}

function normalizeImportedGraph(
  payload: Record<string, unknown>,
  fallbackNodes: ImportedProjectNode[],
): { nodes: ImportedProjectNode[]; edges: ImportedProjectEdge[] } | null {
  const rawNodes = Array.isArray(payload.nodes) ? payload.nodes : [];
  const normalizedNodes = dedupeNodes(
    rawNodes
      .map((item, index) =>
        typeof item === "object" && item !== null
          ? normalizeImportedNode(
              item as Record<string, unknown>,
              index,
              fallbackNodes,
            )
          : null,
      )
      .filter((node): node is ImportedProjectNode => node !== null),
  ).slice(0, 12);

  if (normalizedNodes.length === 0) return null;

  const nodeIds = new Set(normalizedNodes.map((node) => node.id));
  const edgeKeys = new Set<string>();
  let counter = 0;
  const rawEdges = Array.isArray(payload.edges) ? payload.edges : [];
  const normalizedEdges: ImportedProjectEdge[] = [];

  for (const item of rawEdges) {
    if (!item || typeof item !== "object") continue;
    const source = sanitizeId(
      String((item as Record<string, unknown>).source ?? ""),
    );
    const target = sanitizeId(
      String((item as Record<string, unknown>).target ?? ""),
    );
    if (!nodeIds.has(source) || !nodeIds.has(target) || source === target)
      continue;
    const key = `${source}->${target}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    normalizedEdges.push({
      id:
        typeof (item as Record<string, unknown>).id === "string"
          ? String((item as Record<string, unknown>).id)
          : `agent-import-edge-${counter++}`,
      source,
      target,
    });
  }

  return {
    nodes: normalizedNodes,
    edges:
      normalizedEdges.length > 0
        ? normalizedEdges
        : buildEdges(normalizedNodes),
  };
}

function parseImportBlock(rawOutput: string) {
  const output = stripAnsi(rawOutput).replace(/\r/g, "\n");
  const start = output.lastIndexOf(IMPORT_BLOCK_START);
  if (start === -1) return null;
  const end = output.indexOf(
    IMPORT_BLOCK_END,
    start + IMPORT_BLOCK_START.length,
  );
  if (end === -1) return null;
  const jsonText = output.slice(start + IMPORT_BLOCK_START.length, end).trim();
  try {
    const parsed = JSON.parse(jsonText);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function buildImportPrompt(
  structure: ProjectStructureSummary,
  deterministicNodes: ImportedProjectNode[],
) {
  const deterministicPreview = JSON.stringify(
    {
      nodes: deterministicNodes.map((node) => ({
        id: node.id,
        label: node.label,
        category: node.category,
        tag: node.tag,
        ownedPaths: node.ownedPaths,
        expectedFiles: node.expectedFiles,
      })),
      edges: buildEdges(deterministicNodes),
    },
    null,
    2,
  );

  return `You are the architecture import agent for Architect. Your task is to turn a repository structure summary into a clean architecture graph for the app canvas.

Return one complete graph for the existing repository. Use the repository structure, file names, and representative samples to infer component boundaries. Do not ask to inspect more files. Do not emit conversational text after the final block.

## Import Rules
- Prefer palette-biased labels when they fit: Frontend, API Gateway, Auth, Service, Worker, Queue, Database, Cache, Object Storage, Search, Monitoring, Analytics, Tests.
- Use repo-specific prefixes only when they add clarity, for example "Browtool API Gateway".
- Base boundaries on directory structure and filenames first. Use representative samples only to disambiguate obvious runtime roles.
- If the repository is messy or flat, create fewer broader nodes instead of inventing many weak components.
- Merge duplicate storage boundaries when a top-level db folder and package-level db file describe the same persistence layer.
- Keep tests as downstream verification nodes, not primary runtime architecture.
- Do not invent packages, runtimes, or services that are not supported by the repo summary.
- Use ownedPaths relative to the repo root.
- expectedFiles must be files that actually appear in the summary.
- Provide short, practical contracts and reviewHints for each node.
- Provide prompts that tell later coding agents to continue from the existing implementation rather than rebuild from zero.
- Prefer 3 to 8 nodes unless the structure clearly demands otherwise.

## Allowed Categories
infrastructure | services | storage | custom

## Allowed iconNames
Monitor, Shield, Lock, Network, Globe, ArrowLeftRight, GitBranch, Webhook, Settings2, Brain, Layers, Cpu, Clock, Mail, Bell, CreditCard, Search, Activity, BarChart2, ToggleLeft, Database, Zap, Archive, Table, Boxes, Share2, TrendingUp, Wrench

## Required Node Shape
id: kebab-case string
label: short human-readable string
description: one sentence
category: allowed category
iconName: allowed icon name
color: hex color
tag: <= 6 uppercase letters/numbers
prompt: short continuation prompt
ownedPaths: string[]
expectedFiles: string[]
contracts: short boundary summary
reviewHints: short inspection guidance

## Edge Shape
id: string
source: node id
target: node id

## Output Format
Return exactly one machine-readable block whose start marker is the exact text formed by concatenating \`ARCHITECT_PROJECT\` and \`_IMPORT\`.
The end marker must be the exact text formed by concatenating \`END_ARCHITECT_PROJECT\` and \`_IMPORT\`.
After the end marker, print the exact completion token formed by concatenating \`ARCHITECT_IMPORT\` and \`_COMPLETE\` on its own line.

## Example
This is the JSON payload that belongs inside the final block:
\`\`\`json
{"nodes":[{"id":"frontend","label":"Frontend","description":"Owns the existing web UI.","category":"infrastructure","iconName":"Monitor","color":"#f472b6","tag":"UI","prompt":"Continue from the existing frontend implementation. Inspect routes and state boundaries before making changes.","ownedPaths":["frontend"],"expectedFiles":["frontend/package.json","frontend/src/main.tsx"],"contracts":"Routes, UI state boundaries, and app-shell integration points.","reviewHints":"Inspect the app entrypoint, routing tree, and API integration points before editing."},{"id":"api-gateway","label":"API Gateway","description":"Owns the existing HTTP and MCP surface.","category":"infrastructure","iconName":"Shield","color":"#fb923c","tag":"API","prompt":"Continue from the existing API implementation. Preserve request contracts and only plan or apply the next delta.","ownedPaths":["server"],"expectedFiles":["server/app.py"],"contracts":"HTTP routes, MCP tools, and request/response contracts.","reviewHints":"Inspect route registration, request handlers, and public interfaces before editing."},{"id":"database","label":"Database","description":"Owns the existing persistence layer.","category":"storage","iconName":"Database","color":"#60a5fa","tag":"DB","prompt":"Continue from the existing persistence layer. Inspect schema and data access boundaries before changing anything.","ownedPaths":["db"],"expectedFiles":["db/schema.sql"],"contracts":"Schema, migrations, repositories, and storage adapters.","reviewHints":"Inspect schema files and database access helpers before editing."}],"edges":[{"id":"example-edge-1","source":"frontend","target":"api-gateway"},{"id":"example-edge-2","source":"api-gateway","target":"database"}],"summary":"Draft architecture imported from existing structure."}
\`\`\`

## Repository Structure
Project: ${structure.projectName}
Confidence: ${structure.confidence}
Notes: ${structure.notes.length > 0 ? structure.notes.join(" | ") : "none"}

Top-level implementation files:
${structure.topLevelFiles.length > 0 ? structure.topLevelFiles.map((file) => `- ${file}`).join("\n") : "- none"}

Directory tree:
\`\`\`
${structure.tree}
\`\`\`

Candidate boundaries from deterministic scan:
\`\`\`json
${JSON.stringify(structure.candidateBoundaries, null, 2)}
\`\`\`

Representative samples:
\`\`\`json
${JSON.stringify(structure.representativeSamples, null, 2)}
\`\`\`

Current deterministic draft to improve or replace:
\`\`\`json
${deterministicPreview}
\`\`\`

Now produce the final architecture import block.`;
}

async function synthesizeArchitectureFromAgent(
  projectDir: string,
  runtime: AgentRuntime,
  structure: ProjectStructureSummary,
  deterministicNodes: ImportedProjectNode[],
): Promise<{
  graph: { nodes: ImportedProjectNode[]; edges: ImportedProjectEdge[] } | null;
  error?: string;
}> {
  const result = await runOneShotAgentPrompt({
    runtime,
    cwd: projectDir,
    prompt: buildImportPrompt(structure, deterministicNodes),
    model: DEFAULT_MODEL_BY_RUNTIME[runtime],
    completionToken: IMPORT_COMPLETION_TOKEN,
    timeoutMs: 120_000,
  });

  if (!result.ok && !result.output) {
    return { graph: null, error: result.error };
  }

  const payload = parseImportBlock(result.output);
  if (!payload) {
    return {
      graph: null,
      error:
        result.error ??
        "Import agent did not return a valid architecture block.",
    };
  }

  const graph = normalizeImportedGraph(payload, deterministicNodes);
  if (!graph) {
    return {
      graph: null,
      error: "Import agent returned an empty or invalid graph.",
    };
  }

  return { graph };
}

export async function bootstrapProjectCanvas(
  projectDir: string,
  runtime: AgentRuntime = DEFAULT_AGENT_RUNTIME,
): Promise<ProjectBootstrapResult> {
  const deterministicNodes = detectCandidateNodes(projectDir);
  const deterministicEdges = buildEdges(deterministicNodes);
  const structure = buildStructureSummary(projectDir, deterministicNodes);

  if (deterministicNodes.length === 0) {
    return {
      nodes: [],
      edges: [],
      summary: buildResultSummary([], "deterministic"),
      source: "deterministic",
      confidence: structure.confidence,
      notes: structure.notes,
    };
  }

  if (!shouldUseAgentImport(structure, deterministicNodes)) {
    return {
      nodes: deterministicNodes,
      edges: deterministicEdges,
      summary: buildResultSummary(deterministicNodes, "deterministic"),
      source: "deterministic",
      confidence: structure.confidence,
      notes: structure.notes,
    };
  }

  const synthesis = await synthesizeArchitectureFromAgent(
    projectDir,
    runtime,
    structure,
    deterministicNodes,
  );
  if (synthesis.graph) {
    return {
      nodes: synthesis.graph.nodes,
      edges: synthesis.graph.edges,
      summary: buildResultSummary(synthesis.graph.nodes, "agent"),
      source: "agent",
      confidence: structure.confidence,
      notes: structure.notes,
    };
  }

  return {
    nodes: deterministicNodes,
    edges: deterministicEdges,
    summary:
      `${buildResultSummary(deterministicNodes, "fallback")} ${synthesis.error ?? ""}`.trim(),
    source: "fallback",
    confidence: structure.confidence,
    notes: structure.notes,
  };
}
