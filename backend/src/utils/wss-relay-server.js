import { Buffer } from 'buffer';
import $ from '@/core/app';

const MAX_FRAME_BYTES = 512 * 1024;
const MAX_BUFFER_BYTES = 1024 * 1024;
const MAX_CLIENTS = 128;

const clients = new Map();
const pending = new Map();
let relayServerStarted = false;

export function startWssRelayServer(server, { path = '/ws/relay' } = {}) {
    if (!$.env.isNode || !server || relayServerStarted) return;

    const token = getRelayToken();
    if (!token) {
        $.warn('[WSS RELAY] disabled: wssRelayToken or SUB_STORE_WSS_RELAY_TOKEN is required');
        return;
    }

    relayServerStarted = true;
    const crypto = eval('require("crypto")');

    server.on('upgrade', (req, socket) => {
        try {
            const url = new URL(req.url, 'http://127.0.0.1');
            if (url.pathname !== path) return;

            if (!safeTokenEqual(url.searchParams.get('token'), getRelayToken())) {
                rejectUpgrade(socket, 401, 'Unauthorized');
                return;
            }

            if (clients.size >= MAX_CLIENTS) {
                rejectUpgrade(socket, 503, 'Too Many Clients');
                return;
            }

            const key = req.headers['sec-websocket-key'];
            if (!key) {
                rejectUpgrade(socket, 400, 'Bad Request');
                return;
            }

            const accept = crypto
                .createHash('sha1')
                .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
                .digest('base64');
            socket.write(
                'HTTP/1.1 101 Switching Protocols\r\n' +
                    'Upgrade: websocket\r\n' +
                    'Connection: Upgrade\r\n' +
                    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
            );

            registerSocket(socket, {
                clientId: url.searchParams.get('clientId') || '',
                clientName: url.searchParams.get('clientName') || '',
                remoteAddress: req.socket.remoteAddress,
            });
        } catch (error) {
            $.error(`[WSS RELAY] upgrade failed: ${error.message ?? error}`);
            socket.destroy();
        }
    });

    $.info(`[WSS RELAY] listening on ${path}`);
}

export function listWssRelayClients({ includeSensitive = false } = {}) {
    return Array.from(clients.values()).map((client) => {
        const result = {
            id: client.id,
            name: client.name,
            connectedAt: client.connectedAt,
            lastSeenAt: client.lastSeenAt,
            capabilities: client.capabilities,
            maxBodyBytes: client.maxBodyBytes,
            pendingCount: Array.from(pending.values()).filter(
                (item) => item.clientId === client.id,
            ).length,
        };
        if (includeSensitive) result.remoteAddress = client.remoteAddress;
        return result;
    });
}

export function isWssRelayAdminRequest(req) {
    const token = getRelayAdminToken();
    if (!token) return false;
    return safeTokenEqual(getRequestToken(req), token);
}

export async function fetchViaWssClient(clientId, request) {
    if (!$.env.isNode) {
        throw new Error('WSS relay only supports Node backend runtime');
    }

    const client = clients.get(clientId);
    if (!client) throw new Error(`WSS relay client not connected: ${clientId}`);

    const timeoutMs = normalizePositiveInteger(request.timeout, 15000);
    const id = createRequestId();
    const payload = {
        type: 'fetch',
        id,
        url: request.url,
        uac: request.uac,
        headers: request.headers,
        timeout: timeoutMs,
    };

    return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`WSS relay request timeout: ${clientId}`));
        }, timeoutMs + 1000);

        pending.set(id, { clientId, resolve, reject, timeout });

        try {
            sendJson(client.socket, payload);
        } catch (error) {
            clearTimeout(timeout);
            pending.delete(id);
            reject(error);
        }
    });
}

function registerSocket(socket, initialMeta) {
    const initialClientId = initialMeta.clientId || createRequestId();
    if (clients.has(initialClientId)) {
        $.warn(`[WSS RELAY] duplicate client id rejected: ${initialClientId}`);
        socket.end();
        return;
    }

    let buffer = Buffer.alloc(0);
    const client = {
        id: initialClientId,
        name: initialMeta.clientName || initialClientId,
        remoteAddress: initialMeta.remoteAddress,
        connectedAt: Date.now(),
        lastSeenAt: Date.now(),
        capabilities: [],
        maxBodyBytes: undefined,
        socket,
    };

    clients.set(client.id, client);
    $.info(`[WSS RELAY] client connected: ${client.id} ${client.remoteAddress || ''}`);

    socket.on('data', (chunk) => {
        try {
            buffer = Buffer.concat([buffer, chunk]);
            if (buffer.length > MAX_BUFFER_BYTES) {
                throw new Error(`WebSocket buffer exceeds ${MAX_BUFFER_BYTES} bytes`);
            }
            while (true) {
                const frame = readFrame(buffer);
                if (!frame) break;
                buffer = buffer.subarray(frame.consumed);
                handleFrame(client, frame);
            }
        } catch (error) {
            $.error(`[WSS RELAY] client ${client.id} frame error: ${error.message ?? error}`);
            socket.destroy();
        }
    });

    socket.on('close', () => unregisterClient(client.id));
    socket.on('error', (error) => {
        $.error(`[WSS RELAY] client ${client.id} socket error: ${error.message ?? error}`);
        unregisterClient(client.id);
    });
}

function handleFrame(client, frame) {
    client.lastSeenAt = Date.now();

    if (frame.opcode === 0x8) {
        client.socket.end();
        return;
    }
    if (frame.opcode === 0x9) {
        sendFrame(client.socket, frame.payload, 0xA);
        return;
    }
    if (frame.opcode !== 0x1) return;

    let message;
    try {
        message = JSON.parse(frame.payload.toString('utf8'));
    } catch (error) {
        $.error(`[WSS RELAY] invalid json from ${client.id}: ${error.message ?? error}`);
        return;
    }

    if (message.type === 'hello') {
        const oldId = client.id;
        const nextId = message.clientId || client.id;
        if (nextId !== oldId && clients.has(nextId)) {
            $.warn(`[WSS RELAY] duplicate client id rejected: ${nextId}`);
            client.socket.end();
            return;
        }
        client.id = nextId;
        client.name = message.clientName || client.id;
        client.capabilities = Array.isArray(message.capabilities)
            ? message.capabilities
            : [];
        client.maxBodyBytes = normalizePositiveInteger(message.maxBodyBytes, undefined);
        if (oldId !== client.id) {
            clients.delete(oldId);
            clients.set(client.id, client);
        }
        $.info(`[WSS RELAY] client registered: ${client.id} ${client.name}`);
        return;
    }

    if (message.type === 'ping') {
        sendJson(client.socket, { type: 'pong', time: Date.now() });
        return;
    }

    if (message.type === 'fetch-result') {
        settleFetchResult(client, message);
    }
}

function settleFetchResult(client, message) {
    const item = pending.get(message.id);
    if (!item) return;
    if (item.clientId !== client.id) {
        item.reject(new Error(`WSS relay response client mismatch: ${client.id}`));
    } else if (message.ok) {
        item.resolve({
            statusCode: message.statusCode || 200,
            headers: message.headers || {},
            body: message.body || '',
        });
    } else {
        item.reject(new Error(message.error?.message || 'WSS relay fetch failed'));
    }
    clearTimeout(item.timeout);
    pending.delete(message.id);
}

function unregisterClient(clientId) {
    if (!clients.has(clientId)) return;
    clients.delete(clientId);
    for (const [id, item] of pending.entries()) {
        if (item.clientId !== clientId) continue;
        clearTimeout(item.timeout);
        item.reject(new Error(`WSS relay client disconnected: ${clientId}`));
        pending.delete(id);
    }
    $.info(`[WSS RELAY] client disconnected: ${clientId}`);
}

function readFrame(buffer) {
    if (buffer.length < 2) return null;

    const first = buffer[0];
    const second = buffer[1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;

    if (!masked) throw new Error('Client WebSocket frames must be masked');

    if (length === 126) {
        if (buffer.length < offset + 2) return null;
        length = buffer.readUInt16BE(offset);
        offset += 2;
    } else if (length === 127) {
        if (buffer.length < offset + 8) return null;
        const high = buffer.readUInt32BE(offset);
        const low = buffer.readUInt32BE(offset + 4);
        if (high !== 0) throw new Error('WebSocket frame too large');
        length = low;
        offset += 8;
    }

    if (length > MAX_FRAME_BYTES) {
        throw new Error(`WebSocket frame exceeds ${MAX_FRAME_BYTES} bytes`);
    }

    if (buffer.length < offset + 4) return null;
    const mask = buffer.subarray(offset, offset + 4);
    offset += 4;

    if (buffer.length < offset + length) return null;

    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    for (let i = 0; i < payload.length; i++) {
        payload[i] = payload[i] ^ mask[i % 4];
    }

    return {
        opcode,
        payload,
        consumed: offset + length,
    };
}

function sendJson(socket, payload) {
    const body = Buffer.from(JSON.stringify(payload));
    if (body.length > MAX_FRAME_BYTES) {
        throw new Error(`WebSocket response exceeds ${MAX_FRAME_BYTES} bytes`);
    }
    sendFrame(socket, body, 0x1);
}

function sendFrame(socket, payload, opcode = 0x1) {
    const length = payload.length;
    let header;
    if (length < 126) {
        header = Buffer.alloc(2);
        header[1] = length;
    } else if (length < 65536) {
        header = Buffer.alloc(4);
        header[1] = 126;
        header.writeUInt16BE(length, 2);
    } else {
        header = Buffer.alloc(10);
        header[1] = 127;
        header.writeUInt32BE(0, 2);
        header.writeUInt32BE(length, 6);
    }
    header[0] = 0x80 | opcode;
    socket.write(Buffer.concat([header, payload]));
}

function getRelayToken() {
    const settings = $.read('settings') || {};
    return settings.wssRelayToken || eval('process.env.SUB_STORE_WSS_RELAY_TOKEN');
}

function getRelayAdminToken() {
    const settings = $.read('settings') || {};
    return (
        settings.wssRelayAdminToken ||
        settings.wssRelayToken ||
        eval('process.env.SUB_STORE_WSS_RELAY_ADMIN_TOKEN') ||
        eval('process.env.SUB_STORE_WSS_RELAY_TOKEN')
    );
}

function getRequestToken(req) {
    const auth = req.headers?.authorization || req.headers?.Authorization || '';
    if (auth.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim();
    return (
        req.headers?.['x-sub-store-wss-admin-token'] ||
        req.headers?.['X-Sub-Store-Wss-Admin-Token'] ||
        req.query?.token ||
        ''
    );
}

function safeTokenEqual(actual, expected) {
    if (!actual || !expected) return false;
    const actualBuffer = Buffer.from(String(actual));
    const expectedBuffer = Buffer.from(String(expected));
    if (actualBuffer.length !== expectedBuffer.length) return false;
    const crypto = eval('require("crypto")');
    return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function rejectUpgrade(socket, statusCode, message) {
    socket.write(`HTTP/1.1 ${statusCode} ${message}\r\n\r\n`);
    socket.destroy();
}

function createRequestId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function normalizePositiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

