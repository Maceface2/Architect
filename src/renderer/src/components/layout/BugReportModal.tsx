import { useEffect, useState } from 'react'
import { Loader2, ExternalLink } from 'lucide-react'
import { getConsoleRingBuffer } from '../../lib/consoleRingBuffer'

// Opens via window.open so Electron's setWindowOpenHandler routes it to
// shell.openExternal — no extra IPC needed for the form-launch step.
const BUG_REPORT_FORM_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLSfzN2kEodzig3m6KcYRj_JtW-mFBx7JCyDlWmrOjHm9JbWQMQ/viewform'

interface Props {
  projectDir: string | null
  activeDispatchId: string | null
  onClose: () => void
}

type Status =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'copied-and-opened' }
  | { kind: 'saved'; path: string }
  | { kind: 'error'; message: string }

export default function BugReportModal({ projectDir, activeDispatchId, onClose }: Props) {
  const [message, setMessage] = useState('')
  const [includeLogs, setIncludeLogs] = useState(true)
  const [logPath, setLogPath] = useState<string | null>(null)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  useEffect(() => {
    let cancelled = false
    window.electron.bugReport
      .getLogPath()
      .then((p) => { if (!cancelled) setLogPath(p) })
      .catch(() => { if (!cancelled) setLogPath(null) })
    return () => { cancelled = true }
  }, [])

  async function bundle(): Promise<string> {
    return window.electron.bugReport.bundle({
      userMessage: message,
      rendererLogs: getConsoleRingBuffer(),
      projectDir,
      activeDispatchId,
      includeLogs,
    })
  }

  async function handleCopyAndOpen(): Promise<void> {
    setStatus({ kind: 'working' })
    try {
      const text = await bundle()
      await navigator.clipboard.writeText(text)
      window.open(BUG_REPORT_FORM_URL, '_blank')
      setStatus({ kind: 'copied-and-opened' })
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  async function handleSave(): Promise<void> {
    setStatus({ kind: 'working' })
    try {
      const text = await bundle()
      const filePath = await window.electron.bugReport.saveToFile({ text })
      setStatus({ kind: 'saved', path: filePath })
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const working = status.kind === 'working'

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-md border border-white/[0.08] bg-[#1c1916] shadow-2xl">
        <div className="border-b border-white/[0.06] px-5 py-4">
          <h2 className="text-sm font-semibold text-fg">Report a bug</h2>
          <p className="mt-1 text-xs leading-5 text-fg-muted">
            Describe what happened, then click <span className="text-fg">Copy logs &amp; open form</span>. Architect copies a diagnostic bundle to your clipboard and opens the feedback form. Paste the bundle into the &ldquo;Logs&rdquo; field.
          </p>
        </div>

        <div className="px-5 py-4 space-y-3">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="What were you doing when the issue occurred?"
            rows={5}
            className="w-full resize-none rounded border border-node-border bg-[#0e0e0e] px-3 py-2 text-xs text-fg placeholder:text-fg-subtle focus:outline-none focus:border-accent/60"
          />
          <label className="flex items-center gap-2 text-xs text-fg-muted">
            <input
              type="checkbox"
              checked={includeLogs}
              onChange={(e) => setIncludeLogs(e.target.checked)}
            />
            Include recent logs (main process, renderer console{activeDispatchId ? ', active dispatch activity' : ''})
          </label>
          {logPath && (
            <p className="text-[11px] text-fg-subtle break-all">Log file: {logPath}</p>
          )}
          {status.kind === 'copied-and-opened' && (
            <p className="text-[11px] text-emerald-300">
              Bundle copied. Paste it into the &ldquo;Logs&rdquo; field on the form that just opened.
            </p>
          )}
          {status.kind === 'saved' && (
            <p className="text-[11px] text-emerald-300 break-all">Saved to {status.path} (revealed in Finder).</p>
          )}
          {status.kind === 'error' && (
            <p className="text-[11px] text-rose-300 break-all">{status.message}</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] px-5 py-4">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-fg-muted border border-node-border rounded hover:bg-node transition-colors"
          >
            Close
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={working}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-fg-muted border border-node-border rounded hover:bg-node disabled:opacity-50 disabled:pointer-events-none transition-colors"
            title="Save the bundle to a file in Downloads. Useful if the logs are too long to paste into the form."
          >
            {working && <Loader2 size={11} className="animate-spin" />}
            Save to file
          </button>
          <button
            onClick={() => void handleCopyAndOpen()}
            disabled={working}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-fg bg-accent rounded hover:bg-[#4a4ad0] disabled:opacity-50 disabled:pointer-events-none transition-colors"
          >
            {working ? <Loader2 size={11} className="animate-spin" /> : <ExternalLink size={11} />}
            Copy logs &amp; open form
          </button>
        </div>
      </div>
    </div>
  )
}
