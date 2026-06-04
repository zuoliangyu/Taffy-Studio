// Catch any render-time exception below so a bug in one component never
// unmounts the entire app (the "blank white screen" pattern).
//
// React only honors error boundaries that are class components — there is no
// hook-based equivalent. Keep this file minimal and dependency-free.
import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // Surface to the dev console so F12 shows the real failure.
    console.error('Render error caught by ErrorBoundary:', error, info)
  }

  reset = () => this.setState({ error: null })

  render() {
    if (!this.state.error) return this.props.children
    const err = this.state.error
    return (
      <div className="boundary">
        <div className="boundary-card">
          <h2>Something broke.</h2>
          <p className="boundary-msg">{err.message || String(err)}</p>
          {err.stack && <pre className="boundary-stack">{err.stack}</pre>}
          <div className="boundary-actions">
            <button type="button" className="ghost" onClick={() => location.reload()}>
              Reload window
            </button>
            <button type="button" onClick={this.reset}>
              Try again
            </button>
          </div>
        </div>
      </div>
    )
  }
}
