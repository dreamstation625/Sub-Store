import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseImage } from './docker-hub-api.mjs';
import { tagExists } from './docker-tag-exists.mjs';

// 必须异步启动子进程：同步等待会阻塞本进程事件循环，让下面的 mock 服务无法应答。
const SCRIPT = fileURLToPath(new URL('./docker-tag-exists.mjs', import.meta.url));
const runScript = (env) => new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
});

async function withServer(handler, run) {
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        return await run(`http://127.0.0.1:${server.address().port}/v2`);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

test('镜像地址必须是 命名空间/仓库', () => {
    assert.deepEqual(parseImage('dreamstation625/sub-store-27'), {
        repository: 'dreamstation625/sub-store-27',
        namespace: 'dreamstation625',
        name: 'sub-store-27',
    });
    for (const image of ['sub-store-27', 'a/b/c', '', ' a/']) {
        assert.throws(() => parseImage(image));
    }
});

test('标签存在返回 true，不存在返回 false，其他状态必须报错', async () => {
    const statuses = { exist: 200, missing: 404, broken: 500 };
    await withServer((request, response) => {
        const tag = request.url.split('/tags/')[1]?.replace(/\/$/, '');
        response.statusCode = statuses[decodeURIComponent(tag)] ?? 404;
        response.setHeader('content-type', 'application/json');
        response.end('{}');
    }, async (api) => {
        const result = await tagExists({
            api,
            repository: 'dreamstation625/sub-store-27',
            tag: 'exist',
            token: 'jwt',
        });
        assert.equal(result, true);
        assert.equal(await tagExists({ api, repository: 'dreamstation625/sub-store-27', tag: 'missing', token: 'jwt' }), false);
        await assert.rejects(
            tagExists({ api, repository: 'dreamstation625/sub-store-27', tag: 'broken', token: 'jwt' }),
            /500/,
        );
    });
});

test('CLI 登录后写入 exists 输出并记录步骤摘要', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-store-tag-exists-'));
    const outputs = path.join(root, 'outputs.txt');
    const summary = path.join(root, 'summary.md');
    const logins = [];
    try {
        await withServer((request, response) => {
            if (request.method === 'POST' && request.url === '/v2/users/login/') {
                request.resume();
                logins.push(request.url);
                response.setHeader('content-type', 'application/json');
                response.end(JSON.stringify({ token: 'jwt' }));
                return;
            }
            response.statusCode = 404;
            response.end('{}');
        }, async (api) => {
            fs.writeFileSync(outputs, '');
            const result = await runScript({
                DOCKER_HUB_API: api,
                DOCKERHUB_USERNAME: 'dreamstation625',
                DOCKERHUB_TOKEN: 'access-token',
                IMAGE: 'dreamstation625/sub-store-27',
                IMAGE_VERSION: '26.1118.03',
                GITHUB_OUTPUT: outputs,
                GITHUB_STEP_SUMMARY: summary,
            });
            assert.equal(result.status, 0, result.stderr);
        });

        assert.deepEqual(logins, ['/v2/users/login/']);
        assert.equal(fs.readFileSync(outputs, 'utf8').trim(), 'exists=false');
        const text = fs.readFileSync(summary, 'utf8');
        assert.match(text, /dreamstation625\/sub-store-27:26\.1118\.03/);
        assert.match(text, /未发布/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('登录失败时直接失败，不写 exists', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-store-tag-exists-fail-'));
    const outputs = path.join(root, 'outputs.txt');
    try {
        await withServer((request, response) => {
            response.statusCode = 503;
            response.end('unavailable');
        }, async (api) => {
            fs.writeFileSync(outputs, '');
            const result = await runScript({
                DOCKER_HUB_API: api,
                DOCKERHUB_USERNAME: 'dreamstation625',
                DOCKERHUB_TOKEN: 'access-token',
                IMAGE: 'dreamstation625/sub-store-27',
                IMAGE_VERSION: '26.1118.03',
                GITHUB_OUTPUT: outputs,
                GITHUB_STEP_SUMMARY: path.join(root, 'summary.md'),
            });
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /503/);
        });
        assert.equal(fs.readFileSync(outputs, 'utf8'), '');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
