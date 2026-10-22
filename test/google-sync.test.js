'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mergeCalendarEvents, calendarQueryBounds, noteTaskListChange, init } = require('../google-sync');

function imported(id, eventId, due) {
    return {
        id,
        text: 'Brussel Sprouts @ venue',
        status: 'por-hacer',
        due,
        googleEventId: eventId,
        googleFromCalendar: true
    };
}

test('drops imported tasks whose Calendar event was deleted', () => {
    const tasks = [
        imported(38, 'gone-sep', '2026-09-18'),
        imported(63, 'gone-oct', '2026-10-23'),
        { id: 9, text: 'Tarea propia', status: 'por-hacer', due: '2026-10-23', googleEventId: 'mine' }
    ];
    const result = mergeCalendarEvents(tasks, [], {
        cancelledIds: ['gone-sep', 'gone-oct']
    });
    assert.deepEqual(result.tasks.map(t => t.id), [9]);
    assert.equal(result.removedFromCal, 2);
});

test('keeps an imported task when its event is still on the calendar', () => {
    const tasks = [imported(63, 'still-there', '2026-10-23')];
    const result = mergeCalendarEvents(tasks, [{
        id: 'still-there',
        summary: 'Brussel Sprouts @ Crooked Can Brewery',
        status: 'confirmed',
        start: { dateTime: '2026-10-23T17:00:00-04:00' },
        end: { dateTime: '2026-10-23T20:00:00-04:00' },
        updated: '2026-10-22T12:00:00.000Z'
    }]);
    assert.equal(result.tasks.length, 1);
    assert.equal(result.removedFromCal, 0);
    assert.equal(result.tasks[0].text, 'Brussel Sprouts @ Crooked Can Brewery');
});

test('drops a kanban task when its Calendar event was deleted', () => {
    const tasks = [{
        id: 4,
        text: 'Dentista',
        status: 'por-hacer',
        due: '2026-10-23',
        googleEventId: 'kanban-event',
        googleFromCalendar: false
    }];
    const result = mergeCalendarEvents(tasks, [], { cancelledIds: ['kanban-event'] });
    assert.equal(result.tasks.length, 0);
    assert.equal(result.removedFromCal, 1);
});

test('keeps a finished card after its event id was cleared', () => {
    const tasks = [{
        id: 4,
        text: 'Hecha en el kanban',
        status: 'hecho',
        due: '2026-10-23',
        googleEventId: null,
        googleFromCalendar: false
    }];
    const result = mergeCalendarEvents(tasks, [], { cancelledIds: ['old-event'] });
    assert.equal(result.tasks.length, 1);
    assert.equal(result.removedFromCal, 0);
});

test('does not reimport an event deleted from the kanban', () => {
    const importBounds = {
        from: new Date(2026, 9, 15),
        to: new Date(2026, 11, 21)
    };
    const result = mergeCalendarEvents([], [{
        id: 'qe7vvih51lif90ldaklln72jc8',
        summary: '6th Annual Polkaweenie!',
        start: { dateTime: '2026-10-30T18:00:00-04:00' },
        end: { dateTime: '2026-10-31T00:00:00-04:00' }
    }], {
        suppressedIds: ['qe7vvih51lif90ldaklln72jc8'],
        importBounds
    });
    assert.equal(result.imported, 0);
    assert.equal(result.tasks.length, 0);
});

test('does not import calendar history outside the normal window', () => {
    const importBounds = {
        from: new Date(2026, 9, 15),
        to: new Date(2026, 11, 21)
    };
    const result = mergeCalendarEvents([imported(63, 'kept', '2026-10-23')], [
        {
            id: 'old-history',
            summary: 'Cardio viejo',
            start: { date: '2026-09-08' },
            end: { date: '2026-09-09' }
        },
        {
            id: 'kept',
            summary: 'Brussel Sprouts @ Crooked Can Brewery',
            start: { dateTime: '2026-10-23T17:00:00-04:00' },
            end: { dateTime: '2026-10-23T20:00:00-04:00' },
            updated: '2026-10-22T12:00:00.000Z'
        }
    ], { importBounds });
    assert.equal(result.imported, 0);
    assert.deepEqual(result.tasks.map(t => t.id), [63]);
});

test('remembers a removed card for Calendar and clears it on undo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-sync-'));
    init({
        userData: dir,
        clientPath: path.join(dir, 'missing.json'),
        openExternal() {}
    });
    const polka = {
        id: 82,
        text: '6th Annual Polkaweenie!',
        googleEventId: 'qe7vvih51lif90ldaklln72jc8',
        googleFromCalendar: true
    };
    noteTaskListChange([polka], []);
    const queued = JSON.parse(fs.readFileSync(path.join(dir, 'google-state.json'), 'utf8'));
    assert.deepEqual(queued.pendingCalendarDeletes, ['qe7vvih51lif90ldaklln72jc8']);
    assert.deepEqual(queued.suppressedEventIds, ['qe7vvih51lif90ldaklln72jc8']);
    noteTaskListChange([], [polka]);
    const undone = JSON.parse(fs.readFileSync(path.join(dir, 'google-state.json'), 'utf8'));
    assert.deepEqual(undone.pendingCalendarDeletes, []);
    assert.deepEqual(undone.suppressedEventIds, []);
    assert.deepEqual(undone.reviveEventIds, ['qe7vvih51lif90ldaklln72jc8']);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('query window reaches a kanban event older than a week', () => {
    const now = new Date(2026, 9, 22, 15, 0, 0);
    const bounds = calendarQueryBounds([{
        id: 4,
        due: '2026-09-01',
        googleEventId: 'kanban-event',
        googleFromCalendar: false
    }], now);
    assert.equal(bounds.from.getMonth(), 8);
    assert.equal(bounds.from.getDate(), 1);
});

test('query window reaches imported gigs older than a week', () => {
    const now = new Date(2026, 9, 22, 15, 0, 0);
    const bounds = calendarQueryBounds([
        imported(38, 'sep', '2026-09-18'),
        imported(64, 'oct', '2026-10-24')
    ], now);
    assert.equal(bounds.from.getFullYear(), 2026);
    assert.equal(bounds.from.getMonth(), 8);
    assert.equal(bounds.from.getDate(), 18);
    assert.ok(bounds.to > new Date(2026, 9, 24));
});
