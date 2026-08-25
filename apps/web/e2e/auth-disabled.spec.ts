import { expect, test, type Page } from '@playwright/test';

const SENTINEL_USER = {
  id: '00000000-0000-0000-0000-000000000001',
  username: 'default',
};

async function mockApi(page: Page, authDisabled: boolean) {
  await page.route('**/api/v1/**', async (route) => {
    const { pathname } = new URL(route.request().url());

    if (pathname === '/api/v1/auth/status') {
      return route.fulfill({
        json: { usersExist: true, allowRegistration: false, authDisabled },
      });
    }
    if (pathname === '/api/v1/auth/me') {
      return route.fulfill({ json: { user: SENTINEL_USER } });
    }
    if (pathname === '/api/v1/inbox') {
      return route.fulfill({ json: { items: [], nextCursor: null } });
    }
    if (pathname === '/api/v1/events') {
      return route.abort();
    }

    return route.fulfill({ status: 404, json: { message: 'unmocked request' } });
  });
}

test('AUTH_DISABLED sentinel response opens the inbox', async ({ page }) => {
  await mockApi(page, true);
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with passkey' })).toHaveCount(0);
});

test('authenticated mode still rejects the sentinel user', async ({ page }) => {
  await mockApi(page, false);
  await page.goto('/');

  await expect(page.getByRole('button', { name: 'Sign in with passkey' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Inbox' })).toHaveCount(0);
});
