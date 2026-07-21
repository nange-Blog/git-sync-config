import { ConfigProvider } from 'terminus-core';

export class SyncConfigProvider extends ConfigProvider {
    defaults = {
        syncConfig: {
            type: 'Off',
            baseUrl: '',
            token: '',
            gist: '',
            lastSyncTime: '-',
            encryption: false,
            autoSync: false,
            autoSyncInterval: 5,
            localHash: '',
            remoteHash: '',
            syncLogs: [],
            syncLogMax: 5,
        }
    }
}