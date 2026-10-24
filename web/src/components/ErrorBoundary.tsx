import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { error: Error | null };

/** Last-resort boundary so a render crash shows a readable page instead of a blank dark screen. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-md rounded-xl border border-line bg-panel p-5">
          <h1 className="text-[15px] font-semibold">Something went wrong</h1>
          <p className="mt-1 text-[13px] text-ink-2">
            The app hit an unexpected error while rendering. Reloading usually fixes it.
          </p>
          <pre className="mt-3 max-h-48 overflow-auto rounded-lg border border-line bg-ground p-3 text-[12px] leading-relaxed text-ink-3">
            {error.message}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 h-9 rounded-lg bg-accent px-4 text-[13px] font-semibold text-accent-ink hover:bg-accent-hi"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
