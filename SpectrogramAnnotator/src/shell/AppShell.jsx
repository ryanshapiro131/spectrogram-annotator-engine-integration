import React, { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { MEDIA_TYPES } from '../mediaTypes';
import './shell.css';

const COLLAPSED_KEY = 'sidebar-collapsed';

function readCollapsed() {
  try { return localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; }
}

// Left sidebar (projects, annotators, signed-in user) around every page
// except /login. It can be collapsed to a narrow icon rail to give the
// editors more room; the choice is remembered per browser.
export default function AppShell() {
  const { authEnabled, user, signOut, status } = useAuth();
  const { pathname } = useLocation();
  const inProjects = pathname === '/' || pathname.startsWith('/projects');
  const [collapsed, setCollapsed] = useState(readCollapsed);

  const toggleCollapsed = () => {
    setCollapsed(c => {
      try { localStorage.setItem(COLLAPSED_KEY, c ? '0' : '1'); } catch { /* per-viewer nicety only */ }
      return !c;
    });
  };

  return (
    <div className={`shell ${collapsed ? 'shell--sidebar-collapsed' : ''}`}>
      <aside className={`sidebar ${collapsed ? 'sidebar--collapsed' : ''}`}>
        <div className="sidebar-brand">
          <span className="sidebar-brand-mark" title={collapsed ? 'SPECTRA' : undefined}>≋</span>
          <span className="sidebar-text">SPECTRA</span>
          <button
            className="sidebar-toggle"
            onClick={toggleCollapsed}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M9 4v16" />
              {collapsed ? <path d="M13 10l2 2-2 2" /> : <path d="M15 10l-2 2 2 2" />}
            </svg>
          </button>
        </div>

        <nav className="sidebar-nav">
          <NavLink to="/" className={() => `sidebar-link ${inProjects ? 'sidebar-link--active' : ''}`}
            title={collapsed ? 'Projects' : undefined}>
            <span className="sidebar-link-icon">▤</span>
            <span className="sidebar-text">Projects</span>
          </NavLink>

          <div className="sidebar-section"><span className="sidebar-text">Annotators</span></div>
          {MEDIA_TYPES.map(m => (
            <NavLink
              key={m.type}
              to={`/${m.slug}`}
              className={({ isActive }) => `sidebar-link ${isActive ? 'sidebar-link--active' : ''} ${m.available ? '' : 'sidebar-link--soon'}`}
              title={collapsed ? `${m.label}${m.available ? '' : ' (soon)'}` : undefined}
            >
              <span className="sidebar-link-icon">{m.icon}</span>
              <span className="sidebar-text">{m.label}</span>
              {!m.available && <span className="sidebar-soon sidebar-text">soon</span>}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          {user ? (
            <>
              <div className="sidebar-user" title={collapsed ? `${user.display_name || user.email}
${user.email}` : undefined}>
                {user.avatar_url
                  ? <img className="sidebar-avatar" src={user.avatar_url} alt="" referrerPolicy="no-referrer" />
                  : <span className="sidebar-avatar sidebar-avatar--initial">{(user.display_name || user.email || '?')[0].toUpperCase()}</span>}
                <div className="sidebar-user-text">
                  <div className="sidebar-user-name">{user.display_name || user.email}</div>
                  <div className="sidebar-user-email">{user.email}</div>
                </div>
              </div>
              <button className="btn btn-ghost btn-sm sidebar-signout" onClick={signOut} title={collapsed ? 'Sign out' : undefined}>
                {collapsed ? '⎋' : 'Sign out'}
              </button>
            </>
          ) : (
            <div className="sidebar-local sidebar-text">
              {status === 'offline'
                ? "Can't reach the server"
                : authEnabled ? 'Not signed in' : 'Sign-in is off (local mode)'}
            </div>
          )}
        </div>
      </aside>

      <div className="shell-main">
        <Outlet />
      </div>
    </div>
  );
}
