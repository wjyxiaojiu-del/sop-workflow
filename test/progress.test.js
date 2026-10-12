'use strict';

/**
 * §3 core/progress.js 契约测试（纯函数）
 * 覆盖 §12 验收矩阵 #1 #2 #3 #4
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const mod = require('../core/progress.js');

assert.ok(mod && typeof mod === 'object', 'core/progress.js 必须导出对象（契约 §1.2）');
assert.ok(mod.progress && typeof mod.progress === 'object', 'core/progress.js 必须导出 { progress }（契约 §1.2）');
const progress = mod.progress;

/** 构造一个顶层步骤（可带子步骤标题） */
function mkStep(id, title, subTitles) {
  return {
    id,
    title,
    note: '',
    done: false,
    subSteps: (subTitles || []).map((t, i) => ({ id: `${id}_ss${i + 1}`, title: t, done: false }))
  };
}

/** 标准夹具：1 个无子步骤 + 3 子步骤 + 2 子步骤 => checklist 共 6 项，顶层 3 步 */
function makeInstance(steps) {
  return {
    id: 'i_fixture',
    templateId: 't_fixture',
    templateVersion: 1,
    templateName: '测试模板',
    variables: {},
    steps,
    status: 'running',
    startedAt: 0,
    updatedAt: 0,
    completedAt: null,
    elapsedMs: 0,
    runningSince: 0,
    executionNotes: ''
  };
}

function fixture() {
  return makeInstance([
    mkStep('s_1', '无子步骤步骤'),
    mkStep('s_2', '三子步骤步骤', ['a', 'b', 'c']),
    mkStep('s_3', '两子步骤步骤', ['x', 'y'])
  ]);
}

test('progress: 导出契约完整（§3）', () => {
  for (const fn of ['getAllChecklistItems', 'isStepComplete', 'calculateProgress', 'getElapsedMs', 'toggleStep', 'toggleSubStep']) {
    assert.strictEqual(typeof progress[fn], 'function', `progress.${fn} 必须是函数`);
  }
});

test('§12-2 getAllChecklistItems: 无子步骤计 1 项，有子步骤按子步骤计', () => {
  const items = progress.getAllChecklistItems(fixture());
  assert.strictEqual(items.length, 6);
  assert.deepStrictEqual(items.map((i) => i.kind), ['step', 'sub', 'sub', 'sub', 'sub', 'sub']);
  assert.deepStrictEqual(items.map((i) => i.stepIndex), [0, 1, 1, 1, 2, 2]);
  assert.deepStrictEqual(items.map((i) => i.subIndex), [null, 0, 1, 2, 0, 1]);
  assert.strictEqual(items[0].id, 's_1');
  assert.strictEqual(items[0].title, '无子步骤步骤');
  assert.strictEqual(items[0].done, false);
  assert.strictEqual(items[1].id, 's_2_ss1');
  assert.strictEqual(items[1].title, 'a');
  assert.strictEqual(items[5].id, 's_3_ss2');
  assert.strictEqual(items[5].title, 'y');
});

test('§12-1 calculateProgress: 子步骤逐个完成后进度正确', () => {
  let inst = fixture();

  let p = progress.calculateProgress(inst);
  assert.strictEqual(p.total, 6);
  assert.strictEqual(p.done, 0);
  assert.strictEqual(p.percent, 0);
  assert.strictEqual(p.stepsTotal, 3);
  assert.strictEqual(p.stepsDone, 0);
  assert.strictEqual(p.subStepsTotal, 5);
  assert.strictEqual(p.subStepsDone, 0);

  inst = progress.toggleSubStep(inst, 1, 0, true);
  p = progress.calculateProgress(inst);
  assert.strictEqual(p.done, 1);
  assert.strictEqual(p.percent, 17, '1/6 = 16.67 -> 四舍五入 17');
  assert.strictEqual(p.stepsDone, 0, '子步骤未全部完成时顶层步骤不算完成');
  assert.strictEqual(p.subStepsDone, 1);

  inst = progress.toggleSubStep(inst, 1, 1, true);
  p = progress.calculateProgress(inst);
  assert.strictEqual(p.done, 2);
  assert.strictEqual(p.percent, 33);

  inst = progress.toggleSubStep(inst, 1, 2, true);
  p = progress.calculateProgress(inst);
  assert.strictEqual(p.done, 3);
  assert.strictEqual(p.percent, 50);
  assert.strictEqual(p.stepsDone, 1, '三个子步骤全完成 -> 顶层 1 步完成');
  assert.strictEqual(p.subStepsDone, 3);

  inst = progress.toggleStep(inst, 0, true);
  inst = progress.toggleStep(inst, 2, true);
  p = progress.calculateProgress(inst);
  assert.strictEqual(p.done, 6);
  assert.strictEqual(p.percent, 100);
  assert.strictEqual(p.stepsDone, 3);
  assert.strictEqual(p.subStepsDone, 5);
});

test('§12-3 全部子步骤完成 -> 顶层步骤自动完成（isStepComplete + done 派生字段）', () => {
  let inst = fixture();
  inst = progress.toggleSubStep(inst, 1, 0, true);
  assert.strictEqual(progress.isStepComplete(inst.steps[1]), false);
  inst = progress.toggleSubStep(inst, 1, 1, true);
  assert.strictEqual(progress.isStepComplete(inst.steps[1]), false);
  inst = progress.toggleSubStep(inst, 1, 2, true);
  assert.strictEqual(progress.isStepComplete(inst.steps[1]), true);
  assert.strictEqual(inst.steps[1].done, true, 'step.done 必须按 isStepComplete 重算');
  assert.strictEqual(progress.calculateProgress(inst).stepsDone, 1);
});

test('§12-4 取消顶层步骤 -> 其子步骤全部取消', () => {
  let inst = fixture();
  inst = progress.toggleStep(inst, 1, true);
  assert.deepStrictEqual(inst.steps[1].subSteps.map((s) => s.done), [true, true, true]);
  assert.strictEqual(inst.steps[1].done, true);
  assert.strictEqual(progress.calculateProgress(inst).done, 3);

  inst = progress.toggleStep(inst, 1, false);
  assert.deepStrictEqual(inst.steps[1].subSteps.map((s) => s.done), [false, false, false]);
  assert.strictEqual(inst.steps[1].done, false);
  assert.strictEqual(progress.isStepComplete(inst.steps[1]), false);
  assert.strictEqual(progress.calculateProgress(inst).done, 0);
});

test('toggleStep: 勾选有子步骤的顶层步骤 -> 全部子步骤 done=true', () => {
  const inst = progress.toggleStep(fixture(), 2, true);
  assert.deepStrictEqual(inst.steps[2].subSteps.map((s) => s.done), [true, true]);
  assert.strictEqual(progress.calculateProgress(inst).done, 2);
  assert.strictEqual(progress.calculateProgress(inst).percent, 33);
});

test('toggleStep/toggleSubStep: 纯函数，返回新对象且不修改原实例（§3.5）', () => {
  const inst = fixture();
  const before = JSON.parse(JSON.stringify(inst));

  const nextStep = progress.toggleStep(inst, 0, true);
  assert.notStrictEqual(nextStep, inst);
  assert.notStrictEqual(nextStep.steps, inst.steps);
  assert.strictEqual(nextStep.steps[0].done, true);
  assert.strictEqual(inst.steps[0].done, false);

  const nextSub = progress.toggleSubStep(inst, 1, 0, true);
  assert.notStrictEqual(nextSub, inst);
  assert.strictEqual(nextSub.steps[1].subSteps[0].done, true);
  assert.strictEqual(inst.steps[1].subSteps[0].done, false);
  assert.notStrictEqual(nextSub.steps[1].subSteps, inst.steps[1].subSteps);

  assert.deepStrictEqual(inst, before, '原实例必须保持不变');
});

test('§3.2 isStepComplete: 有子步骤看全部子步骤，无子步骤看 step.done', () => {
  assert.strictEqual(progress.isStepComplete({ done: true, subSteps: [] }), true);
  assert.strictEqual(progress.isStepComplete({ done: false, subSteps: [] }), false);
  assert.strictEqual(progress.isStepComplete({ done: false, subSteps: [{ done: true }, { done: true }] }), true);
  assert.strictEqual(progress.isStepComplete({ done: true, subSteps: [{ done: true }, { done: false }] }), false);
});

test('§3.3 calculateProgress: total===0 时 percent 为 0', () => {
  const p = progress.calculateProgress(makeInstance([]));
  assert.strictEqual(p.total, 0);
  assert.strictEqual(p.done, 0);
  assert.strictEqual(p.percent, 0);
  assert.strictEqual(p.stepsTotal, 0);
  assert.strictEqual(p.stepsDone, 0);
  assert.strictEqual(p.subStepsTotal, 0);
});

test('§3.4 getElapsedMs: 只累计 running 时间，now 可注入', () => {
  assert.strictEqual(progress.getElapsedMs({ elapsedMs: 1000, runningSince: 5000 }, 8000), 4000);
  assert.strictEqual(progress.getElapsedMs({ elapsedMs: 1000, runningSince: null }, 8000), 1000);
  assert.strictEqual(progress.getElapsedMs({ elapsedMs: 250, runningSince: 9000 }, 9000), 250);
  assert.strictEqual(progress.getElapsedMs({ elapsedMs: 0, runningSince: 1000 }, 3500), 2500);
  assert.strictEqual(progress.getElapsedMs({ elapsedMs: 1000 }, 8000), 1000, 'runningSince 缺失时按暂停处理');
  assert.strictEqual(progress.getElapsedMs({ elapsedMs: 1000, runningSince: null }), 1000);
});
