import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable, pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

const DEFAULT_UA = 'clash.meta/v1.19.25';
const MAX_FRAME_BYTES = 512 * 1024;
const MAX_CHUNK_BYTES = 128 * 1024;
const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../config.json', import.meta.url));

export class RelayClient {
    constructor(config, { handleSignals = true } = {}) {
        this.config = {
            heartbeatIntervalMs: 30000, pongTimeoutMs: 10000, connectTimeoutMs: 15000,
            maxConcurrentFetches: 4, maxQueuedFetches: 32, logUrlPaths: false,
            ...config,
        };
        this.handleSignals = handleSignals;
        this.reconnectAttempt = 0;
        this.manuallyClosed = false;
        this.ws = null;
        this.heartbeatTimer = this.pongTimer = this.connectTimer = this.reconnectTimer = null;
        this.tasks = new Map();
        this.queue = [];
        this.activeCount = 0;
        if (handleSignals) {
            process.on('SIGINT', () => this.shutdown());
            process.on('SIGTERM', () => this.shutdown());
        }
    }

    start() {
        if (this.manuallyClosed || this.ws) return;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        try {
            const wsUrl = this.buildWssUrl();
            this.log(`connecting to ${this.maskUrl(wsUrl)}`);
            const ws = this.ws = new WebSocket(wsUrl);
            this.connectTimer = setTimeout(() => this.retireConnection(ws, 'connection timeout'), this.config.connectTimeoutMs);
            ws.addEventListener('open', () => this.onOpen(ws));
            ws.addEventListener('message', (event) => {
                void this.onMessage(ws, event).catch((error) => this.retireConnection(ws, this.safeError(error)));
            });
            ws.addEventListener('close', (event) => this.onClose(ws, event));
            ws.addEventListener('error', () => this.retireConnection(ws, 'websocket error'));
        } catch (error) {
            this.error(this.safeError(error));
            this.scheduleReconnect();
        }
    }

    onOpen(ws) {
        if (ws !== this.ws || this.manuallyClosed) return;
        clearTimeout(this.connectTimer);
        this.connectTimer = null;
        this.log('connected');
        if (!this.send(ws, {
            type: 'hello', clientId: this.config.clientId, clientName: this.config.clientName,
            capabilities: ['fetch', 'fetch-chunks-v1'], maxBodyBytes: this.config.maxBodyBytes,
        })) return;
        // 只有收到 pong 才认定连接有效，不在刚握手时清空重连退避。
        this.ping(ws);
        if (ws !== this.ws) return;
        this.heartbeatTimer = setInterval(() => this.ping(ws), this.config.heartbeatIntervalMs);
    }

    ping(ws) {
        if (ws !== this.ws || this.pongTimer) return;
        if (!this.send(ws, { type: 'ping', time: Date.now() })) return;
        this.pongTimer = setTimeout(() => this.retireConnection(ws, 'pong timeout'), this.config.pongTimeoutMs);
    }

    onClose(ws, event) {
        this.retireConnection(ws, `connection closed code=${event.code}`);
    }

    retireConnection(ws, reason) {
        if (ws !== this.ws) return;
        this.ws = null;
        this.clearConnectionTimers();
        this.abortTasks(ws);
        // close 事件可能不及时到达，重连安排不依赖该事件；旧事件不能干扰新连接。
        try { ws.close(); } catch { /* 已断开或仍在握手。 */ }
        this.error(reason);
        this.scheduleReconnect();
    }

    async onMessage(ws, event) {
        if (ws !== this.ws || this.manuallyClosed) return;
        const message = this.parseMessage(event.data);
        if (!message) return;
        if (message.type === 'pong') {
            clearTimeout(this.pongTimer);
            this.pongTimer = null;
            this.reconnectAttempt = 0;
            return;
        }
        if (message.type !== 'fetch') return;
        if (typeof message.id !== 'string' || !message.id || message.id.length > 128) {
            this.error('received fetch message without valid id');
            return;
        }
        if (this.tasks.has(message.id)) return;
        if (this.activeCount >= this.config.maxConcurrentFetches && this.queue.length >= this.config.maxQueuedFetches) {
            this.send(ws, { type: 'fetch-result', id: message.id, ok: false, error: { message: 'Client fetch queue is full' } });
            return;
        }
        const timeoutMs = positiveInt(message.timeout, this.config.defaultTimeoutMs);
        const task = { ws, message, controller: new AbortController(), deadline: Date.now() + timeoutMs, running: false };
        // 接到任务即计时，包含排队、DNS、所有跳转、读响应和回传。
        task.timer = setTimeout(() => {
            task.controller.abort(new Error('Fetch timeout'));
            if (!task.running) {
                this.queue = this.queue.filter((item) => item !== task);
                this.tasks.delete(message.id);
                this.send(ws, { type: 'fetch-result', id: message.id, ok: false, error: { message: 'Fetch timeout while queued' } });
            }
        }, timeoutMs);
        this.tasks.set(message.id, task);
        this.queue.push(task);
        this.drainQueue();
    }

    drainQueue() {
        while (!this.manuallyClosed && this.activeCount < this.config.maxConcurrentFetches && this.queue.length) {
            const task = this.queue.shift();
            if (task.ws !== this.ws || task.controller.signal.aborted) continue;
            task.running = true;
            this.activeCount++;
            void this.runTask(task);
        }
    }

    async runTask(task) {
        const { ws, message, controller, deadline } = task;
        const id = message.id.replace(/[\r\n]/g, '');
        try {
            this.log(`received fetch id=${id} url=${this.maskUrl(message.url)}`);
            const response = await this.handleFetch(message, { signal: controller.signal });
            if (ws !== this.ws) return;
            if (response.ok) this.log(`fetch completed id=${id} status=${response.statusCode} bytes=${Buffer.byteLength(response.body || '')}`);
            else this.error(`fetch failed id=${id} error=${response.error.message}`);
            await this.sendFetchResult(ws, message, response, { signal: controller.signal, deadline });
        } catch (error) {
            if (ws === this.ws) {
                this.error(`fetch failed id=${id} error=${this.safeError(error)}`);
                this.send(ws, { type: 'fetch-result', id: message.id, ok: false, error: { message: this.safeError(error) } });
            }
        } finally {
            clearTimeout(task.timer);
            if (this.tasks.get(message.id) === task) this.tasks.delete(message.id);
            this.activeCount--;
            this.drainQueue();
        }
    }

    abortTasks(ws) {
        for (const [id, task] of this.tasks) {
            if (task.ws !== ws) continue;
            clearTimeout(task.timer);
            task.controller.abort(new Error('Relay connection closed'));
            this.tasks.delete(id);
        }
        this.queue = this.queue.filter((task) => task.ws !== ws);
    }

    async sendFetchResult(ws, request, response, { signal, deadline = Date.now() + positiveInt(request.timeout, this.config.defaultTimeoutMs) } = {}) {
        if (response.ok) {
            signal?.throwIfAborted();
            if (Date.now() >= deadline) throw new Error('Response transfer timeout');
        }
        const result = { type: 'fetch-result', id: request.id, ...response };
        if (!response.ok || Buffer.byteLength(JSON.stringify(result)) <= MAX_FRAME_BYTES) {
            this.send(ws, result);
            return;
        }
        if (!Number.isInteger(request.responseChunkBytes) || request.responseChunkBytes <= 0) {
            this.send(ws, { type: 'fetch-result', id: request.id, ok: false, error: { message: 'Response requires chunk support; update the Sub-Store backend' } });
            return;
        }
        const body = Buffer.from(response.body, 'utf8');
        const chunkBytes = Math.min(request.responseChunkBytes, MAX_CHUNK_BYTES);
        if (!this.send(ws, { type: 'fetch-result-start', id: request.id, bodyBytes: body.length, statusCode: response.statusCode, headers: response.headers })) return;
        for (let offset = 0, index = 0; offset < body.length; offset += chunkBytes, index++) {
            while (ws.bufferedAmount > 1024 * 1024 && ws.readyState === WebSocket.OPEN && Date.now() < deadline) {
                signal?.throwIfAborted();
                await withAbort(new Promise((resolve) => setTimeout(resolve, 10)), signal);
            }
            signal?.throwIfAborted();
            if (Date.now() >= deadline) throw new Error('Response transfer timeout');
            if (!this.send(ws, { type: 'fetch-result-chunk', id: request.id, index, data: body.subarray(offset, offset + chunkBytes).toString('base64') })) return;
        }
        this.send(ws, { type: 'fetch-result-end', id: request.id });
    }

    async handleFetch(message, options) {
        try {
            return { ok: true, ...await this.fetchSubscription(message, options) };
        } catch (error) {
            return { ok: false, error: { message: this.safeError(error) } };
        }
    }

    async fetchSubscription(message, { signal: parentSignal } = {}) {
        const timeoutMs = positiveInt(message.timeout, this.config.defaultTimeoutMs);
        const controller = new AbortController();
        const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
        const timeout = setTimeout(() => controller.abort(new Error('Fetch timeout')), timeoutMs);
        try {
            let target = await this.normalizeFetchUrl(message.url, signal);
            let headers;
            try {
                headers = this.normalizeHeaders(message.headers);
                headers.set('user-agent', message.uac || message.userAgent || DEFAULT_UA);
            } catch { throw new Error('Invalid request headers'); }
            if (!headers.has('accept')) headers.set('accept', '*/*');
            if (!headers.has('accept-encoding')) headers.set('accept-encoding', 'gzip, deflate, br');
            // Host 必须来自目标 URL，不能借请求头改变 TLS 校验或跳转后的虚拟主机。
            headers.delete('host');
            for (let redirectCount = 0; redirectCount <= this.config.maxRedirects; redirectCount++) {
                signal.throwIfAborted();
                this.log(`fetching ${this.maskUrl(target.url)} timeout=${timeoutMs}`);
                const response = await requestPinned(target, headers, signal);
                if (isRedirectStatus(response.status)) {
                    // 不论跳转是否合法，都先释放旧连接的响应体。
                    const location = response.headers.get('location');
                    await response.body.cancel();
                    if (!location) throw new Error(`redirect ${response.status} missing location`);
                    if (redirectCount >= this.config.maxRedirects) throw new Error(`too many redirects: ${this.config.maxRedirects}`);
                    const next = new URL(location, target.url);
                    if (next.origin !== new URL(target.url).origin) {
                        for (const key of [...headers.keys()]) {
                            if (/(authorization|cookie|token|api[-_]?key|secret|credential)/i.test(key) || key.toLowerCase() === 'host') headers.delete(key);
                        }
                    }
                    target = await this.normalizeFetchUrl(next.href, signal);
                    continue;
                }
                if (response.status < 200 || response.status >= 400) {
                    await response.body.cancel();
                    throw new Error(`statusCode: ${response.status}`);
                }
                const maxBodyBytes = Math.min(this.config.maxBodyBytes, positiveInt(message.maxBodyBytes, this.config.maxBodyBytes));
                const body = await this.readLimitedText(response, maxBodyBytes, signal);
                return { statusCode: response.status, headers: Object.fromEntries(response.headers.entries()), body };
            }
            throw new Error('unexpected redirect loop');
        } finally {
            clearTimeout(timeout);
        }
    }

    async readLimitedText(response, maxBodyBytes = this.config.maxBodyBytes, signal) {
        const reader = response.body?.getReader();
        if (!reader) return '';
        const chunks = [];
        let total = 0;
        try {
            while (true) {
                const { done, value } = await withAbort(reader.read(), signal);
                if (done) break;
                total += value.byteLength;
                if (total > maxBodyBytes) throw new Error(`response body exceeds ${maxBodyBytes} bytes`);
                chunks.push(value);
            }
        } catch (error) {
            await reader.cancel().catch(() => {});
            throw error;
        } finally {
            reader.releaseLock();
        }
        return new TextDecoder().decode(Buffer.concat(chunks, total));
    }

    async normalizeFetchUrl(rawUrl, signal) {
        if (!rawUrl || typeof rawUrl !== 'string') throw new Error('url is required');
        const url = new URL(rawUrl);
        if (!this.config.allowedProtocols.includes(url.protocol) || !['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported url protocol');
        if (url.username || url.password) throw new Error('URL credentials are not supported; use request headers');
        const addresses = await this.assertAllowedHost(url, signal);
        return { url: url.href, addresses };
    }

    async assertAllowedHost(url, signal) {
        const host = stripBrackets(url.hostname).toLowerCase();
        const addresses = await resolveHostAddresses(host, signal);
        // allowedHosts 保持兼容：精确匹配的显式可信主机允许内网地址，不是全局域名限制。
        if (!this.config.allowedHosts.includes(host) && !this.config.allowPrivateNetwork && addresses.some((item) => isPrivateAddress(item.address))) {
            throw new Error(`private network address is not allowed: ${host}`);
        }
        return addresses;
    }

    normalizeHeaders(rawHeaders) {
        const headers = new Headers();
        if (!rawHeaders || typeof rawHeaders !== 'object') return headers;
        for (const [key, value] of Object.entries(rawHeaders)) {
            if (value != null) headers.set(key, Array.isArray(value) ? value.join(', ') : String(value));
        }
        return headers;
    }

    scheduleReconnect() {
        if (this.manuallyClosed || this.reconnectTimer) return;
        const base = Math.min(this.config.reconnectMaxMs, this.config.reconnectMinMs * 2 ** Math.min(this.reconnectAttempt++, 8));
        const delay = Math.min(this.config.reconnectMaxMs, base + Math.floor(Math.random() * Math.min(base, 1000)));
        this.log(`reconnecting in ${delay}ms`);
        this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.start(); }, delay);
    }

    clearConnectionTimers() {
        clearInterval(this.heartbeatTimer);
        clearTimeout(this.pongTimer);
        clearTimeout(this.connectTimer);
        this.heartbeatTimer = this.pongTimer = this.connectTimer = null;
    }

    shutdown() {
        this.manuallyClosed = true;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.clearConnectionTimers();
        if (this.ws) {
            const ws = this.ws;
            this.ws = null;
            this.abortTasks(ws);
            try { ws.close(1000, 'shutdown'); } catch { /* 连接已关闭。 */ }
        }
        if (this.handleSignals) setTimeout(() => process.exit(0), 1000).unref();
    }

    send(ws, payload) {
        if (ws.readyState !== WebSocket.OPEN) {
            if (ws === this.ws) this.retireConnection(ws, 'connection is not open');
            return false;
        }
        try {
            const text = JSON.stringify(payload);
            if (Buffer.byteLength(text) > MAX_FRAME_BYTES) throw new Error('response frame exceeds limit');
            ws.send(text);
            return true;
        } catch (error) {
            this.retireConnection(ws, `send failed: ${this.safeError(error)}`);
            return false;
        }
    }

    parseMessage(data) {
        try {
            return JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
        } catch { this.error('invalid json message'); return null; }
    }

    buildWssUrl() {
        const url = new URL(this.config.wssUrl);
        if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('wssUrl must start with ws:// or wss://');
        for (const key of ['token', 'clientId', 'clientName']) url.searchParams.set(key, this.config[key]);
        return url.href;
    }

    maskUrl(rawUrl) {
        try {
            const url = new URL(rawUrl);
            if (!this.config.logUrlPaths) url.pathname = '/***';
            for (const key of new Set(url.searchParams.keys())) url.searchParams.set(key, '***');
            if (url.username) url.username = '***';
            if (url.password) url.password = '***';
            url.hash = '';
            return url.href;
        } catch { return '[invalid URL]'; }
    }

    safeError(error) {
        let text = String(error?.message || error || 'Unknown error');
        text = text.replace(/(?:https?|wss?):\/\/[^\s]+/gi, (url) => this.maskUrl(url));
        if (this.config.token) {
            for (const secret of [this.config.token, encodeURIComponent(this.config.token)]) text = text.split(secret).join('***');
        }
        return text.replace(/[\r\n]/g, ' ').slice(0, 512);
    }

    log(message) { console.log(`[${new Date().toISOString()}] [sub-store-wss-client] ${message}`); }
    error(message) { console.error(`[${new Date().toISOString()}] [sub-store-wss-client] ${message}`); }
}

export function readConfig(configPath = process.argv[2] || DEFAULT_CONFIG_PATH) {
    configPath = path.resolve(configPath);
    if (!fs.existsSync(configPath)) throw new Error(`Config file not found: ${configPath}. Copy config.example.json to config.json first.`);
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const clientId = typeof raw.clientId === 'string' && raw.clientId.trim() || os.hostname() || 'sub-store-wss-client';
    const reconnectMinMs = positiveInt(raw.reconnectMinMs, 1000);
    return {
        wssUrl: requiredConfig(raw, 'wssUrl'), token: requiredConfig(raw, 'token'), clientId,
        clientName: typeof raw.clientName === 'string' && raw.clientName.trim() || clientId,
        maxBodyBytes: positiveInt(raw.maxBodyBytes, 5 * 1024 * 1024),
        defaultTimeoutMs: positiveInt(raw.fetchTimeoutMs, 15000),
        reconnectMinMs, reconnectMaxMs: Math.max(reconnectMinMs, positiveInt(raw.reconnectMaxMs, 30000)),
        heartbeatIntervalMs: positiveInt(raw.heartbeatIntervalMs, 30000),
        pongTimeoutMs: positiveInt(raw.pongTimeoutMs, 10000),
        connectTimeoutMs: positiveInt(raw.connectTimeoutMs, 15000),
        maxConcurrentFetches: positiveInt(raw.maxConcurrentFetches, 4),
        maxQueuedFetches: nonNegativeInt(raw.maxQueuedFetches, 32),
        logUrlPaths: raw.logUrlPaths === true,
        allowedProtocols: Array.isArray(raw.allowedProtocols) ? raw.allowedProtocols : ['https:'],
        allowedHosts: Array.isArray(raw.allowedHosts) ? raw.allowedHosts.filter((host) => typeof host === 'string').map((host) => stripBrackets(host.trim()).toLowerCase()) : [],
        allowPrivateNetwork: raw.allowPrivateNetwork === true,
        maxRedirects: nonNegativeInt(raw.maxRedirects, 3),
    };
}

function requiredConfig(config, key) {
    if (typeof config[key] !== 'string' || !config[key].trim()) throw new Error(`${key} must be a non-empty string`);
    return config[key].trim();
}

function positiveInt(value, fallback) {
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 && n <= 2147483647 ? n : fallback;
}

function nonNegativeInt(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 0 && n <= 2147483647 ? n : fallback;
}

function stripBrackets(host) { return host.replace(/^\[|\]$/g, ''); }
function isRedirectStatus(status) { return [301, 302, 303, 307, 308].includes(status); }

export async function withAbort(promise, signal) {
    if (!signal) return await promise;
    const pending = Promise.resolve(promise);
    if (signal.aborted) {
        // 调用者可能已经创建了异步操作；即使提前取消也必须消费其拒绝。
        void pending.catch(() => {});
        signal.throwIfAborted();
    }
    return await new Promise((resolve, reject) => {
        const abort = () => {
            signal.removeEventListener('abort', abort);
            reject(signal.reason || new Error('Fetch aborted'));
        };
        signal.addEventListener('abort', abort, { once: true });
        pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

async function resolveHostAddresses(host, signal) {
    if (net.isIP(host)) return [{ address: host, family: net.isIP(host) }];
    const records = await withAbort(dns.lookup(host, { all: true, verbatim: true }), signal);
    if (!records.length || records.some((item) => !net.isIP(item.address))) throw new Error('Invalid DNS response');
    return records.map((item) => ({ address: item.address, family: net.isIP(item.address) }));
}

// 保留原始 Host 和 HTTPS 证书校验，仅用已验证的地址建立连接；不会二次解析 DNS。
export async function requestPinned({ url, addresses }, headers, signal) {
    signal?.throwIfAborted();
    return await new Promise((resolve, reject) => {
        const request = (new URL(url).protocol === 'https:' ? https : http).request(url, {
            method: 'GET', headers: Object.fromEntries(headers.entries()), signal,
            lookup(host, options, callback) {
                const candidates = options.family ? addresses.filter((item) => item.family === options.family) : addresses;
                if (!candidates.length) return callback(new Error('No validated IP address for this family'));
                if (options.all) callback(null, candidates);
                else callback(null, candidates[0].address, candidates[0].family);
            },
            // 每个请求的地址校验独立，避免连接池复用未经本次校验的旧地址。
            agent: false,
        }, (response) => {
            const responseHeaders = new Headers();
            for (let i = 0; i < response.rawHeaders.length; i += 2) responseHeaders.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
            const encoding = responseHeaders.get('content-encoding')?.toLowerCase();
            const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null;
            if (decoder) pipeline(response, decoder, () => {});
            resolve({ status: response.statusCode, headers: responseHeaders, body: Readable.toWeb(decoder || response, {
                strategy: { highWaterMark: 64 * 1024, size: (chunk) => chunk.byteLength },
            }) });
        });
        request.once('error', reject);
        request.end();
    });
}

export function isPrivateAddress(address) {
    const family = net.isIP(address);
    if (family === 4) return isPrivateIPv4(address);
    if (family !== 6) return true;
    try {
        const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
        const [left, right] = canonical.split('::');
        const first = left ? left.split(':') : [];
        const last = right ? right.split(':') : [];
        const words = (right === undefined ? first : [...first, ...Array(8 - first.length - last.length).fill('0'), ...last]).map((word) => parseInt(word, 16));
        if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
            return isPrivateIPv4(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
        }
        // 默认仅放行全球单播；回环、未指定、ULA、链路本地 /10、多播和转换前缀均拒绝。
        return (words[0] & 0xe000) !== 0x2000 || words[0] === 0x2002 || (words[0] === 0x2001 && words[1] === 0);
    } catch { return true; }
}

function isPrivateIPv4(address) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) || a >= 224;
}
