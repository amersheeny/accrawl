import { StrictMode, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BrowserRouter,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
} from 'react-router';
import { Login, Setup, Institutions, Connections, Devices } from './pages';
import { SessionMonitor, History } from './session-pages';
import { Accounts } from './accounts-page';
import { Sharing } from './sharing-page';
import { SHARING_COPY } from './sharing-copy';
import {
  getToken,
  hostedLoginUrl,
  restoreHostedSession,
  signOut,
} from './api';
import './styles.css';

// Deployed build stamp, baked at image-build time by vite's `define` (git short SHA, or 'dev' for a bare
// build). Shown in the sidebar footer so the running build is visible at a glance.
declare const __ACCRAWL_VERSION__: string;
declare const __ACCRAWL_SOURCE_URL__: string;

function RequireAuth({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const token = getToken();
  const loginUrl = hostedLoginUrl(loc.pathname, loc.search, loc.hash);
  const [authenticated, setAuthenticated] = useState(token !== null);
  useEffect(() => {
    if (token) {
      setAuthenticated(true);
      return;
    }
    let active = true;
    void restoreHostedSession().then((restored) => {
      if (!active) return;
      if (restored) {
        setAuthenticated(true);
      } else {
        window.location.replace(loginUrl);
      }
    });
    return () => {
      active = false;
    };
  }, [loginUrl, token]);
  if (!authenticated) return null;
  return <>{children}</>;
}

// Inline stroke icons (no icon dependency): sized by .nav-ico.
const ICONS = {
  accounts: <path d="M3 7h18M3 7l2-3h14l2 3M3 7v11a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V7M8 12h8" />,
  connections: <path d="M8 12a4 4 0 0 1 4-4h1a4 4 0 0 1 0 8h-1M16 12a4 4 0 0 1-4 4h-1a4 4 0 0 1 0-8h1" />,
  institutions: <path d="M3 10l9-6 9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18" />,
  history: <path d="M12 8v4l3 2M21 12a9 9 0 1 1-3-6.7M21 4v4h-4" />,
  devices: <path d="M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM11 18h2" />,
  sharing: <path d="M9 12a3 3 0 1 0 0 .01M18 5a3 3 0 1 0 0 .01M18 19a3 3 0 1 0 0 .01M11.7 10.7l3.6-3.4M11.7 13.3l3.6 3.4" />,
} as const;

function NavItem({ to, icon, children }: { to: string; icon: keyof typeof ICONS; children: ReactNode }) {
  return (
    <NavLink to={to} className={({ isActive }) => (isActive ? 'active' : '')}>
      <svg className="nav-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {ICONS[icon]}
      </svg>
      {children}
    </NavLink>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">A</span> Accrawl</div>
        <nav>
          <NavItem to="/accounts" icon="accounts">Accounts</NavItem>
          <NavItem to="/connections" icon="connections">Connections</NavItem>
          <NavItem to="/institutions" icon="institutions">Institutions</NavItem>
          <NavItem to="/history" icon="history">Crawl history</NavItem>
          <NavItem to="/devices" icon="devices">Companion</NavItem>
          <NavItem to="/sharing" icon="sharing">{SHARING_COPY.nav}</NavItem>
        </nav>
        <div className="sidebar-foot">
          <button className="ghost small" onClick={() => {
            void signOut()
              .then(() => { window.location.href = '/login'; })
              .catch((error: unknown) => {
                console.error('[web] sign out failed; session remains active:', error);
              });
          }}>Sign out</button>
          <div className="build-version" title="Deployed build (git short SHA)">build {__ACCRAWL_VERSION__}</div>
          {/* AGPL-3.0 §13: this console is a network interface to the program, so whoever uses it is
              offered its Corresponding Source. A deployment running modified code points
              ACCRAWL_SOURCE_URL at its own. */}
          {__ACCRAWL_SOURCE_URL__ ? (
            <a
              className="build-version source-link"
              href={__ACCRAWL_SOURCE_URL__}
              target="_blank"
              rel="noreferrer noopener"
              title="View or download the source code for this Accrawl deployment."
            >
              Source code (AGPL-3.0)
            </a>
          ) : null}
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/setup" element={<Setup />} />
        <Route path="/login" element={<Login />} />
        <Route path="/accounts" element={<RequireAuth><Shell><Accounts /></Shell></RequireAuth>} />
        <Route path="/institutions" element={<RequireAuth><Shell><Institutions /></Shell></RequireAuth>} />
        <Route path="/connections" element={<RequireAuth><Shell><Connections /></Shell></RequireAuth>} />
        <Route path="/history" element={<RequireAuth><Shell><History /></Shell></RequireAuth>} />
        <Route path="/devices" element={<RequireAuth><Shell><Devices /></Shell></RequireAuth>} />
        <Route path="/sharing" element={<RequireAuth><Shell><Sharing /></Shell></RequireAuth>} />
        <Route path="/sessions/:id" element={<RequireAuth><Shell><SessionMonitor /></Shell></RequireAuth>} />
        <Route path="*" element={<Navigate to="/connections" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
