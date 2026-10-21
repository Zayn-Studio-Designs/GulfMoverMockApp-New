import { Component, type ErrorInfo, type ReactNode } from 'react';

// Last line of defence during a live demo: if any screen throws while rendering, show a calm
// recovery card instead of a blank page. It sits outside the providers (they may be what failed),
// so its wording is fixed in both languages rather than coming from the translation tables.

const DEMO_KEY_PREFIX = 'gm-demo-';

export function clearDemoStorage() {
  try {
    for (const store of [localStorage, sessionStorage]) {
      Object.keys(store).filter(k => k.startsWith(DEMO_KEY_PREFIX)).forEach(k => store.removeItem(k));
    }
  } catch {
    // Storage unavailable: a reload still starts from the built-in sample data.
  }
}

interface State { failed: boolean }

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Gulf Mover demo error', error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="crash-screen" role="alert">
        <div className="crash-card">
          <h1>Something went wrong in the demo</h1>
          <p>Your demo data is stored only in this browser. Reload to try again, or reset the demo data to start fresh.</p>
          <p dir="rtl" lang="ar">حدث خطأ في النموذج التجريبي. أعد تحميل الصفحة للمحاولة مرة أخرى، أو أعد ضبط البيانات التجريبية للبدء من جديد.</p>
          <div className="crash-actions">
            <button type="button" className="btn btn-outline" onClick={() => window.location.reload()}>Reload · إعادة التحميل</button>
            <button type="button" className="btn btn-primary" onClick={() => { clearDemoStorage(); window.location.assign('/'); }}>Reset demo data · إعادة الضبط</button>
          </div>
        </div>
      </div>
    );
  }
}
