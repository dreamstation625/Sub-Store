import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { selectTags } from './docker-prune.mjs';

// 必须异步启动子进程：同步等待会阻塞本进程事件循环，让下面的 mock 服务无法应答。
const SCRIPT = fileURLToPath(new URL('./docker-prune.mjs', import.meta.url));
const runScript = (env) => new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
});

// 列表顺序即推送时间倒序，与 Docker Hub tags 接口的 ordering=last_updated 一致。
const tags = (names) => names.map((name, index) => ({
    name, last_updated: new Date(Date.UTC(2026, 10, 18 - index)).toISOString(),
}));

test('保留 latest 与最新版本标签，删除超期版本和无效标签', () => {
    const list = tags(['26.1118.10', '26.1118.09', '26.1118.08', '26.1118.07', 'probe']);
    list.push({ name: 'latest', last_updated: '2026-11-18T00:00:00Z' });
    const { kept, removed } = selectTags(list, { keep: 2, currentVersion: '26.1118.10' });
    assert.deepEqual(kept.sort(), ['26.1118.09', '26.1118.10', 'latest']);
    assert.deepEqual(removed.sort(), ['26.1118.07', '26.1118.08', 'probe']);
});

test('本次发布版本超出保留窗口也不删除', () => {
    const list = [...tags(['26.1118.05', '26.1118.04', '26.1118.03']), { name: 'latest' }];
    const { removed } = selectTags(list, { keep: 1, currentVersion: '26.1118.03' });
    assert.ok(!removed.includes('26.1118.03'));
    assert.deepEqual(removed.sort(), ['26.1118.04', '26.1118.05']);
});

test('缺少 latest、缺少时间戳或空列表时按最旧处理', () => {
    assert.deepEqual(selectTags([], { keep: 3, currentVersion: '' }), { kept: [], removed: [] });
    const list = [{ name: '26.1118.01' }, { name: '26.1118.02' }, { name: '26.1118.03' }];
    assert.deepEqual(selectTags(list, { keep: 1, currentVersion: '' }).kept, ['26.1118.03']);
    assert.deepEqual(selectTags(list, { keep: 5, currentVersion: '' }).removed, []);
});

test('保留数量必须为正整数', () => {
    for (const keep of [0, -1, 1.5, Number.NaN]) {
        assert.throws(() => selectTags([{ name: 'latest' }], { keep, currentVersion: '' }));
    }
});

test('CLI 登录 Docker Hub、翻页读取标签并删除超期标签', async (t) => {
    const initial = ['26.1118.10', '26.1118.09', '26.1118.08', '26.1118.07', 'probe'];
    let current = initial.map((name, index) => ({ name, last_updated: new Date(Date.UTC(2026, 10, 18 - index)).toISOString() }));
    current.push({ name: 'latest', last_updated: '2026-11-18T00:00:00Z' });
    const deleted = [];
    const requests = [];
    const authorization = [];
    const server = http.createServer((request, response) => {
        requests.push(`${request.method} ${request.url}`);
        if (request.method === 'POST' && request.url === '/v2/users/login/') {
            request.resume();
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ token: 'jwt' }));
            return;
        }
        if (request.method === 'GET' && request.url.startsWith('/v2/repositories/dreamstation625/sub-store-27/tags/')) {
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ next: null, results: current }));
            return;
        }
        const match = /^\/v2\/repositories\/dreamstation625\/sub-store-27\/tags\/([^/]+)\/$/.exec(request.url);
        if (request.method === 'DELETE' && match) {
            authorization.push(request.headers.authorization);
            const tag = decodeURIComponent(match[1]);
            deleted.push(tag);
            current = current.filter((entry) => entry.name !== tag);
            response.statusCode = 204;
            response.end();
            return;
        }
        response.statusCode = 500;
        response.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const summary = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sub-store-27-prune-')), 'summary.md');
    const run = (extraEnv = {}) => runScript({
        DOCKER_HUB_API: `http://127.0.0.1:${server.address().port}/v2`,
        DOCKERHUB_USERNAME: 'dreamstation625', DOCKERHUB_TOKEN: 'access-token',
        IMAGE: 'dreamstation625/sub-store-27', IMAGE_VERSION: '26.1118.10', KEEP_TAGS: '2',
        GITHUB_STEP_SUMMARY: summary,
        ...extraEnv,
    });
    try {
        const dryRun = await run({ PRUNE_DRY_RUN: 'true' });
        assert.equal(dryRun.status, 0, dryRun.stderr);
        assert.deepEqual(deleted, []);
        assert.match(fs.readFileSync(summary, 'utf8'), /待删除：`26\.1118\.08`、`26\.1118\.07`、`probe`/);

        const result = await run();
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(deleted.sort(), ['26.1118.07', '26.1118.08', 'probe']);
        assert.ok(authorization.every((header) => header === 'Bearer jwt'));
        assert.ok(requests.includes('POST /v2/users/login/'));
        const text = fs.readFileSync(summary, 'utf8');
        for (const name of ['latest', '26.1118.09', '26.1118.10']) assert.match(text, new RegExp(`\`${name}\``));
        assert.match(text, /已删除：`26\.1118\.08`、`26\.1118\.07`、`probe`/);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(path.dirname(summary), { recursive: true, force: true });
    }
});

test('Docker Hub 返回异常时停止，不声称已清理', async (t) => {
    const server = http.createServer((request, response) => {
        response.statusCode = 503;
        response.end('unavailable');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const result = await runScript({
            DOCKER_HUB_API: `http://127.0.0.1:${server.address().port}/v2`,
            DOCKERHUB_USERNAME: 'dreamstation625', DOCKERHUB_TOKEN: 'access-token',
            IMAGE: 'dreamstation625/sub-store-27', IMAGE_VERSION: '26.1118.10',
            GITHUB_STEP_SUMMARY: path.join(os.tmpdir(), 'sub-store-27-prune-failure.md'),
        });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /503/);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
