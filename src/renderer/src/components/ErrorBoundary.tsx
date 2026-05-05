import { Component, type ErrorInfo, type ReactNode } from 'react'
import { getConsoleRingBuffer } from '../lib/consoleRingBuffer'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  componentStack: string | null
  copied: boolean
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null, copied: false }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null })
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  handleCopy = async (): Promise<void> => {
    const { error, componentStack } = this.state
    const parts = [
      `Error: ${error?.message ?? '(unknown)'}`,
      error?.stack ? `\nStack:\n${error.stack}` : '',
      componentStack ? `\nComponent stack:\n${componentStack.replace(/^\n/, '')}` : '',
      `\nRecent console:\n${getConsoleRingBuffer()}`,
    ]
    try {
      await navigator.clipboard.writeText(parts.join('\n'))
      this.setState({ copied: true })
      setTimeout(() => this.setState({ copied: false }), 2000)
    } catch {
      // clipboard write can fail in non-focused contexts; the user can also
      // grab the text from the visible stack
    }
  }

  handleReload = (): void => {
    location.reload()
  }

  render(): ReactNode {
    const { error, componentStack, copied } = this.state
    if (!error) return this.props.children

    return (
      <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/80 p-6">
        <div className="w-full max-w-2xl rounded-2xl border border-white/[0.08] bg-[#151515] shadow-2xl">
          <div className="border-b border-white/[0.06] px-5 py-4">
            <h2 className="text-base font-medium text-fg">Something went wrong</h2>
            <p className="mt-1 text-xs text-fg-muted">
              The app caught an unexpected error. Copy diagnostics for a bug report, then reload.
            </p>
          </div>
          <div className="max-h-[50vh] overflow-auto px-5 py-4">
            <div className="text-xs font-mono text-rose-300">{error.message}</div>
            {error.stack && (
              <pre className="mt-3 whitespace-pre-wrap text-[11px] font-mono text-fg-muted">{error.stack}</pre>
            )}
            {componentStack && (
              <details className="mt-3">
                <summary className="cursor-pointer text-[11px] text-fg-muted">Component stack</summary>
                <pre className="mt-2 whitespace-pre-wrap text-[11px] font-mono text-fg-muted">{componentStack}</pre>
              </details>
            )}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] px-5 py-4">
            <button
              onClick={this.handleCopy}
              className="px-3 py-1.5 text-xs text-fg-muted border border-node-border rounded hover:bg-node transition-colors"
            >
              {copied ? 'Copied' : 'Copy diagnostics'}
            </button>
            <button
              onClick={this.handleReload}
              className="px-3 py-1.5 text-xs font-medium text-fg bg-accent rounded hover:bg-accent/90 transition-colors"
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    )
  }
}
