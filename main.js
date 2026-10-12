'use strict';

/**
 * SOP Workflow v1.1 — 主进程
 *
 * 严格实现 docs/contracts/v1.1-interface.md：
 *   §2.1 磁盘布局（sop-data.json / .tmp / backups/ / window-state.json）
 *   §8   IPC 契约全表（16 个 invoke 通道，永不 reject，统一返回 { ok, ... }）
 *   §8.2 关闭流程（脏数据保护）
 *   §8.3 安全边界（contextIsolation / nodeIntegration 不可放宽）
 *   §8.4 安全保存算法（六步）与启动恢复优先级
 *
 * 写入者：persistence-dev（本文件独占）。
 */

const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

const SCHEMA_VERSION = 2;

const DATA_FILE_NAME = 'sop-data.json';
const TMP_FILE_NAME = 'sop-data.json.tmp';
const BACKUP_DIR_NAME = 'backups';
const WINDOW_STATE_FILE_NAME = 'window-state.json';

const MAX_BACKUPS = 3; // §8.4 步骤 5：只保留最近 3 个备份

// 备份文件名：sop-data-<ts>.json（ts 为定宽可字典序排序的时间戳）
const BACKUP_FILE_RE = /^sop-data-[\w.\-]+\.json$/;

const DEFAULT_WIDTH = 1100;
const DEFAULT_HEIGHT = 750;
const MIN_WIDTH = 800;
const MIN_HEIGHT = 600;

const MAX_IMPORT_BYTES = 64 * 1024 * 1024; // 导入文件体积上限（防误选巨型文件）

/* ------------------------------------------------------------------ *
 * 运行时状态（主进程）
 * ------------------------------------------------------------------ */

let mainWindow = null;
let forceClose = false; // §8.2：渲染进程确认关闭后置 true，跳过 preventDefault
let isDirty = false; // set-dirty-state 记录（渲染层权威，主进程只记录）
let lastKnownData = null; // 最近一次成功加载/保存的数据，供导出使用
let windowStateTimer = null;
let startupRecovery = null; // 启动时若发生恢复，用于 'data-recovered' 事件

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

function errMsg(e) {
  if (!e) return '未知错误';
  if (typeof e === 'string') return e;
  return e.message || String(e);
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function emptyData() {
  return {
    schemaVersion: SCHEMA_VERSION,
    templates: [],
    instances: [],
    history: [],
    meta: { lastSavedAt: 0, exportedAt: null },
  };
}

/** 文件名安全、定宽、可按字典序排序的本地时间戳：20260314T090512345 */
function timestampForFile(date) {
  const d = date instanceof Date ? date : new Date();
  const p = (n, w) => String(n).padStart(w || 2, '0');
  return (
    String(d.getFullYear()) +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    'T' +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds()) +
    p(d.getMilliseconds(), 3)
  );
}

/* ------------------------------------------------------------------ *
 * 路径（§2.1）
 * ------------------------------------------------------------------ */

/** <userData> = SOP_DATA_DIR（绝对路径）否则 app.getPath('userData') */
function getDataDir() {
  const override = process.env.SOP_DATA_DIR;
  if (typeof override === 'string' && override.trim() !== '' && path.isAbsolute(override.trim())) {
    return path.resolve(override.trim());
  }
  return app.getPath('userData');
}

function getDataFile() {
  return path.join(getDataDir(), DATA_FILE_NAME);
}

function getTmpFile() {
  return path.join(getDataDir(), TMP_FILE_NAME);
}

function getBackupDir() {
  return path.join(getDataDir(), BACKUP_DIR_NAME);
}

function getWindowStateFile() {
  return path.join(getDataDir(), WINDOW_STATE_FILE_NAME);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/* ------------------------------------------------------------------ *
 * 结构校验（§8.3：主进程侧二次校验，用户/渲染进程输入不可信）
 * ------------------------------------------------------------------ */

/** 缺失字段可由旧版迁移补齐；显式损坏字段必须拒绝，不能静默清空用户数据。 */
function validateStepsShape(steps, label, errors) {
  if (steps === undefined) return;
  if (!Array.isArray(steps)) {
    errors.push(label + ' 必须是数组');
    return;
  }
  steps.forEach((step, index) => {
    const stepLabel = label + '[' + index + ']';
    if (!isPlainObject(step)) {
      errors.push(stepLabel + ' 必须是对象');
      return;
    }
    if (step.subSteps === undefined) return;
    if (!Array.isArray(step.subSteps)) {
      errors.push(stepLabel + '.subSteps 必须是数组');
      return;
    }
    step.subSteps.forEach((subStep, subIndex) => {
      // v1 子步骤为字符串；v2 为对象。两种真实数据格式均可无损迁移。
      if (typeof subStep !== 'string' && !isPlainObject(subStep)) {
        errors.push(stepLabel + '.subSteps[' + subIndex + '] 必须是字符串或对象');
      }
    });
  });
}

function validateDataShape(raw) {
  const errors = [];
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['数据必须是 JSON 对象'] };
  }
  if (raw.meta !== undefined && !isPlainObject(raw.meta)) errors.push('meta 必须是对象');
  for (const key of ['templates', 'instances', 'history']) {
    const value = raw[key];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      errors.push(key + ' 必须是数组');
      continue;
    }
    value.forEach((entry, index) => {
      const label = key + '[' + index + ']';
      if (!isPlainObject(entry)) {
        errors.push(label + ' 必须是对象');
        return;
      }
      if (key === 'templates' || key === 'instances') {
        validateStepsShape(entry.steps, label + '.steps', errors);
      }
      if (key === 'instances' && entry.variables !== undefined && !isPlainObject(entry.variables)) {
        errors.push(label + '.variables 必须是对象');
      }
    });
  }
  return { ok: errors.length === 0, errors };
}

function summarizeData(raw) {
  return {
    templates: Array.isArray(raw.templates) ? raw.templates.length : 0,
    instances: Array.isArray(raw.instances) ? raw.instances.length : 0,
    history: Array.isArray(raw.history) ? raw.history.length : 0,
    schemaVersion: Number.isFinite(raw.schemaVersion) ? raw.schemaVersion : null,
    exportedAt: raw.exportedAt === undefined ? null : raw.exportedAt,
  };
}

/** 导入必须至少含一个业务数组，嵌套结构与保存/恢复使用相同校验。 */
function validateImportShape(raw) {
  const check = validateDataShape(raw);
  if (!check.ok) return { ...check, summary: null };
  if (!['templates', 'instances', 'history'].some((key) => Array.isArray(raw[key]))) {
    return { ok: false, errors: ['缺少 templates/instances/history 数组'], summary: null };
  }
  return { ok: true, errors: [], summary: summarizeData(raw) };
}

/* ------------------------------------------------------------------ *
 * 备份（§8.4）
 * ------------------------------------------------------------------ */

/** 备份列表，新的在前（按文件名时间戳降序）。 */
function listBackups() {
  const dir = getBackupDir();
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!BACKUP_FILE_RE.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      out.push({ name, path: full, size: st.size, mtime: st.mtimeMs });
    } catch (e) {
      /* 单个文件 stat 失败不影响整体列表 */
    }
  }
  out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  return out;
}

/** 以磁盘上最新时间戳为下限，避免同毫秒/系统回拨时复用已被裁剪的旧名称。 */
function uniqueBackupName(backupDir) {
  let stamp = timestampForFile(new Date());
  const newest = listBackups().find((backup) => /^sop-data-\d{8}T\d{9}\.json$/.test(backup.name));
  const previous = newest ? newest.name.slice('sop-data-'.length, -'.json'.length) : '';
  if (stamp <= previous) {
    // 将文件名看作逻辑时钟；使用 UTC 做进位，避免夏令时/时区变化导致排序倒退。
    const date = new Date(Date.UTC(
      Number(previous.slice(0, 4)), Number(previous.slice(4, 6)) - 1,
      Number(previous.slice(6, 8)), Number(previous.slice(9, 11)),
      Number(previous.slice(11, 13)), Number(previous.slice(13, 15)),
      Number(previous.slice(15, 18)) + 1
    ));
    stamp = date.toISOString().replace(/[-:.Z]/g, '');
  }
  let name = 'sop-data-' + stamp + '.json';
  // 目录中同名非文件也不能被覆盖。
  while (fs.existsSync(path.join(backupDir, name))) {
    name = name.slice(0, -'.json'.length) + '-1.json';
  }
  return name;
}

/** §8.4 步骤 5：只保留最近 3 个备份。删除失败即抛出（步骤失败不得静默）。 */
function pruneBackups() {
  const list = listBackups(); // 新的在前
  for (let i = MAX_BACKUPS; i < list.length; i++) {
    fs.unlinkSync(list[i].path);
  }
}

/* ------------------------------------------------------------------ *
 * §8.4 安全保存算法（六步）
 * ------------------------------------------------------------------ */

function safeSave(data) {
  const dataFile = getDataFile();
  const tmpFile = getTmpFile();
  const backupDir = getBackupDir();
  let step = 'ensure-dirs';

  try {
    // 1. 确保 userData 与 backups 目录存在
    ensureDir(getDataDir());
    ensureDir(backupDir);

    // 2. 写 <data>.tmp（UTF-8，写完后 fsync 并关闭）
    step = 'write-tmp';
    const json = JSON.stringify(data, null, 2);
    const fd = fs.openSync(tmpFile, 'w');
    try {
      fs.writeFileSync(fd, json, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    // 3. 若主文件存在 → 复制到 backups/sop-data-<ts>.json
    step = 'backup-current';
    if (fs.existsSync(dataFile)) {
      const backupName = uniqueBackupName(backupDir);
      fs.copyFileSync(dataFile, path.join(backupDir, backupName));
    }

    // 4. rename tmp -> 主文件
    step = 'rename-tmp';
    fs.renameSync(tmpFile, dataFile);

    // 5. 备份目录只保留最近 3 个
    step = 'prune-backups';
    pruneBackups();

    lastKnownData = data;
    return { ok: true, savedAt: Date.now(), error: null };
  } catch (e) {
    // 清理残留 tmp（不掩盖原始错误）
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch (cleanupErr) {
      /* ignore */
    }
    return { ok: false, savedAt: null, error: '保存失败（' + step + '）: ' + errMsg(e) };
  }
}

/* ------------------------------------------------------------------ *
 * §8.4 启动恢复优先级
 * ------------------------------------------------------------------ */

function readDataWithRecovery() {
  let dataDirOk = true;
  try {
    ensureDir(getDataDir());
    ensureDir(getBackupDir());
  } catch (e) {
    dataDirOk = false;
    console.error('[sop-workflow] 创建数据目录失败:', errMsg(e));
  }

  const dataFile = getDataFile();

  // 主文件不存在 → 空数据（ok:true, recovered:false）
  let exists = false;
  try {
    exists = fs.existsSync(dataFile);
  } catch (e) {
    exists = false;
  }
  if (!exists) {
    lastKnownData = emptyData();
    return { ok: true, data: lastKnownData, recovered: false, source: 'empty', error: null };
  }

  // 只有 JSON 可解析且结构有效才正常加载，避免 normalizeData 静默吞掉损坏字段。
  let parseError = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    const check = validateDataShape(parsed);
    if (!check.ok) throw new Error('主数据文件结构非法: ' + check.errors.join('; '));
    lastKnownData = parsed;
    return { ok: true, data: parsed, recovered: false, source: 'main', error: null };
  } catch (e) {
    parseError = e;
  }
  console.error('[sop-workflow] 主数据文件损坏:', errMsg(parseError));

  // 从新到旧尝试每个备份；一个损坏备份不能遮蔽仍然有效的恢复点。
  const backups = listBackups();
  for (const backup of backups) {
    try {
      const obj = JSON.parse(fs.readFileSync(backup.path, 'utf8'));
      const check = validateDataShape(obj);
      if (!check.ok) throw new Error('备份文件结构非法: ' + check.errors.join('; '));
      lastKnownData = obj;
      console.warn('[sop-workflow] 已从备份恢复:', backup.name);
      return {
        ok: true,
        data: obj,
        recovered: true,
        source: 'backup:' + backup.name,
        error: null,
      };
    } catch (e) {
      console.error('[sop-workflow] 备份不可读:', backup.name, errMsg(e));
    }
  }

  // 备份也不可读 → 空数据（ok:true, recovered:true, source:'empty', error）
  const detail = backups.length === 0 ? '没有可用备份' : '所有备份均不可读';
  lastKnownData = emptyData();
  return {
    ok: true,
    data: lastKnownData,
    recovered: true,
    source: 'empty',
    error: errMsg(parseError) + '（' + detail + (dataDirOk ? '' : '；数据目录不可写') + '）',
  };
}

/* ------------------------------------------------------------------ *
 * 导入 / 导出
 * ------------------------------------------------------------------ */

function buildExportPayload(data) {
  const src = isPlainObject(data) ? data : emptyData();
  return {
    app: 'sop-workflow',
    schemaVersion: Number.isFinite(src.schemaVersion) ? src.schemaVersion : SCHEMA_VERSION,
    exportedAt: Date.now(),
    templates: Array.isArray(src.templates) ? src.templates : [],
    instances: Array.isArray(src.instances) ? src.instances : [],
    history: Array.isArray(src.history) ? src.history : [],
  };
}

/** 导出数据来源：最近一次成功加载/保存的数据，否则读主文件，再否则空数据。 */
function getExportSourceData() {
  if (isPlainObject(lastKnownData)) return lastKnownData;
  try {
    const dataFile = getDataFile();
    if (fs.existsSync(dataFile)) {
      const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      if (isPlainObject(parsed)) return parsed;
    }
  } catch (e) {
    console.error('[sop-workflow] 导出前读取主文件失败:', errMsg(e));
  }
  return emptyData();
}

async function exportDataToFile() {
  let defaultPath;
  try {
    const stamp = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const day =
      String(stamp.getFullYear()) + '-' + p(stamp.getMonth() + 1) + '-' + p(stamp.getDate());
    defaultPath = path.join(app.getPath('documents'), 'sop-workflow-export-' + day + '.json');
  } catch (e) {
    defaultPath = 'sop-workflow-export.json';
  }

  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const res = await dialog.showSaveDialog(parent, {
    title: '导出 SOP 数据',
    defaultPath,
    filters: [{ name: 'JSON 文件', extensions: ['json'] }],
  });

  if (!res || res.canceled || !res.filePath) {
    return { ok: true, canceled: true, filePath: null, error: null };
  }

  try {
    const payload = buildExportPayload(getExportSourceData());
    fs.writeFileSync(res.filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true, canceled: false, filePath: res.filePath, error: null };
  } catch (e) {
    return { ok: false, canceled: false, filePath: res.filePath, error: '导出失败: ' + errMsg(e) };
  }
}

async function importDataFromFile() {
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const res = await dialog.showOpenDialog(parent, {
    title: '导入 SOP 数据',
    filters: [{ name: 'JSON 文件', extensions: ['json'] }],
    properties: ['openFile'],
  });

  if (!res || res.canceled || !res.filePaths || res.filePaths.length === 0) {
    return { ok: true, canceled: true, data: null, filePath: null, error: null, summary: null };
  }

  const filePath = res.filePaths[0];
  let raw;
  try {
    const st = fs.statSync(filePath);
    if (st.size > MAX_IMPORT_BYTES) {
      return {
        ok: false,
        canceled: false,
        data: null,
        filePath,
        error: '导入文件过大（超过 ' + Math.round(MAX_IMPORT_BYTES / 1024 / 1024) + 'MB）',
        summary: null,
      };
    }
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return {
      ok: false,
      canceled: false,
      data: null,
      filePath,
      error: '读取文件失败: ' + errMsg(e),
      summary: null,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      canceled: false,
      data: null,
      filePath,
      error: '文件不是合法 JSON: ' + errMsg(e),
      summary: null,
    };
  }

  // §8.3：主进程侧二次结构校验
  const check = validateImportShape(parsed);
  if (!check.ok) {
    return {
      ok: false,
      canceled: false,
      data: null,
      filePath,
      error: '导入文件结构非法: ' + check.errors.join('; '),
      summary: null,
    };
  }

  return {
    ok: true,
    canceled: false,
    data: parsed,
    filePath,
    error: null,
    summary: check.summary,
  };
}

/* ------------------------------------------------------------------ *
 * 备份恢复 / 文件信息
 * ------------------------------------------------------------------ */

function restoreBackup(rawName) {
  if (typeof rawName !== 'string' || rawName.trim() === '') {
    return { ok: false, data: null, error: '备份文件名非法' };
  }
  const requested = rawName.trim();
  const name = path.basename(requested);
  if (name !== requested || !BACKUP_FILE_RE.test(name)) {
    return { ok: false, data: null, error: '备份文件名非法: ' + requested };
  }

  const backupDir = getBackupDir();
  const full = path.join(backupDir, name);
  if (path.dirname(path.resolve(full)) !== path.resolve(backupDir)) {
    return { ok: false, data: null, error: '备份文件路径越界' };
  }

  try {
    if (!fs.existsSync(full)) {
      return { ok: false, data: null, error: '备份文件不存在: ' + name };
    }
    const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    const check = validateDataShape(parsed);
    if (!check.ok) {
      return { ok: false, data: null, error: '备份文件结构非法: ' + name + '（' + check.errors.join('; ') + '）' };
    }
    return { ok: true, data: parsed, error: null };
  } catch (e) {
    return { ok: false, data: null, error: '读取备份失败: ' + errMsg(e) };
  }
}

function getDataFileInfo() {
  const dataFile = getDataFile();
  let size = 0;
  let mtime = null;
  try {
    const st = fs.statSync(dataFile);
    size = st.size;
    mtime = st.mtimeMs;
  } catch (e) {
    /* 主文件不存在 */
  }
  return {
    ok: true,
    filePath: dataFile,
    backupDir: getBackupDir(),
    size,
    mtime,
    backups: listBackups().map((b) => ({ name: b.name, size: b.size, mtime: b.mtime })),
    error: null,
  };
}

/* ------------------------------------------------------------------ *
 * 窗口状态（独立文件 window-state.json，§2.1）
 * ------------------------------------------------------------------ */

function readWindowState() {
  try {
    const file = getWindowStateFile();
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isPlainObject(raw) ? raw : null;
  } catch (e) {
    console.warn('[sop-workflow] 窗口状态文件不可读，使用默认值:', errMsg(e));
    return null;
  }
}

function sanitizeWindowState(raw) {
  const out = {
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    x: null,
    y: null,
    maximized: false,
  };
  if (!isPlainObject(raw)) return out;
  if (Number.isFinite(raw.width)) out.width = Math.max(MIN_WIDTH, Math.round(raw.width));
  if (Number.isFinite(raw.height)) out.height = Math.max(MIN_HEIGHT, Math.round(raw.height));
  if (Number.isFinite(raw.x) && Number.isFinite(raw.y)) {
    out.x = Math.round(raw.x);
    out.y = Math.round(raw.y);
  }
  out.maximized = raw.maximized === true;
  return out;
}

/** 位置是否落在某个显示器的可视工作区内（避免恢复到已拔掉的屏幕外）。 */
function isOnSomeDisplay(x, y, width, height) {
  try {
    return screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return x < a.x + a.width && x + width > a.x && y < a.y + a.height && y + height > a.y;
    });
  } catch (e) {
    return false;
  }
}

/** 当前窗口的“常态”几何（最大化时取还原后的大小/位置）。 */
function currentWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  try {
    const b = mainWindow.getNormalBounds();
    return {
      width: b.width,
      height: b.height,
      x: b.x,
      y: b.y,
      maximized: mainWindow.isMaximized(),
    };
  } catch (e) {
    return null;
  }
}

function persistWindowState(state) {
  const s = state || currentWindowState();
  if (!s) return false;
  try {
    ensureDir(getDataDir());
    const payload = {
      width: Math.round(s.width),
      height: Math.round(s.height),
      x: Number.isFinite(s.x) ? Math.round(s.x) : null,
      y: Number.isFinite(s.y) ? Math.round(s.y) : null,
      maximized: s.maximized === true,
    };
    fs.writeFileSync(getWindowStateFile(), JSON.stringify(payload, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.warn('[sop-workflow] 窗口状态写入失败:', errMsg(e));
    return false;
  }
}

function scheduleWindowStatePersist() {
  if (windowStateTimer) clearTimeout(windowStateTimer);
  windowStateTimer = setTimeout(() => {
    windowStateTimer = null;
    persistWindowState();
  }, 400);
}

/* ------------------------------------------------------------------ *
 * 窗口
 * ------------------------------------------------------------------ */

function createWindow() {
  const saved = sanitizeWindowState(readWindowState());

  const options = {
    width: saved.width,
    height: saved.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    frame: false, // 自定义标题栏（保持不变）
    backgroundColor: '#f3f3f3', // 保持不变
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, // §8.3 IRON RULE
      nodeIntegration: false, // §8.3 IRON RULE
    },
  };
  if (saved.x !== null && saved.y !== null && isOnSomeDisplay(saved.x, saved.y, saved.width, saved.height)) {
    options.x = saved.x;
    options.y = saved.y;
  }

  mainWindow = new BrowserWindow(options);

  if (saved.maximized) mainWindow.maximize();

  mainWindow.on('resize', scheduleWindowStatePersist);
  mainWindow.on('move', scheduleWindowStatePersist);
  mainWindow.on('maximize', scheduleWindowStatePersist);
  mainWindow.on('unmaximize', scheduleWindowStatePersist);

  // §8.2 步骤 1：用户点关闭 → 未确认过则拦截并通知渲染进程
  mainWindow.on('close', (event) => {
    persistWindowState();
    if (!forceClose) {
      event.preventDefault();
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('app-close-requested');
      }
    }
  });

  mainWindow.on('closed', () => {
    if (windowStateTimer) {
      clearTimeout(windowStateTimer);
      windowStateTimer = null;
    }
    mainWindow = null;
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

/* ------------------------------------------------------------------ *
 * IPC（§8 全表，16 个通道；handler 永不 reject）
 * ------------------------------------------------------------------ */

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await fn(event, ...args);
    } catch (e) {
      console.error('[ipc:' + channel + ']', e);
      return { ok: false, error: errMsg(e) };
    }
  });
}

function registerIpc() {
  // --- 数据 ---
  handle('load-data', () => readDataWithRecovery());

  handle('save-data', (_event, data) => {
    const check = validateDataShape(data);
    if (!check.ok) {
      return { ok: false, savedAt: null, error: '数据结构非法: ' + check.errors.join('; ') };
    }
    return safeSave(data);
  });

  handle('export-data', () => exportDataToFile());
  handle('import-data', () => importDataFromFile());
  handle('get-data-file-info', () => getDataFileInfo());
  handle('restore-backup', (_event, name) => restoreBackup(name));

  // --- 窗口 ---
  handle('minimize-window', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
    return { ok: true };
  });

  handle('maximize-window', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: '窗口不存在' };
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    const maximized = mainWindow.isMaximized();
    persistWindowState();
    return { ok: true, maximized };
  });

  handle('close-window', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    return { ok: true };
  });

  handle('get-window-state', () => {
    const s = currentWindowState();
    if (!s) return { ok: false, error: '窗口不存在' };
    return { ok: true, width: s.width, height: s.height, x: s.x, y: s.y, maximized: s.maximized };
  });

  handle('set-window-state', (_event, partial) => {
    const incoming = isPlainObject(partial) ? partial : {};
    const base = currentWindowState() || sanitizeWindowState(readWindowState());
    const next = { width: base.width, height: base.height, x: base.x, y: base.y, maximized: base.maximized };
    if (Number.isFinite(incoming.width)) next.width = Math.max(MIN_WIDTH, Math.round(incoming.width));
    if (Number.isFinite(incoming.height)) next.height = Math.max(MIN_HEIGHT, Math.round(incoming.height));
    if (Number.isFinite(incoming.x)) next.x = Math.round(incoming.x);
    if (Number.isFinite(incoming.y)) next.y = Math.round(incoming.y);
    if (typeof incoming.maximized === 'boolean') next.maximized = incoming.maximized;
    persistWindowState(next);
    return { ok: true };
  });

  // --- 关闭保护（§8.2） ---
  handle('set-dirty-state', (_event, dirty) => {
    isDirty = dirty === true;
    return { ok: true };
  });

  handle('confirm-close', () => {
    // §8.2 步骤 3：置 forceClose=true 后 win.close()（close 事件不再 preventDefault）
    forceClose = true;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    return { ok: true };
  });

  handle('cancel-close', () => {
    // §8.2 步骤 4：取消关闭；forceClose 保持 false，下次关闭仍受保护
    return { ok: true };
  });

  // --- 文件定位 ---
  handle('reveal-data-file', async () => {
    const dataFile = getDataFile();
    try {
      if (fs.existsSync(dataFile)) {
        shell.showItemInFolder(dataFile);
      } else {
        ensureDir(getDataDir());
        const msg = await shell.openPath(getDataDir());
        if (msg) return { ok: false, error: msg };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  });

  handle('open-backup-folder', async () => {
    try {
      const backupDir = getBackupDir();
      ensureDir(backupDir);
      const msg = await shell.openPath(backupDir);
      if (msg) return { ok: false, error: msg };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  });
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

app.whenReady().then(() => {
  console.log('[sop-workflow] data dir:', getDataDir());

  // 启动即读一次：既创建数据目录，也决定是否需要向渲染层广播 'data-recovered'
  let startup;
  try {
    startup = readDataWithRecovery();
  } catch (e) {
    console.error('[sop-workflow] 启动加载失败:', errMsg(e));
    startup = { ok: false, data: emptyData(), recovered: false, source: 'empty', error: errMsg(e) };
  }
  if (startup.recovered) {
    startupRecovery = { source: startup.source, error: startup.error };
  }

  registerIpc();
  createWindow();

  if (startupRecovery && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.once('did-finish-load', () => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('data-recovered', startupRecovery);
      }
    });
  }
});

app.on('window-all-closed', () => {
  app.quit();
});
