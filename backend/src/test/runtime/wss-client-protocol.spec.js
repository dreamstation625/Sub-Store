import { expect } from 'chai';
import path from 'path';
import { Buffer } from 'buffer';
import { pathToFileURL } from 'url';

describe('WSS client response protocol', function () {
    let Client;
    before(async function () {
        // 保留原生 ESM 导入，避免后端 Babel 将客户端模块转换为 require。
        const nativeImport = new Function('specifier', 'return import(specifier)');
        ({ RelayClient: Client } = await nativeImport(pathToFileURL(path.resolve(__dirname, '../../../../wss-client/src/client.js')).href));
    });
    function fixture() {
        const client = new Client({ defaultTimeoutMs: 15000 }, { handleSignals: false });
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
