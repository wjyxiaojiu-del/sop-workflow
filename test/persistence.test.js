'use strict';

// Run with: node --test test/persistence.test.js (Node 18+, no Electron or dependencies).
// Execute the real main/preload source in isolated VMs. Only Electron, time and
// timers are stubbed; persistence uses real files under a fresh temporary root.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

const PROJECT_DIR = path.resolve(__dirname, '..');
const MAIN_FILE = path.join(PROJECT_DIR, 'main.js');
const PRELOAD_FILE = path.join(PROJECT_DIR, 'preload.js');
const MAIN_SOURCE = fs.readFileSync(MAIN_FILE, 'utf8');
const PRELOAD_SOURCE = fs.readFileSync(PRELOAD_FILE, 'utf8');
const NOW = 1_700_000_000_000;
const BACKUP_OLD = 'sop-data-20250101T000000000.json';
const BACKUP_MIDDLE = 'sop-data-20250102T000000000.json';
const BACKUP_NEW = 'sop-data-20250103T000000000.json';
const CHANNELS = {
  loadData: 'load-data',
  saveData: 'save-data',
  exportData: 'export-data',
  importData: 'import-data',
  getDataFileInfo: 'get-data-file-info',
  restoreBackup: 'restore-backup',
  minimize: 'minimize-window',
  maximize: 'maximize-window',
  close: 'close-window',
  getWindowState: 'get-window-state',
  setWindowState: 'set-window-state',
  setDirtyState: 'set-dirty-state',
  confirmClose: 'confirm-close',
  cancelClose: 'cancel-close',
  revealDataFile: 'reveal-data-file',
  openBackupFolder: 'open-backup-folder',
};

function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function data(revision = 0) {
  const steps = [{
    id: 's_1', title: 'Check 文献 ' + revision, note: 'Keep UTF-8 ✓', done: false,
    subSteps: [{ id: 'ss_1', title: 'Record DOI', done: false }],
  }];
  return {
    schemaVersion: 2,
    templates: [{
      id: 't_1', name: 'Template ' + revision, desc: 'Persistence regression',
      category: '科研', tags: ['文献'], favorite: false, version: revision + 1,
      steps, createdAt: NOW, updatedAt: NOW + revision, lastUsedAt: NOW,
    }],
    instances: [{
      id: 'i_1', templateId: 't_1', templateVersion: revision + 1,
      templateName: 'Template ' + revision, variables: { project: 'Regression' },
      steps: plain(steps), status: 'paused', startedAt: NOW, updatedAt: NOW + revision,
      completedAt: null, elapsedMs: 250, runningSince: null, executionNotes: 'Keep this note',
    }],
    history: [{
      id: 'h_1', instanceId: 'i_old', templateId: 't_1', templateName: 'Earlier run',
      status: 'completed', startedAt: NOW - 1000, completedAt: NOW - 100,
      elapsedMs: 900, stepsTotal: 1, stepsDone: 1, completionRate: 100,
    }],
    meta: { lastSavedAt: NOW + revision, exportedAt: null },
  };
}

function writeRaw(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function writeJson(file, value) {
  writeRaw(file, JSON.stringify(value, null, 2));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function createHarness(root) {
  const handlers = new Map();
  const timers = new Map();
  const windows = [];
  const logs = [];
  const exposed = new Map();
  const env = {}; // Never inherit SOP_DATA_DIR or touch real Electron userData.
  const fileSystem = { ...fs }; // Per-VM fault injection, never patch Node's global fs.
  const userDataDir = path.join(root, 'user-data');
  const documentsDir = path.join(root, 'documents');
  const ipcRenderer = new EventEmitter();
  let boot;
  let started = false;
  let now = NOW;
  let timerId = 0;

  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }

  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.bounds = { x: options.x || 0, y: options.y || 0, width: options.width, height: options.height };
      this.destroyed = false;
      this.maximized = false;
      this.minimized = false;
      this.loadedFiles = [];
      this.closeAttempts = [];
      this.sent = [];
      this.webContents = new EventEmitter();
      this.webContents.isDestroyed = () => this.destroyed;
      this.webContents.send = (channel, payload) => {
        this.sent.push([channel, plain(payload)]);
        ipcRenderer.emit(channel, { sender: this.webContents }, payload);
      };
      windows.push(this);
    }
    loadFile(file) { this.loadedFiles.push(file); return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    isMaximized() { return this.maximized; }
    getNormalBounds() { return { ...this.bounds }; }
    maximize() { this.maximized = true; this.emit('maximize'); }
    unmaximize() { this.maximized = false; this.emit('unmaximize'); }
    minimize() { this.minimized = true; }
    close() {
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      this.emit('close', event);
      this.closeAttempts.push(event.defaultPrevented);
      if (!event.defaultPrevented) {
        this.destroyed = true;
        this.emit('closed');
      }
    }
  }

  const app = new EventEmitter();
  app.getPath = (name) => {
    if (name === 'userData') return userDataDir;
    if (name === 'documents') return documentsDir;
    throw new Error('Unexpected app.getPath: ' + name);
  };
  app.whenReady = () => ({ then(callback) { boot = callback; } });
  app.quit = () => { app.quitCalled = true; };
  const dialog = {
    saveResult: { canceled: true }, openResult: { canceled: true },
    async showSaveDialog() { return dialog.saveResult; },
    async showOpenDialog() { return dialog.openResult; },
  };
  const shell = { async openPath() { return ''; }, showItemInFolder() {} };
  const electron = {
    app, BrowserWindow, dialog, shell, ipcRenderer,
    screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }] },
    ipcMain: {
      handle(channel, handler) {
        assert.equal(handlers.has(channel), false, 'duplicate IPC registration: ' + channel);
        handlers.set(channel, handler);
      },
    },
    contextBridge: { exposeInMainWorld(name, api) { exposed.set(name, api); } },
  };

  function evaluate(source, filename) {
    const nativeRequire = createRequire(filename);
    const module = { exports: {} };
    vm.runInNewContext(source, {
      module, exports: module.exports, __filename: filename, __dirname: path.dirname(filename),
      require(name) {
        if (name === 'electron') return electron;
        if (name === 'fs' || name === 'node:fs') return fileSystem;
        return nativeRequire(name);
      },
      process: { env }, Date: ClockDate,
      console: Object.fromEntries(['log', 'warn', 'error'].map((level) => [
        level, (...args) => logs.push({ level, args }),
      ])),
      setTimeout(callback, delay) {
        const id = ++timerId;
        timers.set(id, { callback, delay });
        return id;
      },
      clearTimeout(id) { timers.delete(id); },
    }, { filename });
  }

  const harness = {
    root, env, userDataDir, documentsDir, fileSystem, handlers, timers, windows, logs,
    exposed, ipcRenderer, app, dialog, shell,
    get dataDir() {
      const override = env.SOP_DATA_DIR;
      return typeof override === 'string' && path.isAbsolute(override.trim())
        ? path.resolve(override.trim()) : userDataDir;
    },
    get dataFile() { return path.join(this.dataDir, 'sop-data.json'); },
    get tmpFile() { return path.join(this.dataDir, 'sop-data.json.tmp'); },
    get backupDir() { return path.join(this.dataDir, 'backups'); },
    get windowStateFile() { return path.join(this.dataDir, 'window-state.json'); },
    get window() { return windows[windows.length - 1]; },
    get api() { return exposed.get('api'); },
    async start() {
      assert.equal(started, false, 'start each isolated main process once');
      started = true;
      await boot();
    },
    async invoke(channel, ...args) {
      const handler = handlers.get(channel);
      assert.equal(typeof handler, 'function', 'registered handler: ' + channel);
      return plain(await handler({ sender: this.window && this.window.webContents }, ...args));
    },
    advance(ms = 1000) { now += ms; },
    flushTimers() {
      const pending = [...timers.values()];
      timers.clear();
      for (const timer of pending) timer.callback();
    },
    seedBackup(name, value) { writeJson(path.join(this.backupDir, name), value); },
    selectImport(file) { dialog.openResult = { canceled: false, filePaths: [file] }; },
    selectExport(file) { dialog.saveResult = { canceled: false, filePath: file }; },
  };
  ipcRenderer.invoke = (channel, ...args) => harness.invoke(channel, ...args);
  evaluate(MAIN_SOURCE, MAIN_FILE);
  evaluate(PRELOAD_SOURCE, PRELOAD_FILE);
  return harness;
}

async function withHarness(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sop-persistence-'));
  let harness;
  try {
    harness = createHarness(root);
    return await run(harness);
  } finally {
    if (harness) harness.timers.clear();
    // Verify the exact deletion target; never clean user data or project files.
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('sop-persistence-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

test('startup resolves index.html absolutely and preserves renderer isolation', () => withHarness(async (h) => {
  await h.start();
  assert.deepEqual(h.window.loadedFiles, [path.join(PROJECT_DIR, 'index.html')]);
  assert.equal(path.isAbsolute(h.window.loadedFiles[0]), true);
  const options = h.window.options;
  assert.equal(options.frame, false);
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.notEqual(options.webPreferences.sandbox, false);
  assert.equal(options.webPreferences.preload, PRELOAD_FILE);
}));

test('missing main file loads empty data without claiming recovery', () => withHarness(async (h) => {
  h.seedBackup(BACKUP_NEW, data(1));
  await h.start();
  const result = await h.api.loadData();
  assert.equal(result.ok, true);
  assert.equal(result.recovered, false);
  assert.equal(result.source, 'empty');
  assert.equal(result.error, null);
  assert.deepEqual(result.data, {
    schemaVersion: 2, templates: [], instances: [], history: [], meta: { lastSavedAt: 0, exportedAt: null },
  });
}));

test('valid primary data wins over backups without rewriting the file', () => withHarness(async (h) => {
  writeJson(h.dataFile, data(1));
  h.seedBackup(BACKUP_NEW, data(2));
  const before = fs.readFileSync(h.dataFile, 'utf8');
  await h.start();
  const result = await h.api.loadData();
  assert.equal(result.ok, true);
  assert.equal(result.recovered, false);
  assert.equal(result.source, 'main');
  assert.equal(result.error, null);
  assert.deepEqual(result.data, data(1));
  assert.equal(fs.readFileSync(h.dataFile, 'utf8'), before);
}));

test('safe saves retain the three latest pre-write snapshots and no temporary file', () => withHarness(async (h) => {
  await h.start();
  for (let revision = 0; revision < 7; revision++) {
    h.advance();
    const saved = await h.api.saveData(data(revision));
    assert.equal(saved.ok, true, saved.error);
    assert.equal(typeof saved.savedAt, 'number');
    assert.equal(saved.error, null);
    assert.deepEqual(readJson(h.dataFile), data(revision));
    assert.equal(fs.existsSync(h.tmpFile), false);
    const info = await h.api.getDataFileInfo();
    assert.equal(info.filePath, h.dataFile);
    assert.equal(info.backupDir, h.backupDir);
    assert.equal(info.size, fs.statSync(h.dataFile).size);
    assert.equal(info.backups.length, Math.min(revision, 3));
    assert.deepEqual(info.backups.map((b) => b.name), info.backups.map((b) => b.name).sort().reverse());
    info.backups.forEach((backup, index) => {
      assert.deepEqual(readJson(path.join(h.backupDir, backup.name)), data(revision - index - 1));
      assert.ok(backup.size > 0);
      assert.equal(typeof backup.mtime, 'number');
    });
  }
}));

for (const [label, newest] of [
  ['malformed JSON', '{{{broken'],
  ['invalid schema', JSON.stringify({ templates: 'broken' })],
]) {
  test('recovery skips newest backup with ' + label + ' and chooses latest valid backup', () => withHarness(async (h) => {
    writeRaw(h.dataFile, '{{{broken primary');
    h.seedBackup(BACKUP_OLD, data(1));
    h.seedBackup(BACKUP_MIDDLE, data(2));
    writeRaw(path.join(h.backupDir, BACKUP_NEW), newest);
    await h.start();
    const result = await h.api.loadData();
    assert.equal(result.ok, true);
    assert.equal(result.recovered, true);
    assert.equal(result.source, 'backup:' + BACKUP_MIDDLE);
    assert.equal(result.error, null);
    assert.deepEqual(result.data, data(2));
    assert.equal(fs.readFileSync(h.dataFile, 'utf8'), '{{{broken primary');
  }));
}

const INVALID_PAYLOADS = [
  ['null root', null],
  ['array root', []],
  ['string root', 'broken'],
  ['numeric root', 42],
  ['non-array templates', { templates: 'broken' }],
  ['explicit null templates', { templates: null, instances: [], history: [] }],
  ['explicit null instances', { templates: [], instances: null, history: [] }],
  ['explicit null history', { templates: [], instances: [], history: null }],
  ['null template entry', { templates: [null] }],
  ['array template entry', { templates: [[]] }],
  ['null history entry', { history: [null] }],
  ['non-object meta', { templates: [], meta: 'broken' }],
  ['non-array template steps', { templates: [{ steps: 'bad' }] }],
  ['null template steps', { templates: [{ steps: null }] }],
  ['null step entry', { templates: [{ steps: [null] }] }],
  ['non-array subSteps', { templates: [{ steps: [{ subSteps: 'bad' }] }] }],
  ['null subStep entry', { templates: [{ steps: [{ subSteps: [null] }] }] }],
  ['non-array instance steps', { instances: [{ steps: 'bad' }] }],
  ['non-object instance variables', { instances: [{ steps: [], variables: [] }] }],
];

for (const [label, payload] of INVALID_PAYLOADS) {
  test('save-data rejects ' + label + ' without modifying persisted data', () => withHarness(async (h) => {
    writeJson(h.dataFile, data(1));
    const before = fs.readFileSync(h.dataFile, 'utf8');
    await h.start();
    const result = await h.api.saveData(plain(payload));
    assert.equal(result.ok, false, 'invalid payload must not overwrite the primary file');
    assert.equal(result.savedAt, null);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0);
    assert.equal(fs.readFileSync(h.dataFile, 'utf8'), before);
    assert.deepEqual((await h.api.getDataFileInfo()).backups, []);
    assert.equal(fs.existsSync(h.tmpFile), false);
  }));

  test('import-data rejects ' + label + ' without returning lossy data', () => withHarness(async (h) => {
    writeJson(h.dataFile, data(1));
    const before = fs.readFileSync(h.dataFile, 'utf8');
    const importFile = path.join(h.root, 'invalid-import.json');
    writeJson(importFile, payload);
    h.selectImport(importFile);
    await h.start();
    const result = await h.api.importData();
    assert.equal(result.ok, false, 'invalid fields must not be silently normalized to empty arrays');
    assert.equal(result.canceled, false);
    assert.equal(result.data, null);
    assert.equal(result.summary, null);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0);
    assert.equal(fs.readFileSync(h.dataFile, 'utf8'), before);
    assert.deepEqual((await h.api.getDataFileInfo()).backups, []);
  }));
}

for (const [label, payload] of INVALID_PAYLOADS.filter(([label]) => [
  'null root', 'array root', 'non-array templates', 'explicit null templates', 'non-array template steps',
].includes(label))) {
  test('startup recovers instead of silently emptying ' + label, () => withHarness(async (h) => {
    writeJson(h.dataFile, payload);
    h.seedBackup(BACKUP_NEW, data(3));
    await h.start();
    const result = await h.api.loadData();
    assert.equal(result.ok, true);
    assert.equal(result.recovered, true);
    assert.equal(result.source, 'backup:' + BACKUP_NEW);
    assert.deepEqual(result.data, data(3));
  }));
}

test('all corrupt files return empty recovered data with an actionable error', () => withHarness(async (h) => {
  writeRaw(h.dataFile, '{{{broken primary');
  writeRaw(path.join(h.backupDir, BACKUP_NEW), '{{{broken backup');
  h.seedBackup(BACKUP_MIDDLE, { templates: 'broken' });
  h.seedBackup(BACKUP_OLD, null);
  await h.start();
  const result = await h.api.loadData();
  assert.equal(result.ok, true);
  assert.equal(result.recovered, true);
  assert.equal(result.source, 'empty');
  assert.deepEqual(result.data.templates, []);
  assert.deepEqual(result.data.instances, []);
  assert.deepEqual(result.data.history, []);
  assert.equal(typeof result.error, 'string');
  assert.ok(result.error.length > 0);
}));

test('same-millisecond saves still retain the latest three snapshots after pruning', () => withHarness(async (h) => {
  await h.start();
  for (let revision = 0; revision < 8; revision++) {
    // Do not advance the isolated clock: collisions must not recycle an older name.
    assert.equal((await h.api.saveData(data(revision))).ok, true);
    const { backups } = await h.api.getDataFileInfo();
    assert.equal(backups.length, Math.min(revision, 3));
    assert.deepEqual(backups.map((backup) => readJson(path.join(h.backupDir, backup.name))),
      Array.from({ length: Math.min(revision, 3) }, (_, index) => data(revision - index - 1)));
  }
}));

for (const [stage, method] of [
  ['directory creation', 'mkdirSync'],
  ['temporary write', 'writeFileSync'],
  ['fsync', 'fsyncSync'],
  ['backup copy', 'copyFileSync'],
  ['atomic rename', 'renameSync'],
]) {
  test('failed ' + stage + ' returns an error and preserves the original main file', () => withHarness(async (h) => {
    writeJson(h.dataFile, data(1));
    const before = fs.readFileSync(h.dataFile, 'utf8');
    await h.start();
    h.fileSystem[method] = () => { throw new Error('injected ' + method + ' failure'); };
    const result = await h.api.saveData(data(2));
    assert.equal(result.ok, false);
    assert.equal(result.savedAt, null);
    assert.match(result.error, new RegExp('injected ' + method + ' failure'));
    assert.equal(fs.readFileSync(h.dataFile, 'utf8'), before);
    assert.equal(fs.existsSync(h.tmpFile), false);
  }));
}

test('backup pruning failure is reported rather than silently claiming success', () => withHarness(async (h) => {
  await h.start();
  for (let revision = 0; revision < 4; revision++) {
    h.advance();
    assert.equal((await h.api.saveData(data(revision))).ok, true);
  }
  h.advance();
  h.fileSystem.unlinkSync = () => { throw new Error('injected prune failure'); };
  const result = await h.api.saveData(data(4));
  assert.equal(result.ok, false);
  assert.equal(result.savedAt, null);
  assert.match(result.error, /injected prune failure/);
  assert.deepEqual(readJson(h.dataFile), data(4)); // Rename already completed; do not report success.
  assert.equal(fs.existsSync(h.tmpFile), false);
}));

test('unserializable save payload returns an error without changing persisted data', () => withHarness(async (h) => {
  writeJson(h.dataFile, data(1));
  await h.start();
  const circular = data(2);
  circular.self = circular;
  const result = await h.api.saveData(circular);
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, 'string');
  assert.deepEqual(readJson(h.dataFile), data(1));
  assert.equal(fs.existsSync(h.tmpFile), false);
}));

test('export/import round-trip preserves data and backs up current data when applying import', () => withHarness(async (source) => {
  await source.start();
  assert.equal((await source.api.saveData(data(3))).ok, true);
  const exportFile = path.join(source.root, 'round-trip.json');
  source.selectExport(exportFile);
  const exported = await source.api.exportData();
  assert.equal(exported.ok, true, exported.error);
  assert.equal(exported.canceled, false);
  assert.equal(exported.filePath, exportFile);
  assert.equal(exported.error, null);
  const payload = readJson(exportFile);
  assert.deepEqual(Object.keys(payload).sort(), ['app', 'schemaVersion', 'exportedAt', 'templates', 'instances', 'history'].sort());
  assert.equal(payload.app, 'sop-workflow');
  assert.equal(payload.schemaVersion, 2);
  assert.equal(payload.exportedAt, NOW);
  for (const key of ['templates', 'instances', 'history']) assert.deepEqual(payload[key], data(3)[key]);

  await withHarness(async (target) => {
    writeJson(target.dataFile, data(9));
    await target.start();
    target.selectImport(exportFile);
    const imported = await target.api.importData();
    assert.equal(imported.ok, true, imported.error);
    assert.equal(imported.canceled, false);
    assert.equal(imported.filePath, exportFile);
    assert.deepEqual(imported.data, payload);
    assert.deepEqual(imported.summary, { templates: 1, instances: 1, history: 1, schemaVersion: 2, exportedAt: NOW });
    // Import is a preview; renderer decides merge/replace and then calls save-data.
    assert.deepEqual(readJson(target.dataFile), data(9));
    assert.deepEqual((await target.api.getDataFileInfo()).backups, []);
    assert.equal((await target.api.saveData(imported.data)).ok, true);
    const loaded = await target.api.loadData();
    for (const key of ['templates', 'instances', 'history']) assert.deepEqual(loaded.data[key], data(3)[key]);
    const { backups } = await target.api.getDataFileInfo();
    assert.equal(backups.length, 1);
    assert.deepEqual(readJson(path.join(target.backupDir, backups[0].name)), data(9));
  });
}));

test('legacy string substeps remain accepted by save, import and recovery', () => withHarness(async (h) => {
  const legacy = {
    templates: [{ id: 'legacy-template', name: 'Legacy', steps: [{ title: 'Read', subSteps: ['DOI', 'Methods'] }] }],
    instances: [], history: [],
  };
  writeRaw(h.dataFile, '{{{broken');
  h.seedBackup(BACKUP_NEW, legacy);
  await h.start();
  const recovered = await h.api.loadData();
  assert.equal(recovered.source, 'backup:' + BACKUP_NEW);
  assert.deepEqual(recovered.data, legacy);
  assert.equal((await h.api.saveData(legacy)).ok, true);
  const file = path.join(h.root, 'legacy-import.json');
  writeJson(file, legacy);
  h.selectImport(file);
  const imported = await h.api.importData();
  assert.equal(imported.ok, true, imported.error);
  assert.deepEqual(imported.data, legacy);
}));

test('import/export cancellation is non-destructive and not an error', () => withHarness(async (h) => {
  writeJson(h.dataFile, data(1));
  await h.start();
  const imported = await h.api.importData();
  assert.deepEqual(imported, { ok: true, canceled: true, data: null, filePath: null, error: null, summary: null });
  const exported = await h.api.exportData();
  assert.deepEqual(exported, { ok: true, canceled: true, filePath: null, error: null });
  assert.deepEqual(readJson(h.dataFile), data(1));
  assert.deepEqual((await h.api.getDataFileInfo()).backups, []);
}));

for (const [label, content] of [
  ['malformed JSON', '{{{broken'], ['missing business arrays', '{}'],
]) {
  test('import rejects ' + label, () => withHarness(async (h) => {
    const file = path.join(h.root, 'invalid.json');
    writeRaw(file, content);
    h.selectImport(file);
    await h.start();
    const result = await h.api.importData();
    assert.equal(result.ok, false);
    assert.equal(result.canceled, false);
    assert.equal(result.data, null);
    assert.equal(result.summary, null);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0);
    assert.equal(fs.existsSync(h.dataFile), false);
  }));
}

test('import reports an unreadable selected file without rejecting IPC', () => withHarness(async (h) => {
  h.selectImport(path.join(h.root, 'missing.json'));
  await h.start();
  const result = await h.api.importData();
  assert.equal(result.ok, false);
  assert.equal(result.data, null);
  assert.equal(result.summary, null);
  assert.equal(result.canceled, false);
  assert.ok(result.error.length > 0);
}));

test('import rejects a file larger than 64 MiB before reading it', () => withHarness(async (h) => {
  const file = path.join(h.root, 'oversized.json');
  const descriptor = fs.openSync(file, 'w');
  try { fs.ftruncateSync(descriptor, 64 * 1024 * 1024 + 1); }
  finally { fs.closeSync(descriptor); }
  h.selectImport(file);
  await h.start();
  const result = await h.api.importData();
  assert.equal(result.ok, false);
  assert.equal(result.data, null);
  assert.match(result.error, /64\s*MB/i);
}));

test('export filesystem failure is returned with selected path and an error', () => withHarness(async (h) => {
  await h.start();
  h.selectExport(h.root); // A directory cannot be overwritten as a JSON file.
  const result = await h.api.exportData();
  assert.equal(result.ok, false);
  assert.equal(result.canceled, false);
  assert.equal(result.filePath, h.root);
  assert.equal(typeof result.error, 'string');
  assert.ok(result.error.length > 0);
}));

test('restore-backup rejects traversal and absolute paths without modifying data', () => withHarness(async (h) => {
  writeJson(h.dataFile, data(1));
  const outsideBackup = path.join(h.root, BACKUP_NEW);
  writeJson(outsideBackup, data(9));
  h.seedBackup(BACKUP_NEW, data(2));
  await h.start();
  for (const name of [
    null, 42, '', '  ', '../' + BACKUP_NEW, '..\\' + BACKUP_NEW,
    'nested/' + BACKUP_NEW, 'nested\\' + BACKUP_NEW, outsideBackup,
    '%2e%2e/' + BACKUP_NEW, 'sop-data-missing.json',
  ]) {
    const result = await h.api.restoreBackup(name);
    assert.equal(result.ok, false, 'unsafe or missing backup: ' + name);
    assert.equal(result.data, null);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0);
  }
  assert.deepEqual(readJson(h.dataFile), data(1));
  assert.deepEqual(readJson(outsideBackup), data(9));
}));

test('restore-backup returns valid data as a preview without overwriting current data', () => withHarness(async (h) => {
  writeJson(h.dataFile, data(1));
  h.seedBackup(BACKUP_NEW, data(2));
  await h.start();
  const result = await h.api.restoreBackup(BACKUP_NEW);
  assert.deepEqual(result, { ok: true, data: data(2), error: null });
  assert.deepEqual(readJson(h.dataFile), data(1));
}));

for (const [label, content] of [
  ['malformed JSON', '{{{broken'], ['array root', '[]'],
  ['invalid schema', '{"templates":"broken"}'],
  ['invalid nested steps', '{"templates":[{"steps":"bad"}]}'],
]) {
  test('restore-backup rejects ' + label, () => withHarness(async (h) => {
    writeRaw(path.join(h.backupDir, BACKUP_NEW), content);
    await h.start();
    const result = await h.api.restoreBackup(BACKUP_NEW);
    assert.equal(result.ok, false);
    assert.equal(result.data, null);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0);
  }));
}

test('main registers exactly the 16 allowed invoke channels', () => withHarness(async (h) => {
  await h.start();
  assert.deepEqual([...h.handlers.keys()].sort(), Object.values(CHANNELS).sort());
}));

test('preload exposes only whitelisted methods and forwards exact invoke arguments', () => withHarness(async (h) => {
  assert.deepEqual([...h.exposed.keys()], ['api']);
  assert.deepEqual(Object.keys(h.api).sort(), [...Object.keys(CHANNELS), 'onCloseRequested', 'onDataRecovered'].sort());
  const calls = [];
  h.ipcRenderer.invoke = async (...args) => { calls.push(args); return { ok: true }; };
  const argumentsByMethod = {
    saveData: [data(1)], restoreBackup: [BACKUP_NEW], setWindowState: [{ width: 900 }], setDirtyState: [true],
  };
  for (const [method, channel] of Object.entries(CHANNELS)) {
    const args = argumentsByMethod[method] || [];
    assert.equal((await h.api[method](...args)).ok, true);
    assert.deepEqual(calls[calls.length - 1], [channel, ...args]);
  }
}));

test('preload subscriptions strip Electron events and unsubscribe only their listener', () => withHarness(async (h) => {
  for (const [method, channel] of [
    ['onCloseRequested', 'app-close-requested'], ['onDataRecovered', 'data-recovered'],
  ]) {
    const received = [];
    const remaining = [];
    const unsubscribe = h.api[method]((...args) => received.push(args));
    const other = h.api[method]((...args) => remaining.push(args));
    const payload = { source: 'backup:' + BACKUP_NEW };
    h.ipcRenderer.emit(channel, { sender: { privileged: true } }, payload);
    assert.deepEqual(received, [[payload]]);
    assert.equal(h.ipcRenderer.listenerCount(channel), 2);
    unsubscribe();
    h.ipcRenderer.emit(channel, { sender: { privileged: true } }, payload);
    assert.equal(received.length, 1);
    assert.equal(remaining.length, 2);
    other();
    assert.equal(h.ipcRenderer.listenerCount(channel), 0);
    assert.equal(typeof h.api[method](null), 'function');
    assert.equal(h.ipcRenderer.listenerCount(channel), 0);
  }
}));

test('preload contains callback exceptions rather than breaking other listeners', () => withHarness(async (h) => {
  let calls = 0;
  const stopFirst = h.api.onDataRecovered(() => { throw new Error('renderer callback failure'); });
  const stopSecond = h.api.onDataRecovered(() => { calls++; });
  assert.doesNotThrow(() => h.ipcRenderer.emit('data-recovered', {}, { source: 'empty' }));
  assert.equal(calls, 1);
  assert.ok(h.logs.some((entry) => entry.level === 'error'));
  stopFirst();
  stopSecond();
}));

for (const [channel, method] of [['export-data', 'showSaveDialog'], ['import-data', 'showOpenDialog']]) {
  test(channel + ' catches dialog rejection and returns ok:false', () => withHarness(async (h) => {
    await h.start();
    h.dialog[method] = async () => { throw new Error('dialog unavailable'); };
    assert.deepEqual(await h.invoke(channel), { ok: false, error: 'dialog unavailable' });
  }));
}

test('shell failures return structured errors rather than rejected invokes', () => withHarness(async (h) => {
  await h.start();
  h.shell.openPath = async () => 'file manager unavailable';
  assert.deepEqual(await h.api.openBackupFolder(), { ok: false, error: 'file manager unavailable' });
  h.shell.openPath = async () => { throw new Error('shell failed'); };
  assert.deepEqual(await h.api.revealDataFile(), { ok: false, error: 'shell failed' });
}));

test('startup broadcasts recovered data only after the renderer finishes loading', () => withHarness(async (h) => {
  writeRaw(h.dataFile, '{{{broken');
  h.seedBackup(BACKUP_NEW, data(2));
  const recovered = [];
  const stop = h.api.onDataRecovered((payload) => recovered.push(plain(payload)));
  await h.start();
  assert.deepEqual(recovered, []);
  h.window.webContents.emit('did-finish-load');
  h.window.webContents.emit('did-finish-load');
  assert.deepEqual(recovered, [{ source: 'backup:' + BACKUP_NEW, error: null }]);
  stop();
}));

test('window geometry and maximization persist separately from business data', () => withHarness(async (h) => {
  writeJson(h.dataFile, data(1));
  const before = fs.readFileSync(h.dataFile, 'utf8');
  const saved = { width: 960, height: 640, x: 20, y: 30, maximized: true };
  writeJson(h.windowStateFile, saved);
  await h.start();
  assert.equal(h.window.options.width, saved.width);
  assert.equal(h.window.options.height, saved.height);
  assert.equal(h.window.options.x, saved.x);
  assert.equal(h.window.options.y, saved.y);
  assert.deepEqual(await h.api.getWindowState(), { ok: true, ...saved });
  assert.deepEqual(await h.api.maximize(), { ok: true, maximized: false });
  assert.deepEqual(readJson(h.windowStateFile), { ...saved, maximized: false });
  h.window.bounds = { width: 1024, height: 700, x: 40, y: 50 };
  h.window.emit('resize');
  h.window.emit('move');
  assert.equal(h.timers.size, 1, 'movement writes are debounced');
  h.flushTimers();
  assert.deepEqual(readJson(h.windowStateFile), { ...h.window.bounds, maximized: false });
  assert.equal(fs.readFileSync(h.dataFile, 'utf8'), before);
}));

test('corrupt window-state JSON falls back to safe default dimensions', () => withHarness(async (h) => {
  writeRaw(h.windowStateFile, '{{{broken');
  await h.start();
  assert.equal(h.window.options.width, 1100);
  assert.equal(h.window.options.height, 750);
  assert.equal(h.window.isMaximized(), false);
}));

test('window state clamps small dimensions and ignores off-screen coordinates', () => withHarness(async (h) => {
  writeJson(h.windowStateFile, { width: 1, height: -1, x: 99999, y: 99999, maximized: 'true' });
  await h.start();
  assert.equal(h.window.options.width, 800);
  assert.equal(h.window.options.height, 600);
  assert.equal(h.window.options.x, undefined);
  assert.equal(h.window.options.y, undefined);
  assert.equal(h.window.isMaximized(), false);
  assert.equal((await h.api.setWindowState({ width: 2, height: 2, x: 10.8, y: 20.2, maximized: true })).ok, true);
  assert.deepEqual(readJson(h.windowStateFile), { width: 800, height: 600, x: 11, y: 20, maximized: true });
}));

for (const dirty of [false, true]) {
  test('close handshake protects ' + (dirty ? 'dirty' : 'clean') + ' window until renderer confirms', () => withHarness(async (h) => {
    await h.start();
    const win = h.window;
    let requests = 0;
    const stop = h.api.onCloseRequested(() => { requests++; });
    assert.equal((await h.api.setDirtyState(dirty)).ok, true);
    assert.equal((await h.api.close()).ok, true);
    assert.equal(win.isDestroyed(), false);
    assert.deepEqual(win.closeAttempts, [true]);
    assert.equal(requests, 1);
    assert.equal((await h.api.cancelClose()).ok, true);
    assert.equal((await h.api.close()).ok, true);
    assert.equal(win.isDestroyed(), false);
    assert.deepEqual(win.closeAttempts, [true, true]);
    assert.equal(requests, 2);
    assert.equal((await h.api.confirmClose()).ok, true);
    assert.equal(win.isDestroyed(), true);
    assert.deepEqual(win.closeAttempts, [true, true, false]);
    assert.equal(requests, 2);
    assert.equal(h.timers.size, 0);
    assert.deepEqual(readJson(h.windowStateFile), { ...win.bounds, maximized: false });
    assert.equal((await h.api.getWindowState()).ok, false);
    stop();
  }));
}

test('SOP_DATA_DIR honors only absolute overrides and never accesses real userData', () => withHarness(async (h) => {
  h.env.SOP_DATA_DIR = '  ' + path.join(h.root, 'override') + '  ';
  await h.start();
  assert.equal((await h.api.saveData(data(1))).ok, true);
  assert.equal((await h.api.getDataFileInfo()).filePath, path.join(h.root, 'override', 'sop-data.json'));
  assert.equal(fs.existsSync(h.userDataDir), false);
}));

test('relative SOP_DATA_DIR falls back to the stubbed userData directory', () => withHarness(async (h) => {
  h.env.SOP_DATA_DIR = '../not-an-absolute-data-directory';
  await h.start();
  assert.equal((await h.api.saveData(data(1))).ok, true);
  assert.equal((await h.api.getDataFileInfo()).filePath, path.join(h.userDataDir, 'sop-data.json'));
}));

test('backup retention still chooses latest snapshots when the system clock moves backward', () => withHarness(async (h) => {
  await h.start();
  assert.equal((await h.api.saveData(data(0))).ok, true);
  for (let revision = 1; revision < 6; revision++) {
    h.advance(-1000);
    assert.equal((await h.api.saveData(data(revision))).ok, true);
    const { backups } = await h.api.getDataFileInfo();
    assert.deepEqual(backups.map((backup) => readJson(path.join(h.backupDir, backup.name))),
      Array.from({ length: Math.min(revision, 3) }, (_, index) => data(revision - index - 1)));
  }
}));

for (const failure of ['missing', 'corrupt']) {
  test('loading ' + failure + ' data clears stale cached export data', () => withHarness(async (h) => {
    writeJson(h.dataFile, data(1));
    await h.start();
    assert.deepEqual((await h.api.loadData()).data, data(1));
    if (failure === 'missing') {
      const target = path.resolve(h.dataFile);
      assert.equal(path.dirname(target), path.resolve(h.userDataDir));
      assert.equal(path.basename(target), 'sop-data.json');
      fs.unlinkSync(target);
    } else {
      writeRaw(h.dataFile, '{{{broken');
    }
    const loaded = await h.api.loadData();
    assert.equal(loaded.source, 'empty');
    assert.equal(loaded.recovered, failure === 'corrupt');
    const exportFile = path.join(h.root, 'empty-export.json');
    h.selectExport(exportFile);
    assert.equal((await h.api.exportData()).ok, true);
    const exported = readJson(exportFile);
    for (const key of ['templates', 'instances', 'history']) assert.deepEqual(exported[key], []);
  }));
}

test('atomic save closes and syncs its temporary file before backup and replacement', () => withHarness(async (h) => {
  writeJson(h.dataFile, data(1));
  await h.start();
  const operations = [];
  const originals = { ...h.fileSystem };
  let temporaryFd;
  h.fileSystem.openSync = (file, ...args) => {
    const fd = originals.openSync(file, ...args);
    if (file === h.tmpFile) { temporaryFd = fd; operations.push('open-tmp'); }
    return fd;
  };
  for (const [method, label] of [
    ['writeFileSync', 'write-tmp'], ['fsyncSync', 'fsync-tmp'], ['closeSync', 'close-tmp'],
  ]) {
    h.fileSystem[method] = (fd, ...args) => {
      if (fd === temporaryFd) operations.push(label);
      return originals[method](fd, ...args);
    };
  }
  h.fileSystem.copyFileSync = (source, target, ...args) => {
    operations.push('backup-current');
    assert.equal(source, h.dataFile);
    assert.deepEqual(readJson(source), data(1));
    assert.deepEqual(readJson(h.tmpFile), data(2));
    return originals.copyFileSync(source, target, ...args);
  };
  h.fileSystem.renameSync = (source, target, ...args) => {
    operations.push('rename-tmp');
    assert.equal(source, h.tmpFile);
    assert.equal(target, h.dataFile);
    const backups = fs.readdirSync(h.backupDir);
    assert.equal(backups.length, 1);
    assert.deepEqual(readJson(path.join(h.backupDir, backups[0])), data(1));
    return originals.renameSync(source, target, ...args);
  };
  assert.equal((await h.api.saveData(data(2))).ok, true);
  assert.deepEqual(operations, ['open-tmp', 'write-tmp', 'fsync-tmp', 'close-tmp', 'backup-current', 'rename-tmp']);
}));

test('backup listing and pruning leave unrelated files and directories untouched', () => withHarness(async (h) => {
  await h.start();
  const unrelated = path.join(h.backupDir, 'user-notes.txt');
  const directory = path.join(h.backupDir, 'sop-data-not-a-file.json');
  writeRaw(unrelated, 'Do not delete me');
  fs.mkdirSync(directory);
  for (let revision = 0; revision < 5; revision++) {
    h.advance();
    assert.equal((await h.api.saveData(data(revision))).ok, true);
  }
  const info = await h.api.getDataFileInfo();
  assert.equal(info.backups.length, 3);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'Do not delete me');
  assert.equal(fs.statSync(directory).isDirectory(), true);
  assert.ok(info.backups.every((backup) => backup.name !== path.basename(directory)));
}));
