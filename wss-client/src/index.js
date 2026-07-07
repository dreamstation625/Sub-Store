import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_UA = 'clash.meta/v1.19.25';
const DEFAULT_CONFIG_PATH = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../config.json',
);

const config = readConfig();

if (typeof WebSocket === 'undefined') {
    throw new Error('Global WebSocket is unavailable. Please use Node.js 22+.');
}

new RelayClient(config).start();

class RelayClient {
    constructor(config) {
        this.config = config;
        this.reconnectAttempt = 0;
        this.manuallyClosed = false;
        this.heartbeatTimer = null;

        process.on('SIGINT', () => this.shutdown());
        process.on('SIGTERM', () => this.shutdown());
    }

    start() {
        const wsUrl = this.buildWssUrl();
        this.log(`connecting to ${this.maskUrl(wsUrl)}`);

        const ws = new WebSocket(wsUrl);
        ws.addEventListener('open', () => this.onOpen(ws));
        ws.addEventListener('message', (event) => this.onMessage(ws, event));
        ws.addEventListener('close', (event) => this.onClose(event));
        ws.addEventListener('error', () => this.error('websocket error'));
    }

    onOpen(ws) {
        this.reconnectAttempt = 0;
        this.log('connected');

        // Register this node with the main Sub-Store service. The server can
        // use this metadata to show selectable relay nodes in the frontend.
        this.send(ws, {
            type: 'hello',
            clientId: this.config.clientId,
            clientName: this.config.clientName,
            capabilities: ['fetch'],
            maxBodyBytes: this.config.maxBodyBytes,
        });

        this.heartbeatTimer = setInterval(() => {
            this.send(ws, { type: 'ping', time: Date.now() });
        }, 30000);
    }

    onClose(event) {
        this.clearHeartbeat();
        this.log(`connection closed code=${event.code} reason=${event.reason || ''}`);
        this.scheduleReconnect();
    }

    async onMessage(ws, event) {
        const message = this.parseMessage(event.data);
        if (!message || message.type === 'pong') return;

        if (message.type !== 'fetch') {
            this.log(`ignored message type=${message.type || 'unknown'}`);
            return;
        }

        // Each fetch request is correlated by id. The main service should keep
        // a pending promise keyed by this id and resolve it with fetch-result.
        if (!message.id) {
            this.error('received fetch message without id');
            return;
        }

        const response = await this.handleFetch(message);
        this.send(ws, {
            type: 'fetch-result',
            id: message.id,
            ...response,
        });
    }

    async handleFetch(message) {
        try {
            const result = await this.fetchSubscription(message);
            return {
                ok: true,
                ...result,
            };
        } catch (error) {
            return {
                ok: false,
                error: {
                    message: error.message || String(error),
                },
            };
        }
    }

    async fetchSubscription(message) {
        let url = await this.normalizeFetchUrl(message.url);
        const timeoutMs = positiveInt(message.timeout, this.config.defaultTimeoutMs);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        const headers = this.normalizeHeaders(message.headers);
        headers.set('user-agent', message.uac || message.userAgent || DEFAULT_UA);
        if (!headers.has('accept')) headers.set('accept', '*/*');

        try {
            for (let redirectCount = 0; redirectCount <= this.config.maxRedirects; redirectCount++) {
                this.log(`fetching ${this.maskUrl(url)} timeout=${timeoutMs}`);
                const response = await fetch(url, {
                    method: 'GET',
                    headers,
                    redirect: 'manual',
                    signal: controller.signal,
                });

                if (isRedirectStatus(response.status)) {
                    const location = response.headers.get('location');
                    if (!location) throw new Error(`redirect ${response.status} missing location`);
                    if (redirectCount >= this.config.maxRedirects) {
                        throw new Error(`too many redirects: ${this.config.maxRedirects}`);
                    }
                    url = await this.normalizeFetchUrl(new URL(location, url).href);
                    continue;
                }

                const body = await this.readLimitedText(response);
                if (response.status < 200 || response.status >= 400) {
                    throw new Error(`statusCode: ${response.status}`);
                }

                return {
                    statusCode: response.status,
                    headers: Object.fromEntries(response.headers.entries()),
                    body,
                };
            }
            throw new Error('unexpected redirect loop');
        } finally {
            clearTimeout(timeout);
        }
    }

    async readLimitedText(response) {
        const reader = response.body?.getReader();
        if (!reader) return await response.text();

        const chunks = [];
        let total = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            total += value.byteLength;
            if (total > this.config.maxBodyBytes) {
                throw new Error(
                    `response body exceeds ${this.config.maxBodyBytes} bytes`,
                );
            }
            chunks.push(value);
        }

        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return new TextDecoder().decode(bytes);
    }

    async normalizeFetchUrl(rawUrl) {
        if (!rawUrl || typeof rawUrl !== 'string') {
            throw new Error('url is required');
        }

        const url = new URL(rawUrl);
        if (!this.config.allowedProtocols.includes(url.protocol)) {
            throw new Error(`unsupported url protocol: ${url.protocol}`);
        }
        await this.assertAllowedHost(url);
        return url.href;
    }

    async assertAllowedHost(url) {
        const host = url.hostname;
        if (this.config.allowedHosts.includes(host)) return;
        if (!this.config.allowPrivateNetwork) {
            const addresses = await resolveHostAddresses(host);
            const privateAddress = addresses.find(isPrivateAddress);
            if (privateAddress) {
                throw new Error(`private network address is not allowed: ${host}`);
            }
        }
    }

    normalizeHeaders(rawHeaders) {
        const headers = new Headers();
        if (!rawHeaders || typeof rawHeaders !== 'object') return headers;

        for (const [key, value] of Object.entries(rawHeaders)) {
            if (value == null) continue;
            headers.set(key, Array.isArray(value) ? value.join(', ') : String(value));
        }
        return headers;
    }

    scheduleReconnect() {
        if (this.manuallyClosed) return;

        this.reconnectAttempt += 1;
        const base = Math.min(
            this.config.reconnectMaxMs,
            this.config.reconnectMinMs * 2 ** Math.min(this.reconnectAttempt - 1, 8),
        );
        const jitter = Math.floor(Math.random() * Math.min(base, 1000));
        const delay = Math.min(this.config.reconnectMaxMs, base + jitter);

        this.log(`reconnecting in ${delay}ms`);
        setTimeout(() => this.start(), delay);
    }

    clearHeartbeat() {
        if (!this.heartbeatTimer) return;
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
    }

    shutdown() {
        this.manuallyClosed = true;
        this.clearHeartbeat();
        process.exit(0);
    }

    send(ws, payload) {
        if (ws.readyState !== WebSocket.OPEN) return false;
        ws.send(JSON.stringify(payload));
        return true;
    }

    parseMessage(data) {
        try {
            const text =
                typeof data === 'string' ? data : new TextDecoder().decode(data);
            return JSON.parse(text);
        } catch (error) {
            this.error(`invalid json message: ${error.message || error}`);
            return null;
        }
    }

    buildWssUrl() {
        const url = new URL(this.config.wssUrl);
        if (!['ws:', 'wss:'].includes(url.protocol)) {
            throw new Error('wssUrl must start with ws:// or wss://');
        }

        // Node's built-in WebSocket does not expose custom request headers, so
        // token auth is passed as query data for the server to validate.
        const params = {
            token: this.config.token,
            clientId: this.config.clientId,
            clientName: this.config.clientName,
        };
        for (const [key, value] of Object.entries(params)) {
            if (value) url.searchParams.set(key, value);
        }
        return url.href;
    }

    maskUrl(rawUrl) {
        try {
            const url = new URL(rawUrl);
            if (url.searchParams.has('token')) {
                url.searchParams.set('token', '***');
            }
            if (url.username) url.username = '***';
            if (url.password) url.password = '***';
            return url.href;
        } catch {
            return rawUrl;
        }
    }

    log(message) {
        console.log(`[sub-store-wss-client] ${message}`);
    }

    error(message) {
        console.error(`[sub-store-wss-client] ${message}`);
    }
}

function readConfig() {
    const configPath = path.resolve(process.argv[2] || DEFAULT_CONFIG_PATH);
    if (!fs.existsSync(configPath)) {
        throw new Error(
            `Config file not found: ${configPath}. Copy config.example.json to config.json first.`,
        );
    }

    const rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const clientId = rawConfig.clientId || hostnameFallback();

    return {
        wssUrl: requiredConfig(rawConfig, 'wssUrl', configPath),
        token: requiredConfig(rawConfig, 'token', configPath),
        clientId,
        clientName: rawConfig.clientName || clientId,
        maxBodyBytes: positiveInt(rawConfig.maxBodyBytes, 5 * 1024 * 1024),
        defaultTimeoutMs: positiveInt(rawConfig.fetchTimeoutMs, 15000),
        reconnectMinMs: positiveInt(rawConfig.reconnectMinMs, 1000),
        reconnectMaxMs: positiveInt(rawConfig.reconnectMaxMs, 30000),
        allowedProtocols: Array.isArray(rawConfig.allowedProtocols)
            ? rawConfig.allowedProtocols
            : ['https:'],
        allowedHosts: Array.isArray(rawConfig.allowedHosts)
            ? rawConfig.allowedHosts
            : [],
        allowPrivateNetwork: rawConfig.allowPrivateNetwork === true,
        maxRedirects: positiveInt(rawConfig.maxRedirects, 3),
    };
}

function requiredConfig(config, key, configPath) {
    const value = config[key];
    if (!value) throw new Error(`${key} is required in ${configPath}`);
    return value;
}

function positiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function hostnameFallback() {
    return os.hostname() || 'sub-store-wss-client';
}

async function resolveHostAddresses(host) {
    if (net.isIP(host)) return [host];
    const records = await dns.lookup(host, { all: true, verbatim: true });
    return records.map((record) => record.address);
}

function isRedirectStatus(status) {
    return [301, 302, 303, 307, 308].includes(status);
}

function isPrivateAddress(address) {
    const family = net.isIP(address);
    if (family === 4) return isPrivateIPv4(address);
    if (family === 6) {
        const mapped = address.match(/^::ffff:(\\d+\\.\\d+\\.\\d+\\.\\d+)$/i);
        if (mapped) return isPrivateIPv4(mapped[1]);
        return isPrivateIPv6(address);
    }
    return true;
}

function isPrivateIPv4(address) {
    const parts = address.split('.').map((part) => Number.parseInt(part, 10));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
        return true;
    }
    const [a, b] = parts;
    return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        a >= 224
    );
}

function isPrivateIPv6(address) {
    const normalized = address.toLowerCase();
    return (
        normalized === '::1' ||
        normalized === '::' ||
        normalized.startsWith('fc') ||
        normalized.startsWith('fd') ||
        normalized.startsWith('fe80:') ||
        normalized.startsWith('ff')
    );
}

