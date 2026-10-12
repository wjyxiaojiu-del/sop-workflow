'use strict';

/**
 * §6 core/instance-service.js 契约测试（纯函数 + 不可变风格）
 * 覆盖 §12 验收矩阵 #6 #7 #8 #9 #12
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const mod = require('../core/instance-service.js');
const progressMod = require('../core/progress.js');

assert.ok(mod && typeof mod === 'object', 'core/instance-service.js 必须导出对象（契约 §1.2）');
assert.ok(
  mod.instanceService && typeof mod.instanceService === 'object',
  'core/instance-service.js 必须导出 { instanceService }（契约 §1.2）'
);
const instanceService = mod.instanceService;
const progress = progressMod.progress;

const T0 = 1_700_000_000_000; // 固定基准时间，保证确定性

/**
 * 夹具模板：
 *   s_1 无子步骤（1 项）
 *   s_2 三子步骤（3 项）
 *   s_3 两子步骤（2 项）
 *   => checklist 共 6 项，顶层 3 步
 */
function makeTemplate() {
  return {
    id: 't_lit',
    name: '文献精读',
    desc: '逐段精读',
    category: '科研',
    tags: ['论文'],
    favorite: false,
    version: 3,
    steps: [
      {
        id: 's_1',
        title: '连接 {{服务器地址}}',
        note: '确认 {{服务器地址}} 可达',
        done: false,
        subSteps: []
      },
      {
        id: 's_2',
        title: '三子步骤',
        note: '',
        done: false,
        subSteps: [
          { id: 'ss_2a', title: 'ping {{服务器地址}}', done: false },
          { id: 'ss_2b', title: 'b', done: false },
          { id: 'ss_2c', title: 'c', done: false }
        ]
      },
      {
        id: 's_3',
        title: '两子步骤',
        note: '',
        done: false,
        subSteps: [
          { id: 'ss_3a', title: 'x', done: false },
          { id: 'ss_3b', title: 'y', done: false }
        ]
      }
    ],
    createdAt: 1000,
    updatedAt: 2000,
    lastUsedAt: null
  };
}

function makeInstance(status, overrides) {
  return Object.assign(
    {
      id: 'i_1',
      templateId: 't_lit',
      templateVersion: 3,
      templateName: '文献精读',
      variables: {},
      steps: [],
      status: status || 'running',
      startedAt: T0,
      updatedAt: T0,
      completedAt: null,
      elapsedMs: 0,
      runningSince: status === 'running' || status === undefined ? T0 : null,
      executionNotes: ''
    },
    overrides || {}
  );
}

/** 生成一个已完成全部 checklist 的实例 */
function completedFixture(now) {
  let inst = instanceService.createInstance(makeTemplate(), { 服务器地址: '10.0.0.1' }, T0);
  inst = progress.toggleStep(inst, 0, true);
  inst = progress.toggleStep(inst, 1, true);
  inst = progress.toggleStep(inst, 2, true);
  const out = instanceService.completeInstance(inst, now);
  return out;
}

function assertIllegalTransition(fn, from, to) {
  assert.throws(
    fn,
    (err) => {
      assert.ok(err instanceof Error, '非法状态迁移必须抛出 Error');
      assert.strictEqual(err.message, `非法状态迁移: ${from} -> ${to}`);
      return true;
    },
    `期望抛出「非法状态迁移: ${from} -> ${to}」`
  );
}

test('instanceService: 导出契约完整（§6）', () => {
  const fns = [
    'createInstance', 'pauseInstance', 'resumeInstance', 'completeInstance',
    'abandonInstance', 'updateInstance', 'isActive', 'sortInstances'
  ];
  for (const fn of fns) {
    assert.strictEqual(typeof instanceService[fn], 'function', `instanceService.${fn} 必须是函数`);
  }
});

test('§12-6 createInstance: 快照字段正确（status/runningSince/templateVersion/elapsedMs）', () => {
  const tpl = makeTemplate();
  const vars = { 服务器地址: '10.0.0.1' };
  const inst = instanceService.createInstance(tpl, vars, T0);

  assert.strictEqual(typeof inst.id, 'string');
  assert.ok(inst.id.startsWith('i_'), 'instance.id 必须形如 i_xxx');
  assert.strictEqual(inst.templateId, 't_lit');
  assert.strictEqual(inst.templateVersion, 3, 'templateVersion = 快照时的模板 version');
  assert.strictEqual(inst.templateName, '文献精读');
  assert.deepStrictEqual(inst.variables, { 服务器地址: '10.0.0.1' });
  assert.notStrictEqual(inst.variables, vars, 'variables 必须深拷贝');
  assert.strictEqual(inst.status, 'running');
  assert.strictEqual(inst.startedAt, T0);
  assert.strictEqual(inst.updatedAt, T0);
  assert.strictEqual(inst.completedAt, null);
  assert.strictEqual(inst.elapsedMs, 0);
  assert.strictEqual(inst.runningSince, T0, '进入 running 时 runningSince = now（§3.4）');
  assert.strictEqual(inst.executionNotes, '');
});

test('§12-6 createInstance: 变量在标题/备注/子步骤中已替换（§2.4）', () => {
  const inst = instanceService.createInstance(makeTemplate(), { 服务器地址: '10.0.0.1' }, T0);
  assert.strictEqual(inst.steps[0].title, '连接 10.0.0.1');
  assert.strictEqual(inst.steps[0].note, '确认 10.0.0.1 可达');
  assert.strictEqual(inst.steps[1].subSteps[0].title, 'ping 10.0.0.1');
});

test('§12-6 IRON RULE 快照不变量: 启动实例后修改模板对象，实例内容不变', () => {
  const tpl = makeTemplate();
  const inst = instanceService.createInstance(tpl, { 服务器地址: '10.0.0.1' }, T0);

  // 1) 深拷贝：实例内部对象与模板不共享引用
  assert.notStrictEqual(inst.steps, tpl.steps, 'instance.steps 必须是深拷贝');
  assert.notStrictEqual(inst.steps[0], tpl.steps[0]);
  assert.notStrictEqual(inst.steps[0].subSteps, tpl.steps[0].subSteps);
  assert.notStrictEqual(inst.steps[1].subSteps, tpl.steps[1].subSteps);
  assert.notStrictEqual(inst.steps[1].subSteps[0], tpl.steps[1].subSteps[0]);

  // 2) 快照内容已冻结为替换后的文本
  const snapshot = JSON.stringify(inst.steps);
  const tplBefore = JSON.stringify(tpl.steps);

  // 3) 原地篡改模板（模拟用户在模板编辑页保存后继续编辑）
  tpl.name = '被改名的模板';
  tpl.version = 99;
  tpl.steps[0].title = '被篡改的标题';
  tpl.steps[0].note = '被篡改的备注';
  tpl.steps[0].subSteps.push({ id: 'ss_new', title: '新增子步骤', done: false });
  tpl.steps[1].subSteps[0].title = '被篡改的子步骤';
  tpl.steps[2].subSteps[1].done = true;
  tpl.steps.push({ id: 's_new', title: '新增步骤', note: '', done: false, subSteps: [] });

  // 4) 实例必须完全不变
  assert.strictEqual(inst.templateName, '文献精读', '实例 templateName 不得随模板改名');
  assert.strictEqual(inst.templateVersion, 3, '实例 templateVersion 不得随模板 version 变化');
  assert.strictEqual(inst.steps.length, 3, '模板新增步骤不得影响实例');
  assert.strictEqual(inst.steps[0].title, '连接 10.0.0.1');
  assert.strictEqual(inst.steps[0].note, '确认 10.0.0.1 可达');
  assert.strictEqual(inst.steps[0].subSteps.length, 0);
  assert.strictEqual(inst.steps[1].subSteps[0].title, 'ping 10.0.0.1');
  assert.strictEqual(inst.steps[2].subSteps[1].done, false);
  assert.strictEqual(JSON.stringify(inst.steps), snapshot, '实例 steps 序列化结果必须逐字不变');

  // 5) 反向：改实例不影响模板
  inst.steps[0].title = '改实例';
  inst.steps[1].subSteps[0].title = '改实例子步骤';
  assert.strictEqual(tpl.steps[0].title, '被篡改的标题');
  assert.strictEqual(tpl.steps[1].subSteps[0].title, '被篡改的子步骤');

  assert.notStrictEqual(JSON.stringify(tpl.steps), tplBefore, '（前置条件）模板确实已被篡改');
});

test('§12-7 pauseInstance: running -> paused，结算 elapsedMs，runningSince 置 null', () => {
  const inst = instanceService.createInstance(makeTemplate(), {}, T0);
  const paused = instanceService.pauseInstance(inst, T0 + 5000);

  assert.strictEqual(paused.status, 'paused');
  assert.strictEqual(paused.elapsedMs, 5000, '暂停时必须结算 running 期间的耗时');
  assert.strictEqual(paused.runningSince, null);
  assert.strictEqual(paused.updatedAt, T0 + 5000);
  assert.notStrictEqual(paused, inst);
  assert.strictEqual(inst.status, 'running', '原实例不得被修改');
  assert.strictEqual(inst.elapsedMs, 0);
});

test('§12-7 暂停 -> JSON 序列化 -> 反序列化 -> 继续：状态与 elapsedMs 正确', () => {
  const inst = instanceService.createInstance(makeTemplate(), {}, T0);

  // 运行 5 秒后暂停
  const paused = instanceService.pauseInstance(inst, T0 + 5000);
  assert.strictEqual(paused.status, 'paused');
  assert.strictEqual(paused.elapsedMs, 5000);
  assert.strictEqual(progress.getElapsedMs(paused, T0 + 999_999), 5000, '暂停期间不累计');

  // 模拟「重启应用」：JSON round-trip
  const reloaded = JSON.parse(JSON.stringify(paused));
  assert.strictEqual(reloaded.status, 'paused');
  assert.strictEqual(reloaded.elapsedMs, 5000);
  assert.strictEqual(reloaded.runningSince, null);
  assert.strictEqual(progress.getElapsedMs(reloaded, T0 + 60_000), 5000, '重启后暂停时间不计入');

  // 继续：runningSince = now
  const resumed = instanceService.resumeInstance(reloaded, T0 + 60_000);
  assert.strictEqual(resumed.status, 'running');
  assert.strictEqual(resumed.runningSince, T0 + 60_000, '继续时 runningSince = now');
  assert.strictEqual(resumed.elapsedMs, 5000, '继续时不清零已累计耗时');
  assert.strictEqual(resumed.id, reloaded.id);

  // 读取时累计：暂停 5s + 继续 3s
  assert.strictEqual(progress.getElapsedMs(resumed, T0 + 63_000), 8000);

  // 再次暂停结算
  const paused2 = instanceService.pauseInstance(resumed, T0 + 63_000);
  assert.strictEqual(paused2.elapsedMs, 8000);
  assert.strictEqual(paused2.status, 'paused');
  assert.strictEqual(paused2.runningSince, null);
});

test('§12-8 completeInstance: 全部完成 -> status/completedAt/elapsedMs/history 正确', () => {
  const inst0 = instanceService.createInstance(makeTemplate(), { 服务器地址: '10.0.0.1' }, T0);
  let inst = progress.toggleStep(inst0, 0, true);
  inst = progress.toggleStep(inst, 1, true);
  inst = progress.toggleStep(inst, 2, true);
  const p = progress.calculateProgress(inst);
  assert.strictEqual(p.percent, 100, '（前置条件）全部 checklist 项已完成');

  const now = T0 + 120_000;
  const out = instanceService.completeInstance(inst, now);

  assert.ok(out && typeof out === 'object');
  assert.strictEqual(out.instance.status, 'completed');
  assert.strictEqual(out.instance.completedAt, now);
  assert.strictEqual(out.instance.updatedAt, now);
  assert.strictEqual(out.instance.elapsedMs, 120_000, '完成时结算 running 期间耗时');
  assert.strictEqual(out.instance.runningSince, null);

  const h = out.history;
  assert.strictEqual(typeof h.id, 'string');
  assert.ok(h.id.startsWith('h_'), 'history.id 必须形如 h_xxx');
  assert.strictEqual(h.instanceId, inst.id);
  assert.strictEqual(h.templateId, 't_lit');
  assert.strictEqual(h.templateName, '文献精读');
  assert.strictEqual(h.status, 'completed');
  assert.strictEqual(h.startedAt, T0);
  assert.strictEqual(h.completedAt, now);
  assert.strictEqual(h.elapsedMs, 120_000, 'history.elapsedMs 必须等于结算后的 elapsedMs');
  assert.strictEqual(h.stepsTotal, 3);
  assert.strictEqual(h.stepsDone, 3);
  assert.strictEqual(h.completionRate, 100, 'completionRate = calculateProgress(instance).percent');
  assert.strictEqual(inst.status, 'running', '原实例不得被修改');
});

test('§12-8 completeInstance: 部分完成 -> completionRate 为实际百分比', () => {
  const inst0 = instanceService.createInstance(makeTemplate(), {}, T0);
  const inst = progress.toggleStep(inst0, 1, true); // 3/6 checklist 项
  const out = instanceService.completeInstance(inst, T0 + 10_000);
  assert.strictEqual(out.history.completionRate, 50);
  assert.strictEqual(out.history.stepsTotal, 3);
  assert.strictEqual(out.history.stepsDone, 1);
});

test('§12-8 completeInstance: 暂停后再完成，只累计 running 时间', () => {
  const inst0 = instanceService.createInstance(makeTemplate(), {}, T0);
  const paused = instanceService.pauseInstance(inst0, T0 + 10_000); // 结算 10s
  const resumed = instanceService.resumeInstance(paused, T0 + 40_000); // 暂停 30s 不计
  const out = instanceService.completeInstance(resumed, T0 + 45_000); // 再运行 5s
  assert.strictEqual(out.instance.elapsedMs, 15_000);
  assert.strictEqual(out.history.elapsedMs, 15_000);
});

test('§12-9 abandonInstance: status==="abandoned" 且历史可追溯', () => {
  const inst0 = instanceService.createInstance(makeTemplate(), {}, T0);
  const inst = progress.toggleStep(inst0, 0, true); // 1/6
  const now = T0 + 30_000;
  const out = instanceService.abandonInstance(inst, now);

  assert.strictEqual(out.instance.status, 'abandoned');
  assert.strictEqual(out.instance.completedAt, now);
  assert.strictEqual(out.instance.elapsedMs, 30_000);
  assert.strictEqual(out.instance.runningSince, null);

  const h = out.history;
  assert.strictEqual(h.status, 'abandoned');
  assert.strictEqual(h.instanceId, inst.id);
  assert.strictEqual(h.templateId, 't_lit');
  assert.strictEqual(h.templateName, '文献精读');
  assert.strictEqual(h.startedAt, T0);
  assert.strictEqual(h.completedAt, now);
  assert.strictEqual(h.elapsedMs, 30_000);
  assert.strictEqual(h.stepsTotal, 3);
  assert.strictEqual(h.stepsDone, 1);
  assert.strictEqual(h.completionRate, 17, '1/6 checklist 项 = 16.67 -> 17');
  assert.strictEqual(typeof h.id, 'string');
  assert.ok(h.id.startsWith('h_'));
  assert.strictEqual(inst.status, 'running', '原实例不得被修改');
});

test('§12-9 abandonInstance: 未开始任何步骤也可追溯（completionRate 0）', () => {
  const inst = instanceService.createInstance(makeTemplate(), {}, T0);
  const out = instanceService.abandonInstance(inst, T0 + 1000);
  assert.strictEqual(out.instance.status, 'abandoned');
  assert.strictEqual(out.history.completionRate, 0);
  assert.strictEqual(out.history.stepsDone, 0);
  assert.strictEqual(out.history.stepsTotal, 3);
});

test('§12-12 非法状态迁移: 对 completed 实例调 pauseInstance 抛错', () => {
  const { instance } = completedFixture(T0 + 1000);
  assert.strictEqual(instance.status, 'completed');
  assertIllegalTransition(() => instanceService.pauseInstance(instance, T0 + 2000), 'completed', 'paused');
});

test('§12-12 非法状态迁移: 对 completed 实例调 resumeInstance / abandonInstance 抛错', () => {
  const { instance } = completedFixture(T0 + 1000);
  assertIllegalTransition(() => instanceService.resumeInstance(instance, T0 + 2000), 'completed', 'running');
  assertIllegalTransition(() => instanceService.abandonInstance(instance, T0 + 2000), 'completed', 'abandoned');
});

test('§12-12 非法状态迁移: 对 running 实例调 resumeInstance 抛错', () => {
  const inst = instanceService.createInstance(makeTemplate(), {}, T0);
  assert.strictEqual(inst.status, 'running');
  assertIllegalTransition(() => instanceService.resumeInstance(inst, T0 + 1000), 'running', 'running');
});

test('§12-12 非法状态迁移: 对 abandoned 实例调 pause/resume/complete 抛错', () => {
  const inst = instanceService.createInstance(makeTemplate(), {}, T0);
  const { instance } = instanceService.abandonInstance(inst, T0 + 1000);
  assert.strictEqual(instance.status, 'abandoned');
  assertIllegalTransition(() => instanceService.pauseInstance(instance, T0 + 2000), 'abandoned', 'paused');
  assertIllegalTransition(() => instanceService.resumeInstance(instance, T0 + 2000), 'abandoned', 'running');
  assertIllegalTransition(() => instanceService.completeInstance(instance, T0 + 2000), 'abandoned', 'completed');
});

test('§12-12 非法状态迁移: 对 paused 实例调 completeInstance 不抛错（允许）', () => {
  const inst = instanceService.createInstance(makeTemplate(), {}, T0);
  const paused = instanceService.pauseInstance(inst, T0 + 5000);
  const out = instanceService.completeInstance(paused, T0 + 6000);
  assert.strictEqual(out.instance.status, 'completed');
  assert.strictEqual(out.instance.elapsedMs, 5000, '暂停期间不累计');
});

test('instanceService.updateInstance: 通用不可变更新，updatedAt 自动刷新', () => {
  const inst = instanceService.createInstance(makeTemplate(), {}, T0);
  const before = Date.now();
  const next = instanceService.updateInstance(inst, { executionNotes: '备注内容', elapsedMs: 42 });
  assert.notStrictEqual(next, inst);
  assert.strictEqual(next.executionNotes, '备注内容');
  assert.strictEqual(next.elapsedMs, 42);
  assert.strictEqual(next.id, inst.id);
  assert.strictEqual(next.startedAt, inst.startedAt);
  assert.ok(next.updatedAt >= before, 'updatedAt 必须自动刷新');
  assert.strictEqual(inst.executionNotes, '', '原实例不得被修改');
  assert.strictEqual(inst.elapsedMs, 0);
});

test('instanceService.isActive: running/paused 为 true，completed/abandoned 为 false', () => {
  assert.strictEqual(instanceService.isActive({ status: 'running' }), true);
  assert.strictEqual(instanceService.isActive({ status: 'paused' }), true);
  assert.strictEqual(instanceService.isActive({ status: 'completed' }), false);
  assert.strictEqual(instanceService.isActive({ status: 'abandoned' }), false);
});

test('instanceService.sortInstances: 按 updatedAt 降序，不改入参', () => {
  const list = [
    makeInstance('running', { id: 'i_a', updatedAt: 100 }),
    makeInstance('paused', { id: 'i_b', updatedAt: 300 }),
    makeInstance('completed', { id: 'i_c', updatedAt: 200 })
  ];
  const snapshot = JSON.stringify(list);
  const sorted = instanceService.sortInstances(list);
  assert.deepStrictEqual(sorted.map((i) => i.id), ['i_b', 'i_c', 'i_a']);
  assert.strictEqual(JSON.stringify(list), snapshot, 'sortInstances 不得原地修改入参');
});
