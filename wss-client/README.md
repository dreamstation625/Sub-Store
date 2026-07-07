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
  "uac": "clash.meta/v1.19.23",
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
  "token": "change-me",
  "clientId": "node-1",
  "clientName": "Node Relay 1",
  "maxBodyBytes": 5242880,
  "fetchTimeoutMs": 15000,
  "reconnectMinMs": 1000,
  "reconnectMaxMs": 30000
}
```

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
