import { useEffect, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { LanguageProvider } from './context/LanguageContext';
import { ThemeProvider } from './context/ThemeContext';
import { DemoProvider } from './context/DemoContext';
import { UiProvider } from './context/UiContext';
import { WorkModeProvider } from './context/WorkModeContext';
import { Layout } from './components/Layout';
import CustomerHome from './pages/CustomerHome';
import BookingView from './pages/BookingView';
import MyBookingsView from './pages/MyBookingsView';
import CorporateView from './pages/CorporateView';
import OperationsView from './pages/OperationsView';
import BoardingView from './pages/BoardingView';
import MaterialsView from './pages/MaterialsView';
import FleetView from './pages/FleetView';
import SettingsView from './pages/SettingsView';
import AuthView from './pages/AuthView';
import PasswordRecoveryView from './pages/PasswordRecoveryView';
import OnboardingView from './pages/OnboardingView';
import ProductionBookingView from './pages/ProductionBookingView';
import ProductionBookingsView from './pages/ProductionBookingsView';
import AdminCompaniesView from './pages/AdminCompaniesView';
import AdminOperationsView from './pages/AdminOperationsView';
import ProductionBoardingView from './pages/ProductionBoardingView';
import { NotConnectedView } from './components/ProductionUi';
import { AuthProvider, useAuth } from './context/AuthContext';
import { OnboardingProvider } from './context/OnboardingContext';
import { RECOVERY_PATH } from './lib/recoveryLink';
import './styles/fonts.css';
import './styles/index.css';
import { HostHomeBridge, WalletHostBridge } from './components/wallet/WalletHostBridge';
import { AppCrashScreen, ErrorBoundary } from './components/ErrorBoundary';
import './styles/wallet.css';

/**
 * A Supabase recovery session must land on the new-password screen, wherever the reset
 * link redirected to (e.g. a dashboard redirect URL pointing at the site root). Until the
 * password is set, the recovery session never opens the rest of the app.
 */
function RecoveryRedirect() {
  const { recovery } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (recovery === 'ready' && pathname !== RECOVERY_PATH) navigate(RECOVERY_PATH, { replace: true });
  }, [recovery, pathname, navigate]);
  return null;
}

/**
 * Production and demo never share data: in production a route renders its Supabase-backed page
 * (or an honest "not connected" screen); in demo it renders the original offline page.
 */
function ByMode({ demo, production }: { demo: ReactNode; production: ReactNode }) {
  const { authMode } = useAuth();
  return <>{authMode === 'production' ? production : demo}</>;
}

export function AppRoutes() {
  return (
    <>
    <HostHomeBridge />
    <RecoveryRedirect />
    <Routes>
      <Route path="/signin" element={<AuthView />} />
      <Route path="/signup" element={<AuthView initialMode="signup" />} />
      <Route path={RECOVERY_PATH} element={<PasswordRecoveryView />} />
      <Route element={<Layout />}>
        <Route path="/" element={<ByMode demo={<CustomerHome />} production={<Navigate to="/onboarding" replace />} />} />
        <Route path="/book" element={<ByMode demo={<BookingView />} production={<ProductionBookingView />} />} />
        <Route path="/bookings" element={<ByMode demo={<MyBookingsView />} production={<ProductionBookingsView />} />} />
        <Route path="/bookings/:reference" element={<ByMode demo={<MyBookingsView />} production={<ProductionBookingsView />} />} />
        <Route path="/corporate" element={<ByMode demo={<CorporateView />} production={<NotConnectedView />} />} />
        <Route path="/operations" element={<ByMode demo={<OperationsView />} production={<NotConnectedView />} />} />
        <Route path="/boarding" element={<ByMode demo={<BoardingView />} production={<ProductionBoardingView />} />} />
        <Route path="/materials" element={<ByMode demo={<MaterialsView />} production={<NotConnectedView />} />} />
        <Route path="/fleet" element={<ByMode demo={<FleetView />} production={<NotConnectedView />} />} />
        <Route path="/admin/companies" element={<AdminCompaniesView />} />
        <Route path="/admin/operations" element={<AdminOperationsView />} />
        <Route path="/admin/boarding" element={<ProductionBoardingView />} />
        <Route path="/settings" element={<SettingsView />} />
        <Route path="/onboarding" element={<OnboardingView />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
    </>
  );
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <LanguageProvider>
      <WorkModeProvider>
        <AuthProvider>
          <OnboardingProvider>
            <DemoProvider>
              <UiProvider>{children}<WalletHostBridge /></UiProvider>
            </DemoProvider>
          </OnboardingProvider>
        </AuthProvider>
      </WorkModeProvider>
    </LanguageProvider>
    </ThemeProvider>
  );
}

function App() {
  return (
    <ErrorBoundary fallback={() => <AppCrashScreen />}>
      <AppProviders>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AppProviders>
    </ErrorBoundary>
  );
}

export default App;
