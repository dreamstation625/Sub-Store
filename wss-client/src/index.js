import { readConfig, RelayClient } from './client.js';

if (typeof WebSocket === 'undefined') {
    throw new Error('Global WebSocket is unavailable. Please use Node.js 22+.');
}

new RelayClient(readConfig()).start();
