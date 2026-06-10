import { RawAxiosRequestConfig } from 'axios';
import { MaintainerrLogger } from '../../../logging/logs.service';
import { ExternalApiService } from '../../external-api/external-api.service';
import {
  DownloadClient,
  DownloadClientTorrent,
} from '../download-client.interface';

/**
 * Transmission torrent fields returned by `torrent-get`. seedRatioMode /
 * seedIdleMode: 0=use global, 1=per-torrent override, 2=unlimited.
 * activityDate is a Unix timestamp (seconds); 0 when the torrent was never
 * active. uploadRatio is -1 when the ratio is incalculable (nothing downloaded
 * or uploaded yet).
 */
interface RawTransmissionTorrent {
  hashString: string;
  name: string;
  downloadDir: string;
  uploadRatio: number;
  seedRatioMode: 0 | 1 | 2;
  seedRatioLimit: number;
  seedIdleMode: 0 | 1 | 2;
  seedIdleLimit: number;
  activityDate: number;
}

interface TransmissionSession {
  version: string;
  seedRatioLimit: number;
  seedRatioLimited: boolean;
  seedIdleLimit: number;
  seedIdleLimited: boolean;
}

interface TransmissionRpcResponse<T = Record<string, unknown>> {
  result: string;
  arguments: T;
}

interface TorrentGetArguments {
  torrents: RawTransmissionTorrent[];
}

/**
 * Decide whether the torrent's seeding goal is met, using a combination of
 * per-torrent and global (session) limits. Returns null when no limit is
 * configured so the caller applies its own fallback ratio.
 *
 * Idle detection: activityDate === 0 means the torrent was never active — the
 * idle clock hasn't started, so we treat it as not idle regardless of the limit.
 */
const decideReachedSeedingGoal = (
  torrent: RawTransmissionTorrent,
  session: TransmissionSession | null,
  nowSecs: number,
): boolean | null => {
  let ratioLimit: number | null = null;
  if (torrent.seedRatioMode === 1) {
    ratioLimit = torrent.seedRatioLimit;
  } else if (torrent.seedRatioMode === 0 && session?.seedRatioLimited) {
    ratioLimit = session.seedRatioLimit;
  }

  let idleLimitSecs: number | null = null;
  if (torrent.seedIdleMode === 1) {
    idleLimitSecs = torrent.seedIdleLimit * 60;
  } else if (torrent.seedIdleMode === 0 && session?.seedIdleLimited) {
    idleLimitSecs = session.seedIdleLimit * 60;
  }

  if (ratioLimit === null && idleLimitSecs === null) {
    return null;
  }

  const ratio = torrent.uploadRatio < 0 ? 0 : torrent.uploadRatio;
  const ratioMet = ratioLimit !== null && ratio >= ratioLimit;
  const idleMet =
    idleLimitSecs !== null &&
    torrent.activityDate > 0 &&
    nowSecs - torrent.activityDate >= idleLimitSecs;

  return ratioMet || idleMet;
};

const toDownloadClientTorrent = (
  raw: RawTransmissionTorrent,
  session: TransmissionSession | null,
  nowSecs: number,
): DownloadClientTorrent => {
  const dir = raw.downloadDir;
  const endsWithSlash = dir.length > 0 && dir[dir.length - 1] === '/';
  const contentPath = endsWithSlash
    ? `${dir}${raw.name}`
    : `${dir}/${raw.name}`;

  return {
    hash: raw.hashString.toLowerCase(),
    name: raw.name,
    content_path: contentPath,
    ratio: raw.uploadRatio < 0 ? 0 : raw.uploadRatio,
    reachedSeedingGoal: decideReachedSeedingGoal(raw, session, nowSecs),
  };
};

/**
 * Thin client for the Transmission RPC API — the Transmission implementation
 * of the backend-agnostic `DownloadClient` contract.
 *
 * Transmission uses a single POST endpoint (`/transmission/rpc`) for all
 * operations. Session authentication is header-based: the server returns HTTP
 * 409 when the `X-Transmission-Session-Id` header is missing or stale, and
 * includes the correct ID in the response header. The client retries once on
 * every 409. Username/password use HTTP Basic Auth.
 *
 * Session settings (global ratio/idle limits) are fetched lazily on first use
 * and cached for the lifetime of this instance, which is recreated whenever
 * settings change.
 */
export class TransmissionApi
  extends ExternalApiService
  implements DownloadClient
{
  private sessionId: string | undefined;
  private cachedSession: TransmissionSession | undefined;

  constructor(
    {
      url,
      username,
      password,
    }: { url: string; username?: string; password?: string },
    protected readonly logger: MaintainerrLogger,
  ) {
    logger.setContext(TransmissionApi.name);
    super(
      `${url}/transmission/rpc`,
      {},
      logger,
      username || password
        ? {
            headers: {
              Authorization:
                'Basic ' +
                Buffer.from(`${username ?? ''}:${password ?? ''}`).toString(
                  'base64',
                ),
            },
          }
        : {},
    );
  }

  public async getVersion(config?: RawAxiosRequestConfig): Promise<string> {
    const session = await this.rpc<TransmissionSession>(
      'session-get',
      {
        fields: [
          'version',
          'seedRatioLimit',
          'seedRatioLimited',
          'seedIdleLimit',
          'seedIdleLimited',
        ],
      },
      config,
    );
    this.cachedSession = session;
    return session.version;
  }

  public async getTorrents(): Promise<DownloadClientTorrent[]> {
    const result = await this.rpc<TorrentGetArguments>('torrent-get', {
      fields: TORRENT_FIELDS,
    });

    if (!Array.isArray(result.torrents) || result.torrents.length === 0) {
      return [];
    }

    const session = await this.getSessionSettings();
    const nowSecs = Math.floor(Date.now() / 1000);
    return result.torrents.map((t) =>
      toDownloadClientTorrent(t, session, nowSecs),
    );
  }

  public async getTorrentByHash(
    hash: string,
  ): Promise<DownloadClientTorrent | null> {
    const normalized = hash.toLowerCase();

    const result = await this.rpc<TorrentGetArguments>('torrent-get', {
      ids: [normalized],
      fields: TORRENT_FIELDS,
    });

    const raw = result.torrents?.[0];
    if (!raw) {
      return null;
    }

    const session = await this.getSessionSettings();
    const nowSecs = Math.floor(Date.now() / 1000);
    return toDownloadClientTorrent(raw, session, nowSecs);
  }

  public async deleteTorrents(
    hashes: string[],
    deleteData: boolean,
  ): Promise<void> {
    if (hashes.length === 0) {
      return;
    }

    await this.rpc('torrent-remove', {
      ids: hashes.map((h) => h.toLowerCase()),
      'delete-local-data': deleteData,
    });
  }

  private async getSessionSettings(): Promise<TransmissionSession | null> {
    if (this.cachedSession) {
      return this.cachedSession;
    }

    try {
      const session = await this.rpc<TransmissionSession>('session-get', {
        fields: [
          'version',
          'seedRatioLimit',
          'seedRatioLimited',
          'seedIdleLimit',
          'seedIdleLimited',
        ],
      });
      this.cachedSession = session;
      return session;
    } catch {
      return null;
    }
  }

  /**
   * Make a Transmission RPC call. Handles the 409 session-ID challenge: on the
   * first 409 the correct session ID is read from the response header and the
   * request is retried once. Throws on any other error or a second 409.
   */
  private async rpc<T>(
    method: string,
    args: Record<string, unknown> = {},
    config?: RawAxiosRequestConfig,
  ): Promise<T> {
    const body = { method, arguments: args };

    const doRequest = async (): Promise<T> => {
      const headers: Record<string, string> = {};
      if (this.sessionId) {
        headers['X-Transmission-Session-Id'] = this.sessionId;
      }

      const response = await this.axios.post<TransmissionRpcResponse<T>>(
        '',
        body,
        { ...config, headers: { ...config?.headers, ...headers } },
      );

      if (response.data.result !== 'success') {
        throw new Error(`Transmission RPC error: ${response.data.result}`);
      }

      return response.data.arguments;
    };

    try {
      return await doRequest();
    } catch (error) {
      const status = (
        error as {
          response?: { status?: number; headers?: Record<string, string> };
        }
      )?.response?.status;
      if (status === 409) {
        const newId = (
          error as { response: { headers: Record<string, string> } }
        ).response.headers['x-transmission-session-id'];
        if (newId) {
          this.sessionId = newId;
          return await doRequest();
        }
      }
      throw error;
    }
  }
}

const TORRENT_FIELDS: (keyof RawTransmissionTorrent)[] = [
  'hashString',
  'name',
  'downloadDir',
  'uploadRatio',
  'seedRatioMode',
  'seedRatioLimit',
  'seedIdleMode',
  'seedIdleLimit',
  'activityDate',
];
