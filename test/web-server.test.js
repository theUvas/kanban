'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createKanbanServer, listenAddress } = require('../server');

const root = path.join(__dirname, '..');

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
}

function close(server) {
    return new Promise(resolve => server.close(resolve));
}

test('hosts the original Kanban and proxies its shared snapshot without exposing credentials', async t => {
    const original = {
        revision: 7,
        saved_at_ms: 100,
        tasks: [{ id: 1, text: 'Compartida', status: 'por-hacer', priority: 'm' }],
        projects: []
    };
    const received = [];
    const agentNet = http.createServer(async (req, res) => {
        assert.equal(req.headers.authorization, 'Bearer owner-secret');
        if (req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(original));
            return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        received.push({
            key: req.headers['idempotency-key'],
            body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...original, revision: 8, ...received[0].body }));
    });
    const agentNetPort = await listen(agentNet);
    const kanban = createKanbanServer({
        root,
        ownerToken: 'owner-secret',
        agentNetOrigin: `http://127.0.0.1:${agentNetPort}`
    });
    const kanbanPort = await listen(kanban);
    t.after(async () => {
        await close(kanban);
        await close(agentNet);
    });
    const origin = `http://127.0.0.1:${kanbanPort}`;

    const page = await fetch(origin).then(response => response.text());
    assert.match(page, /Kanban — Tareas Diarias/);
    assert.match(page, /src="web-sync\.js"/);
    assert.doesNotMatch(page, /Abrir AgentNet/);
    assert.doesNotMatch(page, /id="agentnet-bar-btn"/);
    assert.doesNotMatch(page, /id="tag-filters"[^>]*>\s*<span class="tf-label">Etiquetas/);
    assert.doesNotMatch(page, /owner-secret/);

    const bridge = await fetch(`${origin}/web-sync.js`).then(response => response.text());
    assert.match(bridge, /\/api\/v1\/kanban/);
    assert.match(bridge, /POLL_MS = 5_000/);
    assert.match(bridge, /onProjectsChanged/);

    const loaded = await fetch(`${origin}/api/v1/kanban`).then(response => response.json());
    assert.equal(loaded.revision, 7);
    const saved = await fetch(`${origin}/api/v1/kanban`, {
        method: 'PUT',
        headers: {
            'content-type': 'application/json',
            'idempotency-key': 'browser-save'
        },
        body: JSON.stringify({
            base_revision: 7,
            saved_at_ms: 200,
            tasks: original.tasks,
            projects: []
        })
    }).then(response => response.json());
    assert.equal(saved.revision, 8);
    assert.equal(received[0].key, 'browser-save');
    assert.equal(received[0].body.base_revision, 7);
});

test('the shared server refuses a non-loopback listener', () => {
    assert.deepEqual(listenAddress('127.0.0.1:8791'), { host: '127.0.0.1', port: 8791 });
    assert.throws(() => listenAddress('0.0.0.0:8791'), /loopback/);
});
