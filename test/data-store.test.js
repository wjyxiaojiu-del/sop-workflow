'use strict';

/**
 * §7 core/data-store.js 契约测试
 * 纯函数部分（normalizeData / validateImport / mergeData / exportPayload）直接测试；
 * IO 函数（load/save/exportToFile/importFromFile/getFileInfo）通过注入假 window.api 测试，
 * 不依赖 Electron、不依赖真实文件系统。
 *
 * 覆盖 §12 验收矩阵 #10 #13 #15
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// ---- 假 window.api：必须在 require 之前注入（契约 §1.1 禁止模块顶层访问 window） ----
const calls = { loadData: 0, saveData: 0, exportData: 0, importData: 0, getDataFileInfo: 0 };
let apiImpl = null;

globalThis.window = globalThis.window || {};
globalThis.window.api = {
  loadData: (...a) => { calls.loadData += 1; return apiImpl.loadData(...a); },
  saveData: (...a) => { calls.saveData += 1; return apiImpl.saveData(...a); },
  exportData: (...a) => { calls.exportData += 1; return apiImpl.exportData(...a); },
  importData: (...a) => { calls.importData += 1; return apiImpl.importData(...a); },
  getDataFileInfo: (...a) => { calls.getDataFileInfo += 1; return apiImpl.getDataFileInfo(...a); }
};

const mod = require('../core/data-store.js');

assert.ok(mod && typeof mod === 'object', 'core/data-store.js 必须导出对象（契约 §1.2）');
assert.ok(mod.dataStore && typeof mod.dataStore === 'object', 'core/data-store.js 必须导出 { dataStore }（契约 §1.2）');
const dataStore = mod.dataStore;

const NOW = 1_700_000_000_000;

function resetApi(impl) {
  apiImpl = Object.assign(
    {
      loadData: async () => ({ ok: true, data: emptyData() }),
      saveData: async () => ({ ok: true, savedAt: NOW }),
      exportData: async () => ({ ok: true, canceled: false, filePath: '/tmp/sop.json' }),
      importData: async () => ({ ok: true, canceled: false, data: emptyData(), filePath: '/tmp/sop.json' }),
      getDataFileInfo: async () => ({ ok: true, filePath: '/tmp/sop-data.json', backupDir: '/tmp/backups', size: 10, mtime: NOW, backups: [] })
    },
    impl || {}
  );
}
resetApi();

function emptyData() {
  return { schemaVersion: 2, templates: [], instances: [], history: [], meta: { lastSavedAt: 0, exportedAt: null } };
}

function rawTemplate(overrides) {
  return Object.assign(
    {
      id: 't_1',
      name: '文献精读',
      desc: '逐段精读',
      category: '科研',
      tags: ['文献'],
      favorite: false,
      version: 2,
      steps: [
        { id: 's_1', title: '确认文章信息', note: '记录 DOI', done: false, subSteps: [] }
      ],
      createdAt: 1000,
      updatedAt: 2000,
      lastUsedAt: null
    },
    overrides || {}
  );
}

function rawInstance(overrides) {
  return Object.assign(
    {
      id: 'i_1',
      templateId: 't_1',
      templateVersion: 2,
      templateName: '文献精读',
      variables: {},
      steps: [{ id: 's_1', title: '确认文章信息', note: '', done: false, subSteps: [] }],
      status: 'running',
      startedAt: 1000,
      updatedAt: 2000,
      completedAt: null,
      elapsedMs: 0,
      executionNotes: ''
    },
    overrides || {}
  );
}

function rawHistory(overrides) {
  return Object.assign(
    {
      id: 'h_1',
      instanceId: 'i_1',
      templateId: 't_1',
      templateName: '文献精读',
      status: 'completed',
      startedAt: 1000,
      completedAt: 5000,
      elapsedMs: 4000,
      stepsTotal: 3,
      stepsDone: 3,
      completionRate: 100
    },
    overrides || {}
  );
}

function rawData(overrides) {
  return Object.assign(
    { schemaVersion: 2, templates: [rawTemplate()], instances: [rawInstance()], history: [rawHistory()] },
    overrides || {}
  );
}

test('dataStore: 导出契约完整（§7）', () => {
  const fns = ['normalizeData', 'validateImport', 'mergeData', 'exportPayload', 'load', 'save', 'exportToFile', 'importFromFile', 'getFileInfo'];
  for (const fn of fns) {
    assert.strictEqual(typeof dataStore[fn], 'function', `dataStore.${fn} 必须是函数`);
  }
});

test('§2.6 dataStore 常量: STATUS / CATEGORIES / SCHEMA_VERSION', () => {
  assert.deepStrictEqual(dataStore.STATUS, {
    RUNNING: 'running',
    PAUSED: 'paused',
    COMPLETED: 'completed',
    ABANDONED: 'abandoned'
  });
  assert.deepStrictEqual(dataStore.CATEGORIES, ['科研', '学习', '开发', '生活', '其他']);
  assert.strictEqual(dataStore.SCHEMA_VERSION, 2);
});

test('normalizeData: 非法输入回落空数据且永不抛错（null/undefined/字符串/数组/数字）', () => {
  for (const bad of [null, undefined, '字符串', 42, true, [], [1, 2, 3]]) {
    let out;
    assert.doesNotThrow(() => { out = dataStore.normalizeData(bad); }, `normalizeData(${JSON.stringify(bad)}) 不得抛错`);
    assert.ok(out && typeof out === 'object' && !Array.isArray(out));
    assert.deepStrictEqual(out.templates, []);
    assert.deepStrictEqual(out.instances, []);
    assert.deepStrictEqual(out.history, []);
    assert.strictEqual(out.schemaVersion, 2);
  }
});

test('normalizeData: 补齐 schemaVersion / meta / 缺失字段（§7.1）', () => {
  const out = dataStore.normalizeData({ templates: [{}], instances: [{}], history: [{}] });
  assert.strictEqual(out.schemaVersion, 2);
  assert.ok(out.meta && typeof out.meta === 'object');
  assert.strictEqual(typeof out.meta.lastSavedAt, 'number');
  assert.ok('exportedAt' in out.meta);

  const t = out.templates[0];
  assert.ok('category' in t);
  assert.ok(Array.isArray(t.tags));
  assert.strictEqual(typeof t.favorite, 'boolean');
  assert.strictEqual(typeof t.version, 'number');
  assert.ok('lastUsedAt' in t);
  assert.ok(Array.isArray(t.steps));

  const i = out.instances[0];
  assert.strictEqual(typeof i.templateVersion, 'number');
  assert.strictEqual(typeof i.updatedAt, 'number');
  assert.ok('completedAt' in i);
  assert.strictEqual(typeof i.elapsedMs, 'number');
  assert.strictEqual(typeof i.executionNotes, 'string');

  const h = out.history[0];
  assert.ok('instanceId' in h);
  assert.ok('templateId' in h);
  assert.strictEqual(typeof h.completionRate, 'number');
  assert.ok(h.completionRate >= 0 && h.completionRate <= 100);
  assert.strictEqual(typeof h.elapsedMs, 'number');
});

test('normalizeData: 非法 category 回落 "其他"，tags 去重去空（§2.2）', () => {
  const out = dataStore.normalizeData({
    templates: [rawTemplate({ category: '非法分类', tags: [' a ', 'a', '', 'b'] })]
  });
  assert.strictEqual(out.templates[0].category, '其他');
  assert.deepStrictEqual(out.templates[0].tags, ['a', 'b']);
});

test('§12-13 normalizeData: 旧格式迁移 subSteps 字符串数组 -> [{id,title,done}]', () => {
  const legacy = {
    schemaVersion: 1,
    templates: [
      {
        id: 't_old',
        name: '旧模板',
        steps: [
          { id: 's_old', title: '旧步骤', note: '', done: false, subSteps: ['记录 DOI', '记录实验对象'] }
        ]
      }
    ],
    instances: [
      {
        id: 'i_old',
        templateId: 't_old',
        templateName: '旧模板',
        steps: [
          { id: 's_old', title: '旧步骤', note: '', done: false, subSteps: ['记录 DOI', '记录实验对象'] }
        ],
        status: 'running',
        startedAt: 0
      }
    ],
    history: []
  };

  let out;
  assert.doesNotThrow(() => { out = dataStore.normalizeData(legacy); });

  const tplSubs = out.templates[0].steps[0].subSteps;
  assert.strictEqual(tplSubs.length, 2);
  for (const ss of tplSubs) {
    assert.strictEqual(typeof ss, 'object', 'subSteps 元素必须迁移为对象');
    assert.strictEqual(typeof ss.id, 'string');
    assert.ok(ss.id.length > 0, '迁移后子步骤必须有 id');
    assert.strictEqual(ss.done, false);
  }
  assert.strictEqual(tplSubs[0].title, '记录 DOI');
  assert.strictEqual(tplSubs[1].title, '记录实验对象');
  assert.notStrictEqual(tplSubs[0].id, tplSubs[1].id, '迁移后子步骤 id 必须互不相同');

  const instSubs = out.instances[0].steps[0].subSteps;
  assert.strictEqual(instSubs.length, 2);
  assert.strictEqual(instSubs[0].title, '记录 DOI');
  assert.strictEqual(instSubs[0].done, false);
  assert.strictEqual(typeof instSubs[0].id, 'string');

  // 契约 §2.1/§2.6：数据根对象与常量权威值均为 schemaVersion 2，
  // 因此旧数据经 normalizeData 后必须落到 2（而非回落到旧版本号）。
  assert.strictEqual(dataStore.SCHEMA_VERSION, 2);
  assert.strictEqual(out.schemaVersion, 2, '旧数据必须升级为 schemaVersion 2');
});

test('§12-13 normalizeData: 迁移后的子步骤可被 progress 正确计数', () => {
  const progress = require('../core/progress.js').progress;
  const out = dataStore.normalizeData({
    instances: [
      {
        id: 'i_old',
        templateId: 't_old',
        steps: [
          { id: 's_a', title: 'A', note: '', done: false, subSteps: ['x', 'y'] },
          { id: 's_b', title: 'B', note: '', done: false, subSteps: [] }
        ],
        status: 'running'
      }
    ]
  });
  const p = progress.calculateProgress(out.instances[0]);
  assert.strictEqual(p.total, 3, '2 个子步骤 + 1 个无子步骤 = 3 项');
  assert.strictEqual(p.stepsTotal, 2);
  assert.strictEqual(p.subStepsTotal, 2);
});

test('§12-15 validateImport: 非法数据被拒绝（valid:false）', () => {
  const illegal = [
    null,
    undefined,
    'not json',
    42,
    true,
    [],
    [1, 2, 3],
    {},
    { foo: 'bar' },
    { templates: 'not-an-array' },
    { templates: [1, 2], instances: [], history: [] },
    { templates: [], instances: 'x', history: [] },
    { templates: [], instances: [1, 2], history: [] },
    { templates: [], instances: [], history: 'not-an-array' },
    { templates: [], instances: [], history: [1, 2] }
  ];
  for (const bad of illegal) {
    let res;
    assert.doesNotThrow(() => { res = dataStore.validateImport(bad); }, `validateImport(${JSON.stringify(bad)}) 不得抛错`);
    assert.ok(res && typeof res === 'object', 'validateImport 必须返回对象');
    assert.strictEqual(res.valid, false, `validateImport(${JSON.stringify(bad)}) 必须 valid:false`);
    assert.ok(Array.isArray(res.errors), 'errors 必须是数组');
    assert.ok(res.errors.length > 0, `valid:false 时 errors 不得为空（${JSON.stringify(bad)}）`);
    assert.strictEqual(res.data, null, 'valid:false 时 data 必须为 null');
  }
});

test('§12-15 validateImport: 合法数据被接受，summary 正确', () => {
  const res = dataStore.validateImport(rawData());
  assert.strictEqual(res.valid, true);
  assert.deepStrictEqual(res.errors, []);
  assert.ok(res.data && typeof res.data === 'object');
  assert.ok(res.summary && typeof res.summary === 'object');
  assert.strictEqual(res.summary.templates, 1);
  assert.strictEqual(res.summary.instances, 1);
  assert.strictEqual(res.summary.history, 1);
  assert.strictEqual(res.summary.schemaVersion, 2);
  assert.ok('exportedAt' in res.summary);
});

test('§12-15 validateImport: 接受 exportPayload 结构（含 app/exportedAt 字段）', () => {
  const payload = dataStore.exportPayload(dataStore.normalizeData(rawData()));
  const res = dataStore.validateImport(payload);
  assert.strictEqual(res.valid, true, '自身导出的 payload 必须可被 validateImport 接受');
  assert.strictEqual(res.summary.templates, 1);
});

test('§12-15 validateImport: 旧格式（字符串 subSteps）仍可导入并迁移', () => {
  const legacy = {
    schemaVersion: 1,
    templates: [
      { id: 't_old', name: '旧模板', steps: [{ id: 's', title: 'S', note: '', done: false, subSteps: ['a', 'b'] }] }
    ],
    instances: [],
    history: []
  };
  const res = dataStore.validateImport(legacy);
  assert.strictEqual(res.valid, true, 'v1.0 旧导出文件必须仍可导入');
  assert.strictEqual(typeof res.data.templates[0].steps[0].subSteps[0], 'object');
  assert.strictEqual(res.data.templates[0].steps[0].subSteps[0].title, 'a');
});

test('§12-10 exportPayload: 结构正确', () => {
  const data = dataStore.normalizeData(rawData());
  const payload = dataStore.exportPayload(data);
  assert.strictEqual(payload.app, 'sop-workflow');
  assert.strictEqual(payload.schemaVersion, 2);
  assert.strictEqual(typeof payload.exportedAt, 'number');
  assert.ok(payload.exportedAt > 0);
  assert.deepStrictEqual(payload.templates, data.templates);
  assert.deepStrictEqual(payload.instances, data.instances);
  assert.deepStrictEqual(payload.history, data.history);
});

test('§12-10 exportPayload -> normalizeData round-trip: 数据等价', () => {
  const data = dataStore.normalizeData(rawData());
  const payload = dataStore.exportPayload(data);
  const back = dataStore.normalizeData(JSON.parse(JSON.stringify(payload)));
  assert.deepStrictEqual(back.templates, data.templates);
  assert.deepStrictEqual(back.instances, data.instances);
  assert.deepStrictEqual(back.history, data.history);
  assert.strictEqual(back.schemaVersion, 2);
  assert.deepStrictEqual(back, data, 'round-trip 后完整数据必须等价');
});

test('§12-10 round-trip: 含变量替换后的实例快照保持逐字不变', () => {
  const data = dataStore.normalizeData({
    templates: [],
    instances: [
      rawInstance({
        variables: { 服务器地址: '10.0.0.1' },
        steps: [
          { id: 's_1', title: '连接 10.0.0.1', note: '确认 10.0.0.1 可达', done: true, subSteps: [{ id: 'ss_1', title: 'ping 10.0.0.1', done: true }] }
        ]
      })
    ],
    history: []
  });
  const payload = dataStore.exportPayload(data);
  const back = dataStore.normalizeData(JSON.parse(JSON.stringify(payload)));
  assert.strictEqual(back.instances[0].steps[0].title, '连接 10.0.0.1');
  assert.strictEqual(back.instances[0].steps[0].subSteps[0].title, 'ping 10.0.0.1');
  assert.deepStrictEqual(back.instances, data.instances);
});

test('mergeData: 同 id 保留 updatedAt 较新者', () => {
  const current = dataStore.normalizeData({ templates: [rawTemplate({ updatedAt: 100, name: '旧' })], instances: [], history: [] });
  const incoming = dataStore.normalizeData({ templates: [rawTemplate({ updatedAt: 300, name: '新' })], instances: [], history: [] });

  const merged = dataStore.mergeData(current, incoming);
  assert.strictEqual(merged.templates.length, 1);
  assert.strictEqual(merged.templates[0].name, '新');
  assert.strictEqual(merged.templates[0].updatedAt, 300);

  const mergedReverse = dataStore.mergeData(incoming, current);
  assert.strictEqual(mergedReverse.templates.length, 1);
  assert.strictEqual(mergedReverse.templates[0].name, '新', '入参顺序不得改变「较新者胜出」结论');
});

test('mergeData: 不同 id 合并为并集', () => {
  const current = dataStore.normalizeData({ templates: [rawTemplate({ id: 't_a', name: 'A' })], instances: [rawInstance({ id: 'i_a' })], history: [] });
  const incoming = dataStore.normalizeData({ templates: [rawTemplate({ id: 't_b', name: 'B' })], instances: [rawInstance({ id: 'i_b' })], history: [] });
  const merged = dataStore.mergeData(current, incoming);
  assert.deepStrictEqual(merged.templates.map((t) => t.id).sort(), ['t_a', 't_b']);
  assert.deepStrictEqual(merged.instances.map((i) => i.id).sort(), ['i_a', 'i_b']);
});

test('mergeData: history 合并后按 id 去重并按 completedAt 降序', () => {
  const current = dataStore.normalizeData({
    templates: [], instances: [],
    history: [
      rawHistory({ id: 'h_1', completedAt: 1000 }),
      rawHistory({ id: 'h_2', completedAt: 3000 })
    ]
  });
  const incoming = dataStore.normalizeData({
    templates: [], instances: [],
    history: [
      rawHistory({ id: 'h_2', completedAt: 3000 }),
      rawHistory({ id: 'h_3', completedAt: 2000 })
    ]
  });
  const merged = dataStore.mergeData(current, incoming);
  assert.deepStrictEqual(merged.history.map((h) => h.id), ['h_2', 'h_3', 'h_1'], '必须按 completedAt 降序且去重');
});

test('mergeData: 空/非法入参不抛错', () => {
  assert.doesNotThrow(() => dataStore.mergeData(null, null));
  assert.doesNotThrow(() => dataStore.mergeData(undefined, rawData()));
  const merged = dataStore.mergeData(null, rawData());
  assert.strictEqual(merged.templates.length, 1);
});

test('dataStore.load: 调用 window.api.loadData 并经 normalizeData 归一化', async () => {
  resetApi({ loadData: async () => ({ ok: true, data: { templates: [{ id: 't_1', name: 'T', steps: [] }], instances: [], history: [] }, recovered: false, source: 'file' }) });
  const res = await dataStore.load();
  assert.strictEqual(calls.loadData, 1, 'load() 必须调用 window.api.loadData');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.recovered, false);
  assert.strictEqual(res.source, 'file');
  assert.strictEqual(res.data.schemaVersion, 2, 'load() 必须调用 normalizeData');
  assert.ok(Array.isArray(res.data.templates));
  assert.ok(Array.isArray(res.data.instances));
  assert.ok(Array.isArray(res.data.history));
});

test('dataStore.load: 旧格式经 load() 自动迁移', async () => {
  resetApi({
    loadData: async () => ({
      ok: true,
      data: { schemaVersion: 1, templates: [{ id: 't_1', name: 'T', steps: [{ id: 's', title: 'S', note: '', done: false, subSteps: ['a'] }] }], instances: [], history: [] },
      recovered: false
    })
  });
  const res = await dataStore.load();
  assert.strictEqual(typeof res.data.templates[0].steps[0].subSteps[0], 'object');
  assert.strictEqual(res.data.templates[0].steps[0].subSteps[0].title, 'a');
});

test('dataStore.load: 备份恢复时透传 recovered / source', async () => {
  resetApi({ loadData: async () => ({ ok: true, data: emptyData(), recovered: true, source: 'backup:sop-data-123.json' }) });
  const res = await dataStore.load();
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.recovered, true);
  assert.strictEqual(res.source, 'backup:sop-data-123.json');
});

test('dataStore.load: 主进程返回 ok:false 时透传错误且不抛错', async () => {
  resetApi({ loadData: async () => ({ ok: false, error: '读取失败', data: null }) });
  let res;
  await assert.doesNotReject(async () => { res = await dataStore.load(); });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, '读取失败');
  assert.ok('data' in res);
});

test('dataStore.load: window.api 缺失时返回 ok:false，不抛错', async () => {
  const saved = globalThis.window;
  globalThis.window = {};
  try {
    const res = await dataStore.load();
    assert.strictEqual(res.ok, false);
    assert.ok(typeof res.error === 'string' && res.error.length > 0, '必须给出错误信息');
  } finally {
    globalThis.window = saved;
  }
});

test('dataStore.save: 成功时返回 { ok:true, savedAt }', async () => {
  resetApi({ saveData: async () => ({ ok: true, savedAt: NOW }) });
  const data = dataStore.normalizeData(rawData());
  const res = await dataStore.save(data);
  assert.strictEqual(calls.saveData, 1);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.savedAt, NOW);
});

test('dataStore.save: 失败时 ok:false（或抛错），绝不静默成功（IRON RULE §7.2）', async () => {
  resetApi({ saveData: async () => ({ ok: false, error: '磁盘写入失败' }) });
  const data = dataStore.normalizeData(rawData());

  let res = null;
  let threw = null;
  try {
    res = await dataStore.save(data);
  } catch (err) {
    threw = err;
  }
  if (threw) {
    assert.ok(threw instanceof Error, '抛出的必须是 Error');
  } else {
    assert.ok(res && typeof res === 'object', 'save 必须返回对象或抛错');
    assert.strictEqual(res.ok, false, '失败时不得返回 ok:true');
    assert.ok(typeof res.error === 'string' && res.error.length > 0, '失败时必须带 error');
  }
});

test('dataStore.save: 主进程抛异常时不静默成功', async () => {
  resetApi({ saveData: async () => { throw new Error('IPC 断开'); } });
  const data = dataStore.normalizeData(rawData());
  let res = null;
  let threw = null;
  try {
    res = await dataStore.save(data);
  } catch (err) {
    threw = err;
  }
  if (threw) {
    assert.ok(threw instanceof Error);
  } else {
    assert.strictEqual(res.ok, false);
    assert.ok(typeof res.error === 'string' && res.error.length > 0);
  }
});

test('dataStore.exportToFile: 透传 window.api.exportData 结果', async () => {
  resetApi({ exportData: async () => ({ ok: true, canceled: false, filePath: '/home/u/sop-export.json' }) });
  const res = await dataStore.exportToFile();
  assert.strictEqual(calls.exportData, 1);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.canceled, false);
  assert.strictEqual(res.filePath, '/home/u/sop-export.json');
});

test('dataStore.importFromFile: 透传并归一化导入数据', async () => {
  resetApi({
    importData: async () => ({
      ok: true,
      canceled: false,
      filePath: '/home/u/sop-export.json',
      data: { schemaVersion: 1, templates: [{ id: 't_x', name: 'X', steps: [{ id: 's', title: 'S', note: '', done: false, subSteps: ['a'] }] }], instances: [], history: [] }
    })
  });
  const res = await dataStore.importFromFile();
  assert.strictEqual(calls.importData, 1);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.canceled, false);
  assert.ok(res.data, '成功导入必须返回归一化后的 data');
  assert.strictEqual(res.data.schemaVersion, 2);
  assert.strictEqual(typeof res.data.templates[0].steps[0].subSteps[0], 'object');
});

test('dataStore.importFromFile: 用户取消时透传 canceled 且不报错', async () => {
  resetApi({ importData: async () => ({ ok: true, canceled: true, data: null, filePath: null }) });
  const res = await dataStore.importFromFile();
  assert.strictEqual(res.canceled, true);
  assert.strictEqual(res.ok, true);
});

test('dataStore.getFileInfo: 透传文件信息与备份列表', async () => {
  const backups = [{ name: 'sop-data-1.json', size: 100, mtime: NOW }];
  resetApi({ getDataFileInfo: async () => ({ ok: true, filePath: '/home/u/sop-data.json', backupDir: '/home/u/backups', size: 2048, mtime: NOW, backups }) });
  const res = await dataStore.getFileInfo();
  assert.strictEqual(calls.getDataFileInfo, 1);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.filePath, '/home/u/sop-data.json');
  assert.strictEqual(res.backupDir, '/home/u/backups');
  assert.strictEqual(res.size, 2048);
  assert.deepStrictEqual(res.backups, backups);
});
