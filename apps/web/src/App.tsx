import { useEffect, useState } from 'react';
import { Button, Spinner } from '@heroui/react';
import { Link, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { InboxPage } from './pages/InboxPage';
import { ItemDetailPage } from './pages/ItemDetailPage';
import { LoginPage } from './pages/LoginPage';
import { SettingsPage } from './pages/SettingsPage';
import { CalendarPage } from './pages/CalendarPage';
import { ContactsPage } from './pages/ContactsPage';
import { ContactDetailPage } from './pages/ContactDetailPage';
import { SharePage } from './pages/SharePage';
import { CalendarIcon, GearIcon, MoonIcon, PeopleIcon, SunIcon } from './components/icons';
import { BottomNav } from './components/BottomNav';

export type Theme = 'light' | 'dark';

function initialTheme(): Theme {
  const stored = localStorage.getItem('theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const { loading, user } = useAuth();

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('theme', theme);
    // Keep the browser/PWA chrome in sync with the manual theme toggle.
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'dark' ? '#000000' : '#ffffff');
  }, [theme]);

  const themeToggle = (
    <Button
      isIconOnly
      variant="light"
      size="sm"
      aria-label="Toggle dark mode"
      onPress={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
    >
      {theme === 'dark' ? <SunIcon className="h-5 w-5" /> : <MoonIcon className="h-5 w-5" />}
    </Button>
  );

  if (loading) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background text-foreground">
        <Spinner label="Loading…" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="h-dvh overflow-y-auto overscroll-y-contain bg-background text-foreground">
        <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col px-4 pb-8">
          <header className="flex items-center justify-end py-4">{themeToggle}</header>
          <main className="flex flex-1 flex-col">
            <LoginPage />
          </main>
        </div>
      </div>
    );
  }

  return (
    <div className="h-dvh bg-background text-foreground">
      {/* The document is pinned (see styles.css); this container owns scrolling
          so iOS never repositions the fixed overlays layered above it. */}
      <div className="h-full overflow-y-auto overscroll-y-contain">
        <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col px-4 pb-8">
          <header className="hidden items-center justify-between py-4 md:flex">
            <h1 className="text-xl font-bold">
              <Link to="/">Plaudern</Link>
            </h1>
            <div className="flex items-center gap-1">
              {themeToggle}
              <Button
                as={Link}
                to="/calendar"
                isIconOnly
                variant="light"
                size="sm"
                aria-label="Calendar"
              >
                <CalendarIcon className="h-5 w-5" />
              </Button>
              <Button
                as={Link}
                to="/contacts"
                isIconOnly
                variant="light"
                size="sm"
                aria-label="Contacts"
              >
                <PeopleIcon className="h-5 w-5" />
              </Button>
              <Button
                as={Link}
                to="/settings"
                isIconOnly
                variant="light"
                size="sm"
                aria-label="Settings"
              >
                <GearIcon className="h-5 w-5" />
              </Button>
            </div>
          </header>
          <main className="flex-1 pt-4 pb-[calc(5rem+env(safe-area-inset-bottom))] md:pt-0 md:pb-0">
            <Routes>
              <Route path="/" element={<InboxPage />} />
              <Route path="/items/:id" element={<ItemDetailPage />} />
              <Route path="/calendar" element={<CalendarPage />} />
              <Route path="/contacts" element={<ContactsPage />} />
              <Route path="/contacts/:id" element={<ContactDetailPage />} />
              {/* PWA share-target landing (manifest share_target → GET /share). */}
              <Route path="/share" element={<SharePage />} />
              <Route
                path="/settings"
                element={
                  <SettingsPage
                    theme={theme}
                    onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                  />
                }
              />
            </Routes>
          </main>
        </div>
      </div>
      <BottomNav />
    </div>
  );
}
