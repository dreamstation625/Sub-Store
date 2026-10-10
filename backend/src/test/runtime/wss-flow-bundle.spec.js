import { expect } from 'chai';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { describe, it } from 'mocha';

const backendPath = path.resolve(__dirname, '../../..');

describe('direct and WSS subscription flow forwarding', function () {
    this.timeout(60000);

    it('keeps flow forwarding after cache expiry, UA changes, custom flow URLs and Mihomo inheritance', async function () {
        const build = spawnSync(process.execPath, ['bundle-esbuild.js'], { cwd: backendPath, encoding: 'utf8' });
        expect(build.status, build.stderr).to.equal(0);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-store-wss-flow-'));
        const children = [];
        let token;
        let downloadValue = 456;
        const expectedFlow = () => `upload=123; download=${downloadValue}; total=1073741824; expire=4102444800`;
        const calls = [];
        const resource = http.createServer((req, res) => {
            calls.push({ method: req.method, url: req.url, ua: req.headers['user-agent'], token: req.headers['x-flow-test'] });
            res.setHeader('Subscription-Userinfo', expectedFlow());
            res.setHeader('Profile-Web-Page-Url', 'https://panel.example.test');
            if (req.url.startsWith('/flow-body')) return res.end(expectedFlow());
            const large = req.url.includes('large') ? `# ${'x'.repeat(600 * 1024)}\n` : '';
            res.end(`${large}proxies:\n  - {name: Flow Audit, type: ss, server: ss.example.test, port: 8388, cipher: aes-128-gcm, password: test-only}\n`);
        });
        const portProbe = http.createServer();
        async function closeChild(child) {
            if (!child || child.exitCode !== null || child.signalCode !== null) return;
            const done = new Promise((resolve) => child.once('exit', resolve));
            child.kill();
            await done;
        }
        try {
            await new Promise((resolve) => resource.listen(0, '127.0.0.1', resolve));
            await new Promise((resolve) => portProbe.listen(0, '127.0.0.1', resolve));
            const port = portProbe.address().port;
            await new Promise((resolve) => portProbe.close(resolve));
            const base = `http://127.0.0.1:${port}/backend`;
            children.push(spawn(process.execPath, ['dist/sub-store.bundle.js'], {
                cwd: backendPath,
                env: { ...process.env, SUB_STORE_BACKEND_API_HOST: '127.0.0.1', SUB_STORE_BACKEND_API_PORT: String(port),
                    SUB_STORE_DATA_BASE_PATH: directory, SUB_STORE_BACKEND_PREFIX: 'true', SUB_STORE_BACKEND_MERGE: '',
                    SUB_STORE_FRONTEND_BACKEND_PATH: '/backend', SUB_STORE_PUSH_SERVICE: '',
                    SUB_STORE_BACKEND_DEFAULT_PROXY: '' },
                stdio: 'ignore',
            }));
            async function request(route, method = 'GET', body) {
                return await fetch(`${base}${route}`, {
                    method,
                    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                    body: body ? JSON.stringify(body) : undefined,
                    signal: AbortSignal.timeout(10000),
                });
            }
            async function success(route, method = 'GET', body) {
                const response = await request(route, method, body);
                expect(response.status, route).to.be.within(200, 299);
                return response;
            }
            async function waitFor(check) {
                const deadline = Date.now() + 10000;
                while (Date.now() < deadline) {
                    try { if (await check()) return; } catch { /* 服务还未就绪。 */ }
                    await new Promise((resolve) => setTimeout(resolve, 50));
                }
                throw new Error('Flow integration service did not become ready');
            }
            await waitFor(async () => (await request('/api/settings')).ok);
            token = (await (await success('/api/wss/token', 'POST', {})).json()).data.token;
            // 虚构域名仅在客户端进程解析到回环地址，确保后端不能偷偷直连成功。
            const preload = `import dns from 'node:dns/promises';const original=dns.lookup.bind(dns);dns.lookup=(host,options)=>host==='relay-only.invalid'?Promise.resolve([{address:'127.0.0.1',family:4}]):original(host,options);`;
            for (const clientId of ['flow-node-a', 'flow-node-b']) {
                const configPath = path.join(directory, `${clientId}.json`);
                fs.writeFileSync(configPath, JSON.stringify({ wssUrl: `ws://127.0.0.1:${port}/ws/relay`, token, clientId,
                    allowedProtocols: ['http:'], allowPrivateNetwork: true }));
                children.push(spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`,
                    path.join(backendPath, '../wss-client/src/index.js'), configPath], { stdio: 'ignore' }));
            }
            await waitFor(async () => (await (await request('/api/wss/clients')).json()).data?.length === 2);
            const local = `http://127.0.0.1:${resource.address().port}`;
            const remote = `http://relay-only.invalid:${resource.address().port}`;
            async function createSub(name, url, relayNodeId = '') {
                await success('/api/subs', 'POST', { name, source: 'remote', url, relayNodeId, process: [] });
            }
            async function download(name, includeWebPage = true) {
                const response = await success(`/download/${name}?target=ClashMeta`);
                expect(await response.text()).to.include('Flow Audit');
                expect(response.headers.get('subscription-userinfo'), name).to.equal(expectedFlow());
                if (includeWebPage) expect(response.headers.get('profile-web-page-url'), name).to.equal('https://panel.example.test/');
            }
            async function flowApi(name) {
                const result = await (await success(`/api/sub/flow/${name}`)).json();
                expect(result.status).to.equal('success');
                expect(result.data.usage).to.deep.equal({ upload: 123, download: downloadValue });
                expect(result.data.total).to.equal(1073741824);
            }
            for (const [name, origin, node] of [['direct', local, ''], ['relay', remote, 'flow-node-a']]) {
                // 冷缓存网页查询，不依赖先更新正文来预热响应头缓存。
                await createSub(name, `${origin}/subscription?case=${name}`, node);
                await flowApi(name);
                await download(name);

                const customName = `${name}-ua`;
                await createSub(customName, `${origin}/subscription?case=${customName}#flowUserAgent=FlowTestUA&flowHeaders=${encodeURIComponent(JSON.stringify({ 'X-Flow-Test': 'test-only' }))}`, node);
                await download(customName);
                await flowApi(customName);
                expect(calls.some((call) => call.url.includes(customName) && call.ua === 'FlowTestUA' && call.token === 'test-only')).to.equal(true);

                // 流量缓存过期但正文仍缓存时，流量应沿原路径重新查询。
                const expiryName = `${name}-expiry`;
                await createSub(expiryName, `${origin}/subscription?case=${expiryName}#headersCacheTtl=0.4`, node);
                await download(expiryName);
                const before = calls.filter((call) => call.url.includes(expiryName)).length;
                await new Promise((resolve) => setTimeout(resolve, 450));
                downloadValue++;
                await download(expiryName);
                await flowApi(expiryName);
                const added = calls.filter((call) => call.url.includes(expiryName)).slice(before);
                expect(added).to.have.length(1);
                expect(added[0].method).to.equal(node ? 'GET' : 'HEAD');
            }

            // GET 抓取的响应头即使经过 WSS 分块也不能丢失。
            await createSub('relay-large-flow', `${remote}/subscription?case=large`, 'flow-node-a');
            await download('relay-large-flow');
            await flowApi('relay-large-flow');

            for (const endpoint of ['/flow-body', '/flow-header']) {
                const name = endpoint === '/flow-body' ? 'relay-custom-body' : 'relay-custom-header';
                await createSub(name, `${remote}/subscription?case=${name}#flowUrl=${encodeURIComponent(`${remote}${endpoint}?case=${name}`)}`, 'flow-node-a');
                // flowUrl 响应体仅包含流量字段时，不额外要求网页地址字段。
                await download(name, endpoint !== '/flow-body');
                await flowApi(name);
            }
            await createSub('relay-subuserinfo', `${remote}/subscription?case=subuserinfo`, 'flow-node-a');
            await success('/api/sub/relay-subuserinfo', 'PATCH', { subUserinfo: `${remote}/flow-body?case=subuserinfo` });
            await download('relay-subuserinfo');
            await flowApi('relay-subuserinfo');
            await success('/api/subs', 'POST', { name: 'relay-local-flow', source: 'local', content: 'unused',
                relayNodeId: 'flow-node-a', subUserinfo: `${remote}/flow-body?case=local` });
            await flowApi('relay-local-flow');

            // 单订阅和远程 Mihomo 文件均跟随其正文来源节点，手动链接仍优先。
            for (const file of [
                { name: 'mihomo-from-sub', sourceType: 'subscription', sourceName: 'relay' },
                { name: 'mihomo-remote', sourceType: 'remote', url: `${remote}/subscription?case=mihomo`, relayNodeId: 'flow-node-a' },
                { name: 'mihomo-manual', sourceType: 'subscription', sourceName: 'relay', subInfoUrl: `${remote}/flow-header?case=manual` },
            ]) {
                await success('/api/files', 'POST', { ...file, type: 'mihomoConfig', subInfoUserAgent: 'MihomoFlowTestUA', process: [] });
                const response = await success(`/api/file/${file.name}`);
                expect(await response.text()).to.include('Flow Audit');
                expect(response.headers.get('subscription-userinfo'), file.name).to.equal(expectedFlow());
            }
            await createSub('collection-source', `${remote}/subscription?case=collection#flowUserAgent=CollectionFlowTestUA`, 'flow-node-a');
            await success('/api/collections', 'POST', { name: 'relay-collection', subscriptions: ['collection-source'], process: [] });
            await download('collection/relay-collection');

            await createSub('relay-valid-check', `${remote}/subscription?case=valid#validCheck&flowUserAgent=ValidityFlowTestUA`, 'flow-node-a');
            await download('relay-valid-check');
            await createSub('relay-no-flow', `${remote}/subscription?case=noflow`, 'flow-node-a');
            await success('/api/sub/relay-no-flow', 'PATCH', { noFlow: true });
            const noFlowResponse = await success('/download/relay-no-flow?target=ClashMeta');
            expect(await noFlowResponse.text()).to.include('Flow Audit');
            expect(noFlowResponse.headers.get('subscription-userinfo')).to.equal(null);

            // 下载写入和独立查询读取同一节点键，不同节点与本机的缓存不串用。
            const sharedUrl = `${local}/subscription?case=shared`;
            const isolated = [];
            for (const [name, node] of [['cache-direct', ''], ['cache-node-a', 'flow-node-a'], ['cache-node-b', 'flow-node-b']]) {
                downloadValue++;
                await createSub(name, sharedUrl, node);
                await download(name);
                isolated.push([name, downloadValue]);
            }
            for (const [name, value] of isolated) {
                const response = await success(`/download/${name}?target=ClashMeta`);
                await response.text();
                expect(response.headers.get('subscription-userinfo'), name).to.include(`download=${value};`);
                const result = await (await success(`/api/sub/flow/${name}`)).json();
                expect(result.data.usage.download, name).to.equal(value);
            }
        } finally {
            for (const child of children.reverse()) await closeChild(child);
            if (resource.listening) { resource.closeAllConnections(); await new Promise((resolve) => resource.close(resolve)); }
            if (portProbe.listening) await new Promise((resolve) => portProbe.close(resolve));
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});
