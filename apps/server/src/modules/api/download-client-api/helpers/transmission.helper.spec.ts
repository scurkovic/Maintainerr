import { MaintainerrLogger } from '../../../logging/logs.service';
import { TransmissionApi } from './transmission.helper';

const logger = {
  setContext: jest.fn(),
  log: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
} as unknown as MaintainerrLogger;

const buildApi = () => {
  const api = new TransmissionApi(
    { url: 'http://localhost:9091', username: 'admin', password: 'pw' },
    logger,
  );

  const axiosMock = {
    post: jest.fn(),
    defaults: { headers: { common: {} as Record<string, string> } },
  };
  (api as unknown as { axios: typeof axiosMock }).axios = axiosMock;

  return { api, axiosMock };
};

const successResponse = (args: Record<string, unknown>) => ({
  data: { result: 'success', arguments: args },
  headers: {},
});

const sessionResponse = successResponse({
  version: '4.0.6',
  seedRatioLimit: 1.0,
  seedRatioLimited: false,
  seedIdleLimit: 30,
  seedIdleLimited: false,
});

describe('TransmissionApi session management', () => {
  it('retries once with the correct session ID on a 409 challenge', async () => {
    const { api, axiosMock } = buildApi();

    const challengeError = Object.assign(new Error('409'), {
      isAxiosError: true,
      response: {
        status: 409,
        headers: { 'x-transmission-session-id': 'sess-abc' },
      },
    });

    axiosMock.post
      .mockRejectedValueOnce(challengeError)
      .mockResolvedValue(sessionResponse);

    const version = await api.getVersion();

    expect(version).toBe('4.0.6');
    expect(axiosMock.post).toHaveBeenCalledTimes(2);
    const secondCall = axiosMock.post.mock.calls[1];
    expect(secondCall[2]).toMatchObject({
      headers: { 'X-Transmission-Session-Id': 'sess-abc' },
    });
  });

  it('returns the version from session-get', async () => {
    const { api, axiosMock } = buildApi();
    axiosMock.post.mockResolvedValue(sessionResponse);

    await expect(api.getVersion()).resolves.toBe('4.0.6');
  });
});

describe('TransmissionApi torrent mapping', () => {
  const rawTorrent = (overrides = {}) => ({
    hashString: 'ABCDEF',
    name: 'Sample',
    downloadDir: '/downloads',
    uploadRatio: 1.0,
    seedRatioMode: 2 as const,
    seedRatioLimit: 0,
    seedIdleMode: 2 as const,
    seedIdleLimit: 0,
    activityDate: 0,
    ...overrides,
  });

  const getTorrent = async (torrentOverrides = {}, sessionOverrides = {}) => {
    const { api, axiosMock } = buildApi();
    const session = {
      ...sessionResponse.data.arguments,
      ...sessionOverrides,
    };
    axiosMock.post
      .mockResolvedValueOnce(
        successResponse({ torrents: [rawTorrent(torrentOverrides)] }),
      )
      .mockResolvedValue(successResponse(session));
    return api.getTorrentByHash('ABCDEF');
  };

  it('lowercases the hash and builds content_path from downloadDir + name', async () => {
    const t = await getTorrent();
    expect(t?.hash).toBe('abcdef');
    expect(t?.content_path).toBe('/downloads/Sample');
  });

  it('handles a downloadDir that already ends with a slash', async () => {
    const t = await getTorrent({ downloadDir: '/downloads/' });
    expect(t?.content_path).toBe('/downloads/Sample');
  });

  it('normalizes -1 uploadRatio to 0', async () => {
    const t = await getTorrent({ uploadRatio: -1 });
    expect(t?.ratio).toBe(0);
  });

  it('returns reachedSeedingGoal=null when both modes are unlimited (2)', async () => {
    const t = await getTorrent({
      seedRatioMode: 2,
      seedIdleMode: 2,
    });
    expect(t?.reachedSeedingGoal).toBeNull();
  });

  it('uses the per-torrent ratio limit when seedRatioMode is 1', async () => {
    const nowSecs = Math.floor(Date.now() / 1000);

    const metT = await getTorrent({
      seedRatioMode: 1,
      seedRatioLimit: 1.0,
      uploadRatio: 1.5,
      seedIdleMode: 2,
    });
    expect(metT?.reachedSeedingGoal).toBe(true);

    const notMetT = await getTorrent({
      seedRatioMode: 1,
      seedRatioLimit: 2.0,
      uploadRatio: 1.5,
      seedIdleMode: 2,
      activityDate: nowSecs,
    });
    expect(notMetT?.reachedSeedingGoal).toBe(false);
  });

  it('uses the per-torrent idle limit when seedIdleMode is 1', async () => {
    const nowSecs = Math.floor(Date.now() / 1000);

    const metT = await getTorrent({
      seedRatioMode: 2,
      seedIdleMode: 1,
      seedIdleLimit: 30,
      activityDate: nowSecs - 31 * 60,
    });
    expect(metT?.reachedSeedingGoal).toBe(true);

    const notMetT = await getTorrent({
      seedRatioMode: 2,
      seedIdleMode: 1,
      seedIdleLimit: 30,
      activityDate: nowSecs - 10 * 60,
    });
    expect(notMetT?.reachedSeedingGoal).toBe(false);
  });

  it('returns null for idle limit when activityDate is 0 (never active)', async () => {
    const t = await getTorrent({
      seedRatioMode: 2,
      seedIdleMode: 1,
      seedIdleLimit: 30,
      activityDate: 0,
    });
    expect(t?.reachedSeedingGoal).toBe(false);
  });

  it('uses global session ratio limit when seedRatioMode is 0 and seedRatioLimited is true', async () => {
    const metT = await getTorrent(
      { seedRatioMode: 0, seedIdleMode: 2, uploadRatio: 1.5 },
      { seedRatioLimited: true, seedRatioLimit: 1.0 },
    );
    expect(metT?.reachedSeedingGoal).toBe(true);
  });

  it('returns null when seedRatioMode is 0 but seedRatioLimited is false and seedIdleMode is 2', async () => {
    const t = await getTorrent(
      { seedRatioMode: 0, seedIdleMode: 2 },
      { seedRatioLimited: false },
    );
    expect(t?.reachedSeedingGoal).toBeNull();
  });
});

describe('TransmissionApi deleteTorrents', () => {
  it('POSTs torrent-remove with lowercased hashes and delete flag', async () => {
    const { api, axiosMock } = buildApi();
    axiosMock.post.mockResolvedValue(successResponse({}));

    await api.deleteTorrents(['ABC', 'DEF'], true);

    expect(axiosMock.post).toHaveBeenCalledWith(
      '',
      expect.objectContaining({
        method: 'torrent-remove',
        arguments: { ids: ['abc', 'def'], 'delete-local-data': true },
      }),
      expect.anything(),
    );
  });

  it('no-ops when the hashes array is empty', async () => {
    const { api, axiosMock } = buildApi();
    await api.deleteTorrents([], false);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });
});
