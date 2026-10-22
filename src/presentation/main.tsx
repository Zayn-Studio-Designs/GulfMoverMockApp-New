import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PresentationApp } from './PresentationApp';
import { AppCrashScreen, ErrorBoundary } from '../components/ErrorBoundary';
import './presentation.css';

createRoot(document.getElementById('presentation-root') as HTMLElement).render(
  <StrictMode>
    <ErrorBoundary fallback={() => <AppCrashScreen />}>
      <PresentationApp />
    </ErrorBoundary>
  </StrictMode>
);
