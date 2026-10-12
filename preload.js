'use strict';

/**
 * SOP Workflow v1.1 — preload
 *
 * 契约 §8.1：只暴露白名单 API，**禁止**透传 ipcRenderer / 任何 Node 能力。
 * 契约 §8.3：contextIsolation:true + nodeIntegration:false 下运行。
 *
 * 写入者：persistence-dev（本文件独占）。
 */

const { contextBridge, ipcRenderer } = require('electron');

/** 订阅主进程 -> 渲染进程的通道，返回取消订阅函数；绝不把 event 对象传给回调。 */
function subscribe(channel, cb) {
  if (typeof cb !== 'function') return () => {};
  const listener = (_event, payload) => {
    try {
      cb(payload);
    } catch (e) {
      console.error('[preload] ' + channel + ' 回调异常:', e);
    }
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('api', {
  // --- 数据（§8 IPC 表） ---
  loadData: () => ipcRenderer.invoke('load-data'),
  saveData: (data) => ipcRenderer.invoke('save-data', data),
  exportData: () => ipcRenderer.invoke('export-data'),
  importData: () => ipcRenderer.invoke('import-data'),
  getDataFileInfo: () => ipcRenderer.invoke('get-data-file-info'),
  restoreBackup: (name) => ipcRenderer.invoke('restore-backup', name),

  // --- 窗口 ---
  minimize: () => ipcRenderer.invoke('minimize-window'),
  maximize: () => ipcRenderer.invoke('maximize-window'),
  close: () => ipcRenderer.invoke('close-window'),
  getWindowState: () => ipcRenderer.invoke('get-window-state'),
  setWindowState: (partial) => ipcRenderer.invoke('set-window-state', partial),

  // --- 关闭保护（§8.2） ---
  setDirtyState: (dirty) => ipcRenderer.invoke('set-dirty-state', dirty),
  confirmClose: () => ipcRenderer.invoke('confirm-close'),
  cancelClose: () => ipcRenderer.invoke('cancel-close'),

  // --- 文件定位 ---
  revealDataFile: () => ipcRenderer.invoke('reveal-data-file'),
  openBackupFolder: () => ipcRenderer.invoke('open-backup-folder'),

  // --- 主进程 -> 渲染进程 ---
  onCloseRequested: (cb) => subscribe('app-close-requested', cb),
  onDataRecovered: (cb) => subscribe('data-recovered', cb),
});
