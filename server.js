const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3456;
const IP = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;

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
    res.writeHead(code, headers);
    res.end(body);
}

const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    let filePath = urlPath === '/' ? '/index.html' : urlPath;
    filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
    const abs = path.join(ROOT, filePath);

    if (!abs.startsWith(ROOT)) {
        send(res, 403, 'Forbidden');
        return;
    }

    fs.readFile(abs, (err, data) => {
        if (err) {
            send(res, err.code === 'ENOENT' ? 404 : 500, err.code === 'ENOENT' ? 'Not found' : 'Error');
            return;
        }
        const ext = path.extname(abs).toLowerCase();
        send(res, 200, data, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    });
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Puerto ${PORT} ocupado. El Kanban nativo no necesita este servidor.`);
        process.exit(0);
    }
    throw err;
});

server.listen(PORT, IP, () => {
    console.log(`\n📋 Kanban en el navegador: http://${IP}:${PORT}`);
    console.log('   Presiona Ctrl+C para detener\n');
});
