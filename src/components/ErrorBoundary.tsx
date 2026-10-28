import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportError } from '../lib/monitoring';

// Crash recovery for live demos: a screen that throws while rendering shows a calm recovery card
// instead of a blank page. Two layers use it:
//  - around each page inside the app layout (ScreenError, translated, keeps the header and menu usable;
//    moving to another page clears the error), and
//  - around the whole app and the presentation shell (AppCrashScreen), for failures outside a page.

interface Props {
  children: ReactNode;
  /** Renders the recovery UI; `retry` clears the error and renders the children again. */
  fallback: (retry: () => void) => ReactNode;
  /** When this value changes (e.g. the route), a previous error is cleared automatically. */
  resetKey?: unknown;
}

interface State { failed: boolean }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportError(error, `render: ${(info.componentStack ?? '').split('\n').slice(0, 4).join(' ')}`);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  retry = () => this.setState({ failed: false });

  render() {
    return this.state.failed ? this.props.fallback(this.retry) : this.props.children;
  }
}

/** Removes only the saved booking/demo state (never accounts or preferences), then reloads. */
export function resetSavedDemoStateAndReload() {
  try { localStorage.removeItem('gm-demo-state-v1'); } catch { /* storage unavailable */ }
  window.location.reload();
}

/**
 * Whole-app fallback. It sits outside the language provider (which may be what failed), so its
 * short wording is shown in both English and Arabic.
 */
export function AppCrashScreen() {
  return (
    <div className="crash-screen" role="alert">
      <div className="crash-card">
        <h1>Something went wrong in the demo</h1>
        <p>Reload to try again. If it happens again, reset the demo bookings — your demo accounts are kept.</p>
        <p dir="rtl" lang="ar">حدث خطأ في النموذج التجريبي. أعد التحميل للمحاولة مرة أخرى، وإن تكرر الخطأ فأعد ضبط الحجوزات التجريبية — تبقى حساباتك التجريبية محفوظة.</p>
        <div className="crash-actions">
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>Reload · إعادة التحميل</button>
          <button type="button" className="btn btn-outline" onClick={resetSavedDemoStateAndReload}>Reset demo bookings · إعادة ضبط الحجوزات</button>
        </div>
      </div>
    </div>
  );
}
