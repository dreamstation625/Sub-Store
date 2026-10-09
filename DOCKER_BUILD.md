# Docker 构建和部署

本文记录本仓库 Docker 镜像的构建和运行方式，包括 Sub-Store 后端/前端单容器镜像，以及 `wss-client` 中继客户端镜像。

## 后端单容器镜像

根目录的 `Dockerfile` 会在构建时完成两部分：

- 构建 `backend`，输出 `/opt/app/sub-store.bundle.js`
- 构建前端静态文件，输出到 `/opt/app/frontend`

运行时默认监听 `3000` 端口，并把数据目录放在 `/opt/app/data`。

### GitHub Actions 自动发布（自用分支）

自用镜像由 `.github/workflows/docker-publish.yml` 发布。仅允许仓库 `dreamstation625/Sub-Store` 的 `dev-dream` 分支，其他仓库、分支、标签和 PR 均不会发布。原上游 `main.yml` 发布流程在此自用仓库禁用，在上游仍保持原行为。

根目录 `VERSION` 是唯一的自动发布触发文件，初始值为 `26.1009.01-pre`。版本格式为 `yy.MMdd.流水号`，日期必须有效，流水号从 `01` 开始、至少两位（同日继续使用 `02`、`03`，超过 `99` 可使用 `100`）。版本由维护者手动修改，不会自动回写代码；它仅控制镜像标签，不修改前后端的上游 `package.json` 版本。

| VERSION | 推送的 Docker Hub 标签 | 是否更新 latest |
| --- | --- | --- |
| `26.1009.01-pre` | `dreamstation625/sub-store:26.1009.01-pre` | 否 |
| `26.1009.01` | `dreamstation625/sub-store:26.1009.01` 和 `dreamstation625/sub-store:latest` | 是 |

发布步骤：

1. 先把需要包含的前端修改提交并推送到 `dreamstation625/Sub-Store-Front-End` 的 `dev-dream` 分支。
2. 在后端 `dev-dream` 分支修改 `VERSION`，和待发布后端代码一起提交、推送。
3. 工作流比较推送前后的 `VERSION` 内容；没有变化则跳过，其他代码或前端单独变化不会触发发布。
4. 构建时检出后端本次提交、前端 `dev-dream` 当前提交，以 `frontend` 命名构建上下文交给现有 Dockerfile。同时构建 `linux/amd64` 和 `linux/arm64`，Node 版本使用后端 `.node-version`。

两端都使用锁定依赖安装；后端安装前会复制 `pnpm-workspace.yaml` 和 `patches`，确保依赖补丁不会遗漏。

在后端 GitHub 仓库的 Settings → Environments 中使用环境 **`DOCKERHUB`**：

- Environment variable：`DOCKERHUB_USERNAME=dreamstation625`
- Environment secret：`DOCKERHUB_TOKEN`，填入有镜像推送权限的 Docker Hub Access Token。

工作流已绑定该环境，通过 `vars.DOCKERHUB_USERNAME` 和 `secrets.DOCKERHUB_TOKEN` 读取配置，不需要把 Token 写进代码。建议在该环境的 Deployment branches 中进一步只允许 `dev-dream`。

已存在的版本标签会直接跳过，绝不重新构建或更新 `latest`。检查标签时若遇到网络、认证等异常则停止，避免把异常误判为“版本不存在”。构建失败且版本尚未发布时可以重跑失败的 Actions；提供的手动入口也受相同仓库、分支和标签检查约束。GitHub 的手动入口要求该工作流文件存在于默认分支；未满足时使用失败运行的 Re-run jobs，或提交新的 VERSION。

构建摘要会记录版本、前后端提交编号、架构和镜像 digest。镜像标签 `org.opencontainers.image.version`、`org.opencontainers.image.revision` 和 `io.sub-store.frontend.revision` 也会保存构建来源，方便追溯。前端变化不会自动重新发布旧版本，只有下次修改后端 VERSION 时才打入新镜像。

本地验证发布判断（需要后端现有依赖）：

```bash
node --test .github/scripts/docker-version.test.mjs
actionlint .github/workflows/docker-publish.yml .github/workflows/wss-client-docker-publish.yml .github/workflows/main.yml
```

### 构建

在仓库根目录执行：

```bash
docker build --build-context frontend=../Sub-Store-Front-End -t dreamstation625/sub-store:latest .
```

如果需要指定 Node.js 版本：

```bash
docker build --build-context frontend=../Sub-Store-Front-End --build-arg NODE_VERSION=24.15.0 -t dreamstation625/sub-store:latest .
```
本地使用 PowerShell、Docker Buildx 构建并推送多标签镜像：

```powershell
docker buildx build `
  --build-context frontend=../Sub-Store-Front-End `
  -t dreamstation625/sub-store:26.0729.01 `
  -t dreamstation625/sub-store:latest `
  --push .
```

### 运行

```bash
docker run -d \
  --name sub-store \
  --restart unless-stopped \
  -p 3000:3000 \
  -v /vol1/1000/docker/sub-store:/opt/app/data \
  -e SUB_STORE_CORS_ALLOWED_ORIGINS=https://sub-store.example.com \
  dreamstation625/sub-store:latest
```

访问地址：

```text
http://服务器IP:3000
```

`SUB_STORE_CORS_ALLOWED_ORIGINS` 必须填写浏览器实际访问前端的来源（协议、域名或 IP、端口，不包含路径）。上面的域名只是示例；若直接使用 IP 访问，应替换为 `http://服务器IP:3000`。多个来源使用逗号分隔，例如：

```text
SUB_STORE_CORS_ALLOWED_ORIGINS=https://sub-store.example.com,http://192.168.1.10:3000
```

未设置时采用上游默认白名单，仅允许 `https://sub-store.vercel.app`、`http://substore.stash` 和 `https://substore.stash`；自建前端需要显式加入白名单，包括前后端同域的部署。

### 后端镜像环境变量

当前 Dockerfile 默认环境变量：

```text
TZ=Asia/Shanghai
TIME_ZONE=Asia/Shanghai
SUB_STORE_BACKEND_API_HOST=0.0.0.0
SUB_STORE_BACKEND_API_PORT=3000
SUB_STORE_BACKEND_MERGE=true
SUB_STORE_FRONTEND_BACKEND_PATH=/backend
SUB_STORE_FRONTEND_PATH=/opt/app/frontend
SUB_STORE_DATA_BASE_PATH=/opt/app/data
```

## http-meta 说明

如果后端 Dockerfile 需要内置 `http-meta`，构建阶段需要联网访问 GitHub release：

```text
https://github.com/xream/http-meta/releases/latest/download/http-meta.bundle.js
https://github.com/xream/http-meta/releases/latest/download/tpl.yaml
https://api.github.com/repos/MetaCubeX/mihomo/releases/latest
```

推荐的运行时路径约定：

```text
/opt/app/http-meta.bundle.js
/opt/app/http-meta/meta/tpl.yaml
/opt/app/http-meta/meta/http-meta
```

推荐环境变量：

```text
HTTP_META_HOST=127.0.0.1
HTTP_META_PORT=9876
META_TEMP_FOLDER=/opt/app/http-meta
META_FOLDER=/opt/app/http-meta/meta
```

推荐启动命令形式：

```dockerfile
CMD ["sh", "-c", "HOST=${HTTP_META_HOST} PORT=${HTTP_META_PORT} node /opt/app/http-meta.bundle.js & exec node /opt/app/sub-store.bundle.js"]
```

## wss-client 镜像

`wss-client/Dockerfile` 会构建一个独立的 WebSocket 中继客户端镜像。

### GitHub Actions 独立发布

工作流 `.github/workflows/wss-client-docker-publish.yml`（WSS Client Docker 发布（VERSION））仅在 `dreamstation625/Sub-Store` 的 `dev-dream` 分支运行。自动触发文件是 **`wss-client/VERSION`**，初始值为 `26.1009.01-pre`，格式及标签规则与主镜像相同，流水号独立管理。

| 客户端 VERSION | 推送的 Docker Hub 标签 | 是否更新 latest |
| --- | --- | --- |
| `26.1009.01-pre` | `dreamstation625/sub-store-wss-client:26.1009.01-pre` | 否 |
| `26.1009.01` | `dreamstation625/sub-store-wss-client:26.1009.01` 和 `dreamstation625/sub-store-wss-client:latest` | 是 |

修改客户端代码后，递增 `wss-client/VERSION`，一起提交推送即可发布。单独修改根目录 `VERSION` 不会触发客户端构建；单独修改客户端版本也不会触发主镜像构建。如果需要同时发布两个镜像，应分别修改两个版本文件。

客户端不构建前端、不安装额外依赖，构建上下文仅为 `./wss-client`；Node.js 版本使用根目录 `.node-version`，输出 amd64、arm64 两种架构。镜像内 `/app/VERSION` 与镜像版本标签一致，`package.json` 的原版本保持不变。构建上下文采用允许列表，只包含源码、示例配置和必要构建文件，不上传本地连接配置或 Token。

沿用环境 **`DOCKERHUB`** 的 `DOCKERHUB_USERNAME` 与 `DOCKERHUB_TOKEN`，需要确认该 Token 对 `dreamstation625/sub-store-wss-client` 也有推送权限。不需要新增 Action 白名单条目，使用的组件与主镜像一致。

已发布的客户端版本会跳过，不覆盖版本标签或 `latest`；查询 Docker Hub 出现网络或认证异常时会停止。可重跑的失败任务使用 Re-run jobs；启动前失败且无重跑按钮时，修复权限后递增客户端版本重新触发。手动 Run workflow 入口仍要求工作流文件位于默认分支；不要为此合并整个 `dev-dream` 到 `master`。

初次发布是测试版，不会创建 `latest`。部署时使用实际的测试版标签；只有首次正式发布后才能使用下方示例中的 `latest`。

```bash
docker run -d --name sub-store-wss-client --restart unless-stopped \
  -v /vol1/1000/docker/wss-client:/app/config \
  dreamstation625/sub-store-wss-client:26.1009.01-pre
```

镜像内启动命令固定读取：

```text
/app/config/config.json
```

因此宿主机只需要把包含 `config.json` 的目录挂载到 `/app/config`。

### 构建

在仓库根目录执行：

```bash
docker build -t dreamstation625/sub-store-wss-client:latest ./wss-client
```

或者进入 `wss-client` 目录执行：

```bash
cd wss-client
docker build -t dreamstation625/sub-store-wss-client:latest .
```
在仓库根目录使用 PowerShell、Docker Buildx 构建并推送多标签镜像。wss-client 不需要 `frontend` 构建上下文：

```powershell
docker buildx build `
  -t dreamstation625/sub-store-wss-client:26.0729.01 `
  -t dreamstation625/sub-store-wss-client:latest `
  --push ./wss-client
```

### 配置目录

宿主机配置目录：

```text
/vol1/1000/docker/wss-client
```

配置文件路径：

```text
/vol1/1000/docker/wss-client/config.json
```

可以从示例配置复制：

```bash
mkdir -p /vol1/1000/docker/wss-client
cp wss-client/config.example.json /vol1/1000/docker/wss-client/config.json
```

编辑 `config.json`，至少需要填写：

```json
{
  "wssUrl": "wss://sub-store.example.com/ws/relay",
  "token": "paste-wss-token-from-frontend",
  "clientId": "wss-client-1",
  "clientName": "WSS Client 1"
}
```

### docker run

```bash
docker run -d \
  --name sub-store-wss-client \
  --restart unless-stopped \
  -v /vol1/1000/docker/wss-client:/app/config \
  dreamstation625/sub-store-wss-client:latest
```

### docker compose

```yaml
services:
  wss-client:
    image: dreamstation625/sub-store-wss-client:latest
    container_name: sub-store-wss-client
    restart: unless-stopped
    volumes:
      - /vol1/1000/docker/wss-client:/app/config
```

启动：

```bash
docker compose up -d
```

查看日志：

```bash
docker logs -f sub-store-wss-client
```

正常连接后会看到类似：

```text
[sub-store-wss-client] connecting to wss://sub-store.example.com/ws/relay?token=***
[sub-store-wss-client] connected
```

## 推送镜像

构建完成后推送：

```bash
docker push dreamstation625/sub-store:latest
docker push dreamstation625/sub-store-wss-client:latest
```
