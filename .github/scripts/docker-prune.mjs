import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_API = 'https://hub.docker.com/v2';
// 与 docker-version.mjs 的 VERSION 格式一致；不符合的标签视为残留或无效标签。
const VERSION_TAG = /^\d{2}\.\d{2}\d{2}\.(0[1-9]|[1-9]\d+)(-pre)?$/;
const ALWAYS_KEEP = ['latest'];
const MAX_PAGES = 50;

// 保留策略：latest、本次发布的版本，以及按最后推送时间排序的最新 keep 个版本标签，其余全部删除。
export function selectTags(tags, { keep, currentVersion }) {
    assert.ok(Number.isInteger(keep) && keep >= 1, '保留数量必须是大于 0 的整数');
    assert.ok(tags.every((tag) => typeof tag?.name === 'string'), '标签列表无效');
    const ordered = tags
        .map((tag) => ({ name: tag.name, pushed: Date.parse(tag.last_updated) || 0 }))
        .sort((left, right) => right.pushed - left.pushed || right.name.localeCompare(left.name));
    const kept = new Set(ALWAYS_KEEP.filter((tag) => ordered.some((candidate) => candidate.name === tag)));
    if (currentVersion) kept.add(currentVersion);
    let versionsKept = ordered.filter((tag) => kept.has(tag.name) && VERSION_TAG.test(tag.name)).length;
    for (const tag of ordered) {
        if (versionsKept >= keep) break;
        if (kept.has(tag.name) || !VERSION_TAG.test(tag.name)) continue;
        kept.add(tag.name);
        versionsKept += 1;
    }
    return {
        kept: ordered.filter((tag) => kept.has(tag.name)).map((tag) => tag.name),
        removed: ordered.filter((tag) => !kept.has(tag.name)).map((tag) => tag.name),
    };
}

function describe(tags) {
    if (tags.length === 0) return '无';
    const shown = tags.slice(0, 40).map((tag) => `\`${tag}\``).join('、');
    return tags.length > 40 ? `${shown} …（共 ${tags.length} 个）` : shown;
}

async function callApi(url, { method = 'GET', token, body } = {}) {
    const response = await fetch(url, {
        method,
        headers: {
            accept: 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    assert.ok(response.ok, `${method} ${url} 返回 ${response.status} ${response.statusText}`);
    return response;
}

async function listTags(api, repository, token) {
    const tags = [];
    let url = `${api}/repositories/${repository}/tags/?page_size=100&ordering=last_updated`;
    for (let page = 0; url && page < MAX_PAGES; page += 1) {
        const body = await (await callApi(url, { token })).json();
        tags.push(...(body.results || []).map(({ name, last_updated }) => ({ name, last_updated })));
        url = body.next;
    }
    assert.ok(!url, '标签分页超出上限，已停止清理');
    return tags;
}

async function deleteTag(api, repository, tag, token) {
    const response = await fetch(`${api}/repositories/${repository}/tags/${encodeURIComponent(tag)}/`, {
        method: 'DELETE',
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    });
    // 并发删除或人工已清理时视为完成，其他错误必须停止，避免误判为已清理。
    assert.ok(response.status === 204 || response.status === 404, `删除标签 ${tag} 失败：${response.status} ${response.statusText}`);
    return response.status === 204;
}

function readConfig() {
    const image = process.env.IMAGE?.trim();
    assert.ok(image, '缺少 IMAGE');
    const [namespace, name, ...rest] = image.split('/');
    assert.ok(namespace && name && rest.length === 0, `IMAGE 必须是 命名空间/仓库，当前为 ${image}`);
    const keep = Number(process.env.KEEP_TAGS ?? 10);
    assert.ok(Number.isInteger(keep) && keep >= 1, 'KEEP_TAGS 必须是大于 0 的整数');
    const username = process.env.DOCKERHUB_USERNAME;
    assert.ok(username && process.env.DOCKERHUB_TOKEN, '缺少 DOCKERHUB_USERNAME 或 DOCKERHUB_TOKEN');
    return {
        repository: `${namespace}/${name}`,
        keep,
        currentVersion: process.env.IMAGE_VERSION?.trim() || '',
        username,
        password: process.env.DOCKERHUB_TOKEN,
        api: (process.env.DOCKER_HUB_API || DEFAULT_API).replace(/\/+$/, ''),
        dryRun: process.env.PRUNE_DRY_RUN === 'true',
    };
}

async function main() {
    const { repository, keep, currentVersion, username, password, api, dryRun } = readConfig();
    const { token } = await (await callApi(`${api}/users/login/`, { method: 'POST', body: { username, password } })).json();
    assert.ok(token, 'Docker Hub 登录没有返回令牌');

    const tags = await listTags(api, repository, token);
    const { kept, removed } = selectTags(tags, { keep, currentVersion });
    const deleted = [];
    for (const tag of removed) {
        if (!dryRun && (await deleteTag(api, repository, tag, token))) deleted.push(tag);
    }
    const remaining = dryRun ? kept : (await listTags(api, repository, token)).map((tag) => tag.name);
    console.log(`保留 ${remaining.length} 个标签，删除 ${deleted.length} 个标签：${deleted.join(', ') || '无'}`);

    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
        '### Docker Hub 标签清理',
        '',
        `- 镜像：\`${repository}\``,
        `- 保留策略：\`latest\` + 最新 ${keep} 个版本标签${currentVersion ? `（本次版本 \`${currentVersion}\` 不删除）` : ''}`,
        `- 清理前：${tags.length} 个标签`,
        `- 保留：${describe(remaining)}`,
        `- ${dryRun ? '待删除' : '已删除'}：${describe(removed)}`,
        '',
    ].join('\n'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
