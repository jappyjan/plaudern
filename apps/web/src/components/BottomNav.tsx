import type { ComponentType } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { CalendarIcon, GearIcon, InboxIcon, PeopleIcon } from './icons';

interface NavItem {
  to: string;
  label: string;
  Icon: ComponentType<{ className?: string }>;
  /** Whether this tab should render active for the given pathname. */
  isActive: (pathname: string) => boolean;
}

const NAV_ITEMS: NavItem[] = [
  {
    to: '/',
    label: 'Inbox',
    Icon: InboxIcon,
    // Item detail pages are opened from the inbox, so keep Inbox lit there too.
    isActive: (pathname) => pathname === '/' || pathname.startsWith('/items'),
  },
  {
    to: '/calendar',
    label: 'Calendar',
    Icon: CalendarIcon,
    isActive: (pathname) => pathname.startsWith('/calendar'),
  },
  {
    to: '/contacts',
    label: 'Contacts',
    Icon: PeopleIcon,
    isActive: (pathname) => pathname.startsWith('/contacts'),
  },
  {
    to: '/settings',
    label: 'Settings',
    Icon: GearIcon,
    isActive: (pathname) => pathname.startsWith('/settings'),
  },
];

/**
 * Thumb-optimized bottom tab bar. Mobile only (`md:hidden`) — the top header in
 * App.tsx takes over from the `md` breakpoint up.
 */
export function BottomNav() {
  const { pathname } = useLocation();

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-default-200 bg-background/90 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      aria-label="Primary"
    >
      <div className="mx-auto flex w-full max-w-2xl">
        {NAV_ITEMS.map(({ to, label, Icon, isActive }) => {
          const active = isActive(pathname);
          return (
            <Link
              key={to}
              to={to}
              aria-label={label}
              aria-current={active ? 'page' : undefined}
              className={`flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-xs transition-colors ${
                active ? 'text-primary' : 'text-default-400'
              }`}
            >
              <Icon className="h-6 w-6" />
              <span>{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
