const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webmanifest': 'application/manifest+json'
};

function send(res, code, body, headers = {}) {
    res.writeHead(code, {
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'same-origin',
        'X-Content-Type-Options': 'nosniff',
        ...headers
    });
    res.end(body);
}

function loadOwnerToken(file) {
    const line = fs.readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .find(value => value.startsWith('owner_token='));
    const token = line && line.slice('owner_token='.length);
    if (!token) throw new Error(`owner_token missing from ${file}`);
    return token;
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(Object.assign(new Error('request body too large'), { status: 413 }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function staticFile(urlPath) {
    const files = {
        '/': 'index.html',
        '/index.html': 'index.html',
        '/web-sync.js': 'web-sync.js',
        '/manifest.json': 'manifest.json',
        '/icon-192.png': 'icon-192.png',
        '/icon-512.png': 'icon-512.png',
        '/icon.svg': 'icon.svg'
    };
    return files[urlPath] || null;
}

function createKanbanServer(options = {}) {
    const root = options.root || ROOT;
    const agentNetOrigin = (options.agentNetOrigin || 'http://127.0.0.1:8790').replace(/\/$/, '');
    const ownerToken = options.ownerToken || loadOwnerToken(options.secretsFile);

    return http.createServer(async (req, res) => {
        const url = new URL(req.url || '/', 'http://kanban.local');
        if (url.pathname === '/health') {
            send(res, 200, JSON.stringify({ status: 'ready' }), {
                'Content-Type': 'application/json; charset=utf-8'
            });
            return;
        }
        if (url.pathname === '/api/v1/kanban') {
            if (!['GET', 'PUT'].includes(req.method || '')) {
                send(res, 405, JSON.stringify({ error: 'method not allowed' }), {
                    Allow: 'GET, PUT',
                    'Content-Type': 'application/json; charset=utf-8'
                });
                return;
            }
            try {
                const body = req.method === 'PUT' ? await readBody(req) : null;
                const headers = {
                    Accept: 'application/json',
                    Authorization: `Bearer ${ownerToken}`
                };
                if (body) {
                    headers['Content-Type'] = 'application/json';
                    headers['Idempotency-Key'] = req.headers['idempotency-key']
                        || `kanban-web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
                }
                const upstream = await fetch(`${agentNetOrigin}/api/v1/kanban`, {
                    method: req.method,
                    headers,
                    body
                });
                const value = Buffer.from(await upstream.arrayBuffer());
                send(res, upstream.status, value, {
                    'Content-Type': upstream.headers.get('content-type')
                        || 'application/json; charset=utf-8'
                });
            } catch (error) {
                const status = Number(error.status) || 502;
                send(res, status, JSON.stringify({
                    error: status === 413 ? error.message : 'AgentNet no está disponible'
                }), { 'Content-Type': 'application/json; charset=utf-8' });
            }
            return;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
            return;
        }
        const relative = staticFile(url.pathname);
        if (!relative) {
            send(res, 404, 'Not found');
            return;
        }
        fs.readFile(path.join(root, relative), (error, data) => {
            if (error) {
                send(res, error.code === 'ENOENT' ? 404 : 500, 'Not found');
                return;
            }
            const extension = path.extname(relative).toLowerCase();
            send(res, 200, req.method === 'HEAD' ? null : data, {
                'Content-Type': MIME[extension] || 'application/octet-stream'
            });
        });
    });
}

function listenAddress(value) {
    const match = String(value || '127.0.0.1:3456').match(/^(127\.0\.0\.1|localhost):(\d+)$/);
    if (!match) throw new Error('KANBAN_LISTEN must use loopback, for example 127.0.0.1:3456');
    return { host: match[1], port: Number(match[2]) };
}

if (require.main === module) {
    const address = listenAddress(process.env.KANBAN_LISTEN);
    const secretsFile = process.env.AGENTNET_SECRETS_FILE
        || path.resolve(ROOT, '..', 'agentnet', '.agentnet-runtime', 'secrets');
    const server = createKanbanServer({
        secretsFile,
        agentNetOrigin: process.env.AGENTNET_ORIGIN
    });
    server.on('error', error => {
        console.error(error.message);
        process.exitCode = 1;
    });
    server.listen(address.port, address.host, () => {
        console.log(`Kanban compartido en http://${address.host}:${address.port}`);
    });
}

module.exports = { createKanbanServer, listenAddress, loadOwnerToken };
