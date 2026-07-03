import { useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import { Link, Route, Routes } from 'react-router-dom';
import { InboxPage } from './pages/InboxPage';
import { ItemDetailPage } from './pages/ItemDetailPage';
import { SettingsPage } from './pages/SettingsPage';
import { CalendarPage } from './pages/CalendarPage';
import { ContactsPage } from './pages/ContactsPage';
import { ContactDetailPage } from './pages/ContactDetailPage';
import { CalendarIcon, GearIcon, MoonIcon, PeopleIcon, SunIcon } from './components/icons';

type Theme = 'light' | 'dark';

function initialTheme(): Theme {
  const stored = localStorage.getItem('theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('theme', theme);
    // Keep the browser/PWA chrome in sync with the manual theme toggle.
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'dark' ? '#000000' : '#ffffff');
  }, [theme]);

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col px-4 pb-8">
        <header className="flex items-center justify-between py-4">
          <h1 className="text-xl font-bold">
            <Link to="/">Plaudern</Link>
          </h1>
          <div className="flex items-center gap-1">
            <Button
              isIconOnly
              variant="light"
              size="sm"
              aria-label="Toggle dark mode"
              onPress={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            >
              {theme === 'dark' ? <SunIcon className="h-5 w-5" /> : <MoonIcon className="h-5 w-5" />}
            </Button>
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
        <main className="flex-1">
          <Routes>
            <Route path="/" element={<InboxPage />} />
            <Route path="/items/:id" element={<ItemDetailPage />} />
            <Route path="/calendar" element={<CalendarPage />} />
            <Route path="/contacts" element={<ContactsPage />} />
            <Route path="/contacts/:id" element={<ContactDetailPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
