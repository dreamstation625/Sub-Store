import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY = 'dreamstation625/Sub-Store';
export const RELEASE_REF = 'refs/heads/dev-dream';
export const IMAGE = 'dreamstation625/sub-store';

// 镜像版本独立于上游 package.json；日期必须有效，流水号至少两位且从 01 开始。
export function parseVersion(text) {
    const version = text.trim();
    assert.ok(version.length <= 128, 'VERSION 超出 Docker 标签长度上限');
    const match = /^(\d{2})\.(\d{2})(\d{2})\.(0[1-9]|[1-9]\d+)(-pre)?$/.exec(version);
    assert.ok(match, 'VERSION 必须是 yy.MMdd.流水号，例如 26.1009.01 或 26.1009.01-pre');
    const year = 2000 + Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    assert.ok(date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day, 'VERSION 日期无效');
    const prerelease = Boolean(match[5]);
    return { version, prerelease, tags: [`${IMAGE}:${version}`, ...(prerelease ? [] : [`${IMAGE}:latest`])] };
}

export function evaluateVersion({ repository, ref, eventName, current, previous }) {
    if (repository !== REPOSITORY || ref !== RELEASE_REF) {
        return { shouldBuild: false, reason: '不是指定仓库的 dev-dream 分支' };
    }
    if (!['push', 'workflow_dispatch'].includes(eventName)) {
        return { shouldBuild: false, reason: '不支持此触发事件' };
    }
    const result = parseVersion(current);
    // 手动入口仅用于失败重试；发布任务还会检查 Docker Hub，绝不覆盖已发布版本。
    const shouldBuild = eventName === 'workflow_dispatch' || current.trim() !== previous?.trim();
    return { ...result, shouldBuild, reason: shouldBuild ? '新版本或未发布版本重试' : 'VERSION 内容未变化，跳过构建' };
}

export function readPreviousVersion(commit, cwd = process.cwd()) {
    if (!commit || /^0+$/.test(commit)) return undefined;
    assert.match(commit, /^[a-f0-9]{40}$/, '无效的推送前提交编号');
    // 若前提交不可读取则失败退出，不把网络或历史缺失误判为新版本。
    execFileSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd, stdio: 'pipe' });
    const entry = execFileSync('git', ['ls-tree', '--name-only', commit, '--', 'VERSION'], { cwd, encoding: 'utf8' }).trim();
    return entry ? execFileSync('git', ['show', `${commit}:VERSION`], { cwd, encoding: 'utf8' }) : undefined;
}

function main() {
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const result = evaluateVersion({
        repository: process.env.GITHUB_REPOSITORY,
        ref: process.env.GITHUB_REF,
        eventName: process.env.GITHUB_EVENT_NAME,
        current: fs.readFileSync('VERSION', 'utf8'),
        previous: process.env.GITHUB_EVENT_NAME === 'push' ? readPreviousVersion(event.before) : undefined,
    });
    const nodeVersion = fs.readFileSync('.node-version', 'utf8').trim();
    assert.match(nodeVersion, /^\d+\.\d+\.\d+$/, '无效的 .node-version');
    fs.appendFileSync(process.env.GITHUB_OUTPUT, [
        `should_build=${result.shouldBuild}`,
        `version=${result.version || ''}`,
        `prerelease=${result.prerelease || false}`,
        `node_version=${nodeVersion}`,
        'tags<<DOCKER_TAGS', ...(result.tags || []), 'DOCKER_TAGS', '',
    ].join('\n'));
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Docker 发布检查\n\n${result.reason}\n\n版本：\`${result.version || '无'}\`\n`);
    console.log(result.reason);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
