'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL, URLSearchParams } = require('url');

const CALENDAR_SCOPES = [
    'https://www.googleapis.com/auth/calendar.events'
];
const SCOPES = CALENDAR_SCOPES.join(' ');

function hasCalendarScope(tokens) {
    const s = String((tokens && tokens.scope) || '');
    return CALENDAR_SCOPES.some(sc => s.includes(sc)) || s.includes('googleapis.com/auth/calendar');
}

const COLOR = { a: '11', m: '5', b: '8' };
const PRIO = { a: 'Alta', m: 'Media', b: 'Baja' };
const AUTH_EXPIRED_MSG = 'Google Calendar se desconectó. El permiso de prueba dura 7 días: volvé a conectar.';

let refreshInFlight = null;

function authErrorText(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch { return String(value); }
}

function isAuthError(value) {
    const s = authErrorText(value).toLowerCase();
    return s.includes('invalid_grant')
        || s.includes('expired or revoked')
        || s.includes('invalid authentication credentials')
        || s.includes('expected oauth 2 access token')
        || s.includes('unauthenticated')
        || s.includes('invalid_token');
}

function markAuthExpired() {
    saveState({ lastError: AUTH_EXPIRED_MSG, authExpired: true });
}

function clearAuthExpired() {
    saveState({ lastError: null, authExpired: false });
}

let shellOpen = null;
let userData = '';
let clientPath = '';

function tokensPath() {
    return path.join(userData, 'google-tokens.json');
}

function statePath() {
    return path.join(userData, 'google-state.json');
}

function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function loadClient() {
    const data = readJson(clientPath, null);
    const blob = data && (data.installed || data.web);
    if (!blob || !blob.client_id) throw new Error('No encontré el Client ID de Google.');
    return blob;
}

function loadTokens() {
    return readJson(tokensPath(), null);
}

function saveTokens(tokens) {
    writeJson(tokensPath(), tokens);
}

function loadState() {
    return readJson(statePath(), {});
}

function saveState(partial) {
    writeJson(statePath(), { ...loadState(), ...partial });
}

function b64url(buf) {
    return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function addDaysISO(iso, days) {
    const d = new Date(String(iso).slice(0, 10) + 'T12:00:00');
    d.setDate(d.getDate() + days);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function nextDate(iso) {
    return addDaysISO(iso, 1);
}

function pad(n) {
    return String(n).padStart(2, '0');
}

function isoDate(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localTz() {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
        return 'UTC';
    }
}

function normalizeTime(s) {
    const m = String(s || '').match(/^(\d{1,2}):(\d{2})/);
    if (!m) return '';
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return '';
    return `${pad(h)}:${pad(min)}`;
}

function addMinutesHHMM(time, minutes) {
    const [h, m] = String(time).split(':').map(Number);
    let total = h * 60 + m + minutes;
    const extraDays = Math.floor(total / 1440);
    total = ((total % 1440) + 1440) % 1440;
    return { time: `${pad(Math.floor(total / 60))}:${pad(total % 60)}`, extraDays };
}

function eventClock(bound) {
    if (!bound || !bound.dateTime) return '';
    const s = String(bound.dateTime);
    const m = s.match(/T(\d{2}):(\d{2})/);
    if (m) return `${m[1]}:${m[2]}`;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return '';
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function stripHoraNote(notes) {
    return String(notes || '')
        .replace(/^\s*Hora:\s*\d{1,2}:\d{2}(?:\s*[-–]\s*\d{1,2}:\d{2})?\s*\n?/i, '')
        .trim();
}

function asTimed(startDT, endDT, tz) {
    // `date: null` is required on PATCH: otherwise an all-day event keeps
    // start.date and Google answers "Invalid start time."
    return {
        start: { date: null, dateTime: startDT, timeZone: tz },
        end: { date: null, dateTime: endDT, timeZone: tz }
    };
}

function asAllDay(startDate, endDate) {
    return {
        start: { date: startDate, dateTime: null },
        end: { date: endDate, dateTime: null }
    };
}

function timedBounds(due, startTime, endTime, tz) {
    const startDT = `${due}T${startTime}:00`;
    let endDate = due;
    let endHH = endTime;
    if (endHH && endHH <= startTime) {
        endDate = nextDate(due);
    } else if (!endHH) {
        const shifted = addMinutesHHMM(startTime, 60);
        endHH = shifted.time;
        if (shifted.extraDays) endDate = nextDate(due);
    }
    return asTimed(startDT, `${endDate}T${endHH}:00`, tz);
}

function daysBetween(from, to) {
    const a = new Date(String(from).slice(0, 10) + 'T12:00:00');
    const b = new Date(String(to).slice(0, 10) + 'T12:00:00');
    return Math.round((b - a) / 86400000);
}

function shiftDateTimeString(iso, offsetDays) {
    const s = String(iso || '');
    const datePart = s.slice(0, 10);
    const rest = s.slice(10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart) || !rest) {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return iso;
        d.setDate(d.getDate() + offsetDays);
        return d.toISOString();
    }
    return addDaysISO(datePart, offsetDays) + rest;
}

function boundsForDue(start, end, due) {
    if (start && start.dateTime) {
        const old = String(start.dateTime).slice(0, 10);
        const offset = /^\d{4}-\d{2}-\d{2}$/.test(old) ? daysBetween(old, due) : 0;
        const tz = start.timeZone || (end && end.timeZone) || localTz();
        const startDT = shiftDateTimeString(start.dateTime, offset);
        const endDT = end && end.dateTime
            ? shiftDateTimeString(end.dateTime, offset)
            : startDT;
        return asTimed(startDT, endDT, tz);
    }
    if (start && start.date) {
        const old = String(start.date).slice(0, 10);
        const offset = /^\d{4}-\d{2}-\d{2}$/.test(old) ? daysBetween(old, due) : 0;
        const newEnd = end && end.date
            ? addDaysISO(String(end.date).slice(0, 10), offset)
            : nextDate(due);
        return asAllDay(due, newEnd);
    }
    return asAllDay(due, nextDate(due));
}

function eventBody(task) {
    const prio = PRIO[task.priority] || 'Media';
    const notes = stripHoraNote(task.notes);
    const desc = [notes, '', `Kanban · prioridad ${prio}`].filter((x, i, a) => !(x === '' && i === 0)).join('\n').trim();
    const time = normalizeTime(task.dueTime);
    const endTime = normalizeTime(task.dueEnd);
    const bounds = time
        ? timedBounds(task.due, time, endTime, localTz())
        : asAllDay(task.due, nextDate(task.due));
    return {
        summary: String(task.text || 'Tarea Kanban').slice(0, 250),
        description: desc,
        start: bounds.start,
        end: bounds.end,
        colorId: COLOR[task.priority] || COLOR.m,
        extendedProperties: {
            private: {
                kanbanId: String(task.id),
                kanbanSource: 'kanban-app'
            }
        }
    };
}

function init(opts) {
    userData = opts.userData;
    clientPath = opts.clientPath;
    shellOpen = opts.openExternal;
}

function status() {
    const tokens = loadTokens();
    const st = loadState();
    const authExpired = !!st.authExpired;
    const connected = !!(tokens && tokens.refresh_token && hasCalendarScope(tokens) && !authExpired);
    return {
        connected,
        authExpired,
        email: st.email || null,
        lastSync: st.lastSync || null,
        lastError: st.lastError || null,
        needsCalendar: !!(tokens && tokens.refresh_token && !hasCalendarScope(tokens))
    };
}

async function api(method, url, body, retried) {
    const access = await getAccessToken({ force: !!retried });
    const res = await fetch(url, {
        method,
        headers: {
            Authorization: `Bearer ${access}`,
            'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 204) return null;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
        const msg = (data && (data.error_description || data.error && data.error.message || data.error)) || text || res.status;
        if ((res.status === 401 || res.status === 403) && !retried) {
            return api(method, url, body, true);
        }
        if (res.status === 401 || isAuthError(msg)) markAuthExpired();
        const err = new Error(isAuthError(msg) ? AUTH_EXPIRED_MSG : (typeof msg === 'string' ? msg : JSON.stringify(msg)));
        err.status = res.status;
        throw err;
    }
    return data;
}

async function getAccessToken(opts) {
    const force = !!(opts && opts.force);
    const tokens = loadTokens();
    if (!tokens || !tokens.refresh_token) throw new Error('Google Calendar no está conectado.');
    const st = loadState();
    if (st.authExpired && !force) throw new Error(AUTH_EXPIRED_MSG);
    const now = Date.now();
    if (!force && tokens.access_token && tokens.expiry && tokens.expiry > now + 60000) {
        return tokens.access_token;
    }
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
        const client = loadClient();
        const body = new URLSearchParams({
            client_id: client.client_id,
            client_secret: client.client_secret || '',
            refresh_token: tokens.refresh_token,
            grant_type: 'refresh_token'
        });
        const res = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body
        });
        const data = await res.json();
        if (!res.ok || !data.access_token) {
            const detail = data.error_description || data.error || 'No pude renovar el token de Google.';
            if (isAuthError(detail) || data.error === 'invalid_grant') {
                markAuthExpired();
                throw new Error(AUTH_EXPIRED_MSG);
            }
            throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
        }
        saveTokens({
            ...tokens,
            access_token: data.access_token,
            expiry: Date.now() + ((data.expires_in || 3600) * 1000),
            scope: data.scope || tokens.scope
        });
        clearAuthExpired();
        return data.access_token;
    })();
    try {
        return await refreshInFlight;
    } finally {
        refreshInFlight = null;
    }
}

async function listenAndAuth() {
    const client = loadClient();
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));

    const { server, port } = await new Promise((resolve, reject) => {
        const srv = http.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => resolve({ server: srv, port: srv.address().port }));
    });

    const redirectUri = `http://127.0.0.1:${port}/oauth`;
    const codePromise = new Promise((resolve, reject) => {
        const t = setTimeout(() => {
            try { server.close(); } catch {}
            reject(new Error('Se agotó el tiempo para autorizar Google (5 min).'));
        }, 300000);
        server.on('request', (req, res) => {
            const u = new URL(req.url, redirectUri);
            if (u.pathname !== '/oauth') {
                res.writeHead(404); res.end(); return;
            }
            const err = u.searchParams.get('error');
            const code = u.searchParams.get('code');
            const st = u.searchParams.get('state');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            if (err || !code || st !== state) {
                res.end(`<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:48px">No se pudo conectar${err ? ': ' + err : ''}. Cerrá esta ventana e intentá de nuevo.</body>`);
                clearTimeout(t);
                server.close();
                reject(new Error(err || 'Google no devolvió un código válido.'));
                return;
            }
            res.end('<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:48px;max-width:440px"><h2 style="margin:0 0 8px">Kanban conectado</h2><p>Ya podés cerrar esta ventana y volver a la app.</p></body>');
            clearTimeout(t);
            server.close();
            resolve(code);
        });
    });

    const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    auth.search = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES,
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'false',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256'
    }).toString();

    if (shellOpen) shellOpen(auth.toString());
    const code = await codePromise;

    const body = new URLSearchParams({
        client_id: client.client_id,
        client_secret: client.client_secret || '',
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code_verifier: verifier
    });
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) {
        throw new Error(data.error_description || data.error || 'Google no entregó el token.');
    }
    const merged = {
        access_token: data.access_token,
        refresh_token: data.refresh_token || (loadTokens() || {}).refresh_token,
        expiry: Date.now() + ((data.expires_in || 3600) * 1000),
        scope: data.scope || ''
    };
    saveTokens(merged);
    if (!merged.refresh_token) {
        throw new Error('Google no envió refresh token. Volvé a conectar y aceptá los permisos.');
    }
    if (!hasCalendarScope(merged)) {
        saveState({ lastError: 'Google no concedió Calendar. En la pantalla de permisos tenés que dejar marcado Calendar.' });
        throw new Error('Google no dio permiso de Calendar. Volvé a conectar y dejá marcado Calendar (no solo el email).');
    }
    let email = null;
    try {
        const cal = await api('GET', 'https://www.googleapis.com/calendar/v3/calendars/primary');
        email = cal && cal.id;
    } catch {
        email = null;
    }
    saveState({ email, lastError: null, authExpired: false, connectedAt: new Date().toISOString() });
    return status();
}

async function connect() {
    try { fs.unlinkSync(tokensPath()); } catch {}
    return listenAndAuth();
}

function disconnect() {
    try { fs.unlinkSync(tokensPath()); } catch {}
    saveState({ email: null, lastError: null, lastSync: null, authExpired: false });
    return status();
}

function shouldPush(task) {
    return task && task.status !== 'hecho' && /^\d{4}-\d{2}-\d{2}$/.test(String(task.due || ''));
}

function eventDue(ev) {
    const start = ev && ev.start || {};
    if (start.date) return String(start.date).slice(0, 10);
    if (start.dateTime) return String(start.dateTime).slice(0, 10);
    return '';
}

function isKanbanOrigin(ev) {
    const priv = ev && ev.extendedProperties && ev.extendedProperties.private || {};
    return priv.kanbanSource === 'kanban-app';
}

async function listCalendarEvents() {
    const now = new Date();
    const from = new Date(now);
    from.setDate(from.getDate() - 7);
    const to = new Date(now);
    to.setDate(to.getDate() + 60);
    const items = [];
    let pageToken = '';
    for (let i = 0; i < 8; i++) {
        const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
        url.search = new URLSearchParams({
            singleEvents: 'true',
            orderBy: 'startTime',
            maxResults: '250',
            timeMin: from.toISOString(),
            timeMax: to.toISOString(),
            ...(pageToken ? { pageToken } : {})
        }).toString();
        const data = await api('GET', url.toString());
        items.push(...(data.items || []));
        pageToken = data.nextPageToken || '';
        if (!pageToken) break;
    }
    return items.filter(ev => ev && ev.status !== 'cancelled' && eventDue(ev));
}

function mergeCalendarEvents(tasks, events) {
    const out = Array.isArray(tasks) ? tasks.map(t => ({ ...t })) : [];
    const byEvent = new Map();
    let maxId = 0;
    for (const t of out) {
        if (t.googleEventId) byEvent.set(String(t.googleEventId), t);
        if (typeof t.id === 'number' && t.id > maxId) maxId = t.id;
    }
    let imported = 0;
    let updated = 0;
    for (const ev of events) {
        if (isKanbanOrigin(ev)) continue;
        const due = eventDue(ev);
        const title = String(ev.summary || 'Evento de Calendar').slice(0, 250);
        const dueTime = eventClock(ev.start);
        const dueEnd = eventClock(ev.end);
        const desc = String(ev.description || '').trim();
        const loc = String(ev.location || '').trim();
        const notes = [loc ? `Lugar: ${loc}` : '', desc].filter(Boolean).join('\n');
        const existing = byEvent.get(String(ev.id));
        if (existing) {
            const localMs = Number(existing.updatedAt) || 0;
            const googleMs = Date.parse(ev.updated || ev.created || '') || 0;
            if (localMs && googleMs && localMs >= googleMs) {
                existing.googleFromCalendar = true;
                existing.googleStart = ev.start || existing.googleStart || null;
                existing.googleEnd = ev.end || existing.googleEnd || null;
                continue;
            }
            let changed = false;
            if (existing.text !== title) { existing.text = title; changed = true; }
            if (existing.due !== due) { existing.due = due; changed = true; }
            if ((existing.dueTime || '') !== dueTime) { existing.dueTime = dueTime; changed = true; }
            if ((existing.dueEnd || '') !== dueEnd) { existing.dueEnd = dueEnd; changed = true; }
            const cleanedNotes = stripHoraNote(notes);
            if ((existing.notes || '') !== cleanedNotes) { existing.notes = cleanedNotes; changed = true; }
            existing.googleFromCalendar = true;
            existing.googleStart = ev.start || existing.googleStart || null;
            existing.googleEnd = ev.end || existing.googleEnd || null;
            if (Array.isArray(existing.tags) && existing.tags.includes('gcal')) {
                existing.tags = existing.tags.filter(t => t !== 'gcal');
                changed = true;
            }
            if (changed) updated++;
            continue;
        }
        maxId += 1;
        const task = {
            id: maxId,
            text: title,
            status: 'por-hacer',
            priority: 'm',
            due,
            dueTime,
            dueEnd,
            notes,
            date: isoDate(new Date()),
            tags: [],
            subtasks: [],
            order: out.length,
            prevStatus: null,
            googleEventId: ev.id,
            googleFromCalendar: true,
            googleStart: ev.start || null,
            googleEnd: ev.end || null
        };
        out.push(task);
        byEvent.set(String(ev.id), task);
        imported++;
    }
    return { tasks: out, imported, updated };
}

async function deleteEvent(eventId) {
    try {
        await api('DELETE', `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`);
    } catch (err) {
        if (err.status === 404 || err.status === 410) return;
        throw err;
    }
}

async function upsertEvent(task) {
    const body = eventBody(task);
    if (task.googleEventId) {
        try {
            const updated = await api('PATCH', `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(task.googleEventId)}`, body);
            return updated.id;
        } catch (err) {
            if (err.status === 400) {
                // All-day ↔ timed conversion can still 400; recreate as the right type.
                await deleteEvent(task.googleEventId);
            } else if (err.status !== 404 && err.status !== 410) {
                throw err;
            }
        }
    }
    const created = await api('POST', 'https://www.googleapis.com/calendar/v3/calendars/primary/events', stripNullFields(body));
    return created.id;
}

function stripNullFields(value) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(stripNullFields);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        if (v === null) continue;
        out[k] = (v && typeof v === 'object') ? stripNullFields(v) : v;
    }
    return out;
}

async function patchImportedSchedule(task) {
    if (!task.googleEventId || !shouldPush(task)) return false;
    let start = task.googleStart;
    let end = task.googleEnd;
    if (!start) {
        try {
            const ev = await api('GET', `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(task.googleEventId)}`);
            start = ev && ev.start;
            end = ev && ev.end;
            task.googleStart = start || null;
            task.googleEnd = end || null;
        } catch (err) {
            if (err.status === 404 || err.status === 410) return false;
            throw err;
        }
    }
    const currentDue = eventDue({ start });
    const currentStart = eventClock(start);
    const currentEnd = eventClock(end);
    const wantTime = normalizeTime(task.dueTime);
    const wantEnd = normalizeTime(task.dueEnd);
    if (!currentDue) return false;
    const sameDay = currentDue === task.due;
    const sameStart = currentStart === wantTime;
    const sameEnd = !wantEnd || currentEnd === wantEnd;
    if (sameDay && sameStart && sameEnd) return false;

    let body;
    if (wantTime) {
        const tz = (start && start.timeZone) || (end && end.timeZone) || localTz();
        if (wantEnd) {
            body = timedBounds(task.due, wantTime, wantEnd, tz);
        } else if (start && start.dateTime && end && end.dateTime) {
            const dur = new Date(end.dateTime) - new Date(start.dateTime);
            const mins = Number.isFinite(dur) && dur > 0 ? Math.round(dur / 60000) : 60;
            const shifted = addMinutesHHMM(wantTime, mins);
            const endDate = shifted.extraDays ? nextDate(task.due) : task.due;
            body = asTimed(`${task.due}T${wantTime}:00`, `${endDate}T${shifted.time}:00`, tz);
        } else {
            body = timedBounds(task.due, wantTime, '', tz);
        }
    } else {
        body = asAllDay(task.due, end && end.date ? addDaysISO(String(end.date).slice(0, 10), daysBetween(currentDue, task.due)) : nextDate(task.due));
    }
    const updated = await api('PATCH', `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(task.googleEventId)}`, body);
    task.googleStart = (updated && updated.start) || body.start;
    task.googleEnd = (updated && updated.end) || body.end;
    return true;
}

async function syncTasks(tasks) {
    if (!status().connected) return { tasks, changed: false, skipped: true };
    const out = Array.isArray(tasks) ? tasks.map(t => ({ ...t })) : [];
    let changed = false;
    let pushed = 0;
    let removed = 0;
    let lastError = null;
    for (const task of out) {
        try {
            // Importadas: si están hechas se borran de Calendar (igual que las del Kanban).
            // Si siguen abiertas, solo se parchea fecha/hora — no se reescriben como todo el día.
            if (task.googleFromCalendar) {
                if (!shouldPush(task)) {
                    if (task.googleEventId) {
                        await deleteEvent(task.googleEventId);
                        task.googleEventId = null;
                        changed = true;
                        removed++;
                    }
                    continue;
                }
                if (task.googleEventId) {
                    if (await patchImportedSchedule(task)) {
                        changed = true;
                        pushed++;
                    }
                    continue;
                }
                // Se deshizo un Hecho: el evento original ya no está, se recrea.
                const id = await upsertEvent(task);
                task.googleEventId = id;
                task.googleFromCalendar = false;
                changed = true;
                pushed++;
                continue;
            }
            if (shouldPush(task)) {
                const id = await upsertEvent(task);
                if (task.googleEventId !== id) {
                    task.googleEventId = id;
                    changed = true;
                }
                pushed++;
            } else if (task.googleEventId) {
                await deleteEvent(task.googleEventId);
                task.googleEventId = null;
                changed = true;
                removed++;
            }
        } catch (err) {
            lastError = String(err.message || err);
            if (loadState().authExpired) break;
        }
    }
    let pulled = { tasks: out, imported: 0, updated: 0 };
    if (!loadState().authExpired) {
        try {
            const events = await listCalendarEvents();
            pulled = mergeCalendarEvents(out, events);
        } catch (err) {
            lastError = lastError || String(err.message || err);
            if (!loadState().authExpired) throw err;
        }
    }
    saveState({
        lastSync: new Date().toISOString(),
        lastError,
        lastPushed: pushed,
        lastRemoved: removed,
        lastImported: pulled.imported,
        lastUpdatedFromCal: pulled.updated
    });
    return {
        tasks: pulled.tasks,
        changed: changed || pulled.imported > 0 || pulled.updated > 0,
        error: lastError,
        pushed,
        removed,
        imported: pulled.imported,
        updatedFromCal: pulled.updated
    };
}

module.exports = { init, status, connect, disconnect, syncTasks };
