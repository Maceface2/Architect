import { useEffect, useRef, useState } from 'react'
import { LogOut, User } from 'lucide-react'

export default function UserMenu() {
  const [email, setEmail] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    window.electron.auth.getSession().then((s) => setEmail(s?.email ?? null))
    return window.electron.auth.onSessionChanged((s) => setEmail(s?.email ?? null))
  }, [])

  useEffect(() => {
    if (!open) return
    const onDocDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!email) return null

  const initial = email.slice(0, 1).toUpperCase()

  return (
    <div ref={wrapRef} className="relative">
      {open && (
        <div className="absolute bottom-0 left-full ml-1 z-40 w-60 rounded-lg border border-node-border bg-[#161616] shadow-2xl overflow-hidden">
          <div className="px-3 py-2.5 border-b border-node-border">
            <div className="text-[10px] uppercase tracking-wide text-fg-subtle">Account</div>
            <div className="mt-0.5 text-xs text-fg truncate" title={email}>
              {email}
            </div>
          </div>
          <button
            onClick={() => {
              setOpen(false)
              void window.electron.auth.logout()
            }}
            className="flex items-center gap-2 w-full px-3 py-2 text-xs text-fg-muted hover:bg-node hover:text-fg transition-colors"
          >
            <LogOut size={12} />
            Sign out
          </button>
        </div>
      )}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-center w-5 h-5 rounded bg-node border border-node-border text-fg-muted hover:text-fg hover:bg-[#222] transition-colors"
        title={email}
        aria-label="Account menu"
      >
        {initial ? (
          <span className="text-[9px] font-semibold">{initial}</span>
        ) : (
          <User size={10} />
        )}
      </button>
    </div>
  )
}
