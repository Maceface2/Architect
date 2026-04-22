import fs from 'fs'
import { join, dirname, basename } from 'path'
import { randomBytes } from 'crypto'

// Single source of truth for the mailbox protocol version. Stamped on every
// outbound message; harness _index.json carries the same. Bumped whenever the
// wire format changes in a way older participants can't handle.
export const MAILBOX_PROTOCOL_VERSION = 4

export const MAILBOX_HARNESS_ID = '__harness__'
export const MAILBOX_OVERSEER_ID = 'overseer'

// Typed union of every message kind on the wire. Harness-origin kinds use a
// `harness.` prefix so the Overseer prompt can branch on them.
export type MailboxMessageType =
  | 'task'
  | 'result'
  | 'question'
  | 'answer'
  | 'cancel'
  | 'session-ended'
  | 'harness.pty-exit'
  | 'harness.delivery-warning'
  | 'harness.heartbeat-missed'
  | 'harness.timeout'
  | 'harness.wake'
  | 'harness.backpressure'

export type MailboxRole = 'overseer' | 'zone' | 'harness'

export interface MailboxStructured {
  taskId?: string
  result?: 'success' | 'blocked' | 'failed'
  durationMs?: number
  blocker?: { kind: string; message: string }
  round?: number
}

export interface MailboxMessage {
  id: string
  from: string
  to: string
  type: MailboxMessageType
  timestamp: string
  status: 'pending' | 'read'
  content: string
  structured: MailboxStructured | null
  inReplyTo: string | null
  metadata: {
    dispatchId: string
    protocolVersion: number
    fromLabel: string
  }
}

export type ParticipantLifecycle = 'starting' | 'running' | 'idle' | 'exited' | 'unknown'

export interface ParticipantIndexEntry {
  role: MailboxRole
  label: string
  state: ParticipantLifecycle
  lastActivityMs: number
  exitCode?: number
  pendingTaskIds: string[]
  inboxPending: number
  outboxCount: number
  tail: string
}

export interface MailboxIndex {
  dispatchId: string
  protocolVersion: number
  updatedAt: string
  participants: Record<string, ParticipantIndexEntry>
}

export interface ParticipantDescriptor {
  id: string
  role: MailboxRole
  label: string
}

export function mailboxRoot(projectDir: string): string {
  return join(projectDir, 'ARCHITECT', 'mailbox')
}

export function participantDir(projectDir: string, participantId: string): string {
  return join(mailboxRoot(projectDir), participantId)
}

export function inboxDir(projectDir: string, participantId: string): string {
  return join(participantDir(projectDir, participantId), 'inbox')
}

export function outboxDir(projectDir: string, participantId: string): string {
  return join(participantDir(projectDir, participantId), 'outbox')
}

export function participantTmpDir(projectDir: string, participantId: string): string {
  return join(participantDir(projectDir, participantId), '.tmp')
}

export function participantManifestPath(projectDir: string, participantId: string): string {
  return join(participantDir(projectDir, participantId), 'manifest.json')
}

export function indexPath(projectDir: string): string {
  return join(mailboxRoot(projectDir), '_index.json')
}

export function scriptsDir(projectDir: string): string {
  return join(projectDir, 'ARCHITECT', 'scripts')
}

export function createParticipant(projectDir: string, desc: ParticipantDescriptor): void {
  fs.mkdirSync(inboxDir(projectDir, desc.id), { recursive: true })
  fs.mkdirSync(outboxDir(projectDir, desc.id), { recursive: true })
  fs.mkdirSync(participantTmpDir(projectDir, desc.id), { recursive: true })
  const manifest = {
    participantId: desc.id,
    role: desc.role,
    label: desc.label,
    protocolVersion: MAILBOX_PROTOCOL_VERSION,
    startedAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
  }
  atomicWriteJson(participantManifestPath(projectDir, desc.id), manifest, participantTmpDir(projectDir, desc.id))
}

// Wipe the entire mailbox tree. Called by both runGraph (fresh dispatch /
// redispatch) AND resumeDispatch — every entry point into a dispatch starts
// with an empty mailbox.
//
// Why resume also wipes: the dispatch picker lets the user pick any historical
// dispatch, not just the most recent. By the time they resume an old one, the
// shared ARCHITECT/mailbox/ has almost certainly been trampled by later runs,
// so whatever's on disk is unrelated junk that would only confuse the
// resumed Overseer. Durable conversation state lives in each CLI's own
// session store (reloaded via resumeSessionId); the mailbox was only ever the
// transport, so wiping it costs nothing.
//
// Scripts, prompts, outputs, DispatchRecord, and per-zone session history
// all live outside ARCHITECT/mailbox/ and are unaffected by this wipe.
export function wipeMailboxTree(projectDir: string): void {
  try { fs.rmSync(mailboxRoot(projectDir), { recursive: true, force: true }) } catch {}
}

export function listParticipantIds(projectDir: string): string[] {
  try {
    return fs.readdirSync(mailboxRoot(projectDir), { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name)
  } catch {
    return []
  }
}

export interface ReadParticipantManifest {
  participantId: string
  role: MailboxRole
  label: string
  protocolVersion: number
  startedAt: string
  lastHeartbeat: string
}

export function readParticipantManifest(projectDir: string, participantId: string): ReadParticipantManifest | null {
  try {
    const raw = fs.readFileSync(participantManifestPath(projectDir, participantId), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ReadParticipantManifest>
    if (typeof parsed?.participantId !== 'string') return null
    return {
      participantId: parsed.participantId,
      role: (parsed.role ?? 'zone') as MailboxRole,
      label: typeof parsed.label === 'string' ? parsed.label : parsed.participantId,
      protocolVersion: typeof parsed.protocolVersion === 'number' ? parsed.protocolVersion : 0,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      lastHeartbeat: typeof parsed.lastHeartbeat === 'string' ? parsed.lastHeartbeat : '',
    }
  } catch { return null }
}

function isoFilenameStamp(): string {
  // ISO timestamp with colons replaced — safe across filesystems; lexicographic
  // order still matches chronological order.
  return new Date().toISOString().replace(/:/g, '-').replace(/\..+Z$/, 'Z')
}

function randomMessageId(): string {
  return 'msg-' + randomBytes(6).toString('hex')
}

// Atomic JSON write: writes to tmpDir under a unique name, then renames into
// place. tmpDir must be on the same filesystem as the destination.
function atomicWriteJson(destPath: string, data: unknown, tmpDir: string): void {
  fs.mkdirSync(dirname(destPath), { recursive: true })
  fs.mkdirSync(tmpDir, { recursive: true })
  const tmp = join(tmpDir, `.${basename(destPath)}.${randomBytes(4).toString('hex')}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, destPath)
}

export interface WriteMessageOptions {
  projectDir: string
  from: string
  fromLabel: string
  to: string
  type: MailboxMessageType
  content: string
  inReplyTo?: string | null
  structured?: MailboxStructured | null
  dispatchId: string
}

export interface WriteMessageResult {
  ok: boolean
  msgId?: string
  filename?: string
  error?: string
}

// Drops a message into the target's inbox and mirrors to sender's outbox. Both
// writes are atomic (mktemp + rename) and use the participant's own `.tmp/`
// sibling dir to guarantee same-filesystem rename.
export function writeInboxMessage(opts: WriteMessageOptions): WriteMessageResult {
  const targetInbox = inboxDir(opts.projectDir, opts.to)
  const targetTmp = participantTmpDir(opts.projectDir, opts.to)
  const senderOutbox = outboxDir(opts.projectDir, opts.from)
  const senderTmp = participantTmpDir(opts.projectDir, opts.from)

  if (!fs.existsSync(targetInbox)) {
    return { ok: false, error: `target-inbox-not-found:${opts.to}` }
  }
  fs.mkdirSync(targetTmp, { recursive: true })
  fs.mkdirSync(senderOutbox, { recursive: true })
  fs.mkdirSync(senderTmp, { recursive: true })

  const msgId = randomMessageId()
  const filename = `${isoFilenameStamp()}-${msgId}.json`

  const message: MailboxMessage = {
    id: msgId,
    from: opts.from,
    to: opts.to,
    type: opts.type,
    timestamp: new Date().toISOString(),
    status: 'pending',
    content: opts.content,
    structured: opts.structured ?? null,
    inReplyTo: opts.inReplyTo ?? null,
    metadata: {
      dispatchId: opts.dispatchId,
      protocolVersion: MAILBOX_PROTOCOL_VERSION,
      fromLabel: opts.fromLabel,
    },
  }

  try {
    atomicWriteJson(join(targetInbox, filename), message, targetTmp)
    atomicWriteJson(join(senderOutbox, filename), { ...message, status: 'read' }, senderTmp)
    return { ok: true, msgId, filename }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

export function readInbox(
  projectDir: string,
  participantId: string,
  filter?: { status?: 'pending' | 'read' },
): MailboxMessage[] {
  const dir = inboxDir(projectDir, participantId)
  let entries: string[]
  try { entries = fs.readdirSync(dir) } catch { return [] }
  const messages: MailboxMessage[] = []
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = fs.readFileSync(join(dir, name), 'utf-8')
      const msg = JSON.parse(raw) as MailboxMessage
      if (filter?.status && msg.status !== filter.status) continue
      messages.push(msg)
    } catch { /* skip malformed */ }
  }
  messages.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''))
  return messages
}

export function readOutbox(projectDir: string, participantId: string): MailboxMessage[] {
  const dir = outboxDir(projectDir, participantId)
  let entries: string[]
  try { entries = fs.readdirSync(dir) } catch { return [] }
  const messages: MailboxMessage[] = []
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = fs.readFileSync(join(dir, name), 'utf-8')
      const msg = JSON.parse(raw) as MailboxMessage
      messages.push(msg)
    } catch { /* skip */ }
  }
  messages.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''))
  return messages
}

export function writeIndex(projectDir: string, index: MailboxIndex): void {
  const rootTmp = join(mailboxRoot(projectDir), '.tmp')
  fs.mkdirSync(rootTmp, { recursive: true })
  atomicWriteJson(indexPath(projectDir), index, rootTmp)
}

// ──────────────────────────────────────────────────────────────────────────
// Shell script templates. Emitted into ARCHITECT/scripts/ by setupWorkspace.
// Kept as string constants here so the wire format (message schema, script
// behavior) has a single source of truth co-located with the TS utilities.
// ──────────────────────────────────────────────────────────────────────────

export const MAILBOX_SCRIPTS: Record<string, string> = {
  'mailbox-send.sh': `#!/usr/bin/env bash
# mailbox-send.sh — Atomically send a message to a peer's inbox.
# Usage: mailbox-send.sh <to> <type> <content-file> [inReplyTo]
# Env (required): MBX_ROOT, MBX_SELF, MBX_DISPATCH_ID
# Env (optional): MBX_SELF_LABEL, MBX_STRUCTURED_FILE
# Outputs: message id to stdout. Non-zero exit on validation failure.
set -euo pipefail

TO="\${1:?Usage: mailbox-send.sh <to> <type> <content-file> [inReplyTo]}"
TYPE="\${2:?Usage: mailbox-send.sh <to> <type> <content-file> [inReplyTo]}"
CONTENT_FILE="\${3:?Usage: mailbox-send.sh <to> <type> <content-file> [inReplyTo]}"
IN_REPLY_TO="\${4:-}"

MBX_ROOT="\${MBX_ROOT:?MBX_ROOT must be set}"
MBX_SELF="\${MBX_SELF:?MBX_SELF must be set}"
MBX_SELF_LABEL="\${MBX_SELF_LABEL:-\$MBX_SELF}"
MBX_DISPATCH_ID="\${MBX_DISPATCH_ID:?MBX_DISPATCH_ID must be set}"

# Type whitelist — fail fast on typos at send time.
case "\$TYPE" in
  task|result|question|answer|cancel|session-ended) ;;
  harness.pty-exit|harness.delivery-warning|harness.heartbeat-missed|harness.timeout|harness.wake|harness.backpressure) ;;
  *) echo "Error: invalid message type '\$TYPE'" >&2; exit 2 ;;
esac

TARGET_INBOX="\$MBX_ROOT/\$TO/inbox"
TARGET_TMP="\$MBX_ROOT/\$TO/.tmp"
SENDER_OUTBOX="\$MBX_ROOT/\$MBX_SELF/outbox"
SENDER_TMP="\$MBX_ROOT/\$MBX_SELF/.tmp"

[ -d "\$TARGET_INBOX" ] || { echo "Error: target inbox not found: \$TARGET_INBOX" >&2; exit 1; }
[ -f "\$CONTENT_FILE" ] || { echo "Error: content file not found: \$CONTENT_FILE" >&2; exit 2; }
mkdir -p "\$TARGET_TMP" "\$SENDER_OUTBOX" "\$SENDER_TMP"

MSG_ID="msg-\$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom 2>/dev/null | head -c 12 || true)"
if [ -z "\$MSG_ID" ] || [ "\$MSG_ID" = "msg-" ]; then
  MSG_ID="msg-\$(date +%s%N 2>/dev/null | shasum 2>/dev/null | head -c 12 || echo "fallback\$\$")"
fi
NOW_ISO="\$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
FS_TS="\$(date -u +"%Y-%m-%dT%H-%M-%SZ")"
FILENAME="\${FS_TS}-\${MSG_ID}.json"

if [ -z "\$IN_REPLY_TO" ] || [ "\$IN_REPLY_TO" = "null" ]; then
  IN_REPLY_TO_JSON="null"
else
  IN_REPLY_TO_JSON="\$(printf '%s' "\$IN_REPLY_TO" | jq -Rs .)"
fi

if [ -n "\${MBX_STRUCTURED_FILE:-}" ] && [ -f "\$MBX_STRUCTURED_FILE" ]; then
  STRUCTURED_JSON="\$(cat "\$MBX_STRUCTURED_FILE")"
  if ! printf '%s' "\$STRUCTURED_JSON" | jq empty 2>/dev/null; then
    echo "Error: MBX_STRUCTURED_FILE is not valid JSON: \$MBX_STRUCTURED_FILE" >&2
    exit 2
  fi
else
  STRUCTURED_JSON="null"
fi

MSG_JSON="\$(jq -n \\
  --arg id "\$MSG_ID" \\
  --arg from "\$MBX_SELF" \\
  --arg to "\$TO" \\
  --arg type "\$TYPE" \\
  --arg ts "\$NOW_ISO" \\
  --arg fromLabel "\$MBX_SELF_LABEL" \\
  --arg dispatchId "\$MBX_DISPATCH_ID" \\
  --argjson inReplyTo "\$IN_REPLY_TO_JSON" \\
  --argjson structured "\$STRUCTURED_JSON" \\
  --rawfile content "\$CONTENT_FILE" \\
  '{
    id: \$id, from: \$from, to: \$to, type: \$type,
    timestamp: \$ts, status: "pending",
    content: \$content,
    structured: \$structured,
    inReplyTo: \$inReplyTo,
    metadata: { dispatchId: \$dispatchId, protocolVersion: 4, fromLabel: \$fromLabel }
  }')"

# Atomic write to target inbox (tmp lives in target's .tmp — same filesystem).
TARGET_TMPFILE="\$TARGET_TMP/.\${MSG_ID}.send.tmp"
printf '%s' "\$MSG_JSON" > "\$TARGET_TMPFILE"
mv "\$TARGET_TMPFILE" "\$TARGET_INBOX/\$FILENAME"

# Mirror to sender outbox (status=read: it's our audit record).
OUTBOX_JSON="\$(printf '%s' "\$MSG_JSON" | jq '.status = "read"')"
SENDER_TMPFILE="\$SENDER_TMP/.\${MSG_ID}.out.tmp"
printf '%s' "\$OUTBOX_JSON" > "\$SENDER_TMPFILE"
mv "\$SENDER_TMPFILE" "\$SENDER_OUTBOX/\$FILENAME"

printf '%s' "\$MSG_ID"
`,

  'mailbox-listen.sh': `#!/usr/bin/env bash
# mailbox-listen.sh — Block until a pending message arrives in your inbox.
# Usage: mailbox-listen.sh <participant-id> [timeout-seconds]
# Env (required): MBX_ROOT
# Output on success (exit 0): METADATA_K=V lines, a '---' separator, then the
# message content. Exit 1 on timeout (0 = infinite).
set -euo pipefail

SELF="\${1:?Usage: mailbox-listen.sh <participant-id> [timeout]}"
TIMEOUT="\${2:-0}"

MBX_ROOT="\${MBX_ROOT:?MBX_ROOT must be set}"
INBOX="\$MBX_ROOT/\$SELF/inbox"
TMP="\$MBX_ROOT/\$SELF/.tmp"

[ -d "\$INBOX" ] || { echo "Error: inbox not found for \$SELF at \$INBOX" >&2; exit 2; }
mkdir -p "\$TMP"

ELAPSED=0
INTERVAL=2

while :; do
  if [ "\$TIMEOUT" -gt 0 ] && [ "\$ELAPSED" -ge "\$TIMEOUT" ]; then
    exit 1
  fi

  # Scan *.json files in lexicographic (= chronological, per ISO-ts prefix) order.
  # Tempfiles live in sibling .tmp/ so the glob naturally excludes them.
  for FILE in "\$INBOX"/*.json; do
    [ -f "\$FILE" ] || continue
    STATUS="\$(jq -r '.status' "\$FILE" 2>/dev/null || echo)"
    [ "\$STATUS" = "pending" ] || continue
    FROM="\$(jq -r '.from' "\$FILE")"
    [ "\$FROM" = "\$SELF" ] && continue   # echo prevention

    MSG_ID="\$(jq -r '.id' "\$FILE")"
    TO="\$(jq -r '.to' "\$FILE")"
    TYPE="\$(jq -r '.type' "\$FILE")"
    FROM_LABEL="\$(jq -r '.metadata.fromLabel // .from' "\$FILE")"
    IN_REPLY_TO="\$(jq -r '.inReplyTo // ""' "\$FILE")"
    CONTENT="\$(jq -r '.content' "\$FILE")"
    STRUCTURED="\$(jq -c '.structured' "\$FILE" 2>/dev/null || echo null)"

    # Mark read atomically.
    READ_TMP="\$TMP/.read-\$(basename "\$FILE").tmp"
    jq '.status = "read"' "\$FILE" > "\$READ_TMP"
    mv "\$READ_TMP" "\$FILE"

    echo "MESSAGE_ID=\$MSG_ID"
    echo "FROM=\$FROM"
    echo "TO=\$TO"
    echo "FROM_LABEL=\$FROM_LABEL"
    echo "TYPE=\$TYPE"
    echo "IN_REPLY_TO=\$IN_REPLY_TO"
    if [ -n "\$STRUCTURED" ] && [ "\$STRUCTURED" != "null" ]; then
      echo "STRUCTURED=\$STRUCTURED"
    fi
    echo "---"
    printf '%s\\n' "\$CONTENT"
    exit 0
  done

  sleep "\$INTERVAL"
  ELAPSED=\$((ELAPSED + INTERVAL))
done
`,

  'mailbox-drain.sh': `#!/usr/bin/env bash
# mailbox-drain.sh — Return ALL pending messages as a JSON array (FIFO).
# Usage: mailbox-drain.sh <participant-id>
# Env (required): MBX_ROOT
# Output: JSON array on stdout; marks each drained message as 'read' atomically.
set -euo pipefail

SELF="\${1:?Usage: mailbox-drain.sh <participant-id>}"
MBX_ROOT="\${MBX_ROOT:?MBX_ROOT must be set}"
INBOX="\$MBX_ROOT/\$SELF/inbox"
TMP="\$MBX_ROOT/\$SELF/.tmp"

if [ ! -d "\$INBOX" ]; then
  echo "[]"
  exit 0
fi
mkdir -p "\$TMP"

ARR="[]"
# find/sort guarantees FIFO even if the shell's glob order isn't lexicographic.
while IFS= read -r -d '' FILE; do
  [ -f "\$FILE" ] || continue
  STATUS="\$(jq -r '.status' "\$FILE" 2>/dev/null || echo)"
  [ "\$STATUS" = "pending" ] || continue
  FROM="\$(jq -r '.from' "\$FILE")"
  [ "\$FROM" = "\$SELF" ] && continue

  MSG="\$(cat "\$FILE")"
  ARR="\$(jq --argjson m "\$MSG" '. + [\$m]' <<<"\$ARR")"

  READ_TMP="\$TMP/.drain-\$(basename "\$FILE").tmp"
  jq '.status = "read"' "\$FILE" > "\$READ_TMP"
  mv "\$READ_TMP" "\$FILE"
done < <(find "\$INBOX" -maxdepth 1 -type f -name "*.json" -print0 | sort -z)

echo "\$ARR"
`,

  'mailbox-status.sh': `#!/usr/bin/env bash
# mailbox-status.sh — Emit a JSON summary of every participant.
# Env (required): MBX_ROOT
set -euo pipefail

MBX_ROOT="\${MBX_ROOT:?MBX_ROOT must be set}"
[ -d "\$MBX_ROOT" ] || { echo '{}'; exit 0; }

OUT="{}"
for PDIR in "\$MBX_ROOT"/*/; do
  [ -d "\$PDIR" ] || continue
  PID="\$(basename "\$PDIR")"
  case "\$PID" in .*) continue ;; esac

  MANIFEST="\$PDIR/manifest.json"
  ROLE="unknown"; LABEL="\$PID"
  if [ -f "\$MANIFEST" ]; then
    ROLE="\$(jq -r '.role // "unknown"' "\$MANIFEST")"
    LABEL="\$(jq -r '.label // .participantId // "\$PID"' "\$MANIFEST")"
  fi

  PENDING=0; READ_COUNT=0; OUT_COUNT=0
  if [ -d "\$PDIR/inbox" ]; then
    for F in "\$PDIR/inbox"/*.json; do
      [ -f "\$F" ] || continue
      S="\$(jq -r '.status' "\$F" 2>/dev/null || echo unknown)"
      case "\$S" in
        pending) PENDING=\$((PENDING+1)) ;;
        read)    READ_COUNT=\$((READ_COUNT+1)) ;;
      esac
    done
  fi
  if [ -d "\$PDIR/outbox" ]; then
    OUT_COUNT=\$(find "\$PDIR/outbox" -maxdepth 1 -type f -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
  fi

  OUT="\$(jq \\
    --arg id "\$PID" \\
    --arg role "\$ROLE" \\
    --arg label "\$LABEL" \\
    --argjson pending "\$PENDING" \\
    --argjson readMsgs "\$READ_COUNT" \\
    --argjson outbox "\$OUT_COUNT" \\
    '. + {(\$id): {role: \$role, label: \$label, inboxPending: \$pending, inboxRead: \$readMsgs, outboxCount: \$outbox}}' \\
    <<<"\$OUT")"
done

echo "\$OUT"
`,

  'mailbox-cleanup.sh': `#!/usr/bin/env bash
# mailbox-cleanup.sh — Notify peers of session end and remove own mailbox dir.
# Usage: mailbox-cleanup.sh <participant-id>
# Env (required): MBX_ROOT, MBX_DISPATCH_ID
set -euo pipefail

SELF="\${1:?Usage: mailbox-cleanup.sh <participant-id>}"
MBX_ROOT="\${MBX_ROOT:?MBX_ROOT must be set}"
SCRIPT_DIR="\$(cd "\$(dirname "\$0")" && pwd)"

[ -d "\$MBX_ROOT/\$SELF" ] || exit 0

PEERS=""
if [ -d "\$MBX_ROOT/\$SELF/inbox" ]; then
  INBOX_PEERS="\$(find "\$MBX_ROOT/\$SELF/inbox" -maxdepth 1 -type f -name "*.json" -exec jq -r '.from // empty' {} \\; 2>/dev/null || true)"
  PEERS="\$PEERS \$INBOX_PEERS"
fi
if [ -d "\$MBX_ROOT/\$SELF/outbox" ]; then
  OUTBOX_PEERS="\$(find "\$MBX_ROOT/\$SELF/outbox" -maxdepth 1 -type f -name "*.json" -exec jq -r '.to // empty' {} \\; 2>/dev/null || true)"
  PEERS="\$PEERS \$OUTBOX_PEERS"
fi
PEERS="\$(echo "\$PEERS" | tr ' ' '\\n' | sort -u | grep -v '^\$' | grep -v "^\$SELF\$" || true)"

for P in \$PEERS; do
  [ -d "\$MBX_ROOT/\$P/inbox" ] || continue
  TMP_CONTENT="\$(mktemp -t session-ended.XXXXXX)"
  printf '%s' "Session \$SELF ended." > "\$TMP_CONTENT"
  MBX_ROOT="\$MBX_ROOT" MBX_SELF="\$SELF" MBX_SELF_LABEL="\${MBX_SELF_LABEL:-\$SELF}" \\
    MBX_DISPATCH_ID="\${MBX_DISPATCH_ID:?MBX_DISPATCH_ID must be set}" \\
    bash "\$SCRIPT_DIR/mailbox-send.sh" "\$P" "session-ended" "\$TMP_CONTENT" 2>/dev/null || true
  rm -f "\$TMP_CONTENT"
done

rm -rf "\$MBX_ROOT/\$SELF"
`,
}

// Writes (or overwrites) all mailbox scripts under ARCHITECT/scripts/ with +x
// perms. Called from setupWorkspace so each dispatch gets a fresh copy.
export function writeMailboxScripts(projectDir: string): void {
  const dir = scriptsDir(projectDir)
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(MAILBOX_SCRIPTS)) {
    const path = join(dir, name)
    fs.writeFileSync(path, body)
    try { fs.chmodSync(path, 0o755) } catch {}
  }
}
