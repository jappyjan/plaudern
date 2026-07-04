import { GoogleCalendarProvider } from './google-calendar.provider';

describe('GoogleCalendarProvider', () => {
  it('refreshes a token and fetches events for the feed calendar', async () => {
    const client = {
      refreshAccessToken: jest.fn().mockResolvedValue('access-tok'),
      listEvents: jest.fn().mockResolvedValue([{ externalUid: 'e1' }]),
    };
    const feeds = { getDecryptedRefreshToken: jest.fn().mockReturnValue('refresh') };
    const provider = new GoogleCalendarProvider(client as never, feeds as never);
    const feed = { googleCalendarId: 'primary' } as never;
    const events = await provider.fetchEvents(feed, new Date('2026-01-01'), new Date('2026-02-01'));
    expect(feeds.getDecryptedRefreshToken).toHaveBeenCalledWith(feed);
    expect(client.refreshAccessToken).toHaveBeenCalledWith('refresh');
    expect(client.listEvents).toHaveBeenCalledWith('access-tok', 'primary', expect.any(Date), expect.any(Date));
    expect(events).toEqual([{ externalUid: 'e1' }]);
  });
});
