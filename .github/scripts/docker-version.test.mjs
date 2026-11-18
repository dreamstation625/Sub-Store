import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluateVersion, parseVersion, readPreviousVersion, REPOSITORY, RELEASE_REF, IMAGE } from './docker-version.mjs';

const defaults = { repository: REPOSITORY, ref: RELEASE_REF, eventName: 'push', current: '26.1118.02-pre', previous: '26.1118.01' };

test('测试版仅发布版本标签，不含 latest', () => {
    assert.deepEqual(parseVersion('26.1118.02-pre\n'), {
        version: '26.1118.02-pre', prerelease: true, tags: [`${IMAGE}:26.1118.02-pre`],
    });
});

test('正式版同时发布版本标签和 latest', () => {
    assert.deepEqual(parseVersion('26.1118.01'), {
        version: '26.1118.01', prerelease: false, tags: [`${IMAGE}:26.1118.01`, `${IMAGE}:latest`],
    });
});

test('镜像名固定为 sub-store-27，不落到 dev-dream 的 sub-store', () => {
    assert.equal(IMAGE, 'dreamstation625/sub-store-27');
    assert.ok(parseVersion('26.1118.01').tags.every((tag) => tag.startsWith(`${IMAGE}:`)));
});

test('日期支持闰年，流水号支持 99 后继续到 100', () => {
    assert.equal(parseVersion('24.0229.100').version, '24.0229.100');
    assert.equal(parseVersion('26.1118.99').version, '26.1118.99');
});

for (const version of ['25.0229.01', '26.0230.01', '26.1331.01', '26.0001.01', '26.1000.01',
    '26.1118.00', '26.1118.1', '26.1118.001', '2026.1118.01', '26.1118.01-beta', '26.1118.01\nlatest', `26.1118.${'1'.repeat(130)}`]) {
    test(`拒绝无效 VERSION：${JSON.stringify(version)}`, () => assert.throws(() => parseVersion(version)));
}

test('推送前后内容相同，即使换行符不同也跳过', () => {
    assert.equal(evaluateVersion({ ...defaults, previous: '26.1118.02-pre\r\n' }).shouldBuild, false);
});

test('版本变化、首次增加版本文件或首次推送时构建', () => {
    assert.equal(evaluateVersion(defaults).shouldBuild, true);
    assert.equal(evaluateVersion({ ...defaults, previous: undefined }).shouldBuild, true);
});

test('pre 转正式版属于版本变化，并添加 latest', () => {
    const result = evaluateVersion({ ...defaults, current: '26.1118.02', previous: '26.1118.02-pre' });
    assert.equal(result.shouldBuild, true);
    assert.equal(result.prerelease, false);
    assert.deepEqual(result.tags, [`${IMAGE}:26.1118.02`, `${IMAGE}:latest`]);
});

test('其他仓库、分支、标签、PR 均不能构建', () => {
    for (const overrides of [
        { repository: 'sub-store-org/Sub-Store' }, { repository: 'someone/Sub-Store' },
        { ref: 'refs/heads/master' }, { ref: 'refs/heads/dev-dream' }, { ref: 'refs/tags/26.1118.01' },
        { eventName: 'pull_request' },
    ]) assert.equal(evaluateVersion({ ...defaults, ...overrides }).shouldBuild, false);
});

test('手动重试仍受仓库和分支限制', () => {
    assert.equal(evaluateVersion({ ...defaults, eventName: 'workflow_dispatch', previous: defaults.current }).shouldBuild, true);
    assert.equal(evaluateVersion({ ...defaults, eventName: 'workflow_dispatch', ref: 'refs/heads/master' }).shouldBuild, false);
});

test('从真实 Git 历史读取推送前内容，并生成 Actions 输出', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-store-27-docker-version-'));
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const commit = () => { git('add', '.'); git('-c', 'user.name=Version Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
    try {
        git('init', '-q');
        fs.writeFileSync(path.join(root, '.node-version'), '24.15.0\n');
        const beforeVersion = commit();
        assert.equal(readPreviousVersion(beforeVersion, root), undefined);
        fs.writeFileSync(path.join(root, 'VERSION'), '26.1118.01-pre\n');
        const oldVersionCommit = commit();
        fs.writeFileSync(path.join(root, 'VERSION'), '26.1118.02\n');
        commit();
        assert.equal(readPreviousVersion(oldVersionCommit, root), '26.1118.01-pre\n');
        assert.equal(readPreviousVersion('0'.repeat(40), root), undefined);
        assert.throws(() => readPreviousVersion('invalid-ref', root));
        assert.throws(() => readPreviousVersion('f'.repeat(40), root));
        fs.writeFileSync(path.join(root, 'VERSION'), '26.1118.02\r\n');
        assert.equal(readPreviousVersion(oldVersionCommit, root), '26.1118.01-pre\n');

        const eventPath = path.join(root, 'event.json');
        const outputPath = path.join(root, 'outputs.txt');
        const summaryPath = path.join(root, 'summary.md');
        fs.writeFileSync(eventPath, JSON.stringify({ before: oldVersionCommit }));
        const result = spawnSync(process.execPath, [fileURLToPath(new URL('./docker-version.mjs', import.meta.url))], {
            cwd: root, encoding: 'utf8', env: { ...process.env,
                GITHUB_REPOSITORY: REPOSITORY, GITHUB_REF: RELEASE_REF, GITHUB_EVENT_NAME: 'push',
                GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath, GITHUB_STEP_SUMMARY: summaryPath,
            },
        });
        assert.equal(result.status, 0, result.stderr);
        const outputs = fs.readFileSync(outputPath, 'utf8');
        assert.match(outputs, /should_build=true/);
        assert.match(outputs, /version=26\.1118\.02\n/);
        assert.match(outputs, /prerelease=false/);
        assert.match(outputs, /node_version=24\.15\.0/);
        assert.match(outputs, /dreamstation625\/sub-store-27:latest/);
        const summary = fs.readFileSync(summaryPath, 'utf8');
        assert.match(summary, /dreamstation625\/sub-store-27/);
        assert.doesNotMatch(summary, /sub-store:26/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('工作流连接规则、构建来源与标签清理步骤不被遗漏', async () => {
    const require = (await import('node:module')).createRequire(import.meta.url);
    const yaml = require('../../backend/node_modules/yaml');
    const workflow = yaml.parse(fs.readFileSync(new URL('../workflows/docker-publish-27.yml', import.meta.url), 'utf8'));
    assert.equal(workflow.name, 'Docker 发布 sub-store-27（VERSION）');
    assert.deepEqual(workflow.on.push, { branches: ['dream27'], paths: ['VERSION'] });
    assert.ok(Object.hasOwn(workflow.on, 'workflow_dispatch'));
    assert.equal(workflow.permissions.contents, 'read');
    assert.equal(workflow.concurrency['cancel-in-progress'], false);
    for (const job of Object.values(workflow.jobs)) {
        assert.match(job.if, /github\.repository == 'dreamstation625\/Sub-Store'/);
        assert.match(job.if, /github\.ref == 'refs\/heads\/dream27'/);
    }
    assert.match(workflow.jobs.publish.if, /needs\.version\.outputs\.should_build == 'true'/);
    assert.equal(workflow.jobs.publish.environment, 'DOCKERHUB');
    assert.equal(workflow.jobs.publish.env.IMAGE, IMAGE);
    assert.equal(workflow.jobs.version.steps[0].with['fetch-depth'], 0);
    const steps = workflow.jobs.publish.steps;
    const login = steps.find((step) => step.uses?.startsWith('docker/login-action'));
    assert.equal(login.with.username, '${{ vars.DOCKERHUB_USERNAME }}');
    assert.equal(login.with.password, '${{ secrets.DOCKERHUB_TOKEN }}');
    const frontend = steps.find((step) => step.with?.repository);
    assert.equal(frontend.with.repository, 'dreamstation625/Sub-Store-Front-End');
    assert.equal(frontend.with.ref, 'dream27');
    const build = steps.find((step) => step.uses?.startsWith('docker/build-push-action'));
    assert.equal(build.with.platforms, 'linux/amd64,linux/arm64');
    assert.match(build.with['build-contexts'], /frontend=\.\/frontend-source/);
    assert.match(build.with.labels, /io\.sub-store\.frontend\.revision=/);
    assert.match(build.if, /steps\.existing\.outputs\.exists == 'false'/);
    assert.match(build.with['cache-to'], /scope=sub-store-27-dream27/);
    const prune = steps.find((step) => step.run?.includes('docker-prune.mjs'));
    assert.ok(prune, '缺少标签清理步骤');
    assert.equal(prune.env.KEEP_TAGS, '10');
    assert.equal(prune.env.DOCKERHUB_USERNAME, '${{ vars.DOCKERHUB_USERNAME }}');
    assert.equal(prune.env.DOCKERHUB_TOKEN, '${{ secrets.DOCKERHUB_TOKEN }}');
    assert.ok(steps.indexOf(prune) > steps.indexOf(build), '标签清理必须在镜像发布之后');
    assert.ok(steps.findIndex((step) => step.uses?.startsWith('docker/setup-qemu')) < steps.findIndex((step) => step.uses?.startsWith('docker/setup-buildx')));
    const upstream = yaml.parse(fs.readFileSync(new URL('../workflows/main.yml', import.meta.url), 'utf8'));
    assert.equal(upstream.jobs.build.if, "github.repository != 'dreamstation625/Sub-Store'");
    const dockerfile = fs.readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
    const install = dockerfile.indexOf('pnpm install --frozen-lockfile');
    assert.ok(dockerfile.indexOf('COPY backend/package.json backend/pnpm-lock.yaml backend/pnpm-workspace.yaml') < install);
    assert.ok(dockerfile.indexOf('COPY backend/patches ./patches') < install);
    assert.match(dockerfile, /COPY --from=frontend/);
    assert.equal(parseVersion(fs.readFileSync(new URL('../../VERSION', import.meta.url), 'utf8')).prerelease, false);
});

test('实际发布检查脚本：已存在跳过、确实不存在才构建、网络或权限错误停止', async (t) => {
    const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
    if (process.platform === 'win32' && !fs.existsSync(bash)) return t.skip('需要 Git Bash');
    const require = (await import('node:module')).createRequire(import.meta.url);
    const yaml = require('../../backend/node_modules/yaml');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-store-27-publish-check-'));
    try {
        const workflow = yaml.parse(fs.readFileSync(new URL('../workflows/docker-publish-27.yml', import.meta.url), 'utf8'));
        const script = workflow.jobs.publish.steps.find((step) => step.id === 'existing').run;
        for (const [result, exitCode, expected] of [
            ['valid manifest', 0, 'exists=true'],
            ['manifest unknown', 1, 'exists=false'],
            ['no such manifest: dreamstation625/sub-store-27:26.1118.01', 1, 'exists=false'],
            ['image tag not found', 1, 'exists=false'],
            ['unauthorized: authentication required', 1, undefined],
            ['dial tcp: network timeout', 1, undefined],
        ]) {
            const output = path.join(root, 'outputs.txt');
            fs.writeFileSync(output, '');
            const run = spawnSync(bash, ['-e', '-c', `docker() { printf '%s' "$MOCK_RESULT"; return "$MOCK_EXIT"; }\n${script}`], {
                encoding: 'utf8', env: { ...process.env,
                    IMAGE, IMAGE_VERSION: '26.1118.01', MOCK_RESULT: result, MOCK_EXIT: String(exitCode),
                    GITHUB_OUTPUT: output.replaceAll('\\', '/'), GITHUB_STEP_SUMMARY: path.join(root, 'summary.md').replaceAll('\\', '/'),
                },
            });
            if (expected) {
                assert.equal(run.status, 0, `${result}: ${run.stderr}`);
                assert.equal(fs.readFileSync(output, 'utf8').trim(), expected);
            } else {
                assert.equal(run.status, 1, result);
                assert.equal(fs.readFileSync(output, 'utf8'), '');
                assert.match(run.stdout, /::error::/);
            }
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
