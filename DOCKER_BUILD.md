# Docker 构建和部署

本文记录本仓库 Docker 镜像的构建和运行方式，包括 Sub-Store 后端/前端单容器镜像，以及 `wss-client` 中继客户端镜像。

## 后端单容器镜像

根目录的 `Dockerfile` 会在构建时完成两部分：

- 构建 `backend`，输出 `/opt/app/sub-store.bundle.js`
- 构建前端静态文件，输出到 `/opt/app/frontend`

运行时默认监听 `3000` 端口，并把数据目录放在 `/opt/app/data`。

### 构建

在仓库根目录执行：

```bash
docker build -t dreamstation625/sub-store:latest .
```

如果需要指定 Node.js 版本：

```bash
docker build --build-arg NODE_VERSION=22.16.0 -t dreamstation625/sub-store:latest .
```

### 运行

```bash
docker run -d \
  --name sub-store \
  --restart unless-stopped \
  -p 3000:3000 \
  -v /vol1/1000/docker/sub-store:/opt/app/data \
  dreamstation625/sub-store:latest
```

访问地址：

```text
http://服务器IP:3000
```

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
