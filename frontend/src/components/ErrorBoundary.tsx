import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props { children: ReactNode; label?: string }
interface State { error: Error | null }

/** Anything that throws inside renders a readable card instead of a blank screen. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }
  static getDerivedStateFromError(error: Error): State { return { error } }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('[NexMind]', error, info.componentStack) }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="grid h-full min-h-[60vh] place-items-center p-6">
        <div className="glass max-w-lg rounded-2xl p-6">
          <h2 className="text-lg font-semibold">{this.props.label ?? 'This view hit a problem'}</h2>
          <p className="mt-2 text-sm text-mist">Nothing was lost. Your data lives on the server, so you can reload this view.</p>
          <pre className="mono mt-3 max-h-40 overflow-auto rounded-lg bg-black/40 p-3 text-xs text-coral">{this.state.error.message}</pre>
          <div className="mt-4 flex gap-2">
            <button className="btn btn-primary" onClick={() => this.setState({ error: null })}>Try again</button>
            <button className="btn btn-ghost" onClick={() => (window.location.href = '/app')}>Back to workspaces</button>
          </div>
        </div>
      </div>
    )
  }
}
