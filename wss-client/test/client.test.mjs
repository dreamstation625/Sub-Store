import assert from 'node:assert/strict';
import test from 'node:test';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { isPrivateAddress, readConfig, RelayClient, requestPinned, withAbort } from '../src/client.js';
import { cert, key } from './tls-fixture.mjs';

// 不使用真实订阅或公网；网络验证只访问当前测试创建的回环服务器。
function fixture(overrides = {}) {
    const client = new RelayClient({
        wssUrl: 'ws://relay.test/ws/relay', token: 'relay-secret', clientId: 'test', clientName: 'Test',
        maxBodyBytes: 5 * 1024 * 1024, defaultTimeoutMs: 1000, maxRedirects: 3,
        allowedProtocols: ['http:', 'https:'], allowedHosts: [], allowPrivateNetwork: true,
        reconnectMinMs: 10000, reconnectMaxMs: 10000, ...overrides,
    }, { handleSignals: false });
    client.log = client.error = () => {};
    const messages = [];
    const ws = { readyState: WebSocket.OPEN, bufferedAmount: 0,
        send: (text) => messages.push(JSON.parse(text)), close() { this.readyState = WebSocket.CLOSED; } };
    client.ws = ws;
    return { client, ws, messages };
}

async function server(t, handler) {
    const instance = http.createServer(handler);
    await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        instance.closeAllConnections();
        await new Promise((resolve) => instance.close(resolve));
    });
    return `http://127.0.0.1:${instance.address().port}`;
}

async function until(predicate, timeout = 1500) {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
        assert.ok(Date.now() < deadline, 'condition timed out');
        await delay(5);
    }
}

test('IPv4 / IPv6 内网、映射、链路本地和转换前缀不能绕过校验', () => {
    for (const address of ['127.0.0.1', '10.2.3.4', '100.64.0.1', '169.254.169.254', '172.31.1.2',
        '192.168.1.1', '::', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1',
        '0:0:0:0:0:ffff:a00:1', 'fe80::1', 'fe90::1', 'febf::1', 'fd00::1', 'fc00::1',
        'ff02::1', '64:ff9b::7f00:1', '2002:7f00:1::', '2001:0::1', 'invalid']) {
        assert.equal(isPrivateAddress(address), true, address);
    }
    for (const address of ['8.8.8.8', '1.1.1.1', '::ffff:808:808', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
        assert.equal(isPrivateAddress(address), false, address);
    }
});

test('实际连接只使用已校验地址，不进行第二次 DNS 解析，保留原 Host', async (t) => {
    let receivedHost;
    const url = await server(t, (req, res) => { receivedHost = req.headers.host; res.end('pinned'); });
    let lookups = 0;
    t.mock.method(dns, 'lookup', () => { lookups++; throw new Error('unexpected second lookup'); });
    const target = new URL(url);
    target.hostname = 'validated.test';
    const response = await requestPinned({ url: target.href, addresses: [{ address: '127.0.0.1', family: 4 }] }, new Headers());
    const { client } = fixture();
    assert.equal(await client.readLimitedText(response), 'pinned');
    assert.equal(receivedHost, target.host);
    assert.equal(lookups, 0);
});

test('混合公网/内网 DNS 记录整体拒绝，可信主机豁免保持兼容', async (t) => {
    t.mock.method(dnsPromises, 'lookup', async () => [{ address: '8.8.8.8' }, { address: '127.0.0.1' }]);
    const { client } = fixture({ allowPrivateNetwork: false });
    await assert.rejects(client.normalizeFetchUrl('http://mixed.test/sub'), /private network/);
    client.config.allowedHosts = ['mixed.test'];
    assert.equal((await client.normalizeFetchUrl('http://mixed.test/sub')).addresses.length, 2);
});

test('固定 IP 的 HTTPS 仍校验原域名证书，错误域名或不可信证书不能通过', async (t) => {
    let host, servername;
    const instance = https.createServer({ key, cert }, (req, res) => {
        host = req.headers.host; servername = req.socket.servername; res.end('secure');
    });
    instance.on('tlsClientError', () => {});
    await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        instance.closeAllConnections();
        await new Promise((resolve) => instance.close(resolve));
    });
    const target = { url: `https://validated.test:${instance.address().port}/sub`, addresses: [{ address: '127.0.0.1', family: 4 }] };
    await assert.rejects(requestPinned(target, new Headers()), /self-signed certificate/);
    // 仅此测试信任虚构证书；生产请求没有 ca 或 rejectUnauthorized 豁免。
    const original = https.request;
    t.mock.method(https, 'request', (url, options, callback) => original(url, { ...options, ca: cert }, callback));
    const { client } = fixture();
    const response = await requestPinned(target, new Headers());
    assert.equal(await client.readLimitedText(response), 'secure');
    assert.equal(host, new URL(target.url).host);
    assert.equal(servername, 'validated.test');
    await assert.rejects(requestPinned({ ...target, url: target.url.replace('validated.test', 'wrong.test') }, new Headers()), /does not match certificate/);
});

test('IPv6 URL 去除括号再校验，不把字面地址送给 DNS', async (t) => {
    t.mock.method(dnsPromises, 'lookup', () => { throw new Error('DNS must not run'); });
    const { client } = fixture({ allowPrivateNetwork: false });
    const target = await client.normalizeFetchUrl('https://[2606:4700:4700::1111]/sub');
    assert.deepEqual(target.addresses, [{ address: '2606:4700:4700::1111', family: 6 }]);
    await assert.rejects(client.normalizeFetchUrl('http://[::ffff:7f00:1]/sub'), /private network/);
});

test('DNS 挂起也受任务超时限制', async (t) => {
    t.mock.method(dnsPromises, 'lookup', () => new Promise(() => {}));
    const { client } = fixture();
    const start = Date.now();
    const result = await client.handleFetch({ url: 'http://hanging.test/sub', timeout: 30 });
    assert.equal(result.ok, false);
    assert.match(result.error.message, /timeout/);
    assert.ok(Date.now() - start < 1000);
});

test('跨源跳转删除凭据头、释放未结束的旧响应，并保留普通请求头', async (t) => {
    let headers, redirectClosed = false;
    const destination = await server(t, (req, res) => { headers = req.headers; res.end('redirected'); });
    const origin = await server(t, (req, res) => {
        res.writeHead(302, { location: destination });
        res.write('unfinished redirect body');
        res.on('close', () => { redirectClosed = true; });
    });
    const { client } = fixture();
    const result = await client.handleFetch({ url: origin, headers: {
        authorization: 'Bearer test-secret', cookie: 'sid=test', 'x-api-key': 'test-key',
        'x-access-token': 'test-token', host: 'wrong.test', 'x-normal': 'keep',
    } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.body, 'redirected');
    for (const name of ['authorization', 'cookie', 'x-api-key', 'x-access-token']) assert.equal(headers[name], undefined);
    assert.equal(headers['x-normal'], 'keep');
    assert.equal(headers.host, new URL(destination).host);
    await until(() => redirectClosed);
});

test('同源跳转保留凭据，maxRedirects=0 确实禁止跳转', async (t) => {
    let auth, targetGets = 0;
    const origin = await server(t, (req, res) => {
        if (req.url === '/target') { targetGets++; auth = req.headers.authorization; res.end('ok'); }
        else { res.writeHead(302, { location: '/target' }); res.end(); }
    });
    const { client } = fixture();
    assert.equal((await client.handleFetch({ url: origin, headers: { authorization: 'Bearer test' } })).ok, true);
    assert.equal(auth, 'Bearer test');
    client.config.maxRedirects = 0;
    const result = await client.handleFetch({ url: origin });
    assert.equal(result.ok, false);
    assert.match(result.error.message, /too many redirects: 0/);
    assert.equal(targetGets, 1);
});

for (const [encoding, compress] of [['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]]) {
    test(`${encoding} 解压内容正确，按解压后的字节数限制大小`, async (t) => {
        const body = '中文🐉\n'.repeat(2000);
        const origin = await server(t, (req, res) => { res.setHeader('content-encoding', encoding); res.end(compress(body)); });
        const { client } = fixture();
        const success = await client.handleFetch({ url: origin });
        assert.equal(success.ok, true, JSON.stringify(success));
        assert.equal(success.body, body);
        const tooLarge = await client.handleFetch({ url: origin, maxBodyBytes: 100 });
        assert.equal(tooLarge.ok, false);
        assert.match(tooLarge.error.message, /exceeds 100 bytes/);
    });
}

test('损坏的压缩响应返回失败，不产生未处理异常', async (t) => {
    const origin = await server(t, (req, res) => { res.setHeader('content-encoding', 'gzip'); res.end('not gzip'); });
    const { client } = fixture();
    assert.equal((await client.handleFetch({ url: origin })).ok, false);
});

test('读响应阶段超时会取消实际 HTTP 连接', async (t) => {
    let closed = false;
    const origin = await server(t, (req, res) => {
        res.write('never finishes'); res.on('close', () => { closed = true; });
    });
    const { client } = fixture();
    const result = await client.handleFetch({ url: origin, timeout: 40 });
    assert.equal(result.ok, false);
    await until(() => closed);
});

test('并发与排队有上限，断线取消所有在途 HTTP 和未开始任务', async (t) => {
    let started = 0, closed = 0;
    const origin = await server(t, (req, res) => { started++; res.write('waiting'); res.on('close', () => { closed++; }); });
    const { client, ws, messages } = fixture({ maxConcurrentFetches: 2, maxQueuedFetches: 2 });
    t.after(() => client.shutdown());
    for (let i = 0; i < 6; i++) await client.onMessage(ws, { data: JSON.stringify({ type: 'fetch', id: `job-${i}`, url: origin }) });
    await until(() => started === 2);
    assert.equal(client.activeCount, 2);
    assert.equal(client.queue.length, 2);
    assert.equal(messages.filter((m) => m.error?.message === 'Client fetch queue is full').length, 2);
    client.retireConnection(ws, 'test disconnect');
    await until(() => closed === 2 && client.activeCount === 0);
    assert.equal(started, 2);
    assert.equal(client.queue.length, 0);
    assert.equal(client.tasks.size, 0);
    assert.equal(messages.filter((m) => m.ok === true).length, 0);
});

test('排队超时不再发起 HTTP，重复任务 ID 不重复抓取', async (t) => {
    let gets = 0;
    const origin = await server(t, (req, res) => { gets++; res.write('waiting'); });
    const { client, ws, messages } = fixture({ maxConcurrentFetches: 1, maxQueuedFetches: 1 });
    t.after(() => client.shutdown());
    const emit = (id, timeout = 1000) => client.onMessage(ws, { data: JSON.stringify({ type: 'fetch', id, url: origin, timeout }) });
    await emit('running'); await emit('running'); await emit('queued', 30);
    await until(() => messages.some((m) => m.id === 'queued'));
    assert.match(messages.find((m) => m.id === 'queued').error.message, /timeout while queued/);
    assert.equal(gets, 1);
    assert.equal(client.queue.length, 0);
});

test('无 pong 的半开连接主动退役并安排重连；握手不重置退避', async (t) => {
    const { client, ws, messages } = fixture({ heartbeatIntervalMs: 10, pongTimeoutMs: 25 });
    t.after(() => client.shutdown());
    client.reconnectAttempt = 3;
    client.onOpen(ws);
    assert.equal(client.reconnectAttempt, 3);
    await until(() => client.ws === null);
    assert.ok(client.reconnectTimer);
    assert.equal(client.reconnectAttempt, 4);
    assert.equal(messages.filter((m) => m.type === 'ping').length, 1);
    assert.equal(client.heartbeatTimer, null);
});

test('收到 pong 后维持连接并重置退避，旧连接事件不能关闭新连接', async (t) => {
    const { client, ws } = fixture({ heartbeatIntervalMs: 1000, pongTimeoutMs: 1000 });
    t.after(() => client.shutdown());
    client.reconnectAttempt = 3;
    client.onOpen(ws);
    await client.onMessage(ws, { data: '{"type":"pong"}' });
    assert.equal(client.pongTimer, null);
    assert.equal(client.reconnectAttempt, 0);
    client.onClose({ close() {} }, { code: 1006 });
    assert.equal(client.ws, ws);
    assert.equal(client.reconnectTimer, null);
});

test('握手挂起也会超时重连', async (t) => {
    const { client } = fixture({ connectTimeoutMs: 25 });
    client.ws = null;
    class HangingSocket { addEventListener() {} close() {} }
    const originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = HangingSocket;
    t.after(() => { globalThis.WebSocket = originalWebSocket; });
    t.after(() => client.shutdown());
    client.start();
    await until(() => client.ws === null);
    assert.ok(client.reconnectTimer);
    assert.equal(client.connectTimer, null);
});

test('发送抛错不会冒泡或泄漏心跳定时器', (t) => {
    const { client, ws } = fixture();
    t.after(() => client.shutdown());
    ws.send = () => { throw new Error('socket send failed'); };
    assert.doesNotThrow(() => client.onOpen(ws));
    assert.equal(client.ws, null);
    assert.equal(client.heartbeatTimer, null);
    assert.ok(client.reconnectTimer);
});

test('真实 WebSocket 握手成功但不响应心跳时，自动再次连接', async (t) => {
    const sockets = new Set();
    let connections = 0;
    const relay = http.createServer();
    relay.on('upgrade', (req, socket) => {
        connections++;
        sockets.add(socket);
        socket.on('error', () => {});
        socket.on('close', () => sockets.delete(socket));
        const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        // 故意不回应应用层 ping，模拟握手成功后失去服务能力的连接。
    });
    await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));
    const { client } = fixture({ wssUrl: `ws://127.0.0.1:${relay.address().port}/ws/relay`,
        heartbeatIntervalMs: 10, pongTimeoutMs: 30, reconnectMinMs: 10, reconnectMaxMs: 10 });
    client.ws = null;
    t.after(async () => {
        client.shutdown();
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => relay.close(resolve));
    });
    client.start();
    await until(() => connections >= 2);
    assert.ok(client.reconnectAttempt >= 1);
});

test('跳转后的 DNS 也受原超时限制，不能重新得到完整超时', async (t) => {
    t.mock.method(dnsPromises, 'lookup', () => new Promise(() => {}));
    const origin = await server(t, async (req, res) => {
        await delay(30);
        res.writeHead(302, { location: 'http://hanging.test/sub' }); res.end();
    });
    const { client } = fixture();
    const start = Date.now();
    const result = await client.handleFetch({ url: origin, timeout: 60 });
    assert.equal(result.ok, false);
    assert.match(result.error.message, /timeout/);
    assert.ok(Date.now() - start < 500);
});

test('小响应解码保持 fetch 的 UTF-8 BOM 行为', async (t) => {
    const origin = await server(t, (req, res) => res.end(Buffer.from('\ufeff中文🐉', 'utf8')));
    const { client } = fixture();
    assert.equal((await client.handleFetch({ url: origin })).body, '中文🐉');
});

test('回传背压期间超时和取消生效，不发送成功结束帧', async (t) => {
    const { client, ws, messages } = fixture();
    t.after(() => client.shutdown());
    ws.bufferedAmount = 2 * 1024 * 1024;
    await assert.rejects(client.sendFetchResult(ws, { id: 'backpressure', responseChunkBytes: 128 * 1024 },
        { ok: true, body: 'x'.repeat(600 * 1024) }, { deadline: Date.now() + 25 }), /transfer timeout/);
    assert.equal(messages.some((m) => m.type === 'fetch-result-end'), false);
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await assert.rejects(client.sendFetchResult(ws, { id: 'small' }, { ok: true, body: 'small' },
        { signal: controller.signal }), /cancelled/);
    assert.equal(messages.some((m) => m.id === 'small'), false);
});

test('配置支持零跳转 / 零排队，非法数值回退，重连最大值不能小于最小值', (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wss-client-config-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ wssUrl: 'ws://relay.test/', token: 'test', maxRedirects: 0,
        maxQueuedFetches: 0, reconnectMinMs: 50, reconnectMaxMs: 10, maxConcurrentFetches: '4junk',
        allowedHosts: [' TEST.LOCAL ', '[::1]', 3], pongTimeoutMs: 2147483648 }));
    const config = readConfig(file);
    assert.equal(config.maxRedirects, 0); assert.equal(config.maxQueuedFetches, 0);
    assert.equal(config.reconnectMaxMs, 50); assert.equal(config.maxConcurrentFetches, 4);
    assert.equal(config.pongTimeoutMs, 10000);
    assert.deepEqual(config.allowedHosts, ['test.local', '::1']);
    fs.writeFileSync(file, '{"wssUrl":"ws://relay.test","token":123}');
    assert.throws(() => readConfig(file), /token must be/);
});

test('普通和错误日志均包含毫秒级 UTC 时间，保留客户端标识和消息', (t) => {
    const { client } = fixture();
    const logs = [], errors = [];
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-10T12:30:45.123Z') });
    t.mock.method(console, 'log', (message) => logs.push(message));
    t.mock.method(console, 'error', (message) => errors.push(message));
    RelayClient.prototype.log.call(client, 'connected');
    RelayClient.prototype.error.call(client, 'connection closed code=1006');
    assert.deepEqual(logs, ['[2026-10-10T12:30:45.123Z] [sub-store-wss-client] connected']);
    assert.deepEqual(errors, ['[2026-10-10T12:30:45.123Z] [sub-store-wss-client] connection closed code=1006']);
    t.mock.timers.tick(1500);
    RelayClient.prototype.log.call(client, 'reconnecting');
    assert.equal(logs[1], '[2026-10-10T12:30:46.623Z] [sub-store-wss-client] reconnecting');
});

test('日志默认隐藏路径、所有查询值及 URL 凭据，错误中的 token 也脱敏', () => {
    const { client } = fixture();
    const input = 'https://user:password@example.test/path-secret?access_token=query-secret&key=other-secret#hash-secret';
    const masked = client.maskUrl(input);
    for (const value of ['user', 'password', 'path-secret', 'query-secret', 'other-secret', 'hash-secret']) assert.ok(!masked.includes(value));
    assert.equal(client.maskUrl('bad secret URL'), '[invalid URL]');
    const error = client.safeError(new Error(`failed ${input} relay-secret\nnext line`));
    assert.ok(!error.includes('path-secret')); assert.ok(!error.includes('relay-secret')); assert.ok(!error.includes('\n'));
    client.config.logUrlPaths = true;
    assert.ok(client.maskUrl(input).includes('/path-secret'));
    assert.ok(!client.maskUrl(input).includes('query-secret'));
});

test('已取消时仍消费底层拒绝，不产生 unhandledRejection', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await assert.rejects(withAbort(Promise.reject(new Error('underlying failure')), controller.signal), /cancelled/);
    await delay(10);
});
