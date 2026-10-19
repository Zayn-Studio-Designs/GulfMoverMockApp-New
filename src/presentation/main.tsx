import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PresentationApp } from './PresentationApp';
import './presentation.css';

createRoot(document.getElementById('presentation-root') as HTMLElement).render(
  <StrictMode>
    <PresentationApp />
  </StrictMode>
);
