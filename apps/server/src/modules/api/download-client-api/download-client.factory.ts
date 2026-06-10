import { DownloadClientType } from '@maintainerr/contracts';
import { MaintainerrLogger } from '../../logging/logs.service';
import { DownloadClient } from './download-client.interface';
import { QbittorrentApi } from './helpers/qbittorrent.helper';
import { TransmissionApi } from './helpers/transmission.helper';

export interface DownloadClientConnection {
  type?: DownloadClientType;
  url: string;
  username?: string;
  password?: string;
}

export const createDownloadClient = (
  connection: DownloadClientConnection,
  logger: MaintainerrLogger,
): DownloadClient => {
  if (connection.type === DownloadClientType.TRANSMISSION) {
    return new TransmissionApi(connection, logger);
  }
  return new QbittorrentApi(connection, logger);
};
