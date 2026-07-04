import {
  calendarProviderTypeSchema,
  googlePendingResponseSchema,
  createGoogleFeedsRequestSchema,
  calendarFeedsResponseSchema,
} from './calendar';

describe('google calendar contracts', () => {
  it('accepts google as a provider type', () => {
    expect(calendarProviderTypeSchema.parse('google')).toBe('google');
    expect(calendarProviderTypeSchema.parse('ics')).toBe('ics');
  });

  it('parses a pending response with calendars', () => {
    const parsed = googlePendingResponseSchema.parse({
      email: 'me@corp.com',
      calendars: [{ id: 'primary', summary: 'Me', primary: true }],
    });
    expect(parsed.calendars[0].id).toBe('primary');
  });

  it('requires at least one calendarId when creating feeds', () => {
    expect(() => createGoogleFeedsRequestSchema.parse({ pendingId: 'x', calendarIds: [] })).toThrow();
  });

  it('exposes googleConfigured on the feeds response', () => {
    const parsed = calendarFeedsResponseSchema.parse({ feeds: [], syncRunning: false, googleConfigured: true });
    expect(parsed.googleConfigured).toBe(true);
  });
});
