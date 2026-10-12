// core/progress.js — 进度与清单纯函数（契约 §3）
// 双环境 UMD 包装（契约 §1.1）
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  } else {
    root.SOPCore = root.SOPCore || {};
    Object.assign(root.SOPCore, mod);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 跨模块依赖：Node 用 require，浏览器用全局命名空间。
  // 两种环境都返回 { <camelName>: API } 命名空间，保证调用点 dep('x').x 一致。
  function dep(name) {
    if (typeof module === 'object' && module.exports) return require('./' + name + '.js');
    const core = globalThis.SOPCore || {};
    const key = name.replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); });
    const ns = {};
    ns[key] = core[key];
    return ns;
  }

  function toArray(v) {
    return Array.isArray(v) ? v : [];
  }

  function getSteps(instance) {
    if (!instance || typeof instance !== 'object') return [];
    return toArray(instance.steps);
  }

  function nowOr(now) {
    return Number.isFinite(Number(now)) ? Number(now) : Date.now();
  }

  /**
   * isStepComplete(step) -> boolean  （契约 §3.2）
   * 有子步骤：全部子步骤 done；无子步骤：step.done === true。
   */
  function isStepComplete(step) {
    if (!step || typeof step !== 'object') return false;
    const subs = toArray(step.subSteps);
    if (subs.length > 0) {
      for (let i = 0; i < subs.length; i += 1) {
        if (!subs[i] || subs[i].done !== true) return false;
      }
      return true;
    }
    return step.done === true;
  }

  /**
   * getAllChecklistItems(instance) -> CheckItem[]  （契约 §3.1，计数规则唯一权威）
   * 顶层步骤有 subSteps.length > 0 → 每个子步骤算一个任务项；
   * 顶层步骤没有子步骤 → 该顶层步骤本身算一个任务项。
   */
  function getAllChecklistItems(instance) {
    const steps = getSteps(instance);
    const items = [];
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i] || {};
      const subs = toArray(step.subSteps);
      if (subs.length > 0) {
        for (let j = 0; j < subs.length; j += 1) {
          const sub = subs[j] || {};
          items.push({
            kind: 'sub',
            stepIndex: i,
            subIndex: j,
            id: sub.id !== undefined && sub.id !== null ? sub.id : '',
            title: sub.title !== undefined && sub.title !== null ? sub.title : '',
            done: sub.done === true,
          });
        }
      } else {
        items.push({
          kind: 'step',
          stepIndex: i,
          subIndex: null,
          id: step.id !== undefined && step.id !== null ? step.id : '',
          title: step.title !== undefined && step.title !== null ? step.title : '',
          done: isStepComplete(step),
        });
      }
    }
    return items;
  }

  /**
   * calculateProgress(instance) -> Progress  （契约 §3.3）
   */
  function calculateProgress(instance) {
    const steps = getSteps(instance);
    const items = getAllChecklistItems(instance);

    let done = 0;
    for (let i = 0; i < items.length; i += 1) {
      if (items[i].done) done += 1;
    }
    const total = items.length;

    let stepsDone = 0;
    let subStepsDone = 0;
    let subStepsTotal = 0;
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i] || {};
      if (isStepComplete(step)) stepsDone += 1;
      const subs = toArray(step.subSteps);
      subStepsTotal += subs.length;
      for (let j = 0; j < subs.length; j += 1) {
        if (subs[j] && subs[j].done === true) subStepsDone += 1;
      }
    }

    return {
      done: done,
      total: total,
      percent: total === 0 ? 0 : Math.round((done / total) * 100),
      stepsDone: stepsDone,
      stepsTotal: steps.length,
      subStepsDone: subStepsDone,
      subStepsTotal: subStepsTotal,
    };
  }

  /**
   * getElapsedMs(instance, now?) -> number  （契约 §3.4）
   * 只统计 running 时间：elapsedMs + (runningSince ? now - runningSince : 0)
   */
  function getElapsedMs(instance, now) {
    if (!instance || typeof instance !== 'object') return 0;
    const base = Number.isFinite(Number(instance.elapsedMs)) ? Number(instance.elapsedMs) : 0;
    const since = instance.runningSince;
    // runningSince 为 null/undefined/0/NaN 都视为「当前未在计时」（契约 §3.4：runningSince ? ... : 0）
    if (!since || !Number.isFinite(Number(since))) return Math.max(0, base);
    const delta = nowOr(now) - Number(since);
    return Math.max(0, base + Math.max(0, delta));
  }

  function cloneInstance(instance) {
    const src = instance && typeof instance === 'object' ? instance : {};
    const copy = {};
    const keys = Object.keys(src);
    for (let i = 0; i < keys.length; i += 1) copy[keys[i]] = src[keys[i]];
    copy.steps = getSteps(src).map(function (step) {
      const s = step && typeof step === 'object' ? step : {};
      const stepCopy = {};
      const sKeys = Object.keys(s);
      for (let k = 0; k < sKeys.length; k += 1) stepCopy[sKeys[k]] = s[sKeys[k]];
      stepCopy.subSteps = toArray(s.subSteps).map(function (sub) {
        const ss = sub && typeof sub === 'object' ? sub : {};
        const subCopy = {};
        const ssKeys = Object.keys(ss);
        for (let m = 0; m < ssKeys.length; m += 1) subCopy[ssKeys[m]] = ss[ssKeys[m]];
        return subCopy;
      });
      return stepCopy;
    });
    return copy;
  }

  /**
   * toggleStep(instance, stepIndex, done) -> instance（新对象，契约 §3.5）
   * 勾选/取消有子步骤的顶层步骤 → 其所有子步骤同步为 done；
   * 之后统一用 isStepComplete 重算 step.done，避免漂移。
   */
  function toggleStep(instance, stepIndex, done) {
    const next = cloneInstance(instance);
    const idx = Number(stepIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= next.steps.length) return next;

    const step = next.steps[idx];
    const target = done === true;
    const subs = toArray(step.subSteps);

    if (subs.length > 0) {
      for (let i = 0; i < subs.length; i += 1) subs[i].done = target;
      step.done = isStepComplete(step);
    } else {
      step.done = target;
      step.done = isStepComplete(step);
    }
    return next;
  }

  /**
   * toggleSubStep(instance, stepIndex, subIndex, done) -> instance（新对象，契约 §3.5）
   * 子步骤全部 done 时顶层步骤自动完成（用 isStepComplete 派生）。
   */
  function toggleSubStep(instance, stepIndex, subIndex, done) {
    const next = cloneInstance(instance);
    const sIdx = Number(stepIndex);
    const ssIdx = Number(subIndex);
    if (!Number.isInteger(sIdx) || sIdx < 0 || sIdx >= next.steps.length) return next;

    const step = next.steps[sIdx];
    const subs = toArray(step.subSteps);
    if (!Number.isInteger(ssIdx) || ssIdx < 0 || ssIdx >= subs.length) return next;

    subs[ssIdx].done = done === true;
    step.done = isStepComplete(step);
    return next;
  }

  return {
    progress: {
      getAllChecklistItems: getAllChecklistItems,
      isStepComplete: isStepComplete,
      calculateProgress: calculateProgress,
      getElapsedMs: getElapsedMs,
      toggleStep: toggleStep,
      toggleSubStep: toggleSubStep,
    },
  };
});
