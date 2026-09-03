'use strict';

const { app, BrowserWindow, shell, Menu, Tray, ipcMain, nativeImage, systemPreferences, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { sections } = require('./tray-menu');
const googleSync = require('./google-sync');
const grokChat = require('./grok-chat');

let mainWindow = null;
let tray = null;
let tasksCache = [];
let tasksSavedAt = 0;
let projectsCache = [];
let projectsSavedAt = 0;

function tasksPath() {
    return path.join(app.getPath('userData'), 'tasks.json');
}

function projectsPath() {
    return path.join(app.getPath('userData'), 'projects.json');
}

function atomicWrite(file, text) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp';
    const bak = file + '.bak';
    fs.writeFileSync(tmp, text);
    try {
        if (fs.existsSync(file)) fs.copyFileSync(file, bak);
    } catch {
        // keep going; the rename still persists
    }
    fs.renameSync(tmp, file);
}

function unpackList(raw, key) {
    if (Array.isArray(raw)) return { savedAt: 0, list: raw };
    if (raw && Array.isArray(raw[key])) {
        return { savedAt: Number(raw.savedAt) || 0, list: raw[key] };
    }
    return { savedAt: 0, list: [] };
}

function readTasks() {
    try {
        const parsed = unpackList(JSON.parse(fs.readFileSync(tasksPath(), 'utf8')), 'tasks');
        tasksCache = parsed.list;
        tasksSavedAt = parsed.savedAt;
    } catch {
        tasksCache = Array.isArray(tasksCache) ? tasksCache : [];
    }
    return tasksCache;
}

function writeTasks(list) {
    tasksCache = Array.isArray(list) ? list : [];
    tasksSavedAt = Date.now();
    atomicWrite(tasksPath(), JSON.stringify({ savedAt: tasksSavedAt, tasks: tasksCache }, null, 2));
}

function readProjects() {
    try {
        const parsed = unpackList(JSON.parse(fs.readFileSync(projectsPath(), 'utf8')), 'projects');
        projectsCache = parsed.list;
        projectsSavedAt = parsed.savedAt;
    } catch {
        projectsCache = Array.isArray(projectsCache) ? projectsCache : [];
    }
    return projectsCache;
}

function writeProjects(list) {
    projectsCache = Array.isArray(list) ? list : [];
    projectsSavedAt = Date.now();
    atomicWrite(projectsPath(), JSON.stringify({ savedAt: projectsSavedAt, projects: projectsCache }, null, 2));
}

let googleTimer = null;
function scheduleGoogleSync() {
    if (!googleSync.status().connected) return;
    clearTimeout(googleTimer);
    googleTimer = setTimeout(() => {
        runGoogleSync().catch(() => {});
    }, 800);
}

async function runGoogleSync() {
    try {
        const result = await googleSync.syncTasks(readTasks());
        if (result.changed) {
            writeTasks(result.tasks);
            refreshMenus();
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('tasks:changed', result.tasks);
            }
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('google:status', googleSync.status());
        }
        const st = googleSync.status();
        return {
            ok: !result.error && !st.authExpired,
            ...st,
            error: result.error || st.lastError || undefined,
            pushed: result.pushed,
            removed: result.removed,
            imported: result.imported || 0,
            updatedFromCal: result.updatedFromCal || 0
        };
    } catch (err) {
        const st = googleSync.status();
        const payload = {
            ...st,
            ok: false,
            error: st.authExpired
                ? (st.lastError || 'Google Calendar se desconectó. El permiso de prueba dura 7 días: volvé a conectar.')
                : err.message
        };
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('google:status', payload);
        }
        return payload;
    }
}

function showMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
}

function openTask(id) {
    showMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tasks:open', id);
    }
}

function completeTask(id) {
    const list = readTasks();
    const task = list.find(t => t.id === id);
    if (!task || task.status === 'hecho') return;
    task.prevStatus = task.status;
    task.status = 'hecho';
    task.focused = false;
    writeTasks(list);
    refreshMenus();
    scheduleGoogleSync();
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tasks:changed', list);
    }
}

function padTime(n) {
    return String(n).padStart(2, '0');
}

function nowHHMM() {
    const n = new Date();
    return `${padTime(n.getHours())}:${padTime(n.getMinutes())}`;
}

function addMinutesHHMM(time, minutes) {
    const m = String(time || '').match(/^(\d{1,2}):(\d{2})/);
    const h0 = m ? Number(m[1]) : 0;
    const min0 = m ? Number(m[2]) : 0;
    let total = h0 * 60 + min0 + Number(minutes || 0);
    total = ((total % 1440) + 1440) % 1440;
    return `${padTime(Math.floor(total / 60))}:${padTime(total % 60)}`;
}

function todayISOLocal() {
    const n = new Date();
    return `${n.getFullYear()}-${padTime(n.getMonth() + 1)}-${padTime(n.getDate())}`;
}

function extendTask(id, minutes) {
    const list = readTasks();
    const task = list.find(t => t.id === id);
    if (!task) return;
    if (!task.due) task.due = todayISOLocal();
    if (!task.dueTime) task.dueTime = nowHHMM();
    const from = task.dueEnd || task.dueTime;
    const now = (task.due === todayISOLocal()) ? nowHHMM() : from;
    task.dueEnd = addMinutesHHMM(now > from ? now : from, minutes);
    writeTasks(list);
    refreshMenus();
    scheduleGoogleSync();
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tasks:changed', list);
    }
}

function clearFocus() {
    const list = readTasks();
    let changed = false;
    list.forEach(t => {
        if (t.focused) { t.focused = false; changed = true; }
    });
    if (!changed) return;
    writeTasks(list);
    refreshMenus();
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tasks:changed', list);
    }
}

const prioIconCache = {};
function prioIcon(key) {
    if (prioIconCache[key]) return prioIconCache[key];
    const file = { a: 'prio-alta', m: 'prio-media', b: 'prio-baja' }[key] || 'prio-media';
    const twoX = path.join(__dirname, `${file}@2x.png`);
    const oneX = path.join(__dirname, `${file}.png`);
    const image = nativeImage.createEmpty();
    if (fs.existsSync(oneX)) {
        image.addRepresentation({ scaleFactor: 1, width: 18, height: 18, buffer: fs.readFileSync(oneX) });
    }
    if (fs.existsSync(twoX)) {
        image.addRepresentation({ scaleFactor: 2, width: 18, height: 18, buffer: fs.readFileSync(twoX) });
    }
    prioIconCache[key] = image;
    return image;
}

function taskMenuItems() {
    const { groups, counts, focus } = sections(readTasks());
    const items = [];

    if (focus) {
        const it = groups[0] && groups[0].items[0];
        if (it) {
            items.push({
                label: it.label,
                sublabel: it.sublabel,
                icon: prioIcon(it.prioKey),
                toolTip: `En foco · ${it.prio} · ${it.date}`,
                submenu: [
                    { label: `En foco · ${it.date}`, enabled: false },
                    { type: 'separator' },
                    { label: 'Marcar hecha', click: () => completeTask(it.id) },
                    { label: 'Extender 15 min', click: () => extendTask(it.id, 15) },
                    { label: 'Extender 30 min', click: () => extendTask(it.id, 30) },
                    { label: 'Extender 1 hora', click: () => extendTask(it.id, 60) },
                    { type: 'separator' },
                    { label: 'Abrir', click: () => openTask(it.id) },
                    { label: 'Quitar foco', click: () => clearFocus() }
                ]
            });
        }
        return { items, counts, focus };
    }

    if (counts.overdue) {
        items.push({ label: `${counts.overdue} vencida${counts.overdue === 1 ? '' : 's'}`, enabled: false });
    }

    for (const group of groups) {
        if (group.empty) {
            items.push({ label: group.empty, enabled: false });
            continue;
        }
        if (group.header) {
            items.push({ type: 'separator' }, { type: 'header', label: group.header });
        }
        for (const it of group.items) {
            items.push({
                label: it.label,
                sublabel: it.sublabel,
                icon: prioIcon(it.prioKey),
                toolTip: `${it.prio} · ${it.date}`,
                submenu: [
                    { label: `Prioridad  ${it.prio}`, enabled: false },
                    { label: `Fecha  ${it.date}`, enabled: false },
                    { type: 'separator' },
                    { label: 'Abrir', click: () => openTask(it.id) },
                    { label: 'Marcar hecha', click: () => completeTask(it.id) }
                ]
            });
        }
        if (group.extra) {
            items.push({ label: `+${group.extra} más…`, click: () => showMainWindow() });
        }
    }

    return { items, counts, focus };
}

function buildAppMenu() {
    const { items } = taskMenuItems();
    Menu.setApplicationMenu(Menu.buildFromTemplate([
        {
            label: 'Kanban',
            submenu: [
                { role: 'about' },
                { type: 'separator' },
                { label: 'Nueva tarea', accelerator: 'Command+N', click: () => {
                    showMainWindow();
                    if (mainWindow) mainWindow.webContents.send('tasks:new');
                } },
                { label: 'Finalizar día', accelerator: 'Command+Shift+E', click: () => {
                    showMainWindow();
                    if (mainWindow) mainWindow.webContents.send('day:close');
                } },
                { type: 'separator' },
                { label: 'Refrescar', accelerator: 'Command+R', click: () => mainWindow && mainWindow.reload() },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' }
            ]
        },
        {
            label: 'Tareas',
            submenu: [
                ...items,
                { type: 'separator' },
                { label: 'Abrir tablero', accelerator: 'Command+O', click: () => showMainWindow() }
            ]
        },
        {
            label: 'Google',
            submenu: [
                { label: 'Conectar Google Calendar', click: () => connectGoogle() },
                { label: 'Sincronizar ahora', click: () => runGoogleSync() },
                { label: 'Desconectar', click: () => disconnectGoogle() }
            ]
        },
        {
            label: 'Edición',
            submenu: [
                { role: 'undo' },
                { role: 'redo' },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                { role: 'selectAll' }
            ]
        }
    ]));
}

const TRAY_GUID = '7e4c1a2b-9d83-4f0e-b5a1-0c8e6d2f4b17';

function trayIconPath() {
    const oneX = path.join(__dirname, 'trayTemplate.png');
    return fs.existsSync(oneX) ? oneX : path.join(__dirname, 'trayTemplate@2x.png');
}

function logTray(msg, extra) {
    try {
        const line = `${new Date().toISOString()} ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}\n`;
        fs.appendFileSync(path.join(app.getPath('userData'), 'tray-debug.log'), line);
    } catch {
        // ignore
    }
}

function ensureTray() {
    if (tray) return tray;
    const iconPath = trayIconPath();
    const image = nativeImage.createFromPath(iconPath);
    image.setTemplateImage(true);
    logTray('create', {
        iconPath,
        exists: fs.existsSync(iconPath),
        empty: image.isEmpty(),
        size: image.getSize()
    });
    try {
        tray = image.isEmpty()
            ? new Tray(nativeImage.createEmpty(), TRAY_GUID)
            : new Tray(iconPath, TRAY_GUID);
    } catch (err) {
        logTray('create-failed', { error: String(err && err.message || err) });
        tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
    }
    try { tray.setIgnoreDoubleClickEvents(true); } catch (e) {}
    tray.setToolTip('Kanban');
    tray.setTitle('Kanban');
    tray.on('click', () => {
        try { tray.popUpContextMenu(); } catch (e) { showMainWindow(); }
    });
    tray.on('right-click', () => {
        try { tray.popUpContextMenu(); } catch (e) {}
    });
    return tray;
}

function buildTray() {
    ensureTray();
    let items = [];
    let counts = { open: 0 };
    let focus = null;
    try {
        const packed = taskMenuItems();
        items = packed.items || [];
        counts = packed.counts || counts;
        focus = packed.focus || null;
    } catch (err) {
        logTray('menu-items', { error: String(err && err.message || err) });
    }
    try {
        const menu = Menu.buildFromTemplate([
            { label: focus ? 'En foco' : (counts.open ? `Hoy · ${counts.open}` : 'Hoy'), enabled: false },
            ...items,
            { type: 'separator' },
            { label: 'Finalizar día', click: () => {
                showMainWindow();
                if (mainWindow) mainWindow.webContents.send('day:close');
            } },
            { label: 'Nueva tarea', click: () => {
                showMainWindow();
                if (mainWindow) mainWindow.webContents.send('tasks:new');
            } },
            { label: 'Abrir Kanban', click: () => showMainWindow() },
            { type: 'separator' },
            { label: 'Salir', click: () => app.quit() }
        ]);
        tray.setContextMenu(menu);
    } catch (err) {
        logTray('context-menu', { error: String(err && err.message || err) });
        try {
            tray.setContextMenu(Menu.buildFromTemplate([
                { label: 'Abrir Kanban', click: () => showMainWindow() },
                { label: 'Salir', click: () => app.quit() }
            ]));
        } catch (e) {}
    }
    if (focus) {
        const name = String(focus.text || 'Tarea').slice(0, 28);
        tray.setTitle(' Kanban');
        tray.setToolTip(`Kanban · ${name}`);
    } else {
        tray.setTitle(counts.open ? ` ${counts.open}` : ' Kanban');
        tray.setToolTip(counts.open
            ? `Kanban · ${counts.open} para hoy`
            : 'Kanban · nada para hoy');
    }
}

function refreshMenus() {
    try { buildTray(); } catch (err) { logTray('buildTray', { error: String(err && err.message || err) }); }
    try { buildAppMenu(); } catch (err) { logTray('buildAppMenu', { error: String(err && err.message || err) }); }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1100,
        height: 750,
        minWidth: 800,
        minHeight: 500,
        title: 'Kanban — Tareas Diarias',
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 16, y: 18 },
        backgroundColor: '#F3F2EE',
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    mainWindow.once('ready-to-show', () => {
        if (mainWindow) mainWindow.show();
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

function persistTasks(list) {
    writeTasks(list);
    refreshMenus();
    scheduleGoogleSync();
    return true;
}

ipcMain.handle('tasks:save', (_event, list) => persistTasks(list));
ipcMain.on('tasks:save-sync', (event, list) => {
    persistTasks(list);
    event.returnValue = true;
});
ipcMain.handle('tasks:get', () => ({ savedAt: tasksSavedAt, tasks: readTasks() }));
ipcMain.handle('projects:get', () => ({ savedAt: projectsSavedAt, projects: readProjects() }));
ipcMain.handle('projects:save', (_event, list) => {
    writeProjects(list);
    return true;
});
ipcMain.on('projects:save-sync', (event, list) => {
    writeProjects(list);
    event.returnValue = true;
});
ipcMain.handle('google:status', () => googleSync.status());
ipcMain.handle('google:connect', () => connectGoogle());
ipcMain.handle('google:disconnect', () => disconnectGoogle());
ipcMain.handle('google:sync', () => runGoogleSync());
ipcMain.handle('grok:status', () => grokChat.status(app.getPath('userData')));
ipcMain.handle('grok:setKey', (_event, key) => {
    grokChat.saveKey(app.getPath('userData'), key);
    return { hasKey: !!grokChat.loadKey(app.getPath('userData')) };
});
ipcMain.handle('grok:chat', async (_event, payload) => {
    try {
        const result = await grokChat.chat({
            userData: app.getPath('userData'),
            message: payload && payload.message,
            history: payload && payload.history,
            tasks: readTasks(),
            projects: readProjects(),
            google: googleSync.status()
        });
        if (result.ok && Array.isArray(result.tasks) && Array.isArray(result.logs) && result.logs.length) {
            writeTasks(result.tasks);
            refreshMenus();
            scheduleGoogleSync();
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('tasks:changed', result.tasks);
            }
        }
        if (result.ok && Array.isArray(result.projects)) {
            writeProjects(result.projects);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('projects:changed', result.projects);
            }
        }
        return {
            ok: result.ok,
            text: result.text,
            error: result.error,
            needsKey: result.needsKey,
            logs: result.logs,
            history: result.history
        };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});
ipcMain.handle('grok:transcribe', async (_event, payload) => {
    try {
        return await grokChat.transcribe({
            userData: app.getPath('userData'),
            audioBase64: payload && payload.audioBase64,
            mime: payload && payload.mime,
            filename: payload && payload.filename
        });
    } catch (err) {
        return { ok: false, error: err.message };
    }
});
ipcMain.handle('grok:mic', async () => {
    if (process.platform === 'darwin' && systemPreferences && systemPreferences.getMediaAccessStatus) {
        const st = systemPreferences.getMediaAccessStatus('microphone');
        if (st === 'granted') return { ok: true, granted: true };
        if (st === 'denied' || st === 'restricted') {
            return { ok: false, granted: false, error: 'El micrófono está bloqueado. Activalo en Ajustes del Sistema → Privacidad → Micrófono.' };
        }
        const granted = await systemPreferences.askForMediaAccess('microphone');
        return granted
            ? { ok: true, granted: true }
            : { ok: false, granted: false, error: 'Sin permiso de micrófono.' };
    }
    return { ok: true, granted: true };
});

async function connectGoogle() {
    try {
        const st = await googleSync.connect();
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('google:status', st);
        }
        await runGoogleSync();
        return { ok: true, ...st };
    } catch (err) {
        const payload = { ok: false, error: err.message, ...googleSync.status() };
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('google:status', payload);
        }
        return payload;
    }
}

function disconnectGoogle() {
    const st = googleSync.disconnect();
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('google:status', st);
    }
    return { ok: true, ...st };
}

app.whenReady().then(() => {
    session.defaultSession.setPermissionCheckHandler(() => true);
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
        callback(true);
    });
    googleSync.init({
        userData: app.getPath('userData'),
        clientPath: path.join(__dirname, 'google-oauth-client.json'),
        openExternal: (url) => shell.openExternal(url)
    });
    readTasks();
    ensureTray();
    refreshMenus();
    createWindow();
    setTimeout(() => {
        try { refreshMenus(); } catch (e) {}
    }, 800);
    setTimeout(() => runGoogleSync().catch(() => {}), 1500);
    setInterval(() => runGoogleSync().catch(() => {}), 5 * 60 * 1000);

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
        else showMainWindow();
    });
});

app.on('window-all-closed', () => {
    // En Mac el extra de la barra de menú sigue vivo con la app.
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app:flush');
    }
    if (tray) {
        tray.destroy();
        tray = null;
    }
});
