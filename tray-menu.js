'use strict';

function pad(n) {
    return String(n).padStart(2, '0');
}

function todayISO(now = new Date()) {
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function daysUntil(due, now = new Date()) {
    if (!due) return null;
    const t = Date.parse(String(due).slice(0, 10) + 'T12:00:00');
    if (Number.isNaN(t)) return null;
    const n = Date.parse(todayISO(now) + 'T12:00:00');
    return Math.round((t - n) / 86400000);
}

function prioLabel(priority) {
    return { a: 'Alta', m: 'Media', b: 'Baja' }[priority] || 'Media';
}

function prettyDate(due, now = new Date()) {
    if (!due) return 'Sin fecha';
    const d = daysUntil(due, now);
    if (d === 0) return 'Hoy';
    if (d === 1) return 'Mañana';
    if (d === -1) return 'Ayer';
    const dt = new Date(String(due).slice(0, 10) + 'T12:00:00');
    if (Number.isNaN(dt.getTime())) return String(due).slice(0, 10);
    return dt.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' });
}

function formatHour12(s) {
    const m = String(s || '').match(/^(\d{1,2}):(\d{2})/);
    if (!m) return '';
    const h = Number(m[1]), min = Number(m[2]);
    if (h > 23 || min > 59) return '';
    const suffix = h >= 12 ? 'p.m.' : 'a.m.';
    const h12 = (h % 12) || 12;
    const mm = String(min).padStart(2, '0');
    return min ? `${h12}:${mm} ${suffix}` : `${h12} ${suffix}`;
}

function formatTimeRange(task) {
    const start = formatHour12(task && task.dueTime);
    if (!start) return '';
    const end = formatHour12(task && task.dueEnd);
    if (end && end !== start) return `${start} – ${end}`;
    return start;
}

function prettyWhen(task, now = new Date()) {
    const time = formatTimeRange(task);
    const date = prettyDate(task && task.due, now);
    if (!task || !task.due) return time || 'Sin fecha';
    if (!time) return date;
    if (date === 'Hoy') return time;
    return `${date} · ${time}`;
}

function dueSuffix(due, now = new Date()) {
    return prettyDate(due, now);
}

function clip(text, max = 42) {
    const t = String(text || 'Sin título').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function dueSortKey(t) {
    if (!t || !t.due) return '9999-99-99';
    return t.dueTime ? `${t.due}T${t.dueTime}` : t.due;
}

function byDueThenPrio(a, b) {
    const da = dueSortKey(a);
    const db = dueSortKey(b);
    if (da !== db) return da < db ? -1 : 1;
    const pr = { a: 0, m: 1, b: 2 };
    return (pr[a.priority] ?? 1) - (pr[b.priority] ?? 1) || (a.order ?? 0) - (b.order ?? 0);
}

function groupUpcoming(tasks, { maxPer = 8, now = new Date() } = {}) {
    const todayKey = todayISO(now);
    const open = (Array.isArray(tasks) ? tasks : []).filter(t => t && t.status !== 'hecho' && t.due === todayKey);
    const overdue = [];
    const today = [];
    const upcoming = [];
    const progress = [];
    const later = [];

    for (const t of open) {
        const d = daysUntil(t.due, now);
        if (d !== null && d < 0) overdue.push(t);
        else if (d === 0) today.push(t);
        else if (d !== null && d <= 7) upcoming.push(t);
        else if (t.status === 'en-progreso') progress.push(t);
        else later.push(t);
    }

    overdue.sort(byDueThenPrio);
    today.sort(byDueThenPrio);
    upcoming.sort(byDueThenPrio);
    progress.sort(byDueThenPrio);
    later.sort(byDueThenPrio);

    return {
        overdue: overdue.slice(0, maxPer),
        today: today.slice(0, maxPer),
        upcoming: upcoming.slice(0, maxPer),
        progress: progress.slice(0, maxPer),
        later: later.slice(0, maxPer),
        leftover: {
            overdue: Math.max(0, overdue.length - maxPer),
            today: Math.max(0, today.length - maxPer),
            upcoming: Math.max(0, upcoming.length - maxPer)
        },
        counts: {
            open: open.length,
            overdue: overdue.length,
            today: today.length,
            upcoming: upcoming.length
        }
    };
}

function formatItem(task, now = new Date()) {
    const prioKey = ['a', 'm', 'b'].includes(task.priority) ? task.priority : 'm';
    const prio = prioLabel(prioKey);
    const date = prettyWhen(task, now);
    return {
        id: task.id,
        label: clip(task.text, 40),
        sublabel: date,
        prio,
        prioKey,
        date,
        status: task.status,
        due: task.due || '',
        dueTime: task.dueTime || ''
    };
}

function sections(tasks, now = new Date()) {
    const all = Array.isArray(tasks) ? tasks : [];
    const focus = all.find(t => t && t.focused && t.status !== 'hecho');
    const g = groupUpcoming(tasks, { now });
    const out = [];
    const push = (header, list, extra) => {
        if (!list.length) return;
        out.push({ header, items: list.map(t => formatItem(t, now)), extra });
    };
    if (focus) {
        out.push({ header: 'En foco', items: [formatItem(focus, now)], extra: 0, focus: true });
        return {
            groups: out,
            counts: { ...g.counts, open: Math.max(1, g.counts.open), focus: true },
            focus
        };
    }
    push('Hoy', g.today, g.leftover.today);
    if (!g.counts.open) {
        out.push({ header: null, items: [], empty: 'Nada para hoy' });
    }
    return { groups: out, counts: g.counts, focus: null };
}

module.exports = { todayISO, daysUntil, dueSuffix, prettyDate, prettyWhen, formatTimeRange, prioLabel, groupUpcoming, formatItem, sections };
