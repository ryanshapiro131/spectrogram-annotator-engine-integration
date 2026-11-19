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
        <div className="login-brand"><span className="sidebar-brand-mark">≋</span> SPECTRA</div>
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

        {config.password_login && (
          <PasswordForm
            busy={busy}
            allowRegister={config.password_signup}
            onSubmit={async (mode, fields) => {
              setError(null);
              setBusy(true);
              try {
                signIn(await apiJson(mode === 'register' ? '/auth/password/register' : '/auth/password', {
                  method: 'POST', json: fields, redirectOn401: false,
                }));
              } catch (err) {
                setError(err.message);
              } finally {
                setBusy(false);
              }
            }}
            onModeChange={() => setError(null)}
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

const MIN_PASSWORD = 8;

// Email + password: sign in, or (when the server allows it) create an
// account. A new account sees no projects until it creates one or a
// project admin adds it.
function PasswordForm({ busy, allowRegister, onSubmit, onModeChange }) {
  const [mode, setMode] = useState('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [name, setName] = useState('');
  const [problem, setProblem] = useState(null);
  const register = mode === 'register';

  const switchMode = (m) => {
    setMode(m);
    setPassword('');
    setConfirm('');
    setProblem(null);
    onModeChange();
  };

  const submit = (e) => {
    e.preventDefault();
    if (register) {
      if (password.length < MIN_PASSWORD) return setProblem(`Use at least ${MIN_PASSWORD} characters.`);
      if (password !== confirm) return setProblem("The passwords don't match.");
    }
    setProblem(null);
    onSubmit(mode, register
      ? { email: email.trim(), password, display_name: name.trim() || null }
      : { email: email.trim(), password });
  };

  return (
    <form className="login-password" onSubmit={submit}>
      {register && (
        <p className="login-password-note">
          Create your account. To join a project, give a project admin the email you use here.
        </p>
      )}
      <label className="form-field">
        <span>Email</span>
        <input type="email" required autoComplete="username" value={email}
          onChange={e => setEmail(e.target.value)} placeholder="you@example.com" />
      </label>
      <label className="form-field">
        <span>{register ? 'Choose a password' : 'Password'}</span>
        <input type="password" required autoComplete={register ? 'new-password' : 'current-password'}
          minLength={register ? MIN_PASSWORD : undefined} value={password} onChange={e => setPassword(e.target.value)} />
      </label>
      {register && (
        <>
          <label className="form-field">
            <span>Repeat the password</span>
            <input type="password" required autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} />
          </label>
          <label className="form-field">
            <span>Your name <em>(optional, shown to your team)</em></span>
            <input type="text" autoComplete="name" value={name} onChange={e => setName(e.target.value)} maxLength={100} />
          </label>
        </>
      )}
      {problem && <div className="form-error" role="alert">{problem}</div>}
      <button className="btn btn-solid" type="submit" disabled={busy || !email.trim() || !password}>
        {busy ? (register ? 'Creating account…' : 'Signing in…') : (register ? 'Create account' : 'Sign in')}
      </button>
      {allowRegister && (
        <button type="button" className="login-switch" onClick={() => switchMode(register ? 'signin' : 'register')}>
          {register ? 'Already have an account? Sign in' : 'New here? Create an account'}
        </button>
      )}
      {!register && <p className="login-password-note">Forgot your password? Ask the server administrator to reset it.</p>}
    </form>
  );
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
