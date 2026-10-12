// core/instance-service.js — 实例服务（契约 §6）
// 纯函数 + 不可变风格；IRON RULE：createInstance 必须深拷贝模板步骤（§2.4 快照不变量）
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

  const utils = dep('utils').utils;
  const progress = dep('progress').progress;
  const templateService = dep('template-service').templateService;

  const STATUS = {
    RUNNING: 'running',
    PAUSED: 'paused',
    COMPLETED: 'completed',
    ABANDONED: 'abandoned',
  };

  function nowOr(now) {
    return Number.isFinite(Number(now)) ? Number(now) : Date.now();
  }

  function str(v) {
    return v === null || v === undefined ? '' : String(v);
  }

  function shallowCopy(obj) {
    const out = {};
    const src = obj && typeof obj === 'object' ? obj : {};
    const keys = Object.keys(src);
    for (let i = 0; i < keys.length; i += 1) out[keys[i]] = src[keys[i]];
    return out;
  }

  /** 非法状态迁移抛错（契约 §6），格式固定 */
  function invalidTransition(from, to) {
    throw new Error('非法状态迁移: ' + str(from) + ' -> ' + str(to));
  }

  function isActiveStatus(status) {
    return status === STATUS.RUNNING || status === STATUS.PAUSED;
  }

  /**
   * 结算 running 期间耗时（契约 §3.4）：
   * elapsedMs += now - runningSince; runningSince = null
   */
  function settleElapsed(instance, now) {
    const ts = nowOr(now);
    const since = instance.runningSince;
    // 只有真正处于计时中（runningSince 为有效正数时间戳）才结算
    if (!since || !Number.isFinite(Number(since))) {
      instance.runningSince = null;
      return instance;
    }
    const delta = ts - Number(since);
    instance.elapsedMs = (Number.isFinite(Number(instance.elapsedMs)) ? Number(instance.elapsedMs) : 0) +
      (delta > 0 ? delta : 0);
    instance.runningSince = null;
    return instance;
  }

  /** 生成 HistoryRecord（契约 §2.5） */
  function buildHistory(instance, status, now) {
    const p = progress.calculateProgress(instance);
    return {
      id: utils.genId('h'),
      instanceId: str(instance.id),
      templateId: str(instance.templateId),
      templateName: str(instance.templateName),
      status: status,
      startedAt: Number.isFinite(Number(instance.startedAt)) ? Number(instance.startedAt) : 0,
      completedAt: nowOr(now),
      elapsedMs: progress.getElapsedMs(instance, now),
      stepsTotal: p.stepsTotal,
      stepsDone: p.stepsDone,
      completionRate: p.percent,
    };
  }

  /**
   * createInstance(template, variables, now) -> Instance（契约 §6 / §2.4）
   * 深拷贝快照（IRON RULE）；所有 {{变量}} 在创建时替换；status='running'。
   */
  function createInstance(template, variables, now) {
    const t = template && typeof template === 'object' ? template : {};
    const vars = variables && typeof variables === 'object' ? utils.deepClone(variables) : {};
    const ts = nowOr(now);

    return {
      id: utils.genId('i'),
      templateId: str(t.id),
      templateVersion: Number.isFinite(Number(t.version)) ? Number(t.version) : 1,
      templateName: str(t.name),
      variables: vars,
      steps: templateService.buildSnapshotSteps(t, vars),
      status: STATUS.RUNNING,
      startedAt: ts,
      updatedAt: ts,
      completedAt: null,
      elapsedMs: 0,
      executionNotes: '',
      runningSince: ts,
    };
  }

  /** pauseInstance(instance, now) -> Instance  running -> paused，结算 elapsedMs */
  function pauseInstance(instance, now) {
    const from = instance ? instance.status : undefined;
    if (from !== STATUS.RUNNING) invalidTransition(from, STATUS.PAUSED);
    const ts = nowOr(now);
    const next = shallowCopy(instance);
    settleElapsed(next, ts);
    next.status = STATUS.PAUSED;
    next.updatedAt = ts;
    return next;
  }

  /** resumeInstance(instance, now) -> Instance  paused -> running，runningSince=now */
  function resumeInstance(instance, now) {
    const from = instance ? instance.status : undefined;
    if (from !== STATUS.PAUSED) invalidTransition(from, STATUS.RUNNING);
    const ts = nowOr(now);
    const next = shallowCopy(instance);
    next.status = STATUS.RUNNING;
    next.runningSince = ts;
    next.updatedAt = ts;
    return next;
  }

  /** completeInstance(instance, now) -> { instance, history } */
  function completeInstance(instance, now) {
    const from = instance ? instance.status : undefined;
    if (!isActiveStatus(from)) invalidTransition(from, STATUS.COMPLETED);
    const ts = nowOr(now);
    const next = shallowCopy(instance);
    settleElapsed(next, ts);
    next.status = STATUS.COMPLETED;
    next.completedAt = ts;
    next.updatedAt = ts;
    return { instance: next, history: buildHistory(next, STATUS.COMPLETED, ts) };
  }

  /** abandonInstance(instance, now) -> { instance, history } */
  function abandonInstance(instance, now) {
    const from = instance ? instance.status : undefined;
    if (!isActiveStatus(from)) invalidTransition(from, STATUS.ABANDONED);
    const ts = nowOr(now);
    const next = shallowCopy(instance);
    settleElapsed(next, ts);
    next.status = STATUS.ABANDONED;
    next.completedAt = ts;
    next.updatedAt = ts;
    return { instance: next, history: buildHistory(next, STATUS.ABANDONED, ts) };
  }

  /** updateInstance(instance, patch, now?) -> Instance  通用不可变更新，updatedAt 自动更新 */
  function updateInstance(instance, patch, now) {
    const p = patch && typeof patch === 'object' ? patch : {};
    const next = shallowCopy(instance);
    const keys = Object.keys(p);
    for (let i = 0; i < keys.length; i += 1) next[keys[i]] = p[keys[i]];
    if (!Object.prototype.hasOwnProperty.call(p, 'updatedAt')) next.updatedAt = nowOr(now);
    return next;
  }

  /** isActive(instance) -> boolean  running || paused */
  function isActive(instance) {
    return !!instance && isActiveStatus(instance.status);
  }

  /** sortInstances(instances) -> Instance[]  updatedAt 降序（新数组） */
  function sortInstances(instances) {
    const list = Array.isArray(instances) ? instances.slice() : [];
    list.sort(function (a, b) {
      const av = a && Number.isFinite(Number(a.updatedAt)) ? Number(a.updatedAt) : 0;
      const bv = b && Number.isFinite(Number(b.updatedAt)) ? Number(b.updatedAt) : 0;
      return bv - av;
    });
    return list;
  }

  return {
    instanceService: {
      createInstance: createInstance,
      pauseInstance: pauseInstance,
      resumeInstance: resumeInstance,
      completeInstance: completeInstance,
      abandonInstance: abandonInstance,
      updateInstance: updateInstance,
      isActive: isActive,
      sortInstances: sortInstances,
      STATUS: STATUS,
    },
  };
});
