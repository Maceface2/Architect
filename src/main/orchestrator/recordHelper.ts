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
//
// Caveat — argv exposure: the agent invocation itself
// (`"$ARCHITECT_RECORD" done "<content>" ...`) places <content> in the shell
// process's argv, which is briefly visible via `ps` to the same uid. Inside
// the helper we forward CONTENT/STRUCTURED via env vars to python/jq so the
// longer-lived encoder process doesn't re-expose them, but the agent's own
// shell call cannot be hidden without changing the user-facing API. Acceptable
// for a single-user local dev tool; do not use this helper for secrets.

const CONTENT_BYTE_CAP = 8 * 1024

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
//
// CONTENT is capped at 8 KB (CONTENT_BYTE_CAP). Oversized content is
// truncated with a `…[truncated]` marker so the line still parses; the
// activity-log parser otherwise drops lines past the cap silently, which
// makes diagnosis hard for an agent that just sees a non-zero exit.
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

# Forward content/structured via env, not argv. The agent's own argv can't be
# hidden without an API change, but we don't have to widen the leak window by
# re-passing the same data through the longer-lived encoder process.
ARCHITECT_RECORD_CONTENT="$CONTENT"
ARCHITECT_RECORD_STRUCTURED="$STRUCTURED"
ARCHITECT_RECORD_CONTENT_CAP=${CONTENT_BYTE_CAP}
export ARCHITECT_RECORD_CONTENT ARCHITECT_RECORD_STRUCTURED ARCHITECT_RECORD_CONTENT_CAP

# Timestamp generation lives inside python/jq so we get ms precision (BSD date
# on macOS doesn't support %N). When two events emit in the same second this
# avoids ts collisions that would make resume-time interleaving order-undefined.
if command -v python3 >/dev/null 2>&1; then
  python3 - "$ARCHITECT_PARTICIPANT_ID" "$KIND" "$TASK_ID" "$ARCHITECT_ACTIVITY_LOG" <<'PYEOF'
import datetime, json, os, sys
pid, kind, tid, log = sys.argv[1:]
content = os.environ.get("ARCHITECT_RECORD_CONTENT", "")
structured = os.environ.get("ARCHITECT_RECORD_STRUCTURED", "")
cap = int(os.environ.get("ARCHITECT_RECORD_CONTENT_CAP", "8192"))
# Cap at byte length of utf-8 encoding (matches the parser-side limit). Slice
# defensively on a code-point boundary so we don't emit invalid utf-8.
encoded = content.encode("utf-8")
if len(encoded) > cap:
    marker = "…[truncated]"
    keep = max(0, cap - len(marker.encode("utf-8")))
    content = encoded[:keep].decode("utf-8", errors="ignore") + marker
    sys.stderr.write("record: content exceeded {} bytes; truncated\\n".format(cap))
ts = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
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
  #
  # Truncation: jq reports byte length via 'utf8bytelength'. If we exceed the
  # cap, slice the original by character count proportional to the overflow
  # (close enough — the parser cap is byte-based, this keeps us under it on
  # ASCII and most multi-byte text without a per-codepoint loop in jq).
  jq -nc \\
    --arg from "$ARCHITECT_PARTICIPANT_ID" \\
    --arg kind "$KIND" \\
    --arg taskId "$TASK_ID" \\
    --arg contentRaw "$ARCHITECT_RECORD_CONTENT" \\
    --arg structuredRaw "$ARCHITECT_RECORD_STRUCTURED" \\
    --argjson cap $ARCHITECT_RECORD_CONTENT_CAP \\
    '($contentRaw | utf8bytelength) as $clen
     | (if $clen > $cap
          then ($contentRaw[0:($cap / ($clen / ($contentRaw | length)) | floor) - 14] + "…[truncated]")
          else $contentRaw
        end) as $content
     | (now * 1000 | floor) as $ms
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

// Probe for python3 / jq each time. Earlier versions cached the result for
// the lifetime of the Electron process, but a positive cache masks the case
// where the user uninstalls python3 between dispatches: the dispatch starts,
// the agent's first record call hits the script-level fallback, and the
// dispatch hangs on missing activity events. The probe is two ~10 ms execs
// at workspace setup — cheap enough to run unconditionally.
function ensureJsonRuntimePresent(): void {
  for (const cmd of ['python3', 'jq']) {
    try {
      execFileSync(cmd, ['--version'], { stdio: 'ignore' })
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
