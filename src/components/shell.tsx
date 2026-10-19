'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ReactNode, useEffect, useRef, useState } from 'react';
import { Icon, ToastProvider, api, initials } from './ui';

interface Summary {
  online: number;
  servers: number;
  groups: number;
  keys: number;
  guard: boolean;
  blockedToday: number;
  name: string;
  authEnabled: boolean;
}

const MONITOR = [
  { href: '/', label: 'Overview', icon: 'grid' },
  { href: '/activity', label: 'Activity', icon: 'list' },
];
const SETUP = [
  { href: '/servers', label: 'Servers and models' },
  { href: '/groups', label: 'Groups' },
  { href: '/keys', label: 'API keys' },
  { href: '/context', label: 'Context files' },
  { href: '/guard', label: 'Guard checks' },
];
const ADVANCED = [
  { href: '/rules', label: 'Custom rules', icon: 'filter' },
  { href: '/schemas', label: 'Schemas', icon: 'braces' },
];

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const mainRef = useRef<HTMLElement>(null);
  // The main column scrolls on its own, so start each page at its top.
  useEffect(() => {
    if (!window.location.hash) mainRef.current?.scrollTo(0, 0);
  }, [path]);
  const [sum, setSum] = useState<Summary | null>(null);
  useEffect(() => {
    api<Summary>('summary').then(setSum).catch(() => undefined);
  }, [path]);
  const on = (href: string) => (href === '/' ? path === '/' : path.startsWith(href));

  return (
    <ToastProvider>
      <div className="gr">
        <div className="app">
          <header className="topbar">
            <Link href="/" className="brand">
              <Icon name="shieldCheck" size={24} stroke={2.2} color="#3A1FD1" />
              <b>GuardRail AI</b>
              <span className="chip">gateway</span>
            </Link>
            <div className="wrap" style={{ gap: 12 }}>
              <Link href="/keys#create" className="btn blk">
                New API key
              </Link>
              <Link href="/activity?filter=blocked" className="iconbtn" aria-label={`Blocked requests today: ${sum?.blockedToday ?? 0}`} title={`${sum?.blockedToday ?? 0} blocked in the last 24 hours`}>
                <Icon name="shieldAlert" size={18} />
                {!!sum?.blockedToday && <span className="dotbadge" />}
              </Link>
              <span className="wrap" style={{ gap: 10 }}>
                <span className="avatar">{initials(sum?.name ?? 'Admin')}</span>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{sum?.name ?? 'Admin'}</span>
              </span>
              {sum?.authEnabled && (
                <button
                  type="button"
                  className="iconbtn"
                  aria-label="Sign out"
                  onClick={async () => {
                    await fetch('/api/auth/logout', { method: 'POST' });
                    window.location.href = '/login';
                  }}
                >
                  <Icon name="logout" size={18} />
                </button>
              )}
            </div>
          </header>
          <div className="shell">
            <div className="side">
              <nav className="nav" aria-label="Main">
                <div className="nav-group">
                  <div className="nav-title">Monitor</div>
                  {MONITOR.map((l) => (
                    <Link key={l.href} href={l.href} className={on(l.href) ? 'on' : ''}>
                      <Icon name={l.icon} size={18} />
                      {l.label}
                    </Link>
                  ))}
                </div>
                <div className="nav-group">
                  <div className="nav-title">Set up</div>
                  {SETUP.map((l, i) => (
                    <Link key={l.href} href={l.href} className={on(l.href) ? 'on' : ''}>
                      <span className="n">{i + 1}</span>
                      {l.label}
                    </Link>
                  ))}
                </div>
                <div className="nav-group">
                  <div className="nav-title">Advanced</div>
                  {ADVANCED.map((l) => (
                    <Link key={l.href} href={l.href} className={on(l.href) ? 'on' : ''}>
                      <Icon name={l.icon} size={18} />
                      {l.label}
                    </Link>
                  ))}
                </div>
                <div className="nav-status">
                  <div className="live">
                    <i className={sum && sum.online === 0 ? 'off' : ''} />
                    {sum ? `${sum.online} of ${sum.servers} servers online` : 'Checking servers…'}
                  </div>
                  <div className="muted" style={{ marginTop: 4 }}>
                    {sum ? `${sum.groups} groups · ${sum.keys} keys · guard ${sum.guard ? 'on' : 'off'}` : ' '}
                  </div>
                </div>
              </nav>
            </div>
            <main className="main" ref={mainRef}>{children}</main>
          </div>
        </div>
      </div>
    </ToastProvider>
  );
}
