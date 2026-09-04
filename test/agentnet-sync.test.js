'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAgentNetSync, decideAction, loadCredential } = require('../agentnet-sync');

function workspace() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-agentnet-'));
    const credentialPath = path.join(dir, 'worker.json');
    fs.writeFileSync(credentialPath, JSON.stringify({
        server: 'https://agentnet.example/',
        device_id: 'macbook-pro',
        token: 'device-secret'
    }));
    return { dir, credentialPath };
}

function reply(status, value) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => value
    };
}

test('loads the existing AgentNet worker credential without exposing the token in status', () => {
    const { credentialPath } = workspace();
    assert.deepEqual(loadCredential(credentialPath), {
        server: 'https://agentnet.example',
        deviceId: 'macbook-pro',
        token: 'device-secret'
    });
});

test('chooses the newest changed snapshot and seeds an empty server', () => {
    const local = { tasks: [{ id: 1 }], projects: [], savedAt: 100 };
    assert.equal(decideAction(local, { revision: 0, saved_at_ms: 0 }, {}), 'push');
    assert.equal(
        decideAction(local, { revision: 2, saved_at_ms: 200 }, { revision: 1, saved_at_ms: 50 }),
        'pull'
    );
    assert.equal(
        decideAction({ ...local, savedAt: 300 }, { revision: 2, saved_at_ms: 200 }, { revision: 1, saved_at_ms: 50 }),
        'push'
    );
});

test('pushes the local Kanban schema through the device-authenticated endpoint', async () => {
    const { dir, credentialPath } = workspace();
    const calls = [];
    const local = {
        savedAt: 100,
        tasks: [{ id: 1, text: 'Desde la Mac', status: 'por-hacer', priority: 'a' }],
        projects: [{ id: 2, name: 'AgentNet', status: 'activo' }]
    };
    const sync = createAgentNetSync({
        userData: dir,
        credentialPath,
        readLocal: () => ({ ...local }),
        applyRemote: async () => assert.fail('an empty server should be seeded, not pulled'),
        fetch: async (url, options) => {
            calls.push({ url, options });
            if (options.method === 'GET') {
                return reply(200, {
                    revision: 0,
                    saved_at_ms: 0,
                    tasks: [],
                    projects: []
                });
            }
            const body = JSON.parse(options.body);
            return reply(200, {
                revision: 1,
                saved_at_ms: body.saved_at_ms,
                tasks: body.tasks,
                projects: body.projects,
                source_device_id: 'macbook-pro'
            });
        }
    });

    const result = await sync.syncNow();
    assert.equal(result.action, 'push');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://agentnet.example/api/v1/kanban');
    assert.equal(calls[1].options.headers.Authorization, 'Bearer device-secret');
    assert.equal(calls[1].options.headers['X-AgentNet-Device-Id'], 'macbook-pro');
    assert.equal(JSON.parse(calls[1].options.body).tasks[0].text, 'Desde la Mac');
    assert.equal(sync.status().revision, 1);
    assert.equal(sync.status().token, undefined);
});

test('pulls a newer AgentNet revision into the native stores', async () => {
    const { dir, credentialPath } = workspace();
    let applied = null;
    const remote = {
        revision: 4,
        saved_at_ms: 400,
        tasks: [{ id: 9, text: 'Desde AgentNet', status: 'en-progreso', priority: 'm' }],
        projects: []
    };
    const sync = createAgentNetSync({
        userData: dir,
        credentialPath,
        readLocal: () => ({ savedAt: 100, tasks: [], projects: [] }),
        applyRemote: async value => { applied = value; },
        fetch: async () => reply(200, remote)
    });

    const result = await sync.syncNow();
    assert.equal(result.action, 'pull');
    assert.equal(applied.tasks[0].text, 'Desde AgentNet');
    assert.equal(applied.savedAt, 400);
    assert.equal(sync.status().connected, true);
});
