import React from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { MEDIA_TYPES } from '../mediaTypes';
import './shell.css';

// Left sidebar (projects, annotators, signed-in user) around every page
// except /login.
export default function AppShell() {
  const { authEnabled, user, signOut, status } = useAuth();
  const { pathname } = useLocation();
  const inProjects = pathname === '/' || pathname.startsWith('/projects');

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="sidebar-brand-mark">≋</span>
          Spectrogram Annotator
        </div>

        <nav className="sidebar-nav">
          <NavLink to="/" className={() => `sidebar-link ${inProjects ? 'sidebar-link--active' : ''}`}>
            <span className="sidebar-link-icon">▤</span>
            Projects
          </NavLink>

          <div className="sidebar-section">Annotators</div>
          {MEDIA_TYPES.map(m => (
            <NavLink
              key={m.type}
              to={`/${m.slug}`}
              className={({ isActive }) => `sidebar-link ${isActive ? 'sidebar-link--active' : ''} ${m.available ? '' : 'sidebar-link--soon'}`}
            >
              <span className="sidebar-link-icon">{m.icon}</span>
              {m.label}
              {!m.available && <span className="sidebar-soon">soon</span>}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          {user ? (
            <>
              <div className="sidebar-user">
                {user.avatar_url
                  ? <img className="sidebar-avatar" src={user.avatar_url} alt="" referrerPolicy="no-referrer" />
                  : <span className="sidebar-avatar sidebar-avatar--initial">{(user.display_name || user.email || '?')[0].toUpperCase()}</span>}
                <div className="sidebar-user-text">
                  <div className="sidebar-user-name">{user.display_name || user.email}</div>
                  <div className="sidebar-user-email">{user.email}</div>
                </div>
              </div>
              <button className="btn btn-ghost btn-sm sidebar-signout" onClick={signOut}>Sign out</button>
            </>
          ) : (
            <div className="sidebar-local">
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
