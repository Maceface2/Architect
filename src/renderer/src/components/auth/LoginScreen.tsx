import { useState, type FormEvent } from 'react'
import { Loader2 } from 'lucide-react'

const REQUEST_ACCESS_URL = 'https://architect.dev/early-access'

export default function LoginScreen() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (submitting) return
    setError(null)
    setSubmitting(true)
    try {
      const result = await window.electron.auth.login(email, password)
      if (!result.ok) {
        setError(result.error ?? 'Sign in failed')
        setSubmitting(false)
        return
      }
      // Success: App's onSessionChanged listener flips the gate. Leave the
      // form disabled until the unmount.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
  }

  return (
    <div className="h-screen w-screen bg-canvas flex flex-col items-center justify-center gap-8 select-none">
      <div className="flex flex-col items-center gap-4">
        <svg width="52" height="52" viewBox="0 0 400 400" fill="none">
          <line x1="40" y1="360" x2="360" y2="40" stroke="#58A6FF" strokeWidth="14" strokeLinecap="round" />
          <line x1="40" y1="360" x2="200" y2="360" stroke="#58A6FF" strokeWidth="14" strokeLinecap="round" />
          <line x1="200" y1="360" x2="360" y2="40" stroke="#58A6FF" strokeWidth="14" strokeLinecap="round" />
          <circle cx="40" cy="360" r="14" fill="#58A6FF" />
          <circle cx="200" cy="360" r="14" fill="#58A6FF" />
          <circle cx="360" cy="40" r="14" fill="#58A6FF" />
        </svg>
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-white tracking-tight">Architect</h1>
          <p className="text-sm text-slate-500 mt-1">Sign in to continue</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="w-full max-w-xs flex flex-col gap-3">
        <input
          type="email"
          placeholder="Email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={submitting}
          className="w-full bg-node border border-node-border rounded px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
        />
        <input
          type="password"
          placeholder="Password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={submitting}
          className="w-full bg-node border border-node-border rounded px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
        />

        {error && (
          <div className="text-xs text-red-400 leading-relaxed">{error}</div>
        )}

        <button
          type="submit"
          disabled={submitting || !email || !password}
          className="flex items-center justify-center gap-2 px-6 py-3 bg-accent hover:bg-[#4a4ad0] disabled:opacity-50 disabled:pointer-events-none text-white text-sm font-medium rounded-lg transition-colors"
        >
          {submitting ? <Loader2 size={14} className="animate-spin" /> : null}
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p className="text-xs text-slate-700">
        Don&apos;t have an account?{' '}
        <a
          href={REQUEST_ACCESS_URL}
          target="_blank"
          rel="noreferrer"
          className="text-slate-500 hover:text-slate-300 underline underline-offset-2"
        >
          Request access
        </a>
      </p>
    </div>
  )
}
