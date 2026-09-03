'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const MODEL = 'grok-4.6';
const API = 'https://api.x.ai/v1/chat/completions';
const STT = 'https://api.x.ai/v1/stt';

function pad(n) { return String(n).padStart(2, '0'); }

function todayISO() {
    const n = new Date();
    return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
}

function addDaysISO(iso, days) {
    const d = new Date(String(iso).slice(0, 10) + 'T12:00:00');
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDue(s) {
    const today = todayISO();
    const t = String(s || '').trim().toLowerCase();
    if (!t || t === 'today' || t === 'hoy') return today;
    if (t === 'tomorrow' || t === 'mañana' || t === 'manana') return addDaysISO(today, 1);
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(s).trim())) return String(s).trim();
    return today;
}

function parseTime(s) {
    const raw = String(s || '').trim().toLowerCase();
    let m = raw.match(/^(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?$/);
    if (m) {
        let h = Number(m[1]);
        const min = Number(m[2]);
        const ap = m[3] || '';
        if (ap.startsWith('p') && h < 12) h += 12;
        if (ap.startsWith('a') && h === 12) h = 0;
        if (h > 23 || min > 59) return '';
        return `${pad(h)}:${pad(min)}`;
    }
    m = raw.match(/^(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)$/);
    if (!m) return '';
    let h = Number(m[1]);
    const ap = m[2] || '';
    if (ap.startsWith('p') && h < 12) h += 12;
    if (ap.startsWith('a') && h === 12) h = 0;
    if (h > 23) return '';
    return `${pad(h)}:00`;
}

const TOOLS = [
    {
        type: 'function',
        function: {
            name: 'add_task',
            description: 'Crear una tarea en el Kanban. Horas en 24h o con am/pm.',
            parameters: {
                type: 'object',
                properties: {
                    text: { type: 'string' },
                    due: { type: 'string', description: 'YYYY-MM-DD, hoy o mañana' },
                    dueTime: { type: 'string', description: 'HH:MM inicio' },
                    dueEnd: { type: 'string', description: 'HH:MM fin' },
                    status: { type: 'string', enum: ['por-hacer', 'en-progreso', 'hecho'] },
                    priority: { type: 'string', enum: ['a', 'm', 'b'] },
                    project: { type: 'string', description: 'Nombre del proyecto' },
                    tag: { type: 'string', enum: ['trabajo', 'Musica', 'personal', 'actividad'] },
                    notes: { type: 'string' }
                },
                required: ['text']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'update_task',
            description: 'Modificar una tarea existente por id o por texto.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'number' },
                    match: { type: 'string', description: 'Fragmento del título si no hay id' },
                    text: { type: 'string' },
                    due: { type: 'string' },
                    dueTime: { type: 'string' },
                    dueEnd: { type: 'string' },
                    status: { type: 'string', enum: ['por-hacer', 'en-progreso', 'hecho'] },
                    priority: { type: 'string', enum: ['a', 'm', 'b'] },
                    project: { type: 'string' },
                    tag: { type: 'string', enum: ['trabajo', 'Musica', 'personal', 'actividad'] },
                    notes: { type: 'string' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'complete_task',
            description: 'Marcar una tarea como hecha.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'number' },
                    match: { type: 'string' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'delete_task',
            description: 'Eliminar una tarea.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'number' },
                    match: { type: 'string' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'reschedule_task',
            description: 'Cambiar la fecha de una tarea.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'number' },
                    match: { type: 'string' },
                    due: { type: 'string' }
                },
                required: ['due']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'extend_task',
            description: 'Alargar el fin de una tarea en minutos.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'number' },
                    match: { type: 'string' },
                    minutes: { type: 'number' }
                },
                required: ['minutes']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'set_focus',
            description: 'Poner una tarea en foco (menú de la barra).',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'number' },
                    match: { type: 'string' },
                    clear: { type: 'boolean' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'append_note',
            description: 'Agregar una nota a una tarea, sin borrar las que ya tiene.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'number' },
                    match: { type: 'string' },
                    note: { type: 'string' }
                },
                required: ['note']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'add_subtask',
            description: 'Agregar una subtarea.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'number' },
                    match: { type: 'string' },
                    text: { type: 'string' }
                },
                required: ['text']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'complete_subtask',
            description: 'Marcar una subtarea hecha (o deshacerla).',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'number' },
                    match: { type: 'string' },
                    sub: { type: 'string', description: 'Fragmento del texto de la subtarea' },
                    done: { type: 'boolean' }
                },
                required: ['sub']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'update_project',
            description: 'Actualizar info, notas o estado de un proyecto.',
            parameters: {
                type: 'object',
                properties: {
                    project: { type: 'string' },
                    description: { type: 'string' },
                    notes: { type: 'string' },
                    status: { type: 'string', enum: ['activo', 'pausado', 'archivado'] }
                },
                required: ['project']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'add_goal',
            description: 'Agregar una meta a un proyecto.',
            parameters: {
                type: 'object',
                properties: {
                    project: { type: 'string' },
                    text: { type: 'string' }
                },
                required: ['project', 'text']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'complete_goal',
            description: 'Marcar una meta de proyecto hecha (o deshacerla).',
            parameters: {
                type: 'object',
                properties: {
                    project: { type: 'string' },
                    match: { type: 'string' },
                    done: { type: 'boolean' }
                },
                required: ['project', 'match']
            }
        }
    }
];

function keyPath(userData) {
    return path.join(userData, 'xai-key.json');
}

function grokAuthFile() {
    return path.join(os.homedir(), '.grok', 'auth.json');
}

function readGrokStore() {
    try { return JSON.parse(fs.readFileSync(grokAuthFile(), 'utf8')); } catch { return null; }
}

function pickGrokSession(store) {
    if (!store || typeof store !== 'object') return null;
    for (const [id, sess] of Object.entries(store)) {
        if (sess && sess.auth_mode === 'oidc' && (sess.key || sess.refresh_token)) {
            return { id, sess };
        }
    }
    return null;
}

function sessionExpired(sess) {
    if (!sess || !sess.expires_at) return !sess || !sess.key;
    const t = Date.parse(sess.expires_at);
    if (Number.isNaN(t)) return false;
    return t - Date.now() < 90 * 1000;
}

async function refreshGrokSession(id, sess, store) {
    if (!sess.refresh_token || !sess.oidc_client_id) {
        throw new Error('Sesión de Grok incompleta. En la terminal: grok login');
    }
    const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: sess.refresh_token,
        client_id: sess.oidc_client_id
    });
    const res = await fetch('https://auth.x.ai/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
        throw new Error('Tu sesión de Grok expiró. En la terminal ejecutá: grok login');
    }
    sess.key = data.access_token;
    if (data.refresh_token) sess.refresh_token = data.refresh_token;
    if (data.expires_in) {
        sess.expires_at = new Date(Date.now() + Number(data.expires_in) * 1000).toISOString();
    }
    store[id] = sess;
    fs.writeFileSync(grokAuthFile(), JSON.stringify(store, null, 2), { mode: 0o600 });
    return sess.key;
}

function loadSavedKey(userData) {
    try {
        const raw = JSON.parse(fs.readFileSync(keyPath(userData), 'utf8'));
        return raw && raw.key ? String(raw.key) : '';
    } catch {
        return '';
    }
}

function loadKey(userData) {
    const picked = pickGrokSession(readGrokStore());
    if (picked && picked.sess.key && !sessionExpired(picked.sess)) return picked.sess.key;
    if (process.env.XAI_API_KEY) return process.env.XAI_API_KEY;
    return loadSavedKey(userData);
}

async function getAccessToken(userData) {
    const store = readGrokStore();
    const picked = pickGrokSession(store);
    if (picked) {
        if (picked.sess.key && !sessionExpired(picked.sess)) return picked.sess.key;
        if (picked.sess.refresh_token) return refreshGrokSession(picked.id, picked.sess, store);
    }
    if (process.env.XAI_API_KEY) return process.env.XAI_API_KEY;
    return loadSavedKey(userData);
}

function historyPath(userData) {
    return path.join(userData, 'grok-history.json');
}

function cleanHistory(list) {
    if (!Array.isArray(list)) return [];
    return list.filter(m => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
        .map(m => ({ role: m.role, content: String(m.content) }))
        .slice(-24);
}

function loadHistory(userData) {
    try {
        return cleanHistory(JSON.parse(fs.readFileSync(historyPath(userData), 'utf8')));
    } catch {
        return [];
    }
}

function saveHistory(userData, history) {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(historyPath(userData), JSON.stringify(cleanHistory(history), null, 2));
}

function status(userData) {
    const history = loadHistory(userData);
    const picked = pickGrokSession(readGrokStore());
    if (picked && (picked.sess.key || picked.sess.refresh_token)) {
        return { hasKey: true, source: 'grok', email: picked.sess.email || null, history };
    }
    if (process.env.XAI_API_KEY || loadSavedKey(userData)) {
        return { hasKey: true, source: 'api-key', history };
    }
    return { hasKey: false, source: 'none', history };
}

function saveKey(userData, key) {
    const k = String(key || '').trim();
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(keyPath(userData), JSON.stringify({ key: k }, null, 2), { mode: 0o600 });
}

function findTask(list, args) {
    if (args && args.id != null) {
        const id = Number(args.id);
        return list.find(t => t.id === id) || null;
    }
    const q = String((args && args.match) || '').toLowerCase().trim();
    if (!q) return null;
    return list.find(t => t.status !== 'hecho' && String(t.text || '').toLowerCase().includes(q))
        || list.find(t => String(t.text || '').toLowerCase().includes(q))
        || null;
}

function findProject(projects, name) {
    const q = String(name || '').toLowerCase().trim();
    if (!q) return null;
    return projects.find(p => String(p.name || '').toLowerCase() === q)
        || projects.find(p => String(p.name || '').toLowerCase().includes(q))
        || null;
}

function nextId(list) {
    return list.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0) + 1;
}

function addMinutes(time, minutes) {
    const m = String(time || '').match(/^(\d{1,2}):(\d{2})/);
    const h0 = m ? Number(m[1]) : 0;
    const min0 = m ? Number(m[2]) : 0;
    let total = h0 * 60 + min0 + Number(minutes || 0);
    total = ((total % 1440) + 1440) % 1440;
    return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

const DAYS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const PRIO_ES = { a: 'Alta', m: 'Media', b: 'Baja' };
const STATUS_ES = { 'por-hacer': 'Pendiente', 'en-progreso': 'En progreso', 'hecho': 'Hecho' };

function clip(s, n) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

function formatHour12(hhmm) {
    const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
    if (!m) return '';
    let h = Number(m[1]);
    const min = m[2];
    const ap = h >= 12 ? 'p.m.' : 'a.m.';
    h = h % 12 || 12;
    return min === '00' ? `${h} ${ap}` : `${h}:${min} ${ap}`;
}

function formatRange(t) {
    if (!t || !t.dueTime) return '';
    const a = formatHour12(t.dueTime);
    const b = t.dueEnd && t.dueEnd !== t.dueTime ? formatHour12(t.dueEnd) : '';
    return b ? `${a}–${b}` : a;
}

function formatDateEs(iso) {
    const raw = String(iso || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return '';
    const d = new Date(raw + 'T12:00:00');
    if (Number.isNaN(d.getTime())) return raw;
    return `${DAYS_ES[d.getDay()].slice(0, 3)} ${d.getDate()} ${MONTHS_ES[d.getMonth()]}`;
}

function toMin(hhmm) {
    const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function nowParts() {
    const n = new Date();
    return {
        date: todayISO(),
        weekday: DAYS_ES[n.getDay()],
        time: formatHour12(`${pad(n.getHours())}:${pad(n.getMinutes())}`),
        minutes: n.getHours() * 60 + n.getMinutes(),
        hour: n.getHours()
    };
}

function dueKey(t) {
    const d = String(t.due || '9999-99-99');
    const tm = t.dueTime || '99:99';
    return `${d}T${tm}`;
}

function isNowBlock(t, now) {
    if (!t || t.status === 'hecho' || t.due !== now.date || !t.dueTime) return false;
    const a = toMin(t.dueTime);
    if (a == null) return false;
    const b = t.dueEnd ? (toMin(t.dueEnd) || a + 60) : a + 60;
    return now.minutes >= a && now.minutes < b;
}

function taskLine(t, projects, { notes } = {}) {
    const proj = (projects || []).find(p => p.id === t.projectId);
    const bits = [`#${t.id}`, `[${STATUS_ES[t.status] || t.status}]`];
    if (t.focused) bits.push('[FOCO]');
    if (t.googleFromCalendar) bits.push('[cal]');
    if (t.priority === 'a') bits.push('Alta');
    bits.push(`«${t.text}»`);
    if (t.due) bits.push(formatDateEs(t.due) || t.due);
    const rng = formatRange(t);
    if (rng) bits.push(rng);
    if (proj) bits.push(`proy:${proj.name}`);
    const tags = (t.tags || []).filter(Boolean).join(',');
    if (tags) bits.push(tags);
    const subs = Array.isArray(t.subtasks) ? t.subtasks : [];
    if (subs.length) bits.push(`sub ${subs.filter(s => s.done).length}/${subs.length}`);
    let line = bits.join(' ');
    if (notes && t.notes && String(t.notes).trim()) line += `\n    notas: ${clip(t.notes, 320)}`;
    if (subs.length) {
        line += '\n    subtareas: ' + subs.map(s => `${s.done ? '✓' : '○'} ${s.text}`).join('; ');
    }
    return line;
}

function section(title, lines) {
    const body = !lines || !lines.length ? '(ninguna)' : lines.join('\n');
    return `=== ${title} ===\n${body}`;
}

function cloneTasks(tasks) {
    return (Array.isArray(tasks) ? tasks : []).map(t => ({
        ...t,
        tags: Array.isArray(t.tags) ? t.tags.slice() : [],
        subtasks: Array.isArray(t.subtasks) ? t.subtasks.map(s => ({ ...s })) : []
    }));
}

function cloneProjects(projects) {
    return (Array.isArray(projects) ? projects : []).map(p => ({
        ...p,
        goals: Array.isArray(p.goals) ? p.goals.map(g => ({ ...g })) : []
    }));
}

function nextSubId(list) {
    let m = 0;
    for (const t of list || []) {
        for (const s of t.subtasks || []) m = Math.max(m, Number(s.id) || 0);
    }
    return m + 1;
}

function nextGoalId(projects) {
    let m = 0;
    for (const p of projects || []) {
        for (const g of p.goals || []) m = Math.max(m, Number(g.id) || 0);
    }
    return m + 1;
}

function buildContext(tasks, projects, extra) {
    const now = nowParts();
    const today = now.date;
    const tomorrow = addDaysISO(today, 1);
    const weekEnd = addDaysISO(today, 7);
    const recentFrom = addDaysISO(today, -14);
    const list = tasks || [];
    const projs = projects || [];
    const open = list.filter(t => t && t.status !== 'hecho');
    const done = list.filter(t => t && t.status === 'hecho');
    const byDue = (a, b) => dueKey(a).localeCompare(dueKey(b));
    const focus = open.find(t => t.focused);
    const inProg = open.filter(t => t.status === 'en-progreso').sort(byDue);
    const overdue = open.filter(t => t.due && t.due < today).sort(byDue);
    const todayItems = open.filter(t => t.due === today).sort(byDue);
    const tomorrowItems = open.filter(t => t.due === tomorrow).sort(byDue);
    const weekItems = open.filter(t => t.due && t.due > tomorrow && t.due <= weekEnd).sort(byDue);
    const later = open.filter(t => !t.due || t.due > weekEnd).sort(byDue);
    const happening = todayItems.filter(t => isNowBlock(t, now));
    const doneToday = done.filter(t => t.due === today || t.date === today).sort(byDue);
    const doneRecent = done.filter(t => {
        const d = t.due || t.date || '';
        return d >= recentFrom && d < today;
    }).sort(byDue).slice(-20);
    const tagCounts = { trabajo: 0, Musica: 0, personal: 0, actividad: 0 };
    for (const t of open) {
        for (const tag of t.tags || []) {
            if (tagCounts[tag] != null) tagCounts[tag] += 1;
        }
    }
    const remainingToday = todayItems.filter(t => t.status !== 'hecho');
    const g = extra && extra.google ? extra.google : {};
    const googleLine = g.connected
        ? `Google Calendar conectado${g.email ? ` (${g.email})` : ''}${g.lastSync ? `. Última sync: ${g.lastSync}` : ''}. Los eventos importados están marcados [cal].`
        : 'Google Calendar no conectado.';

    const projectBlocks = projs.length ? projs.map(p => {
        const mine = list.filter(t => t.projectId === p.id);
        const o = mine.filter(t => t.status !== 'hecho');
        const d = mine.filter(t => t.status === 'hecho');
        const next = o.filter(t => t.due && t.due >= today).sort(byDue)[0] || o.sort(byDue)[0];
        const goals = Array.isArray(p.goals) ? p.goals : [];
        const gDone = goals.filter(x => x.done).length;
        const lines = [
            `· ${p.name} [${p.status || 'activo'}] abiertas ${o.length} · hechas ${d.length}`
        ];
        if (p.description && p.description.trim()) lines.push(`  info: ${clip(p.description, 280)}`);
        if (p.notes && p.notes.trim()) lines.push(`  notas: ${clip(p.notes, 280)}`);
        if (goals.length) {
            lines.push(`  metas ${gDone}/${goals.length}: ` + goals.map(x => `${x.done ? '✓' : '○'} ${x.text}`).join('; '));
        }
        if (next) lines.push(`  siguiente: #${next.id} «${next.text}» ${next.due || ''} ${formatRange(next)}`.trim());
        return lines.join('\n');
    }) : ['(ninguno)'];

    return [
        `Diego. Asistente personal del Kanban local (tablero + calendario + proyectos).`,
        `AHORA: ${now.weekday} ${formatDateEs(today)} ${today}, ${now.time}. Cierre de día a las 9 p.m.`,
        `TABLERO: ${open.length} abiertas (${open.filter(t => t.status === 'por-hacer').length} pendientes, ${inProg.length} en progreso) · ${done.length} hechas · ${overdue.length} vencidas · ${remainingToday.length} de hoy.`,
        happening.length ? `EN CURSO AHORA:\n${happening.map(t => taskLine(t, projs, { notes: true })).join('\n')}` : 'EN CURSO AHORA: (nada en este horario)',
        section('FOCO', focus ? [taskLine(focus, projs, { notes: true })] : []),
        section('EN PROGRESO', inProg.map(t => taskLine(t, projs, { notes: true }))),
        section('VENCIDAS', overdue.map(t => taskLine(t, projs, { notes: true }))),
        section('HOY', todayItems.map(t => taskLine(t, projs, { notes: true }))),
        section('MAÑANA', tomorrowItems.map(t => taskLine(t, projs))),
        section('PRÓXIMOS 7 DÍAS', weekItems.map(t => taskLine(t, projs))),
        section('MÁS ADELANTE / SIN FECHA', later.map(t => taskLine(t, projs))),
        section('HECHO HOY', doneToday.map(t => taskLine(t, projs))),
        section('HECHO RECIENTE (14 días)', doneRecent.map(t => taskLine(t, projs))),
        `=== PROYECTOS ===\n${projectBlocks.join('\n')}`,
        `=== ETIQUETAS (abiertas) ===\ntrabajo ${tagCounts.trabajo} · Musica ${tagCounts.Musica} · personal ${tagCounts.personal} · actividad ${tagCounts.actividad}`,
        `=== GOOGLE ===\n${googleLine}`,
        `Etiquetas válidas (una sola por tarea): trabajo, Musica, personal, actividad.`,
        `Estados: por-hacer, en-progreso, hecho. Prioridades: a=Alta, m=Media, b=Baja.`
    ].join('\n\n');
}

function execute(name, args, { tasks, projects }) {
    const a = args || {};
    if (name === 'add_task') {
        const dueTime = parseTime(a.dueTime);
        const dueEnd = parseTime(a.dueEnd);
        const proj = findProject(projects, a.project);
        const task = {
            id: nextId(tasks),
            text: String(a.text || '').trim() || 'Tarea',
            status: ['por-hacer', 'en-progreso', 'hecho'].includes(a.status) ? a.status : 'por-hacer',
            priority: ['a', 'm', 'b'].includes(a.priority) ? a.priority : 'm',
            due: parseDue(a.due),
            dueTime,
            dueEnd: dueEnd && dueEnd !== dueTime ? dueEnd : '',
            notes: String(a.notes || ''),
            date: todayISO(),
            tags: a.tag ? [a.tag] : [],
            subtasks: [],
            order: tasks.length,
            prevStatus: null,
            projectId: proj ? proj.id : null,
            focused: false
        };
        if (task.dueTime && !task.due) task.due = todayISO();
        tasks.push(task);
        return `Creada #${task.id} «${task.text}» ${task.due} ${task.dueTime || ''}`.trim();
    }
    if (name === 'set_focus' && a.clear) {
        tasks.forEach(t => { t.focused = false; });
        return 'Foco quitado';
    }
    if (name === 'update_project' || name === 'add_goal' || name === 'complete_goal') {
        const proj = findProject(projects, a.project);
        if (!proj) return `No encontré el proyecto «${a.project || '?'}»`;
        if (name === 'update_project') {
            if (a.description != null) proj.description = String(a.description);
            if (a.notes != null) proj.notes = String(a.notes);
            if (['activo', 'pausado', 'archivado'].includes(a.status)) proj.status = a.status;
            return `Proyecto «${proj.name}» actualizado`;
        }
        if (name === 'add_goal') {
            const text = String(a.text || '').trim();
            if (!text) return 'La meta está vacía';
            if (!Array.isArray(proj.goals)) proj.goals = [];
            proj.goals.push({ id: nextGoalId(projects), text, done: false });
            return `Meta agregada a «${proj.name}»: ${text}`;
        }
        const q = String(a.match || '').toLowerCase().trim();
        const goal = (proj.goals || []).find(g => String(g.text || '').toLowerCase().includes(q));
        if (!goal) return `No encontré esa meta en «${proj.name}»`;
        goal.done = a.done !== false;
        return `${goal.done ? 'Meta hecha' : 'Meta reabierta'} en «${proj.name}»: ${goal.text}`;
    }
    const task = findTask(tasks, a);
    if (!task && name !== 'add_task') return `No encontré esa tarea (${a.id || a.match || '?'})`;
    if (name === 'complete_task') {
        task.prevStatus = task.status;
        task.status = 'hecho';
        task.focused = false;
        return `Hecha #${task.id} «${task.text}»`;
    }
    if (name === 'delete_task') {
        const i = tasks.indexOf(task);
        if (i >= 0) tasks.splice(i, 1);
        return `Eliminada #${task.id} «${task.text}»`;
    }
    if (name === 'reschedule_task') {
        task.due = parseDue(a.due);
        return `Reagendada #${task.id} a ${task.due}`;
    }
    if (name === 'extend_task') {
        if (!task.dueTime) task.dueTime = `${pad(new Date().getHours())}:${pad(new Date().getMinutes())}`;
        const from = task.dueEnd || task.dueTime;
        task.dueEnd = addMinutes(from, a.minutes);
        return `Extendida #${task.id} hasta ${task.dueEnd}`;
    }
    if (name === 'set_focus') {
        tasks.forEach(t => { t.focused = t.id === task.id; });
        return `En foco #${task.id} «${task.text}»`;
    }
    if (name === 'update_task') {
        if (a.text) task.text = a.text;
        if (a.due) task.due = parseDue(a.due);
        if (a.dueTime != null) task.dueTime = parseTime(a.dueTime);
        if (a.dueEnd != null) task.dueEnd = parseTime(a.dueEnd);
        if (a.status) task.status = a.status;
        if (a.priority) task.priority = a.priority;
        if (a.notes != null) task.notes = a.notes;
        if (a.tag) task.tags = [a.tag];
        if (a.project) {
            const proj = findProject(projects, a.project);
            task.projectId = proj ? proj.id : null;
        }
        if (task.status === 'hecho') task.focused = false;
        return `Actualizada #${task.id} «${task.text}»`;
    }
    if (name === 'append_note') {
        const note = String(a.note || '').trim();
        if (!note) return 'La nota está vacía';
        task.notes = [String(task.notes || '').trim(), note].filter(Boolean).join('\n');
        return `Nota agregada a #${task.id}`;
    }
    if (name === 'add_subtask') {
        const text = String(a.text || '').trim();
        if (!text) return 'La subtarea está vacía';
        if (!Array.isArray(task.subtasks)) task.subtasks = [];
        task.subtasks.push({ id: nextSubId(tasks), text, done: false });
        return `Subtarea en #${task.id}: ${text}`;
    }
    if (name === 'complete_subtask') {
        const q = String(a.sub || '').toLowerCase().trim();
        const sub = (task.subtasks || []).find(s => String(s.text || '').toLowerCase().includes(q));
        if (!sub) return `No encontré esa subtarea en #${task.id}`;
        sub.done = a.done !== false;
        return `${sub.done ? 'Subtarea hecha' : 'Subtarea reabierta'} en #${task.id}: ${sub.text}`;
    }
    return `Herramienta desconocida: ${name}`;
}

async function grokRequest(apiKey, messages) {
    const res = await fetch(API, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: MODEL,
            messages,
            tools: TOOLS,
            tool_choice: 'auto'
        })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error((data && data.error && data.error.message) || res.statusText || 'Error Grok');
        err.status = res.status;
        throw err;
    }
    return data;
}

function systemPrompt(ctx) {
    return `Sos el asistente personal de Diego para su Kanban local (tablero + calendario de Google + proyectos).
Conocés el estado actual: está en el snapshot de abajo. No digas que no ves el tablero.

Reglas:
- Hablá en español, como un jefe de gabinete: concreto, informado, sin relleno.
- Horarios en 12 h con a.m./p.m. (ej. 2:14 p.m.).
- Preguntas sobre agenda, progreso, conflictos o “qué hago ahora”: respondé con el snapshot. No hace falta una herramienta.
- Para crear o cambiar algo, USÁ herramientas. No inventes ids: usá los #id o match por título.
- Si no da fecha, usá hoy. Si da hora sin fecha, hoy.
- Una sola etiqueta: trabajo, Musica, personal, actividad.
- Proyectos por nombre: Lyrios, LeLoLa, Luvaty, TripiWorld, Sana Sana, Inkisition, InkstinctNYC, etc.
- Eventos [cal] vienen de Google Calendar; al marcarlos hecho se borran del calendario de Google.
- Si hay vencidas, un bloque ahora, o foco, mencionalo cuando ayude.
- No vuelques el snapshot entero. Resumí lo que importa.
- Después de actuar, confirmá en una o dos líneas qué quedó.

${ctx}`;
}

async function chat({ userData, message, history, tasks, projects, google }) {
    let apiKey = '';
    try { apiKey = await getAccessToken(userData); } catch (err) {
        return { ok: false, needsKey: true, error: err.message };
    }
    if (!apiKey) {
        return {
            ok: false,
            needsKey: true,
            error: 'No hay sesión de Grok. En la terminal ejecutá: grok login'
        };
    }
    const list = cloneTasks(tasks);
    const projs = cloneProjects(projects);
    const ctx = buildContext(list, projs, { google });
    const persisted = loadHistory(userData);
    const incoming = cleanHistory(history);
    const hist = (incoming.length >= persisted.length ? incoming : persisted).slice(-20);
    const userText = String(message || '').trim();
    const messages = [
        { role: 'system', content: systemPrompt(ctx) },
        ...hist,
        { role: 'user', content: userText }
    ];
    const logs = [];
    let text = '';
    let projectsChanged = false;
    for (let round = 0; round < 6; round++) {
        let data;
        try {
            data = await grokRequest(apiKey, messages);
        } catch (err) {
            if (err.status === 401) {
                const store = readGrokStore();
                const picked = pickGrokSession(store);
                if (picked && picked.sess.refresh_token) {
                    apiKey = await refreshGrokSession(picked.id, picked.sess, store);
                    data = await grokRequest(apiKey, messages);
                } else {
                    throw err;
                }
            } else {
                throw err;
            }
        }
        const msg = data.choices && data.choices[0] && data.choices[0].message;
        if (!msg) break;
        const calls = msg.tool_calls || [];
        if (!calls.length) {
            text = String(msg.content || '').trim();
            break;
        }
        messages.push(msg);
        for (const call of calls) {
            const name = call.function && call.function.name;
            let args = {};
            try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = {}; }
            if (name === 'update_project' || name === 'add_goal' || name === 'complete_goal') {
                projectsChanged = true;
            }
            const result = execute(name, args, { tasks: list, projects: projs });
            logs.push(result);
            messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: result
            });
        }
    }
    if (!text) text = logs.join('\n') || 'Listo.';
    const nextHistory = cleanHistory([...hist, { role: 'user', content: userText }, { role: 'assistant', content: text }]);
    try { saveHistory(userData, nextHistory); } catch (e) {}
    return {
        ok: true,
        text,
        logs,
        tasks: list,
        projects: projectsChanged ? projs : undefined,
        history: nextHistory
    };
}

function extFromMime(mime) {
    const t = String(mime || '').toLowerCase();
    if (t.includes('wav')) return 'wav';
    if (t.includes('mpeg') || t.includes('mp3')) return 'mp3';
    if (t.includes('mp4') || t.includes('m4a') || t.includes('aac')) return 'm4a';
    if (t.includes('ogg')) return 'ogg';
    if (t.includes('webm')) return 'webm';
    if (t.includes('flac')) return 'flac';
    return 'wav';
}

function apiError(data, fallback) {
    if (!data) return fallback;
    if (typeof data.error === 'string') return data.error;
    if (data.error && data.error.message) return data.error.message;
    if (data.message) return data.message;
    return fallback;
}

async function sttRequest(apiKey, buf, mime, filename) {
    const form = new FormData();
    form.append('model', 'grok-stt');
    form.append('language', 'es');
    form.append('format', 'true');
    const file = new File([buf], filename, { type: mime || 'audio/wav' });
    form.append('file', file);
    const res = await fetch(STT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(apiError(data, res.statusText || 'Error al transcribir'));
        err.status = res.status;
        throw err;
    }
    return data;
}

async function transcribe({ userData, audioBase64, mime, filename }) {
    let apiKey = '';
    try { apiKey = await getAccessToken(userData); } catch (err) {
        return { ok: false, needsKey: true, error: err.message };
    }
    if (!apiKey) {
        return {
            ok: false,
            needsKey: true,
            error: 'No hay sesión de Grok. En la terminal ejecutá: grok login'
        };
    }
    const raw = String(audioBase64 || '').replace(/^data:[^;]+;base64,/, '');
    if (!raw) return { ok: false, error: 'Audio vacío' };
    const buf = Buffer.from(raw, 'base64');
    if (!buf.length) return { ok: false, error: 'Audio vacío' };
    const type = mime || 'audio/wav';
    const name = filename || `voice.${extFromMime(type)}`;
    let data;
    try {
        data = await sttRequest(apiKey, buf, type, name);
    } catch (err) {
        if (err.status === 401) {
            const store = readGrokStore();
            const picked = pickGrokSession(store);
            if (picked && picked.sess.refresh_token) {
                apiKey = await refreshGrokSession(picked.id, picked.sess, store);
                data = await sttRequest(apiKey, buf, type, name);
            } else {
                return { ok: false, needsKey: true, error: err.message };
            }
        } else {
            return { ok: false, error: err.message, status: err.status };
        }
    }
    const text = String((data && data.text) || '').trim();
    if (!text) return { ok: false, error: 'No pude entender el audio. Probá de nuevo.' };
    return { ok: true, text, language: data.language || null };
}

module.exports = { chat, loadKey, saveKey, status, transcribe };
