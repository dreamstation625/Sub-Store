import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    apiRequest,
    login,
    parseImage,
    resolveApi,
} from './docker-hub-api.mjs';

// 直接问 Docker Hub 上这个标签是否存在, 避免依赖 docker manifest inspect 的错误文案。
export async function tagExists({ api, repository, tag, token }) {
    const response = await apiRequest(
        `${api}/repositories/${repository}/tags/${encodeURIComponent(tag)}/`,
        { token },
    );
    if (response.status === 200) return true;
    if (response.status === 404) return false;
    throw new Error(
        `无法确认 ${repository}:${tag} 是否存在：${response.status} ${response.statusText}`,
    );
}

async function main() {
    const { repository } = parseImage(process.env.IMAGE);
    const tag = `${process.env.IMAGE_VERSION ?? ''}`.trim();
    assert.ok(tag, '缺少 IMAGE_VERSION');
    const api = resolveApi();
    const token = await login({
        api,
        username: process.env.DOCKERHUB_USERNAME,
        password: process.env.DOCKERHUB_TOKEN,
    });
    const exists = await tagExists({ api, repository, tag, token });

    fs.appendFileSync(process.env.GITHUB_OUTPUT, `exists=${exists}\n`);
    fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### 版本检查\n\n- 镜像：\`${repository}:${tag}\`\n- 状态：${
            exists ? '**已发布**，跳过构建且不更新 latest' : '未发布，继续构建'
        }\n`,
    );
    console.log(
        exists
            ? `版本 ${tag} 已发布，跳过构建且不更新 latest。`
            : `版本 ${tag} 未发布，开始构建。`,
    );
}

if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    await main();
}
