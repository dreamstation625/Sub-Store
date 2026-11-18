import assert from 'node:assert/strict';

export const DEFAULT_API = 'https://hub.docker.com/v2';

export function resolveApi() {
    return (process.env.DOCKER_HUB_API || DEFAULT_API).replace(/\/+$/, '');
}

export function parseImage(image) {
    const [namespace, name, ...rest] = `${image ?? ''}`.trim().split('/');
    assert.ok(
        namespace && name && rest.length === 0,
        `IMAGE 必须是 命名空间/仓库，当前为 ${image}`,
    );
    return { repository: `${namespace}/${name}`, namespace, name };
}

export async function login({ api = resolveApi(), username, password } = {}) {
    assert.ok(username && password, '缺少 DOCKERHUB_USERNAME 或 DOCKERHUB_TOKEN');
    const response = await fetch(`${api}/users/login/`, {
        method: 'POST',
        headers: {
            accept: 'application/json',
            'content-type': 'application/json',
        },
        body: JSON.stringify({ username, password }),
    });
    assert.ok(
        response.ok,
        `Docker Hub 登录失败：${response.status} ${response.statusText}`,
    );
    const { token } = await response.json();
    assert.ok(token, 'Docker Hub 登录没有返回令牌');
    return token;
}

export function apiRequest(url, { method = 'GET', token, body } = {}) {
    return fetch(url, {
        method,
        headers: {
            accept: 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
}

export async function apiJson(url, options) {
    const response = await apiRequest(url, options);
    assert.ok(
        response.ok,
        `${options?.method || 'GET'} ${url} 返回 ${response.status} ${
            response.statusText
        }`,
    );
    return response.json();
}
