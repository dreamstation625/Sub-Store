# Docker 构建和部署

本文记录 `dream27` 分支 Docker 镜像的构建、发布和清理方式。镜像只发布到 `dreamstation625/sub-store-27`，与 `dev-dream` 的 `sub-store` 互不影响。

## 镜像内容

根目录 `Dockerfile` 在构建时完成两部分：

- 构建 `backend`，输出 `/opt/app/sub-store.bundle.js`
- 构建前端静态文件，输出到 `/opt/app/frontend`

运行时默认监听 `3000` 端口，数据目录为 `/opt/app/data`。

## GitHub Actions 自动发布

自用镜像由 `.github/workflows/docker-publish-27.yml` 发布，只允许仓库 `dreamstation625/Sub-Store` 的 `dream27` 分支；其他仓库、分支、标签和 PR 都不会发布。上游 `main.yml` 发布流程在本仓库被 `if` 条件禁用，在上游仓库保持原行为。

根目录 `VERSION` 是唯一的自动发布触发文件。版本格式 `yy.MMdd.流水号`，日期必须有效，流水号从 `01` 开始且至少两位（同日继续用 `02`、`03`，超过 `99` 可以用 `100`）。版本由维护者手动修改，不会回写代码，也不影响前后端 `package.json` 版本。

| VERSION | 推送的 Docker Hub 标签 | 是否更新 latest |
| --- | --- | --- |
| `26.1118.02-pre` | `dreamstation625/sub-store-27:26.1118.02-pre` | 否 |
| `26.1118.02` | `dreamstation625/sub-store-27:26.1118.02` 和 `dreamstation625/sub-store-27:latest` | 是 |

发布步骤：

1. 先把要包含的前端修改提交并推送到 `dreamstation625/Sub-Store-Front-End` 的 `dream27` 分支。
2. 在 `dream27` 分支修改 `VERSION`，与待发布后端代码一起提交、推送。
3. 工作流比较推送前后的 `VERSION` 内容；没有变化就跳过，其他代码或前端单独变化不会触发发布。
4. 构建时检出后端本次提交和前端 `dream27` 当前提交，以 `frontend` 命名构建上下文交给 Dockerfile；同时构建 `linux/amd64` 和 `linux/arm64`，Node 版本取自 `.node-version`。

两端都使用锁定依赖安装；后端安装前会复制 `pnpm-workspace.yaml` 和 `patches`，避免补丁遗漏。

已存在的版本标签会直接跳过，绝不重新构建或覆盖 `latest`。检查标签时遇到网络、认证异常会停止，不把异常当成“版本不存在”。构建失败且版本未发布时可以重跑失败的运行。

### Docker Hub 环境配置

在仓库 Settings → Environments 使用环境 **`DOCKERHUB`**：

- Environment variable：`DOCKERHUB_USERNAME=dreamstation625`
- Environment secret：`DOCKERHUB_TOKEN`，需要有镜像读写和删除权限的 Docker Hub Access Token

工作流通过 `vars.DOCKERHUB_USERNAME` 和 `secrets.DOCKERHUB_TOKEN` 读取，不把 Token 写进代码。环境的 Deployment branches 需要同时允许 `dream27`，否则发布任务会在环境校验处失败。

### 旧标签自动清理

每次构建发布成功后，工作流会执行 `.github/scripts/docker-prune.mjs`，按以下规则清理 `dreamstation625/sub-store-27`：

- 始终保留 `latest` 和本次发布的版本；
- 版本标签按最后推送时间排序，只保留最新 `10` 个（`KEEP_TAGS` 可调）；
- 超出保留窗口的旧版本标签，以及不符合 `yy.MMdd.流水号` 格式的残留标签（例如中断构建留下的临时标签）全部删除。

删除标签会同时移除该标签指向的多架构镜像索引，其 `amd64`/`arm64` 子镜像随之失效并被 Docker Hub 回收，旧版本不会再长期占用仓库空间。清理失败会让任务失败，不会静默跳过；需要观察结果时可以先本地用 `PRUNE_DRY_RUN=true` 试运行。

### 本地验证

```bash
node --test .github/scripts/docker-version.test.mjs .github/scripts/docker-prune.test.mjs
```

## 构建

在仓库根目录执行：

```bash
docker build --build-context frontend=../Sub-Store-Front-End -t dreamstation625/sub-store-27:latest .
```

指定 Node.js 版本：

```bash
docker build --build-context frontend=../Sub-Store-Front-End --build-arg NODE_VERSION=24.15.0 -t dreamstation625/sub-store-27:latest .
```

构建并推送多标签镜像：

```powershell
docker buildx build `
  --build-context frontend=../Sub-Store-Front-End `
  -t dreamstation625/sub-store-27:26.1118.01 `
  -t dreamstation625/sub-store-27:latest `
  --push .
```

## 运行

```bash
docker run -d \
  --name sub-store-27 \
  --restart unless-stopped \
  -p 3000:3000 \
  -v /vol1/1000/docker/sub-store-27:/opt/app/data \
  -e SUB_STORE_CORS_ALLOWED_ORIGINS=https://sub-store.example.com \
  dreamstation625/sub-store-27:latest
```

访问 `http://服务器IP:3000`。

`SUB_STORE_CORS_ALLOWED_ORIGINS` 必须填写浏览器实际访问前端的来源（协议、域名或 IP、端口，不含路径），多个来源用逗号分隔。未设置时使用上游默认白名单（`https://sub-store.vercel.app`、`http://substore.stash`、`https://substore.stash`），自建前端需要显式加入。

### 默认环境变量

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
