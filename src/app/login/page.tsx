'use client';

import { FormEvent, useState } from 'react';

export default function Login() {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) });
    if (!res.ok) return setErr('Wrong password.');
    const next = new URLSearchParams(window.location.search).get('next');
    window.location.href = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
  };
  return (
    <div className="gr">
      <form className="card login stack" onSubmit={submit} style={{ gap: 14 }}>
        <h1 style={{ fontSize: 20 }}>GuardRail AI</h1>
        <p className="muted" style={{ margin: 0 }}>Sign in to the admin panel.</p>
        <label>
          <span className="lbl">Admin password</span>
          <input className="inp" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        </label>
        {err && <div style={{ color: 'var(--bad)', fontSize: 13 }}>{err}</div>}
        <button className="btn pri" type="submit">Sign in</button>
      </form>
    </div>
  );
}
