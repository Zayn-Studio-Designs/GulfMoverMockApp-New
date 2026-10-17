import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { LanguageProvider } from './context/LanguageContext';
import { DemoProvider } from './context/DemoContext';
import { UiProvider } from './context/UiContext';
import { Layout } from './components/Layout';
import BookingView from './pages/BookingView';
import MyBookingsView from './pages/MyBookingsView';
import CorporateView from './pages/CorporateView';
import OperationsView from './pages/OperationsView';
import BoardingView from './pages/BoardingView';
import MaterialsView from './pages/MaterialsView';
import './styles/index.css';

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<BookingView />} />
        <Route path="/bookings" element={<MyBookingsView />} />
        <Route path="/corporate" element={<CorporateView />} />
        <Route path="/operations" element={<OperationsView />} />
        <Route path="/boarding" element={<BoardingView />} />
        <Route path="/materials" element={<MaterialsView />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <LanguageProvider>
      <DemoProvider>
        <UiProvider>{children}</UiProvider>
      </DemoProvider>
    </LanguageProvider>
  );
}

function App() {
  return (
    <AppProviders>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AppProviders>
  );
}

export default App;
