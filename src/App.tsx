import { BrowserRouter as Router, Routes, Route, NavLink } from 'react-router-dom';
import LanguageContext from './context/LanguageContext';
import DemoContext from './context/DemoContext';
import BookingView from './pages/BookingView';
import MyBookingsView from './pages/MyBookingsView';
import CorporateView from './pages/CorporateView';
import OperationsView from './pages/OperationsView';
import BoardingView from './pages/BoardingView';
import MaterialsView from './pages/MaterialsView';
import './styles/index.css';

function App() {
  return (
    <LanguageContext.Provider value={{ language: 'en', toggleLanguage: () => {} }}>
      <DemoContext.Provider value={{
        demoMode: true,
        resetDemoData: () => {},
        sampleData: {}
      }}>
        <Router>
          <div className="App">
            <header className="app-header">
              <div className="header-inner">
                <div className="demo-banner">
                  <span className="dot"></span>
                  <span data-i18n="demoBanner">PROTOTYPE / DEMO ONLY — fictional data; no live payments, permit integration, or boarding authorization</span>
                </div>
                <div className="brand">
                  <div className="brand-mark">GM</div>
                  <div>
                    <div className="brand-name">Gulf Mover</div>
                    <div className="brand-sub" data-i18n="brandSub">Marine transfers · Ras Tanura</div>
                  </div>
                </div>
                <nav>
                  <NavLink
                    to="/"
                    end
                    className={({ isActive }) => `nav-btn ${isActive ? 'active' : ''}`}
                    data-view="bookings"
                    onClick={(e) => { e.preventDefault(); }}
                  >
                    <span data-i18n="navBook">Book Transfer</span>
                  </NavLink>
                  <NavLink
                    to="/bookings"
                    end
                    className={({ isActive }) => `nav-btn ${isActive ? 'active' : ''}`}
                    data-view="bookings"
                    onClick={(e) => { e.preventDefault(); }}
                  >
                    <span data-i18n="navBookings">My Bookings</span>
                  </NavLink>
                  <NavLink
                    to="/corporate"
                    end
                    className={({ isActive }) => `nav-btn ${isActive ? 'active' : ''}`}
                    data-view="corporate"
                    onClick={(e) => { e.preventDefault(); }}
                  >
                    <span data-i18n="navCorporate">Corporate / Agent</span>
                  </NavLink>
                  <NavLink
                    to="/operations"
                    end
                    className={({ isActive }) => `nav-btn ${isActive ? 'active' : ''}`}
                    data-view="operations"
                    onClick={(e) => { e.preventDefault(); }}
                  >
                    <span data-i18n="navOps">Operations</span>
                  </NavLink>
                  <NavLink
                    to="/boarding"
                    end
                    className={({ isActive }) => `nav-btn ${isActive ? 'active' : ''}`}
                    data-view="boarding"
                    onClick={(e) => { e.preventDefault(); }}
                  >
                    <span data-i18n="navBoarding">Boarding Desk</span>
                  </NavLink>
                  <NavLink
                    to="/materials"
                    end
                    className={({ isActive }) => `nav-btn ${isActive ? 'active' : ''}`}
                    data-view="materials"
                    onClick={(e) => { e.preventDefault(); }}
                  >
                    <span data-i18n="navMaterials">Materials</span>
                  </NavLink>
                </nav>
              </div>
            </header>

            <main className="app-main">
              <Routes>
                <Route path="/" element={<BookingView />} />
                <Route path="/bookings" element={<MyBookingsView />} />
                <Route path="/corporate" element={<CorporateView />} />
                <Route path="/operations" element={<OperationsView />} />
                <Route path="/boarding" element={<BoardingView />} />
                <Route path="/materials" element={<MaterialsView />} />
              </Routes>
            </main>
          </div>
        </Router>
      </DemoContext.Provider>
    </LanguageContext.Provider>
  );
}

export default App;