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

不需要安装额外依赖；客户端使用 Node.js 内置的 `fetch` 和 `WebSocket`。

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
| `maxBodyBytes` | 单次抓取响应体最大字节数，默认示例为 5 MB。 |
| `fetchTimeoutMs` | 单次抓取超时时间，单位毫秒。 |
| `reconnectMinMs` | 断线重连最小等待时间。 |
| `reconnectMaxMs` | 断线重连最大等待时间。 |
| `allowedProtocols` | 允许抓取的 URL 协议，默认只允许 `https:`。 |
| `allowedHosts` | 显式允许的主机名列表。留空表示不按域名白名单限制。 |
| `allowPrivateNetwork` | 是否允许请求内网、回环、链路本地等私有地址。默认 `false`。 |
| `maxRedirects` | 最大跳转次数。每次跳转后的 URL 都会重新校验。 |

## 启动

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
[sub-store-wss-client] connecting to wss://sub-store.example.com/ws/relay?token=***
[sub-store-wss-client] connected
```

## 在 Sub-Store 里使用

1. 启动 Sub-Store 后端。
2. 在前端生成 WSS relay token。
3. 启动 `wss-client`，确认日志显示 `connected`。
4. 回到前端，查看 WSS relay 客户端列表，应该能看到 `clientName`。
5. 在订阅、文件、同步或预览等支持 relay 的位置选择对应客户端。

当后端需要抓取订阅 URL 时，会通过 WebSocket 下发任务给选中的客户端。

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
- `allowedHosts` 可用于限制客户端只抓指定域名。

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
