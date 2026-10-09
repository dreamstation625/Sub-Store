import { expect } from 'chai';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { describe, it } from 'mocha';

const backendPath = path.resolve(__dirname, '../../..');

async function closeChild(child) {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
}

describe('WSS relay standalone bundle compatibility', function () {
    this.timeout(45000);

    it('preserves relay fetching, per-item cache controls and inherited Mihomo flow headers', async function () {
        const build = spawnSync(process.execPath, ['bundle-esbuild.js'], {
            cwd: backendPath,
            encoding: 'utf8',
        });
        expect(build.status, build.stderr).to.equal(0);

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-store-relay-smoke-'));
        let backend;
        let client;
        let resourceGets = 0;
        const flowInfo = 'upload=1; download=2; total=1024; expire=4102444800';
        const resource = http.createServer((request, response) => {
            if (request.method === 'GET') resourceGets += 1;
            response.setHeader('subscription-userinfo', flowInfo);
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
            backend = spawn(process.execPath, ['dist/sub-store.bundle.js'], {
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
            });

            async function request(route, method = 'GET', body, token) {
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
        } finally {
            await closeChild(client);
            await closeChild(backend);
            if (resource.listening) await new Promise((resolve) => resource.close(resolve));
            if (portServer.listening) await new Promise((resolve) => portServer.close(resolve));
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
