import React, { useEffect, useRef, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { apiJson } from '../api';
import { useAuth } from '../auth/AuthContext';
import './pages.css';

const GIS_SRC = 'https://accounts.google.com/gsi/client';
let gisPromise = null;

function loadGoogleIdentity() {
  if (window.google?.accounts?.id) return Promise.resolve();
  gisPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => { gisPromise = null; reject(new Error("Couldn't load Google sign-in.")); };
    document.head.appendChild(s);
  });
  return gisPromise;
}

// Only same-app paths, so ?next= can't send someone off-site.
function safeNext(next) {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/login') ? next : '/';
}

export default function LoginPage() {
  const { status, authEnabled, config, user, signIn } = useAuth();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  if (status === 'loading') return <div className="page-loading">Loading…</div>;
  // Sign-in is off on this server: nothing to log into.
  if (!authEnabled) return <Navigate to="/audio" replace />;
  if (user) return <Navigate to={next} replace />;

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand"><span className="sidebar-brand-mark">≋</span> Spectrogram Annotator</div>
        <h1 className="login-title">Sign in</h1>
        <p className="login-sub">Sign in to see your projects and annotate together.</p>

        {config.google_client_id && (
          <GoogleButton
            clientId={config.google_client_id}
            onCredential={async (credential) => {
              setError(null);
              setBusy(true);
              try {
                signIn(await apiJson('/auth/google', { method: 'POST', json: { credential }, redirectOn401: false }));
              } catch (err) {
                setError(err.message);
              } finally {
                setBusy(false);
              }
            }}
            onError={setError}
          />
        )}

        {config.dev_login && (
          <DevLoginForm
            busy={busy}
            onSubmit={async (email, displayName) => {
              setError(null);
              setBusy(true);
              try {
                signIn(await apiJson('/auth/dev', {
                  method: 'POST', json: { email, display_name: displayName || null }, redirectOn401: false,
                }));
              } catch (err) {
                setError(err.message);
              } finally {
                setBusy(false);
              }
            }}
          />
        )}

        {error && <div className="form-error" role="alert">{error}</div>}
      </div>
    </div>
  );
}

function GoogleButton({ clientId, onCredential, onError }) {
  const ref = useRef(null);
  const onCredentialRef = useRef(onCredential);
  onCredentialRef.current = onCredential;

  useEffect(() => {
    let cancelled = false;
    loadGoogleIdentity().then(() => {
      if (cancelled || !ref.current) return;
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: (resp) => onCredentialRef.current(resp.credential),
      });
      window.google.accounts.id.renderButton(ref.current, {
        theme: 'outline', size: 'large', text: 'signin_with', shape: 'rectangular', width: 280,
      });
    }).catch(err => onError(err.message));
    return () => { cancelled = true; };
  }, [clientId, onError]);

  return <div className="login-google" ref={ref} />;
}

function DevLoginForm({ busy, onSubmit }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  return (
    <form
      className="login-dev"
      onSubmit={e => { e.preventDefault(); if (email.trim()) onSubmit(email.trim(), name.trim()); }}
    >
      <div className="login-dev-banner">
        Developer login — no password. Local testing only; must be off on the server.
      </div>
      <label className="form-field">
        <span>Email</span>
        <input type="email" required autoComplete="off" value={email} onChange={e => setEmail(e.target.value)} placeholder="someone@example.com" />
      </label>
      <label className="form-field">
        <span>Display name <em>(optional, first sign-in)</em></span>
        <input type="text" autoComplete="off" value={name} onChange={e => setName(e.target.value)} />
      </label>
      <button className="btn btn-solid" type="submit" disabled={busy || !email.trim()}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
