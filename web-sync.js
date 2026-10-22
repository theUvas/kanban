'use strict';

(() => {
    if (!/^https?:$/.test(window.location.protocol) || window.kanbanNative) return;

    window.kanbanHosted = true;
    const API = '/api/v1/kanban';
    const POLL_MS = 5_000;
    const SAVE_DELAY_MS = 300;
    const taskListeners = new Set();
    const projectListeners = new Set();
    let snapshot = {
        revision: 0,
        saved_at_ms: 0,
        tasks: [],
        projects: []
    };
    let localTasks = [];
    let localProjects = [];
    let loaded = false;
    let dirty = false;
    let changeVersion = 0;
    let initialLoad = null;
    let saveTimer = null;
    let running = null;
    let connected = false;
    let lastError = null;

    const clone = value => JSON.parse(JSON.stringify(value));
    const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
    const itemKey = item => `${typeof item?.id}:${String(item?.id)}`;

    function status() {
        return {
            configured: true,
            connected,
            syncing: !!running,
            revision: Number(snapshot.revision) || 0,
            lastSync: snapshot.updated_at || null,
            lastError,
            server: window.location.origin
        };
    }

    function idempotencyKey() {
        if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
            return globalThis.crypto.randomUUID();
        }
        return `kanban-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    async function request(method = 'GET', body) {
        const headers = { Accept: 'application/json' };
        if (body) {
            headers['Content-Type'] = 'application/json';
            headers['Idempotency-Key'] = idempotencyKey();
        }
        const response = await fetch(API, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
            cache: 'no-store'
        });
        const value = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(value.error || `Kanban respondió ${response.status}`);
            error.status = response.status;
            error.snapshot = value.snapshot;
            throw error;
        }
        return value;
    }

    function remember(remote, notify = false) {
        snapshot = clone(remote);
        localTasks = clone(Array.isArray(remote.tasks) ? remote.tasks : []);
        localProjects = clone(Array.isArray(remote.projects) ? remote.projects : []);
        loaded = true;
        connected = true;
        lastError = null;
        if (notify) {
            for (const listener of taskListeners) listener(clone(localTasks));
            for (const listener of projectListeners) listener(clone(localProjects));
        }
    }

    async function ensureLoaded() {
        if (!initialLoad) {
            initialLoad = request()
                .then(remote => {
                    remember(remote);
                    return remote;
                })
                .catch(error => {
                    connected = false;
                    lastError = error.message;
                    throw error;
                });
        }
        return initialLoad;
    }

    function remapNewCollisions(base, local, remote) {
        const baseIds = new Set(base.map(itemKey));
        const remoteById = new Map(remote.map(item => [itemKey(item), item]));
        let nextId = Math.max(0, ...remote.concat(local)
            .map(item => Number.isSafeInteger(item?.id) ? item.id : 0));
        const remapped = new Map();
        const list = local.map(item => {
            const key = itemKey(item);
            const collision = !baseIds.has(key) && remoteById.has(key)
                && !same(remoteById.get(key), item);
            if (!collision) return clone(item);
            const copy = clone(item);
            const oldId = copy.id;
            copy.id = ++nextId;
            remapped.set(String(oldId), copy.id);
            return copy;
        });
        return { list, remapped };
    }

    function mergeList(base, local, remote) {
        const baseById = new Map(base.map(item => [itemKey(item), item]));
        const localById = new Map(local.map(item => [itemKey(item), item]));
        const result = remote
            .filter(item => !(baseById.has(itemKey(item)) && !localById.has(itemKey(item))))
            .map(clone);
        const resultIndex = new Map(result.map((item, index) => [itemKey(item), index]));
        for (const item of local) {
            const key = itemKey(item);
            const before = baseById.get(key);
            if (before && same(before, item)) continue;
            if (resultIndex.has(key)) result[resultIndex.get(key)] = clone(item);
            else {
                resultIndex.set(key, result.length);
                result.push(clone(item));
            }
        }
        return result;
    }

    function mergeConflict(base, local, remote) {
        const projectCollision = remapNewCollisions(
            base.projects || [], local.projects || [], remote.projects || []
        );
        const adjustedTasks = clone(local.tasks || []).map(task => {
            const replacement = projectCollision.remapped.get(String(task.projectId));
            return replacement == null ? task : { ...task, projectId: replacement };
        });
        const taskCollision = remapNewCollisions(
            base.tasks || [], adjustedTasks, remote.tasks || []
        );
        return {
            tasks: mergeList(base.tasks || [], taskCollision.list, remote.tasks || []),
            projects: mergeList(
                base.projects || [], projectCollision.list, remote.projects || []
            )
        };
    }

    async function commit(base, local) {
        let currentBase = clone(base);
        let currentLocal = clone(local);
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                return await request('PUT', {
                    base_revision: Number(currentBase.revision) || 0,
                    saved_at_ms: Date.now(),
                    tasks: currentLocal.tasks,
                    projects: currentLocal.projects
                });
            } catch (error) {
                if (error.status !== 409 || !error.snapshot || attempt === 2) throw error;
                currentLocal = mergeConflict(currentBase, currentLocal, error.snapshot);
                currentBase = clone(error.snapshot);
            }
        }
        throw new Error('No se pudo guardar el Kanban compartido');
    }

    async function pushChanges() {
        if (!loaded || !dirty) return { action: 'idle', snapshot };
        const startedVersion = changeVersion;
        const base = clone(snapshot);
        const local = { tasks: clone(localTasks), projects: clone(localProjects) };
        const remote = await commit(base, local);
        snapshot = clone(remote);
        connected = true;
        lastError = null;
        if (changeVersion === startedVersion) {
            const changedDuringMerge = !same(local.tasks, remote.tasks)
                || !same(local.projects, remote.projects);
            dirty = false;
            localTasks = clone(remote.tasks || []);
            localProjects = clone(remote.projects || []);
            if (changedDuringMerge) remember(remote, true);
        } else {
            scheduleSave();
        }
        return { action: 'push', snapshot: remote };
    }

    async function pullChanges() {
        await ensureLoaded();
        if (dirty) return pushChanges();
        const remote = await request();
        if (Number(remote.revision) > Number(snapshot.revision)) {
            remember(remote, true);
            return { action: 'pull', snapshot: remote };
        }
        connected = true;
        lastError = null;
        return { action: 'idle', snapshot: remote };
    }

    function runSync() {
        if (!running) {
            running = (dirty ? pushChanges() : pullChanges())
                .catch(error => {
                    connected = false;
                    lastError = error.message;
                    throw error;
                })
                .finally(() => { running = null; });
        }
        return running;
    }

    function scheduleSave() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => runSync().catch(() => {}), SAVE_DELAY_MS);
    }

    function setTasks(list) {
        if (!Array.isArray(list) || same(localTasks, list)) return;
        localTasks = clone(list);
        dirty = true;
        changeVersion += 1;
        scheduleSave();
    }

    function setProjects(list) {
        if (!Array.isArray(list) || same(localProjects, list)) return;
        localProjects = clone(list);
        dirty = true;
        changeVersion += 1;
        scheduleSave();
    }

    window.kanbanNative = {
        async getTasks() {
            await ensureLoaded();
            return { savedAt: Number(snapshot.saved_at_ms) || 0, tasks: clone(localTasks) };
        },
        async getProjects() {
            await ensureLoaded();
            return { savedAt: Number(snapshot.saved_at_ms) || 0, projects: clone(localProjects) };
        },
        saveTasks(list) {
            setTasks(list);
            return Promise.resolve({ ok: true });
        },
        saveProjects(list) {
            setProjects(list);
            return Promise.resolve({ ok: true });
        },
        acceptInitialState(tasks, projects) {
            if (Array.isArray(tasks)) localTasks = clone(tasks);
            if (Array.isArray(projects)) localProjects = clone(projects);
        },
        onChanged(listener) {
            taskListeners.add(listener);
            return () => taskListeners.delete(listener);
        },
        onProjectsChanged(listener) {
            projectListeners.add(listener);
            return () => projectListeners.delete(listener);
        },
        onOpenTask() { return () => {}; },
        onNewTask() { return () => {}; },
        onFlush(listener) {
            const handler = () => listener();
            window.addEventListener('pagehide', handler);
            return () => window.removeEventListener('pagehide', handler);
        },
        agentNetStatus() { return Promise.resolve(status()); },
        agentNetSync() { return runSync(); }
    };

    setInterval(() => runSync().catch(() => {}), POLL_MS);
})();
