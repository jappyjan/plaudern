import { GoogleOAuthService } from './google-oauth.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';

function makeService(overrides?: Partial<Record<string, unknown>>) {
  const config = { clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://api/cb', appBaseUrl: '' };
  const client = {
    exchangeCode: jest.fn().mockResolvedValue({
      tokens: { accessToken: 'a', refreshToken: 'r' },
      email: 'me@corp.com',
      calendars: [{ id: 'primary', summary: 'Me', primary: true }],
    }),
  };
  const feeds = { createGoogleFeeds: jest.fn().mockResolvedValue([{ id: 'f1' }]), updateGoogleRefreshToken: jest.fn().mockResolvedValue(2) };
  const svc = new GoogleOAuthService(config as never, client as never, feeds as never);
  return { svc, client, feeds, ...overrides };
}

describe('GoogleOAuthService', () => {
  it('rejects a callback with an unknown state', async () => {
    const { svc } = makeService();
    await expect(svc.handleCallback('code', 'bogus')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('round-trips: auth-url state -> callback -> pending -> confirm', async () => {
    const { svc, feeds } = makeService();
    const url = svc.buildAuthUrl();
    const state = new URL(url).searchParams.get('state') as string;
    const redirect = await svc.handleCallback('the-code', state);
    const pendingId = new URL(redirect, 'https://x').searchParams.get('googlePending') as string;
    const pending = svc.getPending(pendingId);
    expect(pending.email).toBe('me@corp.com');
    await svc.confirmFeeds(pendingId, ['primary']);
    expect(feeds.createGoogleFeeds).toHaveBeenCalledWith({
      email: 'me@corp.com',
      refreshToken: 'r',
      calendars: [{ id: 'primary', summary: 'Me', primary: true }],
    });
    // pending consumed
    expect(() => svc.getPending(pendingId)).toThrow(NotFoundException);
  });

  it('isConfigured is false when clientId missing', () => {
    const svc = new GoogleOAuthService({ clientId: '', clientSecret: 's', redirectUri: 'u', appBaseUrl: '' } as never, {} as never, {} as never);
    expect(svc.isConfigured()).toBe(false);
  });
});
