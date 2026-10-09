import { expect } from 'chai';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { Buffer } from 'buffer';

// 直接运行 CLI 中的原始客户端类，避免为了测试改变客户端启动方式。
const source = fs.readFileSync(path.resolve(__dirname, '../../../../wss-client/src/index.js'), 'utf8');
const clientClass = source.slice(source.indexOf('class RelayClient'), source.indexOf('function readConfig()'));
const scope = {
    Buffer, WebSocket: { OPEN: 1 }, MAX_FRAME_BYTES: 512 * 1024, MAX_CHUNK_BYTES: 128 * 1024,
    process: { on() {} }, setTimeout, Date,
    positiveInt(value, fallback) { return Number.isInteger(value) && value > 0 ? value : fallback; },
};
vm.createContext(scope);
vm.runInContext(`${clientClass}\nglobalThis.Client = RelayClient;`, scope);

describe('WSS client response protocol', function () {
    function fixture() {
        const client = new scope.Client({ defaultTimeoutMs: 15000 });
        const messages = [];
        const ws = { readyState: 1, bufferedAmount: 0, send: (message) => messages.push(JSON.parse(message)) };
        return { client, ws, messages };
    }

    it('keeps small responses compatible with old backends', async function () {
        const { client, ws, messages } = fixture();
        await client.sendFetchResult(ws, { id: 'legacy' }, { ok: true, body: 'small-body', statusCode: 200 });
        expect(messages).to.deep.equal([{ type: 'fetch-result', id: 'legacy', ok: true, body: 'small-body', statusCode: 200 }]);
    });

    it('reports upgrade requirements without sending an oversized message to an old backend', async function () {
        const { client, ws, messages } = fixture();
        await client.sendFetchResult(ws, { id: 'old-server' }, { ok: true, body: 'x'.repeat(600 * 1024) });
        expect(messages).to.have.length(1);
        expect(messages[0].ok).to.equal(false);
        expect(messages[0].error.message).to.include('update the Sub-Store backend');
        expect(Buffer.byteLength(JSON.stringify(messages[0]))).to.be.lessThan(512 * 1024);
    });

    it('chunks UTF-8 and JSON-escaped bodies without exceeding the frame limit', async function () {
        const { client, ws, messages } = fixture();
        const body = '中文🐉\n"\\'.repeat(75000);
        await client.sendFetchResult(ws, { id: 'chunks', responseChunkBytes: 128 * 1024 }, { ok: true, body, statusCode: 200, headers: { test: 'value' } });
        expect(messages[0].type).to.equal('fetch-result-start');
        expect(messages[0].bodyBytes).to.equal(Buffer.byteLength(body));
        expect(messages[messages.length - 1].type).to.equal('fetch-result-end');
        const chunks = messages.filter((message) => message.type === 'fetch-result-chunk');
        chunks.forEach((chunk, index) => expect(chunk.index).to.equal(index));
        expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data, 'base64'))).toString('utf8')).to.equal(body);
        messages.forEach((message) => expect(Buffer.byteLength(JSON.stringify(message))).to.be.at.most(512 * 1024));
    });

    it('does not continue writing chunks to a closed connection', async function () {
        const { client, ws, messages } = fixture();
        ws.readyState = 3;
        await client.sendFetchResult(ws, { id: 'closed', responseChunkBytes: 128 * 1024 }, { ok: true, body: 'x'.repeat(600 * 1024) });
        expect(messages).to.have.length(0);
    });
});
