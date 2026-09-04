'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kanbanNative', {
    saveTasks: (tasks) => {
        try {
            ipcRenderer.sendSync('tasks:save-sync', tasks);
            return Promise.resolve(true);
        } catch {
            return ipcRenderer.invoke('tasks:save', tasks);
        }
    },
    getTasks: () => ipcRenderer.invoke('tasks:get'),
    saveProjects: (projects) => {
        try {
            ipcRenderer.sendSync('projects:save-sync', projects);
            return Promise.resolve(true);
        } catch {
            return ipcRenderer.invoke('projects:save', projects);
        }
    },
    getProjects: () => ipcRenderer.invoke('projects:get'),
    onFlush: (cb) => {
        const listener = () => cb();
        ipcRenderer.on('app:flush', listener);
        return () => ipcRenderer.removeListener('app:flush', listener);
    },
    onChanged: (cb) => {
        const listener = (_event, list) => cb(list);
        ipcRenderer.on('tasks:changed', listener);
        return () => ipcRenderer.removeListener('tasks:changed', listener);
    },
    onProjectsChanged: (cb) => {
        const listener = (_event, list) => cb(list);
        ipcRenderer.on('projects:changed', listener);
        return () => ipcRenderer.removeListener('projects:changed', listener);
    },
    onOpenTask: (cb) => {
        const listener = (_event, id) => cb(id);
        ipcRenderer.on('tasks:open', listener);
        return () => ipcRenderer.removeListener('tasks:open', listener);
    },
    onNewTask: (cb) => {
        const listener = () => cb();
        ipcRenderer.on('tasks:new', listener);
        return () => ipcRenderer.removeListener('tasks:new', listener);
    },
    onDayClose: (cb) => {
        const listener = () => cb();
        ipcRenderer.on('day:close', listener);
        return () => ipcRenderer.removeListener('day:close', listener);
    },
    googleStatus: () => ipcRenderer.invoke('google:status'),
    googleConnect: () => ipcRenderer.invoke('google:connect'),
    googleDisconnect: () => ipcRenderer.invoke('google:disconnect'),
    googleSync: () => ipcRenderer.invoke('google:sync'),
    onGoogleStatus: (cb) => {
        const listener = (_event, st) => cb(st);
        ipcRenderer.on('google:status', listener);
        return () => ipcRenderer.removeListener('google:status', listener);
    },
    agentNetStatus: () => ipcRenderer.invoke('agentnet:status'),
    agentNetSync: () => ipcRenderer.invoke('agentnet:sync'),
    onAgentNetStatus: (cb) => {
        const listener = (_event, st) => cb(st);
        ipcRenderer.on('agentnet:status', listener);
        return () => ipcRenderer.removeListener('agentnet:status', listener);
    },
    grokStatus: () => ipcRenderer.invoke('grok:status'),
    grokSetKey: (key) => ipcRenderer.invoke('grok:setKey', key),
    grokChat: (payload) => ipcRenderer.invoke('grok:chat', payload),
    grokTranscribe: (payload) => ipcRenderer.invoke('grok:transcribe', payload),
    grokMic: () => ipcRenderer.invoke('grok:mic')
});
