import { execFileSync } from 'child_process'
import fs from 'fs'
import { dirname, join } from 'path'

// Per-dispatch helper script that wraps the activity-log append in a
// positional-argv interface, instead of asking agents to construct heredoc
// shell commands themselves. Heredoc-based writes are fragile under the
// command wrappers Architect sees in the wild (rtk, etc.) because the agent
// has to triple-escape single quotes around the heredoc terminator. Argv-based
// writes survive proper exec-based wrappers cleanly.
//
// The script is written per-dispatch under ARCHITECT/runtime/<dispatchId>/bin/
// so it lives inside the same ephemeral subtree everything else does (wiped on
// resume, recreated by setupWorkspaceV5).

function runtimeRoot(projectDir: string, dispatchId: string): string {
  return join(projectDir, 'ARCHITECT', 'runtime', dispatchId)
}

export function recordHelperPath(projectDir: string, dispatchId: string): string {
  return join(runtimeRoot(projectDir, dispatchId), 'bin', 'record')
}

// POSIX shell + python3 (with jq fallback) for safe JSON encoding. The agent
// only deals with simple positional args; the script handles JSON quoting,
// timestamp generation, and the participant-id check internally.
//
// Usage from the agent's shell:
//   "$ARCHITECT_RECORD" <kind> <content>
//   "$ARCHITECT_RECORD" <kind> <content> --task <taskId>
//   "$ARCHITECT_RECORD" <kind> <content> --task <taskId> --structured <json>
//   "$ARCHITECT_RECORD" <kind> <content> --structured <json>
const SCRIPT_BODY = `#!/bin/sh
# Architect activity-log record helper. Generated per dispatch.
# Usage:
#   record <kind> <content> [--task <taskId>] [--structured <json>]
# Required env: ARCHITECT_PARTICIPANT_ID, ARCHITECT_ACTIVITY_LOG
set -e

if [ $# -lt 2 ]; then
  echo "record: usage: record <kind> <content> [--task <taskId>] [--structured <json>]" >&2
  exit 2
fi

KIND="$1"
CONTENT="$2"
shift 2
TASK_ID=""
STRUCTURED=""
while [ $# -gt 0 ]; do
  case "$1" in
    --task)
      [ $# -ge 2 ] || { echo "record: --task needs an argument" >&2; exit 2; }
      TASK_ID="$2"; shift 2 ;;
    --structured)
      [ $# -ge 2 ] || { echo "record: --structured needs an argument" >&2; exit 2; }
      STRUCTURED="$2"; shift 2 ;;
    *)
      echo "record: unknown arg: $1" >&2; exit 2 ;;
  esac
done

: "\${ARCHITECT_PARTICIPANT_ID:?ARCHITECT_PARTICIPANT_ID not set}"
: "\${ARCHITECT_ACTIVITY_LOG:?ARCHITECT_ACTIVITY_LOG not set}"

# Timestamp generation lives inside python/jq so we get ms precision (BSD date
# on macOS doesn't support %N). When two events emit in the same second this
# avoids ts collisions that would make resume-time interleaving order-undefined.
if command -v python3 >/dev/null 2>&1; then
  python3 - "$ARCHITECT_PARTICIPANT_ID" "$KIND" "$TASK_ID" "$CONTENT" "$STRUCTURED" "$ARCHITECT_ACTIVITY_LOG" <<'PYEOF'
import datetime, json, sys
pid, kind, tid, content, structured, log = sys.argv[1:]
ts = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
ev = {"ts": ts, "from": pid, "kind": kind, "content": content}
if tid:
    ev["taskId"] = tid
if structured:
    try:
        ev["structured"] = json.loads(structured)
    except json.JSONDecodeError as e:
        sys.stderr.write("record: --structured is not valid JSON: " + str(e) + "\\n")
        sys.exit(2)
with open(log, "a", encoding="utf-8") as f:
    f.write(json.dumps(ev, ensure_ascii=False) + "\\n")
PYEOF
elif command -v jq >/dev/null 2>&1; then
  # jq fallback: ms precision via 'now * 1000' arithmetic since strftime %N is
  # GNU-only. Same wire shape as the python branch.
  jq -nc \\
    --arg from "$ARCHITECT_PARTICIPANT_ID" \\
    --arg kind "$KIND" \\
    --arg taskId "$TASK_ID" \\
    --arg content "$CONTENT" \\
    --arg structuredRaw "$STRUCTURED" \\
    '(now * 1000 | floor) as $ms
     | ($ms / 1000 | floor | strftime("%Y-%m-%dT%H:%M:%S")) as $secs
     | (($ms % 1000 + 1000 | tostring) | .[1:]) as $msPart
     | ($secs + "." + $msPart + "Z") as $ts
     | {ts: $ts, from: $from, kind: $kind, content: $content}
     + (if $taskId == "" then {} else {taskId: $taskId} end)
     + (if $structuredRaw == "" then {} else {structured: ($structuredRaw | fromjson)} end)' \\
    >> "$ARCHITECT_ACTIVITY_LOG"
else
  echo "record: requires python3 or jq for safe JSON encoding" >&2
  exit 1
fi
`

// Cheap once-per-process check: at least one of python3 / jq must be on PATH.
// Without this, the script-level fallback fires on every emit and the agent
// sees opaque exit codes instead of a clear setup error at dispatch start.
let runtimeChecked = false
function ensureJsonRuntimePresent(): void {
  if (runtimeChecked) return
  for (const cmd of ['python3', 'jq']) {
    try {
      execFileSync(cmd, ['--version'], { stdio: 'ignore' })
      runtimeChecked = true
      return
    } catch {
      // try next
    }
  }
  throw new Error(
    'Architect record helper requires python3 or jq on PATH for safe JSON encoding. ' +
    'Install one of them and retry the dispatch.',
  )
}

export function ensureRecordHelper(projectDir: string, dispatchId: string): string {
  ensureJsonRuntimePresent()
  const path = recordHelperPath(projectDir, dispatchId)
  fs.mkdirSync(dirname(path), { recursive: true })
  fs.writeFileSync(path, SCRIPT_BODY, { mode: 0o755 })
  // writeFileSync's mode option is ignored if the file already exists; chmod
  // unconditionally so resumes and re-writes both end up executable.
  fs.chmodSync(path, 0o755)
  return path
}
