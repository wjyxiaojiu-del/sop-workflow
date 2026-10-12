'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dataStore } = require('../core/data-store.js');
const { progress } = require('../core/progress.js');
const { instanceService } = require('../core/instance-service.js');
const { utils } = require('../core/utils.js');

const T0 = 1_700_000_000_000;

/**
 * Real v1 shapes from `git show 253813d:renderer.js`:
 * - btn-save-template stores {id,name,desc,steps,createdAt,updatedAt};
 *   each step is {title,note,subSteps:string[]} (no step IDs or done).
 * - createInstance stores {id,templateId,templateName,variables,steps,startedAt,status};
 *   steps contain already-substituted text, string subSteps and a parent done boolean.
 * - btn-finish-instance removes the instance and stores history with id=instance.id,
 *   templateName, startedAt, completedAt, stepsTotal and stepsDone only.
 * There are NO completedSteps/stepStates fields, independent child completion flags,
 * elapsedMs or runningSince in that source. Do not fabricate those as legacy fixtures.
 */
function legacyData() {
  return {
    templates: [{
      id: 'loyw3v28tpl01',
      name: '服务器发布',
      desc: '部署与验证',
      steps: [
        { title: '连接 {{服务器地址}}', note: '检查 {{服务器地址}}', subSteps: ['ping {{服务器地址}}', '备份配置'] },
        { title: '发布结束', note: '', subSteps: [] }
      ],
      createdAt: T0 - 60_000,
      updatedAt: T0 - 30_000
    }],
    instances: [{
      id: 'loyw3v28run01',
      templateId: 'loyw3v28tpl01',
      templateName: '服务器发布',
      variables: { 服务器地址: '10.0.0.1' },
      steps: [
        { title: '连接 10.0.0.1', note: '检查 10.0.0.1', subSteps: ['ping 10.0.0.1', '备份配置'], done: true },
        { title: '发布结束', note: '', subSteps: [], done: false }
      ],
      startedAt: T0,
      status: 'running'
    }],
    history: [{
      id: 'loyw2l00end01',
      templateName: '服务器发布',
      startedAt: T0 - 300_000,
      completedAt: T0 - 180_000,
      stepsTotal: 3,
      stepsDone: 2
    }]
  };
}

function reload(data) {
  return dataStore.normalizeData(JSON.parse(JSON.stringify(data)));
}

test('actual v1: checked parent migrates its non-executable string children as completed', () => {
  const raw = legacyData();
  const before = JSON.stringify(raw);
  const migrated = dataStore.normalizeData(raw);
  const inst = migrated.instances[0];

  assert.deepStrictEqual(inst.steps[0].subSteps.map(s => s.done), [true, true]);
  assert.deepStrictEqual(progress.calculateProgress(inst), {
    done: 2, total: 3, percent: 67,
    stepsDone: 1, stepsTotal: 2, subStepsDone: 2, subStepsTotal: 2
  });
  assert.strictEqual(inst.steps[0].title, '连接 10.0.0.1');
  assert.strictEqual(inst.steps[0].subSteps[0].title, 'ping 10.0.0.1');
  assert.deepStrictEqual(migrated.templates[0].steps[0].subSteps.map(s => s.done), [false, false]);
  assert.strictEqual(JSON.stringify(raw), before, 'migration must not mutate the old file');
  assert.deepStrictEqual(reload(migrated), migrated, 'migration must be idempotent after persistence');
});

test('actual v1: entirely completed checklist remains 100%, including string children', () => {
  const raw = legacyData();
  raw.instances[0].steps[1].done = true;
  const inst = dataStore.normalizeData(raw).instances[0];
  assert.strictEqual(progress.calculateProgress(inst).percent, 100);
});

test('actual v1: missing timer anchor preserves wall-clock elapsed across restart, pause and finish', () => {
  const inst = dataStore.normalizeData(legacyData()).instances[0];
  assert.strictEqual(progress.getElapsedMs(inst, T0 + 12_000), 12_000);
  assert.strictEqual(inst.runningSince, T0);
  assert.strictEqual(inst.elapsedMs, 0);

  const paused = instanceService.pauseInstance(reload({ instances: [inst] }).instances[0], T0 + 12_000);
  assert.strictEqual(paused.elapsedMs, 12_000);
  assert.strictEqual(progress.getElapsedMs(paused, T0 + 50_000), 12_000);
  const resumed = instanceService.resumeInstance(reload({ instances: [paused] }).instances[0], T0 + 50_000);
  const finished = instanceService.completeInstance(resumed, T0 + 53_000);
  assert.strictEqual(finished.instance.elapsedMs, 15_000);
  assert.strictEqual(finished.history.elapsedMs, 15_000);
  assert.strictEqual(finished.history.stepsDone, 1);
  assert.strictEqual(finished.history.completionRate, 67);
});

test('actual v1: history retains instance identity, partial counts, start/end and elapsed without guessing template', () => {
  const raw = legacyData();
  const h = dataStore.normalizeData(raw).history[0];
  assert.strictEqual(h.id, raw.history[0].id);
  assert.strictEqual(h.instanceId, raw.history[0].id, 'old history.id was the instance ID');
  assert.strictEqual(h.templateId, '', 'same template name is not proof of identity');
  assert.strictEqual(h.templateName, raw.history[0].templateName);
  assert.strictEqual(h.startedAt, T0 - 300_000);
  assert.strictEqual(h.completedAt, T0 - 180_000);
  assert.strictEqual(h.elapsedMs, 120_000);
  assert.strictEqual(h.stepsTotal, 3);
  assert.strictEqual(h.stepsDone, 2);
  assert.strictEqual(h.completionRate, 67);
  assert.strictEqual(h.status, 'completed');
});

test('modern data: child flags are authoritative and parent done is derived, not copied over them', () => {
  const raw = dataStore.normalizeData(legacyData());
  raw.instances[0].steps[0].done = true;
  raw.instances[0].steps[0].subSteps[0].done = true;
  raw.instances[0].steps[0].subSteps[1].done = false;
  let inst = dataStore.normalizeData(raw).instances[0];
  assert.deepStrictEqual(inst.steps[0].subSteps.map(s => s.done), [true, false]);
  assert.strictEqual(inst.steps[0].done, false);

  raw.instances[0].steps[0].done = false;
  raw.instances[0].steps[0].subSteps[1].done = true;
  inst = dataStore.normalizeData(raw).instances[0];
  assert.strictEqual(inst.steps[0].done, true);
});

test('modern data: elapsed time with a missing anchor resumes deterministically from persisted updatedAt', () => {
  const raw = dataStore.normalizeData(legacyData());
  const inst = raw.instances[0];
  inst.elapsedMs = 12_000;
  inst.updatedAt = T0 + 60_000;
  delete inst.runningSince;

  const migrated = dataStore.normalizeData(raw);
  assert.strictEqual(migrated.instances[0].runningSince, T0 + 60_000);
  assert.strictEqual(progress.getElapsedMs(migrated.instances[0], T0 + 65_000), 17_000);
  assert.deepStrictEqual(reload(migrated), migrated, 'reloading must not settle or restart the timer');
  assert.deepStrictEqual(dataStore.normalizeData(migrated), migrated);

  inst.runningSince = null;
  const stopped = dataStore.normalizeData(raw).instances[0];
  assert.strictEqual(stopped.runningSince, null, 'an explicit null is not a missing field');
  assert.strictEqual(progress.getElapsedMs(stopped, T0 + 65_000), 12_000);
});

test('modern data: paused/completed/abandoned instances cannot keep a stale running clock', () => {
  for (const status of ['paused', 'completed', 'abandoned']) {
    const raw = dataStore.normalizeData(legacyData());
    Object.assign(raw.instances[0], { status, elapsedMs: 12_000, runningSince: T0 });
    const inst = dataStore.normalizeData(raw).instances[0];
    assert.strictEqual(inst.runningSince, null, status);
    assert.strictEqual(progress.getElapsedMs(inst, T0 + 65_000), 12_000, status);
  }
});

test('migration/export/merge: variable snapshots never share mutable input references', () => {
  const raw = legacyData();
  raw.instances[0].variables.extra = { values: ['original'] };
  const migrated = dataStore.normalizeData(raw);
  const exported = dataStore.exportPayload(migrated);
  const merged = dataStore.mergeData(migrated, { templates: [], instances: [], history: [] });
  raw.instances[0].variables.服务器地址 = 'raw mutation';
  raw.instances[0].variables.extra.values[0] = 'raw nested mutation';
  assert.strictEqual(migrated.instances[0].variables.服务器地址, '10.0.0.1');
  assert.strictEqual(migrated.instances[0].variables.extra.values[0], 'original');

  migrated.instances[0].variables.extra.values[0] = 'normalized mutation';
  assert.strictEqual(exported.instances[0].variables.extra.values[0], 'original');
  assert.strictEqual(merged.instances[0].variables.extra.values[0], 'original');
});

test('variables: inherited prototype names stay unresolved unless supplied as own values', () => {
  const text = '{{toString}} {{constructor}} {{valueOf}} {{__proto__}} {{服务器地址}}';
  assert.strictEqual(utils.replaceVars(text, { 服务器地址: '10.0.0.1' }),
    '{{toString}} {{constructor}} {{valueOf}} {{__proto__}} 10.0.0.1');
  const inherited = Object.create({ 服务器地址: 'not supplied' });
  assert.strictEqual(utils.replaceVars('{{服务器地址}}', inherited), '{{服务器地址}}');
});

test('variables: explicit __proto__/toString/constructor values survive creation and JSON round-trip', () => {
  const variables = JSON.parse('{"__proto__":"server-a","toString":"text","constructor":"build"}');
  const template = legacyData().templates[0];
  template.steps[0].title = '{{__proto__}} / {{toString}} / {{constructor}}';
  const inst = instanceService.createInstance(template, variables, T0);
  assert.strictEqual(inst.steps[0].title, 'server-a / text / build');
  assert.strictEqual(Object.getPrototypeOf(inst.variables), Object.prototype);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(inst.variables, '__proto__'), true);
  const back = reload(dataStore.exportPayload({ instances: [inst] })).instances[0];
  assert.deepStrictEqual(back.variables, variables);
  assert.strictEqual(back.steps[0].title, inst.steps[0].title);
});

test('deepClone: JSON __proto__ objects remain own data and cannot inject inherited values', () => {
  const raw = JSON.parse('{"__proto__":{"injected":"not inherited"},"nested":{"__proto__":{"flag":true}}}');
  const clone = utils.deepClone(raw);
  assert.strictEqual(Object.getPrototypeOf(clone), Object.prototype);
  assert.strictEqual(Object.getPrototypeOf(clone.nested), Object.prototype);
  assert.strictEqual(clone.injected, undefined);
  assert.strictEqual(clone.nested.flag, undefined);
  assert.strictEqual({}.injected, undefined);
  assert.deepStrictEqual(clone, raw);
  assert.notStrictEqual(clone.__proto__, raw.__proto__);
  assert.notStrictEqual(clone.nested.__proto__, raw.nested.__proto__);
});

test('actual v1 merge: a same-timestamp older import cannot erase local checked progress', () => {
  const raw = legacyData();
  raw.instances[0].steps[1].done = true;
  const current = dataStore.normalizeData(raw);
  const incoming = legacyData();
  incoming.instances[0].steps[0].done = false;
  const merged = dataStore.mergeData(current, incoming);
  assert.deepStrictEqual(merged.instances[0], current.instances[0]);
  assert.strictEqual(progress.calculateProgress(merged.instances[0]).percent, 100);
});

test('merge: equal timestamps preserve local templates/history while strictly newer records still win', () => {
  const current = dataStore.normalizeData(legacyData());
  current.templates[0].name = 'local edit';
  current.history[0].templateId = current.templates[0].id;
  const merged = dataStore.mergeData(current, legacyData());
  assert.deepStrictEqual(merged.templates[0], current.templates[0]);
  assert.deepStrictEqual(merged.history[0], current.history[0]);

  const incoming = reload(current);
  incoming.templates[0].name = 'newer edit';
  incoming.templates[0].updatedAt += 1000;
  assert.strictEqual(dataStore.mergeData(current, incoming).templates[0].name, 'newer edit');
});

test('actual v1 merge: finished execution cannot resurrect from its earlier running backup', () => {
  const runningBackup = legacyData();
  const before = JSON.stringify(runningBackup);
  const oldInstance = runningBackup.instances[0];
  // Exact btn-finish-instance history shape from v1; the instance is removed there.
  const finishedData = {
    templates: runningBackup.templates,
    instances: [],
    history: [{
      id: oldInstance.id,
      templateName: oldInstance.templateName,
      startedAt: oldInstance.startedAt,
      completedAt: T0 + 20_000,
      stepsTotal: 2,
      stepsDone: 1
    }]
  };

  for (const [current, incoming] of [[finishedData, runningBackup], [runningBackup, finishedData]]) {
    const merged = dataStore.mergeData(current, incoming);
    const inst = merged.instances.find(i => i.id === oldInstance.id);
    const h = merged.history.find(h => h.instanceId === oldInstance.id);
    assert.ok(inst, 'retain the historical steps/variables snapshot rather than deleting it');
    assert.strictEqual(inst.status, 'completed');
    assert.strictEqual(instanceService.isActive(inst), false);
    assert.strictEqual(inst.completedAt, T0 + 20_000);
    assert.strictEqual(inst.elapsedMs, 20_000);
    assert.strictEqual(inst.runningSince, null);
    assert.strictEqual(inst.updatedAt, T0 + 20_000);
    assert.strictEqual(inst.steps[0].title, oldInstance.steps[0].title);
    assert.deepStrictEqual(inst.variables, oldInstance.variables);
    assert.strictEqual(h.templateId, oldInstance.templateId, 'only an exact instance identity proves linkage');
    assert.strictEqual(h.stepsDone, 1);
    assert.deepStrictEqual(reload(merged), merged);
  }
  assert.strictEqual(JSON.stringify(runningBackup), before);
});

test('modern merge: abandoned history prevents resurrection while preserving paused snapshot content', () => {
  const backup = dataStore.normalizeData(legacyData());
  const oldInstance = backup.instances[0];
  oldInstance.status = 'paused';
  oldInstance.runningSince = null;
  oldInstance.elapsedMs = 7000;
  oldInstance.executionNotes = 'retain execution notes';
  const result = instanceService.abandonInstance(oldInstance, T0 + 25_000);
  const terminal = { templates: [], instances: [], history: [result.history] };
  const merged = dataStore.mergeData(terminal, backup);
  const inst = merged.instances[0];
  assert.strictEqual(inst.status, 'abandoned');
  assert.strictEqual(inst.elapsedMs, 7000, 'do not substitute wall time for paused elapsed');
  assert.strictEqual(inst.completedAt, T0 + 25_000);
  assert.strictEqual(inst.executionNotes, 'retain execution notes');
  assert.deepStrictEqual(inst.steps, oldInstance.steps);
  assert.strictEqual(instanceService.isActive(inst), false);
});

test('normalization: history from the exact instance reconciles terminal status without template-name guessing', () => {
  const raw = legacyData();
  raw.history[0].id = raw.instances[0].id;
  raw.history[0].startedAt = T0;
  raw.history[0].completedAt = T0 + 10_000;
  const migrated = dataStore.normalizeData(raw);
  assert.strictEqual(migrated.instances[0].status, 'completed');
  assert.strictEqual(migrated.history[0].templateId, raw.instances[0].templateId);
  assert.strictEqual(migrated.instances[0].completedAt, T0 + 10_000);
});

test('merge: repeated history import without a record ID deduplicates by execution identity and time', () => {
  const history = [{
    instanceId: 'i_missing_history_id', templateId: 't_1', templateName: 'one execution',
    status: 'completed', startedAt: T0, completedAt: T0 + 1000,
    elapsedMs: 1000, stepsTotal: 1, stepsDone: 1, completionRate: 100
  }];
  const current = dataStore.normalizeData({ history });
  const merged = dataStore.mergeData(current, { history });
  assert.strictEqual(merged.history.length, 1);
  assert.deepStrictEqual(merged.history[0], current.history[0]);
  assert.deepStrictEqual(dataStore.mergeData(merged, { history }), merged);
});

test('merge identity guards: same names or timestamps never collapse distinct executions or templates', () => {
  const a = dataStore.normalizeData(legacyData());
  const b = reload(a);
  b.templates[0].id = 'other-template';
  b.instances[0].id = 'other-instance';
  b.history[0].id = 'other-history';
  b.history[0].instanceId = 'other-finished-instance';
  const merged = dataStore.mergeData(a, b);
  assert.strictEqual(merged.templates.length, 2);
  assert.strictEqual(merged.instances.length, 2);
  assert.strictEqual(merged.history.length, 2);
  assert.strictEqual(merged.instances.every(instanceService.isActive), true);

  const ids = ['__proto__', 'constructor'];
  const unusual = dataStore.mergeData(
    { templates: [{ ...a.templates[0], id: ids[0] }] },
    { templates: [{ ...a.templates[0], id: ids[1] }] }
  );
  assert.deepStrictEqual(unusual.templates.map(t => t.id), ids, 'IDs are opaque keys, not object properties');
});
