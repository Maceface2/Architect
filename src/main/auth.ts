import { app, ipcMain, safeStorage, BrowserWindow } from 'electron'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'
import type { AuthLoginResult, SessionInfo } from '../shared/electronTypes'

// Re-export so existing call sites (`import { SessionInfo } from './auth'`)
// keep working without changes. The canonical definition lives in
// shared/electronTypes.ts so renderer + main agree on the wire shape.
export type { SessionInfo } from '../shared/electronTypes'

const SESSION_FILE = 'session.enc'

let supabase: SupabaseClient | null = null
let configError: string | null = null
let mainWindow: BrowserWindow | null = null
let warnedAboutPlaintext = false
let logoutHandler: (() => void) | null = null

function sessionFilePath(): string {
  return path.join(app.getPath('userData'), SESSION_FILE)
}

function makeStorage() {
  return {
    getItem(_key: string): string | null {
      try {
        const buf = fs.readFileSync(sessionFilePath())
        if (safeStorage.isEncryptionAvailable()) {
          return safeStorage.decryptString(buf)
        }
        return buf.toString('utf-8')
      } catch {
        return null
      }
    },
    setItem(_key: string, value: string): void {
      try {
        let data: Buffer
        if (safeStorage.isEncryptionAvailable()) {
          data = safeStorage.encryptString(value)
        } else {
          if (!warnedAboutPlaintext) {
            console.warn('[auth] safeStorage encryption unavailable — session stored in plaintext')
            warnedAboutPlaintext = true
          }
          data = Buffer.from(value, 'utf-8')
        }
        fs.mkdirSync(path.dirname(sessionFilePath()), { recursive: true })
        fs.writeFileSync(sessionFilePath(), data)
      } catch (err) {
        console.error('[auth] failed to persist session', err)
      }
    },
    removeItem(_key: string): void {
      try {
        fs.unlinkSync(sessionFilePath())
      } catch {
        // ignore
      }
    },
  }
}

function readEnv(name: string): string | undefined {
  const fromImportMeta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  return fromImportMeta?.[name] ?? process.env[name]
}

function ensureClient(): SupabaseClient | null {
  if (supabase) return supabase
  if (configError) return null

  const url = readEnv('MAIN_VITE_SUPABASE_URL')
  const key = readEnv('MAIN_VITE_SUPABASE_PUBLISHABLE_KEY')
  if (!url || !key) {
    configError =
      'Auth not configured. Set MAIN_VITE_SUPABASE_URL and MAIN_VITE_SUPABASE_PUBLISHABLE_KEY in .env, then restart the app.'
    console.error('[auth]', configError)
    return null
  }

  supabase = createClient(url, key, {
    auth: {
      storage: makeStorage(),
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  })

  supabase.auth.onAuthStateChange((event, session) => {
    const info = sessionToInfo(session)
    if (event === 'SIGNED_OUT') {
      try {
        logoutHandler?.()
      } catch (err) {
        console.error('[auth] logout handler failed', err)
      }
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('auth:session-changed', info)
    }
  })

  return supabase
}

function sessionToInfo(session: { user?: { id: string; email?: string | null } | null } | null): SessionInfo | null {
  if (!session?.user) return null
  return { userId: session.user.id, email: session.user.email ?? '' }
}

export function setAuthMainWindow(win: BrowserWindow | null): void {
  mainWindow = win
}

// Registers the cleanup that should run when Supabase emits SIGNED_OUT.
// Used by the main entry point to tear down PTYs (including user shells)
// and close any popout terminal windows so prior session state cannot
// leak across accounts.
export function setAuthLogoutHandler(fn: (() => void) | null): void {
  logoutHandler = fn
}

export function registerAuthIpc(): void {
  ipcMain.handle('auth:get-session', async (): Promise<SessionInfo | null> => {
    const client = ensureClient()
    if (!client) return null
    const { data } = await client.auth.getSession()
    return sessionToInfo(data.session)
  })

  ipcMain.handle(
    'auth:login',
    async (_event, email: string, password: string): Promise<AuthLoginResult> => {
      const client = ensureClient()
      if (!client) {
        return { ok: false, error: configError ?? 'Auth not configured' }
      }
      const { data, error } = await client.auth.signInWithPassword({
        email: email.trim(),
        password,
      })
      if (error) {
        return { ok: false, error: error.message }
      }
      const info = sessionToInfo(data.session)
      if (!info) {
        return { ok: false, error: 'Sign-in succeeded but no session was returned' }
      }
      return { ok: true, session: info }
    },
  )

  ipcMain.handle('auth:logout', async (): Promise<{ ok: boolean }> => {
    const client = ensureClient()
    if (!client) return { ok: true }
    await client.auth.signOut()
    return { ok: true }
  })
}
