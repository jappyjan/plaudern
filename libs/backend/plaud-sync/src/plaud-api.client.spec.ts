import { PlaudApiClient, PlaudApiError } from './plaud-api.client';

function fakeJwt(exp: number): string {
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return `header.${payload}.signature`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('PlaudApiClient', () => {
  describe('login', () => {
    it('posts form-encoded credentials and reads expiry from the JWT', async () => {
      const exp = Math.floor(Date.now() / 1000) + 300 * 24 * 60 * 60;
      const token = fakeJwt(exp);
      const fetchFn = jest.fn().mockResolvedValue(
        jsonResponse({ status: 0, access_token: token, token_type: 'Bearer' }),
      );
      const client = new PlaudApiClient(fetchFn as unknown as typeof fetch);

      const result = await client.login('us', 'me@example.com', 'pw');

      expect(fetchFn).toHaveBeenCalledWith(
        'https://api.plaud.ai/auth/access-token',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'content-type': 'application/x-www-form-urlencoded',
          }),
          body: 'username=me%40example.com&password=pw',
        }),
      );
      expect(result.accessToken).toBe(token);
      expect(new Date(result.expiresAt).getTime()).toBe(exp * 1000);
    });

    it('uses the EU base URL for the eu region', async () => {
      const fetchFn = jest.fn().mockResolvedValue(jsonResponse({ access_token: fakeJwt(1) }));
      const client = new PlaudApiClient(fetchFn as unknown as typeof fetch);
      await client.login('eu', 'me@example.com', 'pw');
      expect(fetchFn.mock.calls[0][0]).toBe('https://api-euc1.plaud.ai/auth/access-token');
    });

    it('throws PlaudApiError on a non-2xx response', async () => {
      const fetchFn = jest.fn().mockResolvedValue(new Response('bad credentials', { status: 401 }));
      const client = new PlaudApiClient(fetchFn as unknown as typeof fetch);
      await expect(client.login('us', 'me@example.com', 'pw')).rejects.toThrow(PlaudApiError);
    });

    it('throws when the response has no access_token', async () => {
      const fetchFn = jest.fn().mockResolvedValue(jsonResponse({ status: 1, msg: 'wrong region' }));
      const client = new PlaudApiClient(fetchFn as unknown as typeof fetch);
      await expect(client.login('us', 'me@example.com', 'pw')).rejects.toThrow('wrong region');
    });
  });

  describe('listRecordings', () => {
    it('reads data_file_list, sends the bearer token, normalizes fields', async () => {
      const fetchFn = jest.fn().mockResolvedValue(
        jsonResponse({
          data_file_list: [
            {
              id: 12345,
              filename: 'meeting.mp3',
              duration: 61000,
              filesize: 999,
              start_time: 1719900000000, // epoch millis
              is_trash: 0,
              serial_number: 'SN42',
            },
          ],
        }),
      );
      const client = new PlaudApiClient(fetchFn as unknown as typeof fetch);

      const recordings = await client.listRecordings('us', 'tok');

      expect(fetchFn).toHaveBeenCalledWith(
        'https://api.plaud.ai/file/simple/web',
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: 'Bearer tok' }),
        }),
      );
      expect(recordings).toEqual([
        {
          id: '12345',
          filename: 'meeting.mp3',
          startTime: new Date(1719900000000).toISOString(),
          duration: 61000,
          fileSize: 999,
          serialNumber: 'SN42',
          isTrash: false,
        },
      ]);
    });

    it('falls back to the data field and tolerates epoch seconds', async () => {
      const fetchFn = jest.fn().mockResolvedValue(
        jsonResponse({ data: [{ id: 'abc', start_time: 1719900000, is_trash: true }] }),
      );
      const client = new PlaudApiClient(fetchFn as unknown as typeof fetch);
      const recordings = await client.listRecordings('us', 'tok');
      expect(recordings[0].startTime).toBe(new Date(1719900000 * 1000).toISOString());
      expect(recordings[0].isTrash).toBe(true);
      expect(recordings[0].filename).toBe('plaud-abc');
    });

    it('produces a valid ISO timestamp even for a garbage start_time', async () => {
      const fetchFn = jest.fn().mockResolvedValue(
        jsonResponse({ data_file_list: [{ id: '1', start_time: 'garbage' }] }),
      );
      const client = new PlaudApiClient(fetchFn as unknown as typeof fetch);
      const recordings = await client.listRecordings('us', 'tok');
      expect(Number.isNaN(new Date(recordings[0].startTime).getTime())).toBe(false);
    });
  });

  describe('downloadRecording', () => {
    it('prefers the temp URL when available', async () => {
      const audio = Buffer.from('audio-bytes');
      const fetchFn = jest.fn().mockImplementation((url: string) => {
        if (url.includes('/file/temp-url/')) {
          return Promise.resolve(jsonResponse({ url: 'https://cdn.example.com/rec.mp3' }));
        }
        return Promise.resolve(
          new Response(audio, { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
        );
      });
      const client = new PlaudApiClient(fetchFn as unknown as typeof fetch);

      const result = await client.downloadRecording('us', 'tok', 'rec-1');

      expect(fetchFn.mock.calls[0][0]).toBe('https://api.plaud.ai/file/temp-url/rec-1?is_opus=false');
      expect(fetchFn.mock.calls[1][0]).toBe('https://cdn.example.com/rec.mp3');
      expect(result.body.equals(audio)).toBe(true);
      expect(result.contentType).toBe('audio/mpeg');
    });

    it('falls back to the direct download endpoint when temp-url fails', async () => {
      const audio = Buffer.from('audio-bytes');
      const fetchFn = jest.fn().mockImplementation((url: string) => {
        if (url.includes('/file/temp-url/')) {
          return Promise.resolve(new Response('nope', { status: 404 }));
        }
        return Promise.resolve(new Response(audio, { status: 200 }));
      });
      const client = new PlaudApiClient(fetchFn as unknown as typeof fetch);

      const result = await client.downloadRecording('us', 'tok', 'rec-1');

      expect(fetchFn.mock.calls[1][0]).toBe('https://api.plaud.ai/file/download/rec-1');
      expect(result.body.equals(audio)).toBe(true);
      // no audio content-type header -> default
      expect(result.contentType).toBe('audio/mpeg');
    });

    it('lets a 401 bubble so the caller can re-login', async () => {
      const fetchFn = jest.fn().mockResolvedValue(new Response('expired', { status: 401 }));
      const client = new PlaudApiClient(fetchFn as unknown as typeof fetch);
      await expect(client.downloadRecording('us', 'tok', 'rec-1')).rejects.toMatchObject({
        status: 401,
      });
    });
  });
});
