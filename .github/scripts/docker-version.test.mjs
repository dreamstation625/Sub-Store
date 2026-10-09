import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluateVersion, parseVersion, readPreviousVersion, REPOSITORY, RELEASE_REF, IMAGE, CLIENT_IMAGE } from './docker-version.mjs';

const defaults = { repository: REPOSITORY, ref: RELEASE_REF, eventName: 'push', current: '26.1009.01-pre', previous: '26.1008.01-pre' };

test('测试版仅发布版本标签，不含 latest', () => {
    assert.deepEqual(parseVersion('26.1009.01-pre\n'), {
        version: '26.1009.01-pre', prerelease: true, tags: [`${IMAGE}:26.1009.01-pre`],
    });
});

test('正式版同时发布版本标签和 latest', () => {
    assert.deepEqual(parseVersion('26.1009.02'), {
        version: '26.1009.02', prerelease: false, tags: [`${IMAGE}:26.1009.02`, `${IMAGE}:latest`],
    });
});

test('日期支持闰年，流水号支持 99 后继续到 100', () => {
    assert.equal(parseVersion('24.0229.100').version, '24.0229.100');
    assert.equal(parseVersion('26.1009.99').version, '26.1009.99');
});

for (const version of ['25.0229.01', '26.0230.01', '26.1331.01', '26.0001.01', '26.1000.01',
    '26.1009.00', '26.1009.1', '26.1009.001', '2026.1009.01', '26.1009.01-beta', '26.1009.01\nlatest', `26.1009.${'1'.repeat(130)}`]) {
    test(`拒绝无效 VERSION：${JSON.stringify(version)}`, () => assert.throws(() => parseVersion(version)));
}

test('推送前后内容相同，即使换行符不同也跳过', () => {
    const result = evaluateVersion({ ...defaults, previous: '26.1009.01-pre\r\n' });
    assert.equal(result.shouldBuild, false);
});

test('版本变化、首次增加版本文件或首次推送时构建', () => {
    assert.equal(evaluateVersion(defaults).shouldBuild, true);
    assert.equal(evaluateVersion({ ...defaults, previous: undefined }).shouldBuild, true);
});

test('pre 转正式版属于版本变化，并添加 latest', () => {
    const result = evaluateVersion({ ...defaults, current: '26.1009.01', previous: '26.1009.01-pre' });
    assert.equal(result.shouldBuild, true);
    assert.equal(result.prerelease, false);
    assert.deepEqual(result.tags, [`${IMAGE}:26.1009.01`, `${IMAGE}:latest`]);
});

test('其他仓库、分支、标签、PR 均不能构建', () => {
    for (const overrides of [
        { repository: 'sub-store-org/Sub-Store' }, { repository: 'someone/Sub-Store' },
        { ref: 'refs/heads/master' }, { ref: 'refs/tags/26.1009.01' }, { eventName: 'pull_request' },
    ]) assert.equal(evaluateVersion({ ...defaults, ...overrides }).shouldBuild, false);
});

test('手动重试仍受仓库和分支限制', () => {
    assert.equal(evaluateVersion({ ...defaults, eventName: 'workflow_dispatch', previous: defaults.current }).shouldBuild, true);
    assert.equal(evaluateVersion({ ...defaults, eventName: 'workflow_dispatch', ref: 'refs/heads/master' }).shouldBuild, false);
});

test('客户端标签、重试与分支限制独立于主镜像', () => {
    const client = { ...defaults, target: 'wss-client' };
    assert.deepEqual(evaluateVersion(client).tags, [`${CLIENT_IMAGE}:26.1009.01-pre`]);
    assert.deepEqual(evaluateVersion({ ...client, current: '26.1009.02' }).tags,
        [`${CLIENT_IMAGE}:26.1009.02`, `${CLIENT_IMAGE}:latest`]);
    assert.equal(evaluateVersion({ ...client, previous: defaults.current }).shouldBuild, false);
    assert.equal(evaluateVersion({ ...client, eventName: 'workflow_dispatch', previous: defaults.current }).shouldBuild, true);
    for (const overrides of [{ repository: 'someone/Sub-Store' }, { ref: 'refs/heads/master' },
        { ref: 'refs/tags/26.1009.01' }, { eventName: 'pull_request' }]) {
        assert.equal(evaluateVersion({ ...client, ...overrides }).shouldBuild, false);
    }
    for (const target of ['unknown', 'constructor', '__proto__']) {
        assert.throws(() => evaluateVersion({ ...defaults, target }));
    }
});

test('真实 Git 与客户端 CLI：首次新增、版本独立变更、正式标签及仅换行时跳过', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-store-client-version-'));
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const commit = () => {
        git('add', '.');
        git('-c', 'user.name=Version Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
        return git('rev-parse', 'HEAD');
    };
    const cli = (target, before) => {
        const eventPath = path.join(root, 'event.json');
        const outputPath = path.join(root, 'outputs.txt');
        fs.writeFileSync(eventPath, JSON.stringify({ before }));
        fs.writeFileSync(outputPath, '');
        const result = spawnSync(process.execPath, [fileURLToPath(new URL('./docker-version.mjs', import.meta.url)), target], {
            cwd: root, encoding: 'utf8', env: { ...process.env,
                GITHUB_REPOSITORY: REPOSITORY, GITHUB_REF: RELEASE_REF, GITHUB_EVENT_NAME: 'push',
                GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath,
                GITHUB_STEP_SUMMARY: path.join(root, 'summary.md'),
            },
        });
        assert.equal(result.status, 0, result.stderr);
        return fs.readFileSync(outputPath, 'utf8');
    };
    try {
        git('init', '-q');
        fs.writeFileSync(path.join(root, '.node-version'), '24.15.0\n');
        fs.writeFileSync(path.join(root, 'VERSION'), '26.1009.03-pre\n');
        const initial = commit();
        assert.equal(readPreviousVersion(initial, root, 'wss-client/VERSION'), undefined);
        assert.throws(() => readPreviousVersion(initial, root, '../VERSION'));
        fs.mkdirSync(path.join(root, 'wss-client'));
        fs.writeFileSync(path.join(root, 'wss-client/VERSION'), '26.1009.01-pre\n');
        const firstClient = commit();
        const first = cli('wss-client', initial);
        assert.match(first, /should_build=true/);
        assert.match(first, /version=26\.1009\.01-pre/);
        assert.match(first, /prerelease=true/);
        assert.match(first, /node_version=24\.15\.0/);
        assert.match(first, /dreamstation625\/sub-store-wss-client:26\.1009\.01-pre/);
        assert.doesNotMatch(first, /:latest|sub-store:/);
        assert.match(cli('main', initial), /should_build=false/);

        fs.writeFileSync(path.join(root, 'VERSION'), '26.1009.04-pre\n');
        const mainOnly = commit();
        assert.match(cli('wss-client', firstClient), /should_build=false/);
        assert.match(cli('main', firstClient), /should_build=true/);
        assert.equal(readPreviousVersion(firstClient, root, 'wss-client/VERSION'), '26.1009.01-pre\n');

        fs.writeFileSync(path.join(root, 'wss-client/VERSION'), '26.1009.02\n');
        const stableClient = commit();
        const stable = cli('wss-client', mainOnly);
        assert.match(stable, /should_build=true/);
        assert.match(stable, /prerelease=false/);
        assert.match(stable, /dreamstation625\/sub-store-wss-client:latest/);
        assert.doesNotMatch(stable, /sub-store:/);
        assert.match(cli('main', mainOnly), /should_build=false/);
        fs.writeFileSync(path.join(root, 'wss-client/VERSION'), '26.1009.02\r\n');
        assert.match(cli('wss-client', stableClient), /should_build=false/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('从真实 Git 历史读取推送前内容，并生成 Actions 输出', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-store-docker-version-'));
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const commit = () => { git('add', '.'); git('-c', 'user.name=Version Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
    try {
        git('init', '-q');
        fs.writeFileSync(path.join(root, '.node-version'), '24.15.0\n');
        const beforeVersion = commit();
        assert.equal(readPreviousVersion(beforeVersion, root), undefined);
        fs.writeFileSync(path.join(root, 'VERSION'), '26.1009.01-pre\n');
        const oldVersionCommit = commit();
        fs.writeFileSync(path.join(root, 'VERSION'), '26.1009.02\n');
        commit();
        assert.equal(readPreviousVersion(oldVersionCommit, root), '26.1009.01-pre\n');
        assert.equal(readPreviousVersion('0'.repeat(40), root), undefined);
        assert.throws(() => readPreviousVersion('invalid-ref', root));
        assert.throws(() => readPreviousVersion('f'.repeat(40), root));
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
        assert.match(outputs, /version=26\.1009\.02\n/);
        assert.match(outputs, /prerelease=false/);
        assert.match(outputs, /node_version=24\.15\.0/);
        assert.match(outputs, /dreamstation625\/sub-store:latest/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('工作流连接规则及两端提交记录不被遗漏', async () => {
    const require = (await import('node:module')).createRequire(import.meta.url);
    const yaml = require('../../backend/node_modules/yaml');
    const workflow = yaml.parse(fs.readFileSync(new URL('../workflows/docker-publish.yml', import.meta.url), 'utf8'));
    assert.deepEqual(workflow.on.push, { branches: ['dev-dream'], paths: ['VERSION'] });
    assert.equal(workflow.permissions.contents, 'read');
    assert.equal(workflow.concurrency['cancel-in-progress'], false);
    assert.equal(workflow.jobs.publish.environment, 'DOCKERHUB');
    const steps = workflow.jobs.publish.steps;
    const login = steps.find((step) => step.uses?.startsWith('docker/login-action'));
    assert.equal(login.with.username, '${{ vars.DOCKERHUB_USERNAME }}');
    assert.equal(login.with.password, '${{ secrets.DOCKERHUB_TOKEN }}');
    const frontend = steps.find((step) => step.with?.repository);
    assert.equal(frontend.with.repository, 'dreamstation625/Sub-Store-Front-End');
    assert.equal(frontend.with.ref, 'dev-dream');
    const build = steps.find((step) => step.uses?.startsWith('docker/build-push-action'));
    assert.equal(build.with.platforms, 'linux/amd64,linux/arm64');
    assert.match(build.with['build-contexts'], /frontend=\.\/frontend-source/);
    assert.match(build.with.labels, /io\.sub-store\.frontend\.revision=/);
    assert.match(build.if, /steps\.existing\.outputs\.exists == 'false'/);
    assert.ok(steps.findIndex((step) => step.uses?.startsWith('docker/setup-qemu')) < steps.findIndex((step) => step.uses?.startsWith('docker/setup-buildx')));
    const upstream = yaml.parse(fs.readFileSync(new URL('../workflows/main.yml', import.meta.url), 'utf8'));
    assert.equal(upstream.jobs.build.if, "github.repository != 'dreamstation625/Sub-Store'");
    const dockerfile = fs.readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
    const install = dockerfile.indexOf('pnpm install --frozen-lockfile');
    assert.ok(dockerfile.indexOf('COPY backend/package.json backend/pnpm-lock.yaml backend/pnpm-workspace.yaml') < install);
    assert.ok(dockerfile.indexOf('COPY backend/patches ./patches') < install);
    assert.match(dockerfile, /COPY --from=frontend/);
});

test('客户端工作流使用独立版本、镜像、上下文和队列，并复用环境及组件白名单', async () => {
    const require = (await import('node:module')).createRequire(import.meta.url);
    const yaml = require('../../backend/node_modules/yaml');
    const readWorkflow = (name) => yaml.parse(fs.readFileSync(new URL(`../workflows/${name}`, import.meta.url), 'utf8'));
    const workflow = readWorkflow('wss-client-docker-publish.yml');
    const main = readWorkflow('docker-publish.yml');
    assert.deepEqual(workflow.on.push, { branches: ['dev-dream'], paths: ['wss-client/VERSION'] });
    assert.ok(Object.hasOwn(workflow.on, 'workflow_dispatch'));
    assert.equal(workflow.permissions.contents, 'read');
    assert.equal(workflow.concurrency['cancel-in-progress'], false);
    assert.notEqual(workflow.concurrency.group, main.concurrency.group);
    for (const job of Object.values(workflow.jobs)) {
        assert.match(job.if, /github.repository == 'dreamstation625\/Sub-Store'/);
        assert.match(job.if, /github.ref == 'refs\/heads\/dev-dream'/);
    }
    assert.match(workflow.jobs.publish.if, /needs.version.outputs.should_build == 'true'/);
    assert.equal(workflow.jobs.version.steps.find((step) => step.id === 'version').run,
        'node .github/scripts/docker-version.mjs wss-client');
    assert.ok(workflow.jobs.version.steps.some((step) => step.run === 'node --check wss-client/src/index.js'));
    assert.ok(workflow.jobs.version.steps.some((step) => step.run === 'node --check wss-client/src/client.js'));
    assert.ok(workflow.jobs.version.steps.some((step) => step.run === 'node --test wss-client/test/*.test.mjs'));
    assert.equal(workflow.jobs.version.steps[0].with['fetch-depth'], 0);
    assert.equal(workflow.jobs.publish.environment, 'DOCKERHUB');
    assert.equal(workflow.jobs.publish.env.IMAGE, CLIENT_IMAGE);
    const steps = workflow.jobs.publish.steps;
    const login = steps.find((step) => step.uses?.startsWith('docker/login-action'));
    assert.equal(login.with.username, '${{ vars.DOCKERHUB_USERNAME }}');
    assert.equal(login.with.password, '${{ secrets.DOCKERHUB_TOKEN }}');
    const build = steps.find((step) => step.uses?.startsWith('docker/build-push-action'));
    assert.equal(build.with.context, './wss-client');
    assert.equal(build.with.file, './wss-client/Dockerfile');
    assert.equal(build.with.platforms, 'linux/amd64,linux/arm64');
    assert.equal(build.with.push, true);
    assert.equal(build.with.tags, '${{ needs.version.outputs.tags }}');
    assert.match(build.with['build-args'], /NODE_VERSION=\$\{\{ needs.version.outputs.node_version \}\}/);
    assert.match(build.with.labels, /org.opencontainers.image.revision=\$\{\{ github.sha \}\}/);
    assert.match(build.if, /steps.existing.outputs.exists == 'false'/);
    assert.equal(build.with['build-contexts'], undefined);
    assert.notEqual(build.with['cache-to'], main.jobs.publish.steps.find((step) => step.uses?.startsWith('docker/build-push-action')).with['cache-to']);
    assert.ok(!steps.some((step) => step.with?.repository));
    assert.ok(steps.findIndex((step) => step.uses?.startsWith('docker/setup-qemu')) < steps.findIndex((step) => step.uses?.startsWith('docker/setup-buildx')));
    const mainActions = new Set(Object.values(main.jobs).flatMap((job) => job.steps.map((step) => step.uses).filter(Boolean)));
    for (const job of Object.values(workflow.jobs)) {
        for (const step of job.steps) {
            if (step.uses) assert.ok(mainActions.has(step.uses), `需要额外白名单的组件：${step.uses}`);
            if (step.uses?.startsWith('actions/checkout')) {
                assert.equal(step.with.ref, '${{ github.sha }}');
                assert.equal(step.with['persist-credentials'], false);
            }
        }
    }
    const clientVersion = parseVersion(fs.readFileSync(new URL('../../wss-client/VERSION', import.meta.url), 'utf8'), CLIENT_IMAGE);
    assert.ok(clientVersion.tags.every((tag) => tag.startsWith(`${CLIENT_IMAGE}:`)));
    const dockerfile = fs.readFileSync(new URL('../../wss-client/Dockerfile', import.meta.url), 'utf8');
    assert.match(dockerfile, /COPY VERSION \.\//);
    assert.match(dockerfile, /USER node/);
    assert.match(dockerfile, /\/app\/config\/config.json/);
    const allowedContext = fs.readFileSync(new URL('../../wss-client/.dockerignore', import.meta.url), 'utf8')
        .split(/\r?\n/).filter((line) => line && !line.startsWith('#'));
    assert.deepEqual(allowedContext, ['**', '!Dockerfile', '!package.json', '!VERSION', '!config.example.json', '!src/', '!src/**']);
});

test('实际发布检查脚本：已存在跳过、确实不存在才构建、网络或权限错误停止', async (t) => {
    const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
    if (process.platform === 'win32' && !fs.existsSync(bash)) return t.skip('需要 Git Bash');
    const require = (await import('node:module')).createRequire(import.meta.url);
    const yaml = require('../../backend/node_modules/yaml');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-store-publish-check-'));
    try {
        for (const [filename, image] of [['docker-publish.yml', IMAGE], ['wss-client-docker-publish.yml', CLIENT_IMAGE]]) {
        const workflow = yaml.parse(fs.readFileSync(new URL(`../workflows/${filename}`, import.meta.url), 'utf8'));
        const script = workflow.jobs.publish.steps.find((step) => step.id === 'existing').run;
        for (const [result, exitCode, expected] of [
            ['valid manifest', 0, 'exists=true'],
            ['manifest unknown', 1, 'exists=false'],
            ['no such manifest: dreamstation625/sub-store:26.1009.01', 1, 'exists=false'],
            ['image tag not found', 1, 'exists=false'],
            ['unauthorized: authentication required', 1, undefined],
            ['dial tcp: network timeout', 1, undefined],
        ]) {
            const output = path.join(root, 'outputs.txt');
            fs.writeFileSync(output, '');
            const run = spawnSync(bash, ['-e', '-c', `docker() { printf '%s' "$MOCK_RESULT"; return "$MOCK_EXIT"; }\n${script}`], {
                encoding: 'utf8', env: { ...process.env,
                    IMAGE: image, IMAGE_VERSION: '26.1009.01', MOCK_RESULT: result, MOCK_EXIT: String(exitCode),
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
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
