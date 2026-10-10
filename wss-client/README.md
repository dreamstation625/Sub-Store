# Sub-Store WSS Client

`wss-client` 是 Sub-Store 的 WebSocket 中继客户端。它连接到主 Sub-Store 后端，等待后端下发抓取任务，然后由客户端所在网络去请求订阅链接，再把结果通过 WebSocket 回传给后端。

适合这些场景：

- Sub-Store 后端部署在服务器上，但某些订阅源只能从家宽、内网、特定地区或代理环境访问。
- 想把下载订阅的动作交给另一台机器执行。
- 想避免主后端直接访问某些外部地址。

## 工作方式

```text
Sub-Store 后端  <==== WebSocket ====>  wss-client
      |                                  |
      | 下发 fetch 任务                  | 请求订阅 URL
      |                                  |
      | <========= 返回订阅内容 ========= |
```

默认 WebSocket 路径：

```text
/ws/relay
```

如果你的后端地址是：

```text
https://sub-store.example.com
```

那么 `wssUrl` 就是：

```text
wss://sub-store.example.com/ws/relay
```

本地测试时可以用：

```text
ws://127.0.0.1:3000/ws/relay
```

## 环境要求

- Node.js 22 或更新版本。
- 能访问你的 Sub-Store 后端 WebSocket 地址。
- 能访问需要抓取的订阅源。

不需要安装额外依赖；客户端使用 Node.js 内置的 HTTP / HTTPS 和 `WebSocket`。订阅请求将 DNS 校验得到的地址固定用于实际连接，仍使用原域名进行 Host 和 HTTPS 证书校验，并保留 gzip、deflate、br 解压支持。

## 生成连接 Token

WSS 客户端必须使用 token 连接后端。token 由 Sub-Store 前端生成并保存到后端设置里。

在前端里进入设置页面，找到 WSS / Relay 相关设置，创建或刷新 WSS relay token。复制生成的 token，填到 `wss-client/config.json` 的 `token` 字段。

如果你是直接调 API，也可以请求后端接口：

```text
POST /api/wss/token
```

已有 token 时，后端可能要求带上当前 token 才能读取或轮换。

## 配置

进入目录并复制示例配置：

```powershell
cd H:\code\Sub-Store\wss-client
Copy-Item .\config.example.json .\config.json
```

编辑 `config.json`：

```json
{
  "wssUrl": "wss://sub-store.example.com/ws/relay",
  "token": "paste-wss-token-from-frontend",
  "clientId": "node-1",
  "clientName": "Node Relay 1",
  "maxBodyBytes": 5242880,
  "fetchTimeoutMs": 15000,
  "reconnectMinMs": 1000,
  "reconnectMaxMs": 30000,
  "heartbeatIntervalMs": 30000,
  "pongTimeoutMs": 10000,
  "connectTimeoutMs": 15000,
  "maxConcurrentFetches": 4,
  "maxQueuedFetches": 32,
  "logUrlPaths": false,
  "allowedProtocols": ["https:"],
  "allowedHosts": [],
  "allowPrivateNetwork": false,
  "maxRedirects": 3
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `wssUrl` | Sub-Store 后端的 WebSocket relay 地址。公网 HTTPS 对应 `wss://域名/ws/relay`，本地 HTTP 对应 `ws://127.0.0.1:3000/ws/relay`。 |
| `token` | 前端生成的 WSS relay token，必填。 |
| `clientId` | 客户端唯一 ID。多个客户端不要重复。 |
| `clientName` | 前端里展示用的客户端名称。 |
| `maxBodyBytes` | 单次抓取响应体最大字节数，默认 5 MiB。更新后的后端总响应上限也是 5 MiB，实际使用两端上限的较小值。 |
| `fetchTimeoutMs` | 默认任务超时，单位毫秒。从收到任务开始，包含排队、DNS、所有跳转、读取和回传；后端下发的 `timeout` 可指定该任务的时间。 |
| `reconnectMinMs` | 断线重连最小等待时间。 |
| `reconnectMaxMs` | 断线重连最大等待时间。 |
| `heartbeatIntervalMs` | 心跳间隔，默认 30000 毫秒。连接建立后立即发送第一次 ping。 |
| `pongTimeoutMs` | 等待后端 pong 的超时，默认 10000 毫秒。超时主动关闭旧连接并重连，只有收到 pong 才重置重连退避。 |
| `connectTimeoutMs` | WebSocket 握手超时，默认 15000 毫秒。 |
| `maxConcurrentFetches` | 同时执行的抓取数，默认 4。 |
| `maxQueuedFetches` | 等待队列上限，默认 32；设为 0 不排队。满载时立即返回错误。断线或退出会取消该连接的所有任务。 |
| `logUrlPaths` | 默认 `false`，日志隐藏 URL 路径、所有查询值及凭据。排查时可设为 `true` 显示路径，但路径中的订阅 Token 也可能暴露。查询值仍脱敏。 |
| `allowedProtocols` | 允许抓取的 URL 协议，默认只允许 `https:`。 |
| `allowedHosts` | 精确匹配的可信主机例外，允许这些主机解析到内网地址。为兼容旧配置，这不是“仅允许这些域名”的全局白名单；其他公网主机仍可访问。 |
| `allowPrivateNetwork` | 是否允许请求内网、回环、链路本地等私有地址。默认 `false`。 |
| `maxRedirects` | 最大跳转次数，默认 3；设为 0 禁止跳转。每次跳转重新校验地址，跨源跳转移除凭据头，旧响应及时取消。 |

旧配置可以继续使用，新增字段会采用默认值。默认拒绝私有 IPv4、IPv6 回环、ULA、链路本地、映射内网地址及常见转换前缀；确需访问时使用精确的 `allowedHosts` 例外或明确开启 `allowPrivateNetwork`。请求中的 `Host` 始终取自目标 URL，URL 中的用户名 / 密码不受支持，请使用请求头传递认证信息。

## 启动

较大响应使用分块传输，仍保留后端单帧 512 KiB 限制。请同时更新后端与 `wss-client`，否则旧客户端回传大响应仍可能断线；新客户端连接旧后端时会明确提示升级，不发送超限消息。

使用默认 `config.json`：

```powershell
cd H:\code\Sub-Store\wss-client
npm start
```

使用自定义配置文件：

```powershell
npm start -- .\node-2.json
```

连接成功后会看到类似日志：

```text
[2026-10-10T12:30:45.123Z] [sub-store-wss-client] connecting to wss://sub-store.example.com/***?token=***&clientId=***&clientName=***
[2026-10-10T12:30:45.456Z] [sub-store-wss-client] connected
```

普通日志和错误日志均附带毫秒级 UTC 时间（末尾 `Z` 表示 UTC，北京时间为 UTC+8），不依赖宿主机或容器的时区配置，便于对照不同设备的连接、重连和抓取记录。URL 和 Token 仍按原规则脱敏。

## Docker 自动发布

客户端使用独立版本文件 `wss-client/VERSION`，初始版本 `26.1009.01-pre`，版本格式为 `yy.MMdd.流水号`（至少两位，从 `01` 开始），测试版加 `-pre`。

在本仓库的 `dev-dream` 分支修改客户端代码并递增该版本文件后，工作流 **WSS Client Docker 发布（VERSION）** 自动构建 amd64、arm64 镜像并推送到 `dreamstation625/sub-store-wss-client`。带 `-pre` 仅发布版本标签；不带 `-pre` 同时发布 `latest`。两个镜像的版本文件、触发条件、缓存和发布队列互相独立，不需要先构建前端。

沿用 GitHub Environment `DOCKERHUB` 的用户名和 Token；Token 必须有客户端镜像仓库的推送权限。已发布版本不会被覆盖，初次测试版不会创建 `latest`，部署时应使用 `dreamstation625/sub-store-wss-client:26.1009.01-pre`。镜像内 `/app/VERSION` 可用于查看发布版本。

完整构建、挂载配置和启动命令见 [Docker 构建和部署](../DOCKER_BUILD.md#wss-client-镜像)。真实配置由宿主机挂载到 `/app/config/config.json`；构建上下文仅允许源码和示例配置，不上传真实 Token。

## 在 Sub-Store 里使用

1. 启动 Sub-Store 后端。
2. 在前端生成 WSS relay token。
3. 启动 `wss-client`，确认日志显示 `connected`。
4. 回到前端，查看 WSS relay 客户端列表，应该能看到 `clientName`。
5. 在订阅、文件、同步或预览等支持 relay 的位置选择对应客户端。

当后端需要抓取订阅 URL 时，会通过 WebSocket 下发任务给选中的客户端。

更新后的后端会让流量查询也跟随所选节点，包括订阅更新、网页流量查询、自定义流量链接以及 Mihomo 配置文件。单订阅来源的 Mihomo 文件跟随来源订阅的节点；远程文件跟随文件自身的节点。流量缓存按本机和各个节点分别保存，过期后仍从同一路径重新获取；节点离线时不会偷偷改走后端本机。当前 WSS 协议使用 GET 获取响应头，不走 WSS 时仍保留原来的 HEAD / GET 查询方式。

## Docker 单容器部署时的地址

如果你使用本仓库的单容器 Dockerfile，前端和后端在同一个端口上，页面地址通常是：

```text
http://服务器IP:3000
```

客户端配置示例：

```json
{
  "wssUrl": "ws://服务器IP:3000/ws/relay",
  "token": "paste-wss-token-from-frontend",
  "clientId": "home-node",
  "clientName": "Home Node",
  "allowedProtocols": ["https:"],
  "allowPrivateNetwork": false
}
```

如果外面套了 HTTPS 反向代理：

```json
{
  "wssUrl": "wss://你的域名/ws/relay",
  "token": "paste-wss-token-from-frontend",
  "clientId": "home-node",
  "clientName": "Home Node"
}
```

反向代理需要支持 WebSocket upgrade。

## 安全建议

- 不要把 `config.json` 提交到 Git。
- `token` 泄露后应立即在前端刷新 token。
- 默认只允许抓取 `https:`，不建议随意加入 `http:`。
- 默认禁止访问私有网络地址，除非你明确需要抓内网资源。
- 如果开启 `allowPrivateNetwork: true`，请只在可信环境使用。
- `allowedHosts` 不是全局域名白名单；只添加你确认可信、需要访问内网地址的主机。
- 跨源跳转不转发 Authorization、Cookie 和常见 Token / API Key 等凭据头。需要另一域名的认证时，请直接使用该域名的订阅地址。
- 默认隐藏日志路径；不要在含有路径 Token 的订阅上随意开启 `logUrlPaths`。

## 回归测试

在 `wss-client` 目录运行 `npm run check` 和 `npm test`。测试不使用真实订阅或公网，覆盖固定 DNS 地址连接、IPv6 校验、跳转凭据保护、压缩响应限额、任务取消和限流、心跳及握手超时、日志脱敏和回传背压。客户端 Docker 发布前也会执行这些测试。

## 协议简述

后端下发任务：

```json
{
  "type": "fetch",
  "id": "request-id",
  "url": "https://example.com/sub",
  "uac": "clash.meta/v1.19.25",
  "headers": {
    "accept": "*/*"
  },
  "timeout": 15000
}
```

客户端返回成功：

```json
{
  "type": "fetch-result",
  "id": "request-id",
  "ok": true,
  "statusCode": 200,
  "headers": {},
  "body": "subscription content"
}
```

客户端返回失败：

```json
{
  "type": "fetch-result",
  "id": "request-id",
  "ok": false,
  "error": {
    "message": "error detail"
  }
}
```

## 常见问题

### 连接后马上断开

检查 `token` 是否正确，后端是否已经生成 WSS relay token。

### 本地 HTTP 地址应该用 ws 还是 wss

HTTP 后端用 `ws://`：

```text
ws://127.0.0.1:3000/ws/relay
```

HTTPS 后端用 `wss://`：

```text
wss://sub-store.example.com/ws/relay
```

### 反向代理后连接不上

确认代理已转发 WebSocket upgrade 头，并且 `/ws/relay` 没有被前端静态页面路由吃掉。

### 抓取内网订阅失败

默认会阻止私有网络地址。确认安全后，在 `config.json` 中设置：

```json
{
  "allowPrivateNetwork": true
}
```

### 响应体太大

调大 `maxBodyBytes`，例如 20 MB：

```json
{
  "maxBodyBytes": 20971520
}
```
