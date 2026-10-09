import { expect } from 'chai';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { describe, it } from 'mocha';

const backendPath = path.resolve(__dirname, '../../..');

async function closeChild(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
}

describe('WSS relay standalone bundle compatibility', function () {
    this.timeout(60000);

    it('preserves relay fetching, per-item cache controls and inherited Mihomo flow headers', async function () {
        const build = spawnSync(process.execPath, ['bundle-esbuild.js'], {
            cwd: backendPath,
            encoding: 'utf8',
        });
        expect(build.status, build.stderr).to.equal(0);

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-store-relay-smoke-'));
        let backend;
        let client;
        let secondClient;
        let protocolClient;
        let resourceGets = 0;
        let cacheBody = 'local-route-body';
        const largeBodies = {
            '/large-ascii': 'x'.repeat(600 * 1024),
            '/large-unicode': '远端🐉\n"\\'.repeat(75000),
            '/large-limit': 'x'.repeat(5 * 1024 * 1024),
            '/large-over-limit': 'x'.repeat(5 * 1024 * 1024 + 1),
        };
        const flowInfo = 'upload=1; download=2; total=1024; expire=4102444800';
        const resource = http.createServer((request, response) => {
            if (request.method === 'GET') resourceGets += 1;
            response.setHeader('subscription-userinfo', flowInfo);
            if (largeBodies[request.url]) return response.end(largeBodies[request.url]);
            if (request.url === '/cache') return response.end(cacheBody);
            response.end('proxies:\n  - {name: Relay Smoke, type: ss, server: ss.example.com, port: 8388, cipher: aes-128-gcm, password: test-only}\n');
        });
        const portServer = http.createServer();
        try {
            await new Promise((resolve) => resource.listen(0, '127.0.0.1', resolve));
            await new Promise((resolve) => portServer.listen(0, '127.0.0.1', resolve));
            const port = portServer.address().port;
            await new Promise((resolve) => portServer.close(resolve));
            const baseUrl = `http://127.0.0.1:${port}/backend`;
            const sourceUrl = `http://127.0.0.1:${resource.address().port}/subscription`;
            const backendOptions = {
                cwd: backendPath,
                env: {
                    ...process.env,
                    SUB_STORE_BACKEND_API_HOST: '127.0.0.1',
                    SUB_STORE_BACKEND_API_PORT: `${port}`,
                    SUB_STORE_DATA_BASE_PATH: tempDir,
                    SUB_STORE_BACKEND_PREFIX: 'true',
                    SUB_STORE_BACKEND_MERGE: '',
                    SUB_STORE_FRONTEND_BACKEND_PATH: '/backend',
                    SUB_STORE_CORS_ALLOWED_ORIGINS: 'http://merge-smoke.local',
                    SUB_STORE_PUSH_SERVICE: '',
                },
                stdio: 'ignore',
            };
            backend = spawn(process.execPath, ['dist/sub-store.bundle.js'], backendOptions);

            async function request(route, method = 'GET', body, token) {
                if (process.env.WSS_RELAY_TEST_TRACE) console.log(`[WSS TEST] ${method} ${route}`);
                const response = await fetch(`${baseUrl}${route}`, {
                    method,
                    headers: {
                        Origin: 'http://merge-smoke.local',
                        ...(body ? { 'Content-Type': 'application/json' } : {}),
                        ...(token ? { Authorization: `Bearer ${token}` } : {}),
                    },
                    body: body ? JSON.stringify(body) : undefined,
                    signal: AbortSignal.timeout(5000),
                });
                expect(response.status, route).to.be.within(200, 299);
                return response;
            }

            async function waitFor(check) {
                const deadline = Date.now() + 10000;
                while (Date.now() < deadline) {
                    if (await check()) return;
                    await new Promise((resolve) => setTimeout(resolve, 100));
                }
                throw new Error('Relay smoke condition did not become ready');
            }

            await waitFor(async () => {
                try {
                    return (await fetch(`${baseUrl}/api/settings`)).ok;
                } catch {
                    return false;
                }
            });
            const initialized = await (await request('/api/wss/token', 'POST', {})).json();
            const token = initialized.data.token;
            expect(token).to.be.a('string').and.not.equal('***');
            const settings = await (await request('/api/settings')).json();
            expect(settings.data.wssRelayToken).to.equal(token);

            const configPath = path.join(tempDir, 'client.json');
            fs.writeFileSync(configPath, JSON.stringify({
                wssUrl: `ws://127.0.0.1:${port}/ws/relay`,
                token,
                clientId: 'merge-smoke-node',
                clientName: 'Merge Smoke Node',
                allowedProtocols: ['http:'],
                allowPrivateNetwork: true,
            }));
            client = spawn(process.execPath, [
                path.join(backendPath, '..', 'wss-client', 'src', 'index.js'),
                configPath,
            ], { stdio: 'ignore' });
            await waitFor(async () => {
                const result = await (await request('/api/wss/clients', 'GET', undefined, token)).json();
                return result.data.some((item) => item.id === 'merge-smoke-node' && item.capabilities.includes('fetch'));
            });

            await request('/api/subs', 'POST', {
                name: 'relay-smoke-sub', source: 'remote', url: sourceUrl,
                relayNodeId: 'merge-smoke-node', noCache: true, noFlow: true, process: [],
            });
            for (let index = 0; index < 2; index++) {
                const response = await request('/download/relay-smoke-sub?target=ClashMeta');
                expect(await response.text()).to.include('Relay Smoke');
            }
            expect(resourceGets).to.equal(2);

            await request('/api/sub/relay-smoke-sub', 'PATCH', { noCache: false });
            for (let index = 0; index < 2; index++) {
                await (await request('/download/relay-smoke-sub?target=ClashMeta')).text();
            }
            expect(resourceGets).to.equal(2);

            await request('/api/files', 'POST', {
                name: 'relay-smoke-file', type: 'file', source: 'remote', url: sourceUrl,
                relayNodeId: 'merge-smoke-node', noCache: true, process: [],
            });
            for (let index = 0; index < 2; index++) {
                const response = await request('/api/file/relay-smoke-file');
                expect(await response.text()).to.include('Relay Smoke');
            }
            expect(resourceGets).to.equal(4);

            await request('/api/files', 'POST', {
                name: 'relay-smoke-mihomo', type: 'mihomoConfig', sourceType: 'remote', url: sourceUrl,
                relayNodeId: 'merge-smoke-node', noCache: true, process: [],
            });
            const mihomo = await request('/api/file/relay-smoke-mihomo');
            expect(await mihomo.text()).to.include('Relay Smoke');
            expect(mihomo.headers.get('subscription-userinfo')).to.equal(flowInfo);
            expect(resourceGets).to.equal(5);

            // 节点选择必须由后端保存；显式清除后重新查询也应保持本机状态。
            for (const [route, storedRoute] of [
                ['/api/sub/relay-smoke-sub', '/api/sub/relay-smoke-sub'],
                ['/api/file/relay-smoke-mihomo', '/api/wholeFile/relay-smoke-mihomo'],
            ]) {
                expect((await (await request(storedRoute)).json()).data.relayNodeId).to.equal('merge-smoke-node');
                await request(route, 'PATCH', { relayNodeId: '' });
                expect((await (await request(storedRoute)).json()).data.relayNodeId).to.equal('');
            }

            // 相同 URL 在本机、节点 A、节点 B 上各有自己的缓存。
            const cacheUrl = sourceUrl.replace('/subscription', '/cache');
            await request('/api/files', 'POST', {
                name: 'relay-cache-route', type: 'file', source: 'remote', url: cacheUrl, process: [],
            });
            expect(await (await request('/api/file/relay-cache-route')).text()).to.equal('local-route-body');
            cacheBody = 'node-a-route-body';
            await request('/api/file/relay-cache-route', 'PATCH', { relayNodeId: 'merge-smoke-node' });
            expect(await (await request('/api/file/relay-cache-route')).text()).to.equal('node-a-route-body');
            const secondConfigPath = path.join(tempDir, 'second-client.json');
            fs.writeFileSync(secondConfigPath, JSON.stringify({
                wssUrl: `ws://127.0.0.1:${port}/ws/relay`, token,
                clientId: 'second-smoke-node', allowedProtocols: ['http:'], allowPrivateNetwork: true,
            }));
            secondClient = spawn(process.execPath, [
                path.join(backendPath, '..', 'wss-client', 'src', 'index.js'), secondConfigPath,
            ], { stdio: 'ignore' });
            await waitFor(async () => {
                const result = await (await request('/api/wss/clients', 'GET', undefined, token)).json();
                return result.data.some((item) => item.id === 'second-smoke-node' && item.capabilities.includes('fetch-chunks-v1'));
            });
            cacheBody = 'node-b-route-body';
            await request('/api/file/relay-cache-route', 'PATCH', { relayNodeId: 'second-smoke-node' });
            expect(await (await request('/api/file/relay-cache-route')).text()).to.equal('node-b-route-body');
            const cachedGets = resourceGets;
            expect(await (await request('/api/file/relay-cache-route')).text()).to.equal('node-b-route-body');
            expect(resourceGets).to.equal(cachedGets);
            await request('/api/file/relay-cache-route', 'PATCH', { relayNodeId: '' });
            expect(await (await request('/api/file/relay-cache-route')).text()).to.equal('local-route-body');
            expect(resourceGets).to.equal(cachedGets);

            // 自定义缓存也应隔离节点，即使用户在 URL 中指定同一个 cacheKey。
            await request('/api/files', 'POST', {
                name: 'relay-custom-cache', type: 'file', source: 'remote',
                url: `${cacheUrl}#cacheKey=shared-route`, relayNodeId: 'merge-smoke-node', process: [],
            });
            expect(await (await request('/api/file/relay-custom-cache')).text()).to.equal('node-a-route-body');
            await request('/api/file/relay-custom-cache', 'PATCH', { relayNodeId: 'second-smoke-node' });
            expect(await (await request('/api/file/relay-custom-cache')).text()).to.equal('node-b-route-body');

            // 中文、emoji、引号和反斜杠不会因分块边界损坏，5 MiB 边界保持可用。
            const clientsBefore = (await (await request('/api/wss/clients', 'GET', undefined, token)).json()).data;
            const connectedAt = clientsBefore.find((item) => item.id === 'merge-smoke-node').connectedAt;
            await request('/api/files', 'POST', {
                name: 'relay-large', type: 'file', source: 'remote',
                url: sourceUrl.replace('/subscription', '/large-ascii'),
                relayNodeId: 'merge-smoke-node', noCache: true, process: [],
            });
            for (const route of ['/large-ascii', '/large-unicode', '/large-limit']) {
                await request('/api/file/relay-large', 'PATCH', { url: sourceUrl.replace('/subscription', route) });
                expect(await (await request('/api/file/relay-large')).text()).to.equal(largeBodies[route]);
            }
            await request('/api/file/relay-large', 'PATCH', { url: sourceUrl.replace('/subscription', '/large-over-limit') });
            const overLimit = await fetch(`${baseUrl}/api/file/relay-large`, { signal: AbortSignal.timeout(5000) });
            expect(overLimit.status).to.equal(500);
            await overLimit.text();
            const clientsAfter = (await (await request('/api/wss/clients', 'GET', undefined, token)).json()).data;
            expect(clientsAfter.find((item) => item.id === 'merge-smoke-node').connectedAt).to.equal(connectedAt);

            // 保留旧版单消息响应兼容；拒绝错误分块但不能让隧道断线。
            let responseMode = 'legacy';
            protocolClient = new WebSocket(`ws://127.0.0.1:${port}/ws/relay?token=${token}&clientId=protocol-smoke-node`);
            protocolClient.addEventListener('open', () => protocolClient.send(JSON.stringify({
                type: 'hello', capabilities: ['fetch', 'fetch-chunks-v1'], maxBodyBytes: 5 * 1024 * 1024,
            })));
            protocolClient.addEventListener('message', (event) => {
                const message = JSON.parse(event.data);
                if (message.type !== 'fetch') return;
                const send = (payload) => protocolClient.send(JSON.stringify({ id: message.id, ...payload }));
                if (responseMode === 'legacy') {
                    send({ type: 'fetch-result', ok: true, body: 'legacy-response', statusCode: 200 });
                    return;
                }
                send({ type: 'fetch-result-start', bodyBytes: responseMode === 'oversize' ? 5 * 1024 * 1024 + 1 : 4 });
                if (responseMode === 'oversize') return;
                send({ type: 'fetch-result-chunk', index: responseMode === 'out-of-order' ? 1 : 0, data: 'YWI=' });
                send({ type: 'fetch-result-end' });
            });
            await waitFor(async () => {
                const result = await (await request('/api/wss/clients', 'GET', undefined, token)).json();
                return result.data.some((item) => item.id === 'protocol-smoke-node' && item.capabilities.includes('fetch'));
            });
            await request('/api/files', 'POST', {
                name: 'relay-protocol', type: 'file', source: 'remote', url: sourceUrl,
                relayNodeId: 'protocol-smoke-node', noCache: true, process: [],
            });
            expect(await (await request('/api/file/relay-protocol')).text()).to.equal('legacy-response');
            for (const mode of ['oversize', 'out-of-order', 'incomplete']) {
                responseMode = mode;
                const invalid = await fetch(`${baseUrl}/api/file/relay-protocol`, { signal: AbortSignal.timeout(5000) });
                expect(invalid.status, mode).to.equal(500);
                await invalid.text();
            }
            responseMode = 'legacy';
            expect(await (await request('/api/file/relay-protocol')).text()).to.equal('legacy-response');
            protocolClient.close();

            // 使用同一临时数据目录重启服务，不依赖浏览器也能恢复 Token 和节点。
            await request('/api/file/relay-smoke-mihomo', 'PATCH', { relayNodeId: 'merge-smoke-node' });
            await closeChild(client);
            await closeChild(secondClient);
            await closeChild(backend);
            backend = spawn(process.execPath, ['dist/sub-store.bundle.js'], backendOptions);
            await waitFor(async () => {
                try { return (await fetch(`${baseUrl}/api/settings`)).ok; } catch { return false; }
            });
            expect((await (await request('/api/settings')).json()).data.wssRelayToken).to.equal(token);
            expect((await (await request('/api/sub/relay-smoke-sub')).json()).data.relayNodeId).to.equal('');
            expect((await (await request('/api/wholeFile/relay-smoke-mihomo')).json()).data.relayNodeId).to.equal('merge-smoke-node');
        } finally {
            protocolClient?.close();
            await closeChild(secondClient);
            await closeChild(client);
            await closeChild(backend);
            if (resource.listening) {
                resource.closeAllConnections();
                await new Promise((resolve) => resource.close(resolve));
            }
            if (portServer.listening) await new Promise((resolve) => portServer.close(resolve));
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
