import { Component, OnInit, OnDestroy } from '@angular/core'
import { ConfigService, PlatformService } from 'terminus-core'
import { ToastrService } from 'ngx-toastr'
import { Connection, getGist, syncGist } from 'api';
import { PasswordStorageService } from 'services/PasswordStorage.service';
import CryptoJS from 'crypto-js'
import * as yaml from 'js-yaml'
import { GistFile } from 'gist/Gist';
import GitLab from 'gist/GitLab';
import * as crypto from 'crypto'

/** @hidden */
@Component({
    template: require('./SettingsTab.component.pug'),
    styles: [require('./SettingsTab.component.scss')]
})
export class SyncConfigSettingsTabComponent implements OnInit, OnDestroy {
    private isUploading: boolean = false;
    private isDownloading: boolean = false;
    private isAutoSyncing: boolean = false;
    private autoSyncTimer: any = null;
    syncLogs: Array<{ time: string, direction: string, success: boolean, message: string }> = [];

    constructor(
        public config: ConfigService,
        private toastr: ToastrService,
        private platform: PlatformService,
        private passwordStorage: PasswordStorageService
    ) {
    }

    ngOnInit(): void {
        this.syncLogs = this.config.store.syncConfig.syncLogs || [];
        if (this.config.store.syncConfig.autoSync) {
            this.startAutoSync();
        }
    }

    ngOnDestroy(): void {
        this.stopAutoSync();
    }

    private dateFormat(date: Date): any {
        var fmt = "yyyy-MM-dd HH:mm:ss";
        var o = {
            "M+": date.getMonth() + 1,
            "d+": date.getDate(),
            "H+": date.getHours(),
            "m+": date.getMinutes(),
            "s+": date.getSeconds(),
            "q+": Math.floor((date.getMonth() + 3) / 3),
            "S": date.getMilliseconds()
        };
        if (/(y+)/.test(fmt))
            fmt = fmt.replace(RegExp.$1, (date.getFullYear() + "").substr(4 - RegExp.$1.length));
        for (var k in o)
            if (new RegExp("(" + k + ")").test(fmt))
                fmt = fmt.replace(RegExp.$1, (RegExp.$1.length == 1) ? (o[k]) : (("00" + o[k]).substr(("" + o[k]).length)));
        return fmt;
    }

    private addSyncLog(direction: string, success: boolean, message: string): void {
        const log = {
            time: this.dateFormat(new Date()),
            direction,
            success,
            message,
        };
        this.syncLogs.unshift(log);
        const max = this.config.store.syncConfig.syncLogMax || 5;
        if (this.syncLogs.length > max) {
            this.syncLogs = this.syncLogs.slice(0, max);
        }
        this.config.store.syncConfig.syncLogs = this.syncLogs;
        this.config.save();
    }

    private sha256(content: string): string {
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    private async computeLocalHash(): Promise<string> {
        const store = yaml.load(this.config.readRaw()) as any;
        delete store.syncConfig;
        const configYaml = yaml.dump(store);
        const { token } = this.config.store.syncConfig;
        const sshAuth = JSON.stringify(await this.getSSHPluginAllPasswordInfos(token));
        return this.sha256(configYaml + '\n' + sshAuth);
    }

    private computeRemoteHash(files: Map<string, GistFile>): string {
        const parts: string[] = [];
        if (files.has('config.yaml')) {
            parts.push(files.get('config.yaml').value);
        } else if (files.has('config.json')) {
            parts.push(files.get('config.json').value);
        }
        if (files.has('ssh.auth.json')) {
            parts.push(files.get('ssh.auth.json').value);
        }
        return this.sha256(parts.join('\n'));
    }

    startAutoSync(): void {
        this.stopAutoSync();
        const interval = (this.config.store.syncConfig.autoSyncInterval || 5) * 60 * 1000;
        // Perform an immediate check on start
        this.autoSyncCheck();
        this.autoSyncTimer = setInterval(() => this.autoSyncCheck(), interval);
    }

    stopAutoSync(): void {
        if (this.autoSyncTimer) {
            clearInterval(this.autoSyncTimer);
            this.autoSyncTimer = null;
        }
    }

    onAutoSyncToggle(): void {
        this.config.save();
        if (this.config.store.syncConfig.autoSync) {
            this.startAutoSync();
        } else {
            this.stopAutoSync();
        }
    }

    onAutoSyncIntervalChange(): void {
        this.config.save();
        if (this.config.store.syncConfig.autoSync) {
            this.startAutoSync();
        }
    }

    onSyncLogMaxChange(): void {
        const max = this.config.store.syncConfig.syncLogMax || 5;
        if (this.syncLogs.length > max) {
            this.syncLogs = this.syncLogs.slice(0, max);
            this.config.store.syncConfig.syncLogs = this.syncLogs;
        }
        this.config.save();
    }

    private async autoSyncCheck(): Promise<void> {
        const { type, token, gist } = this.config.store.syncConfig;

        if (type === 'Off' || !token) {
            return;
        }

        if (!gist) {
            this.toastr.error('Gist ID is required for auto sync. Please fill in the Gist ID first.');
            return;
        }

        if (this.isUploading || this.isDownloading || this.isAutoSyncing) {
            return;
        }

        this.isAutoSyncing = true;

        try {
            const localNow = await this.computeLocalHash();
            const localChanged = localNow !== this.config.store.syncConfig.localHash;

            const remoteFiles = await getGist(
                this.config.store.syncConfig.type,
                this.config.store.syncConfig.token,
                this.config.store.syncConfig.baseUrl,
                this.config.store.syncConfig.gist
            );
            const remoteNow = this.computeRemoteHash(remoteFiles);
            const remoteChanged = remoteNow !== this.config.store.syncConfig.remoteHash;

            if (!localChanged && !remoteChanged) {
                return;
            }

            if (remoteChanged && !localChanged) {
                // Remote changed, download
                await this.sync(false);
            } else if (localChanged && !remoteChanged) {
                // Local changed, upload
                await this.sync(true);
            } else {
                // Both changed: download first, then upload
                await this.sync(false);
                await this.sync(true);
            }

            // Update hashes after successful sync
            this.config.store.syncConfig.localHash = await this.computeLocalHash();
            const newRemoteFiles = await getGist(
                this.config.store.syncConfig.type,
                this.config.store.syncConfig.token,
                this.config.store.syncConfig.baseUrl,
                this.config.store.syncConfig.gist
            );
            this.config.store.syncConfig.remoteHash = this.computeRemoteHash(newRemoteFiles);
            this.config.save();

        } catch (error) {
            console.error('Auto sync check failed:', error);
            this.addSyncLog('Auto', false, String(error));
        } finally {
            this.isAutoSyncing = false;
        }
    }


    async sync(isUploading: boolean): Promise<void> {

        const { type,baseUrl, token, gist, encryption } = this.config.store.syncConfig;
        const selfConfig = JSON.parse(JSON.stringify(this.config.store.syncConfig));

        if (!token) {
            this.toastr.error("token is missing");
            return;
        }

        if (isUploading) {
            if (!gist) {
                this.toastr.error("gist id is missing");
                return;
            }
            this.isUploading = true;
        } else {
            if (!gist) {
                this.toastr.error("gist id is missing");
                return;
            }
            this.isDownloading = true;
        }


        try {
            if (isUploading) {
                const files = [];

                const store = yaml.load(this.config.readRaw()) as any;

                // no sync self
                delete store.syncConfig;

                // config file
                files.push(new GistFile('config.yaml', yaml.dump(store)));

                // ssh password
                files.push(new GistFile('ssh.auth.json', JSON.stringify(await this.getSSHPluginAllPasswordInfos(token))));

                await syncGist(type, token, baseUrl, gist, files);

            } else {

                const result = await getGist(type, token, baseUrl, gist);

                if (result.has('config.yaml')) {
                    const config = yaml.load(result.get('config.yaml').value) as any;
                    config.syncConfig = selfConfig;
                    this.config.writeRaw(yaml.dump(config));
                }
                // Maintain a check for `config.json` for backwards-compatibility.
                else if (result.has('config.json')) {
                    const config = yaml.load(result.get('config.json').value) as any;
                    config.syncConfig = selfConfig;
                    this.config.writeRaw(yaml.dump(config));
                }

                if (result.has('ssh.auth.json')) {
                    await this.saveSSHPluginAllPasswordInfos(JSON.parse(result.get('ssh.auth.json').value) as Connection[], token);
                }

            }

            this.toastr.info('Sync succeeded', null, {
                timeOut: 1500
            });

            this.config.store.syncConfig.lastSyncTime = this.dateFormat(new Date);
            this.addSyncLog(isUploading ? 'Upload' : 'Download', true, 'Sync succeeded');

        } catch (error) {
            console.error(error);
            this.toastr.error(error);
            this.addSyncLog(isUploading ? 'Upload' : 'Download', false, String(error));
        } finally {
            if (isUploading) this.isUploading = false;
            else this.isDownloading = false;
            this.config.save();
        }

    }

    viewGist(): void {
        if (this.config.store.syncConfig.type === 'GitHub') {
            this.platform.openExternal('https://gist.github.com/' + this.config.store.syncConfig.gist)
        } else if (this.config.store.syncConfig.type === 'GitLab') {
            this.platform.openExternal(this.config.store.syncConfig.baseUrl + '/-/snippets/' + this.config.store.syncConfig.gist)
        }
    }

    async saveSSHPluginAllPasswordInfos(conns: Connection[], token: string) {
        if (conns.length < 1) return;
        for (const conn of conns) {
            try {
                if (conn.auth !== null && conn.auth.encryptType && conn.auth.encryptType === 'AES') {
                    conn.auth.password = this.aesDecrypt(conn.auth.password, token);
                }
                await this.passwordStorage.savePassword(conn)
            } catch (error) {
                console.error(conn, error);
            }
        }

    }

    getSSHPluginAllPasswordInfos(token: string): Promise<Connection[]> {
        return new Promise(async (resolve) => {

            const store = this.config.store

            let connections = [];
            if (store.version == "3" && store.profiles instanceof Array) {
                connections = store.profiles.filter(e => e.type === 'ssh' && typeof e.options === "object" && e.options.auth === "password").map(e => {
                    const { host, port, user } = e.options
                    return { host, port: port || 22, user: user || 'root' };
                })
            } else {
                connections = store.ssh.connections;
            }

            if (!(connections instanceof Array) || connections.length < 1) {
                resolve([]);
                return;
            }

            const isEncrypt = store.syncConfig.encryption === true;

            const infos = [];
            for (const connect of connections) {
                try {
                    const { host, port, user } = connect;
                    const pwd = await this.passwordStorage.loadPassword({ host, port, user });
                    if (!pwd) continue;
                    infos.push({
                        host, port, user,
                        auth: {
                            password: isEncrypt ? this.aesEncrypt(pwd.toString(), token) : pwd,
                            encryptType: isEncrypt ? 'AES' : 'NONE'
                        }
                    });
                } catch (error) {
                    console.error(connect, error);
                }
            }

            resolve(infos);

        });


    }

    /* AES Begin http://www.kt5.cn/fe/2019/12/12/cryptojs-aes-128-bit-ecrypt-decrypt/ */

    aesEncrypt(str: string, token: string) {
        const k = this.getEncKey(token);
        const formatedKey = CryptoJS.enc.Utf8.parse(k)
        const formatedIv = CryptoJS.enc.Utf8.parse(k)
        const encrypted = CryptoJS.AES.encrypt(str, formatedKey, { iv: formatedIv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 })
        return encrypted.ciphertext.toString()
    }

    aesDecrypt(encryptedStr: string, token: string) {
        const encryptedHexStr = CryptoJS.enc.Hex.parse(encryptedStr)
        const encryptedBase64Str = CryptoJS.enc.Base64.stringify(encryptedHexStr)
        const k = this.getEncKey(token);
        const formatedKey = CryptoJS.enc.Utf8.parse(k)
        const formatedIv = CryptoJS.enc.Utf8.parse(k)
        const decryptedData = CryptoJS.AES.decrypt(encryptedBase64Str, formatedKey, { iv: formatedIv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 })
        return decryptedData.toString(CryptoJS.enc.Utf8)
    }

    getEncKey(token: string): string {
        const diff = 16 - token.length;
        if (diff < 0) {
            return token.substr(0, 16);
        }
        return token + Array(diff + 1).join('0');
    }

    /* AES End */
}
