'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const POLL_MS = 15_000;
const REQUEST_TIMEOUT_MS = 8_000;

function defaultCredentialPath() {
    return process.env.AGENTNET_CREDENTIAL_FILE
        || path.join(os.homedir(), '.config', 'agentnet', 'worker.json');
}

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return fallback;
    }
}

function atomicWrite(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, file);
}

function loadCredential(file = defaultCredentialPath()) {
    const value = readJson(file, null);
    if (!value || typeof value.server !== 'string' || typeof value.device_id !== 'string'
        || typeof value.token !== 'string' || !value.token) return null;
    let server;
    try {
        server = new URL(value.server);
    } catch {
        return null;
    }
    if (!['http:', 'https:'].includes(server.protocol)) return null;
    return {
        server: server.toString().replace(/\/$/, ''),
        deviceId: value.device_id,
        token: value.token
    };
}

function decideAction(local, remote, state) {
    const localSavedAt = Number(local.savedAt) || 0;
    const remoteSavedAt = Number(remote.saved_at_ms) || 0;
    const localHasData = local.tasks.length > 0 || local.projects.length > 0;
    if (Number(remote.revision) === 0) return localHasData ? 'push' : 'idle';
    const localChanged = localSavedAt > (Number(state.saved_at_ms) || 0);
    const remoteChanged = Number(remote.revision) > (Number(state.revision) || 0);
    if (localChanged && remoteChanged) return localSavedAt > remoteSavedAt ? 'push' : 'pull';
    if (localChanged) return 'push';
    if (remoteChanged) return 'pull';
    return 'idle';
}

function createAgentNetSync(options) {
    const statePath = path.join(options.userData, 'agentnet-sync-state.json');
    const fetchImpl = options.fetch || globalThis.fetch;
    let state = readJson(statePath, { revision: 0, saved_at_ms: 0 });
    let timer = null;
    let interval = null;
    let running = null;
    let status = {
        configured: false,
        connected: false,
        syncing: false,
        revision: Number(state.revision) || 0,
        lastSync: state.last_sync || null,
        lastError: null,
        server: null
    };

    function publish(changes = {}) {
        status = { ...status, ...changes };
        if (options.onStatus) options.onStatus({ ...status });
    }

    async function request(credential, method, body) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const headers = {
                Authorization: `Bearer ${credential.token}`,
                'X-AgentNet-Device-Id': credential.deviceId,
                Accept: 'application/json'
            };
            if (body) {
                headers['Content-Type'] = 'application/json';
                headers['Idempotency-Key'] = crypto.randomUUID();
            }
            const response = await fetchImpl(`${credential.server}/api/v1/kanban`, {
                method,
                headers,
                body: body ? JSON.stringify(body) : undefined,
                signal: controller.signal
            });
            const value = await response.json().catch(() => ({}));
            if (!response.ok) {
                const error = new Error(value.error || `AgentNet respondió ${response.status}`);
                error.status = response.status;
                error.snapshot = value.snapshot;
                throw error;
            }
            return value;
        } finally {
            clearTimeout(timeout);
        }
    }

    function remember(snapshot) {
        state = {
            revision: Number(snapshot.revision) || 0,
            saved_at_ms: Number(snapshot.saved_at_ms) || 0,
            last_sync: new Date().toISOString()
        };
        atomicWrite(statePath, state);
        publish({
            configured: true,
            connected: true,
            syncing: false,
            revision: state.revision,
            lastSync: state.last_sync,
            lastError: null
        });
    }

    async function pull(snapshot) {
        await options.applyRemote({
            tasks: Array.isArray(snapshot.tasks) ? snapshot.tasks : [],
            projects: Array.isArray(snapshot.projects) ? snapshot.projects : [],
            savedAt: Number(snapshot.saved_at_ms) || Date.now()
        });
        remember(snapshot);
        return { action: 'pull', snapshot };
    }

    async function push(credential, local, remote, allowRetry = true) {
        try {
            const snapshot = await request(credential, 'PUT', {
                base_revision: Number(remote.revision) || 0,
                saved_at_ms: Number(local.savedAt) || Date.now(),
                tasks: local.tasks,
                projects: local.projects
            });
            remember(snapshot);
            return { action: 'push', snapshot };
        } catch (error) {
            if (allowRetry && error.status === 409 && error.snapshot) {
                const latest = error.snapshot;
                if ((Number(local.savedAt) || 0) > (Number(latest.saved_at_ms) || 0)) {
                    return push(credential, local, latest, false);
                }
                return pull(latest);
            }
            throw error;
        }
    }

    async function performSync() {
        const credential = loadCredential(options.credentialPath);
        if (!credential) {
            publish({
                configured: false,
                connected: false,
                syncing: false,
                lastError: 'Instala primero el puente de AgentNet en esta Mac.'
            });
            return { action: 'unconfigured' };
        }
        publish({ configured: true, syncing: true, server: credential.server, lastError: null });
        try {
            const remote = await request(credential, 'GET');
            const local = options.readLocal();
            local.tasks = Array.isArray(local.tasks) ? local.tasks : [];
            local.projects = Array.isArray(local.projects) ? local.projects : [];
            const action = decideAction(local, remote, state);
            if (action === 'pull') return await pull(remote);
            if (action === 'push') return await push(credential, local, remote);
            remember(remote);
            return { action: 'idle', snapshot: remote };
        } catch (error) {
            publish({
                connected: false,
                syncing: false,
                lastError: error.name === 'AbortError'
                    ? 'AgentNet no respondió a tiempo.'
                    : error.message
            });
            throw error;
        }
    }

    function syncNow() {
        if (!running) {
            running = performSync().finally(() => { running = null; });
        }
        return running;
    }

    function schedule(delay = 500) {
        clearTimeout(timer);
        timer = setTimeout(() => syncNow().catch(() => {}), delay);
    }

    function start() {
        schedule(1_000);
        interval = setInterval(() => syncNow().catch(() => {}), POLL_MS);
    }

    function stop() {
        clearTimeout(timer);
        clearInterval(interval);
        timer = null;
        interval = null;
    }

    return {
        start,
        stop,
        schedule,
        syncNow,
        status: () => ({ ...status })
    };
}

module.exports = { createAgentNetSync, decideAction, loadCredential };
