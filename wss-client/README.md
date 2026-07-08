# Sub-Store WSS Client

Node client for a Sub-Store WSS relay channel. It connects to the main Sub-Store service, waits for fetch jobs, downloads subscription content, and sends the result back over WebSocket.

## Requirements

- Node.js 22 or newer. This project uses the built-in `WebSocket` and `fetch` APIs.

## Protocol

Main service to client:

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

Client to main service:

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

Failure response:

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

## Config

Copy the example config first:

```powershell
cd H:\code\Sub-Store\wss-client
Copy-Item .\config.example.json .\config.json
```

Edit `config.json`:

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

Security defaults:

- `token` is required. The token is created from the Sub-Store frontend and saved in backend settings as `wssRelayToken`; it is not read from backend environment variables.
- Only `https:` URLs are fetched by default.
- Private, loopback, link-local, multicast, and reserved IP ranges are blocked by default.
- Redirects are followed manually and each redirected URL is validated again.
- Put explicit hostnames in `allowedHosts` only when you intentionally allow them.
- Set `allowPrivateNetwork` to `true` only for a trusted private deployment.

## Run

Start with the default `config.json`:

```powershell
cd H:\code\Sub-Store\wss-client
npm start
```

Or pass a custom config path:

```powershell
npm start -- .\node-2.json
```

The token is appended to the WSS URL as `token=...` because the built-in Node WebSocket API does not expose custom request headers.
