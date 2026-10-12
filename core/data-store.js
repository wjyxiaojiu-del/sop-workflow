// core/data-store.js — 数据存储（契约 §7）
// 纯函数：normalizeData / validateImport / mergeData / exportPayload
// IO 函数：load / save / exportToFile / importFromFile / getFileInfo（依赖 window.api）
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
  const templateService = dep('template-service').templateService;

  const SCHEMA_VERSION = 2;
  const CATEGORIES = templateService.CATEGORIES || ['科研', '学习', '开发', '生活', '其他'];
  const STATUS = {
    RUNNING: 'running',
    PAUSED: 'paused',
    COMPLETED: 'completed',
    ABANDONED: 'abandoned',
  };
  const VALID_STATUS = [STATUS.RUNNING, STATUS.PAUSED, STATUS.COMPLETED, STATUS.ABANDONED];
  const MAX_TAGS = 20;

  function toArray(v) {
    return Array.isArray(v) ? v : [];
  }

  function str(v) {
    return v === null || v === undefined ? '' : String(v);
  }

  function num(v, fallback) {
    return Number.isFinite(Number(v)) ? Number(v) : fallback;
  }

  function nowOr(now) {
    return Number.isFinite(Number(now)) ? Number(now) : Date.now();
  }

  function normalizeCategory(category) {
    return CATEGORIES.indexOf(category) === -1 ? '其他' : category;
  }

  function normalizeTags(input) {
    let parts;
    if (Array.isArray(input)) parts = input;
    else if (typeof input === 'string') parts = input.split(/[,，]/);
    else return [];
    const seen = new Set();
    const out = [];
    for (let i = 0; i < parts.length; i += 1) {
      const tag = str(parts[i]).trim();
      if (!tag || seen.has(tag)) continue;
      seen.add(tag);
      out.push(tag);
      if (out.length >= MAX_TAGS) break;
    }
    return out;
  }

  /** 规整 Step：迁移旧格式 subSteps 字符串数组 → [{id,title,done}]（契约 §2.3） */
  function normalizeStep(step) {
    const s = step && typeof step === 'object' ? step : {};
    const subs = toArray(s.subSteps).map(function (sub) {
      if (sub && typeof sub === 'object') {
        return {
          id: sub.id ? str(sub.id) : utils.genId('ss'),
          title: str(sub.title),
          done: sub.done === true,
        };
      }
      // v1 只能勾选父步骤：已完成父步骤的字符串子项也必须完成，不能迁移后倒退进度。
      return { id: utils.genId('ss'), title: str(sub), done: s.done === true };
    });
    return {
      id: s.id ? str(s.id) : utils.genId('s'),
      title: str(s.title),
      note: str(s.note),
      done: subs.length > 0 ? subs.every(function (sub) { return sub.done; }) : s.done === true,
      subSteps: subs,
    };
  }

  function normalizeSteps(steps) {
    return toArray(steps).map(normalizeStep);
  }

  /** 规整 Template（契约 §2.2） */
  function normalizeTemplate(t) {
    const src = t && typeof t === 'object' ? t : {};
    const createdAt = num(src.createdAt, 0);
    return {
      id: src.id ? str(src.id) : utils.genId('t'),
      name: str(src.name),
      desc: str(src.desc),
      category: normalizeCategory(src.category),
      tags: normalizeTags(src.tags),
      favorite: src.favorite === true,
      version: num(src.version, 1),
      steps: normalizeSteps(src.steps),
      createdAt: createdAt,
      updatedAt: num(src.updatedAt, createdAt),
      lastUsedAt: src.lastUsedAt === undefined || src.lastUsedAt === null ? null : num(src.lastUsedAt, null),
    };
  }

  /** 规整 Instance（契约 §2.4） */
  function normalizeInstance(inst) {
    const src = inst && typeof inst === 'object' ? inst : {};
    const startedAt = num(src.startedAt, 0);
    const updatedAt = num(src.updatedAt, startedAt);
    const status = VALID_STATUS.indexOf(src.status) === -1 ? STATUS.RUNNING : src.status;
    let runningSince = null;
    if (status === STATUS.RUNNING) {
      if (src.runningSince === undefined) {
        // v1 无暂停与累计字段，从 startedAt 连续计时；缺锚点的 v2 使用持久化更新时间，
        // 不在 normalize 时结算或使用 Date.now()，避免重复加载重置计时。
        runningSince = src.elapsedMs === undefined ? startedAt : updatedAt;
      } else if (src.runningSince !== null) {
        runningSince = num(src.runningSince, null);
      }
    }
    return {
      id: src.id ? str(src.id) : utils.genId('i'),
      templateId: str(src.templateId),
      templateVersion: num(src.templateVersion, 1),
      templateName: str(src.templateName),
      variables: src.variables && typeof src.variables === 'object' && !Array.isArray(src.variables)
        ? utils.deepClone(src.variables)
        : {},
      steps: normalizeSteps(src.steps),
      status: status,
      startedAt: startedAt,
      updatedAt: updatedAt,
      completedAt: src.completedAt === undefined || src.completedAt === null ? null : num(src.completedAt, null),
      elapsedMs: num(src.elapsedMs, 0),
      executionNotes: str(src.executionNotes),
      runningSince: runningSince,
    };
  }

  /** 规整 HistoryRecord（契约 §2.5） */
  function normalizeHistoryRecord(h) {
    const src = h && typeof h === 'object' ? h : {};
    const startedAt = num(src.startedAt, 0);
    const completedAt = num(src.completedAt, startedAt);
    const status = src.status === STATUS.ABANDONED ? STATUS.ABANDONED : STATUS.COMPLETED;
    const stepsTotal = num(src.stepsTotal, 0);
    const stepsDone = num(src.stepsDone, 0);
    let completionRate = num(src.completionRate, null);
    if (completionRate === null) {
      completionRate = stepsTotal > 0 ? Math.round((stepsDone / stepsTotal) * 100) : 0;
    }
    return {
      id: src.id ? str(src.id) : utils.genId('h'),
      // v1 完成时直接将 instance.id 用作 history.id，没有独立 instanceId 字段。
      instanceId: src.instanceId === undefined || src.instanceId === null ? str(src.id) : str(src.instanceId),
      templateId: str(src.templateId),
      templateName: str(src.templateName),
      status: status,
      startedAt: startedAt,
      completedAt: completedAt,
      elapsedMs: num(src.elapsedMs, Math.max(0, completedAt - startedAt)),
      stepsTotal: stepsTotal,
      stepsDone: stepsDone,
      completionRate: Math.max(0, Math.min(100, Math.round(completionRate))),
    };
  }

  /** 只修改已复制的记录：精确 instanceId 关联，不能由模板名称猜测或重建步骤快照。 */
  function reconcileHistory(instances, history) {
    const byId = new Map();
    instances.forEach(function (inst) { byId.set(inst.id, inst); });
    // history 已按 completedAt 降序；同一实例只采用最新终态。
    history.forEach(function (h) {
      const inst = h.instanceId ? byId.get(h.instanceId) : null;
      if (!inst) return;
      if (!h.templateId) h.templateId = inst.templateId;
      if ((inst.status === STATUS.RUNNING || inst.status === STATUS.PAUSED) && h.completedAt >= inst.startedAt) {
        // 合并旧活动备份时保留步骤/变量/备注，但不能复活已经完成或放弃的执行。
        inst.status = h.status;
        inst.completedAt = h.completedAt;
        inst.elapsedMs = h.elapsedMs;
        inst.runningSince = null;
        inst.updatedAt = Math.max(inst.updatedAt, h.completedAt);
      }
    });
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

  /**
   * normalizeData(raw) -> Data  （契约 §7.1）
   * 兼容旧版本缺失字段；非法输入回落空数据；**永不抛错**。
   */
  function normalizeData(raw) {
    try {
      let src = raw;
      if (typeof src === 'string') {
        try {
          src = JSON.parse(src);
        } catch (e) {
          return emptyData();
        }
      }
      if (!src || typeof src !== 'object' || Array.isArray(src)) return emptyData();

      const meta = src.meta && typeof src.meta === 'object' && !Array.isArray(src.meta) ? src.meta : {};
      const history = toArray(src.history).map(normalizeHistoryRecord);
      history.sort(function (a, b) { return b.completedAt - a.completedAt; });
      const instances = toArray(src.instances).map(normalizeInstance);
      reconcileHistory(instances, history);

      return {
        // 契约 §2.1：数据根 schemaVersion 恒为当前版本；normalizeData 负责把旧版本升级上来
        schemaVersion: SCHEMA_VERSION,
        templates: toArray(src.templates).map(normalizeTemplate),
        instances: instances,
        history: history,
        meta: {
          lastSavedAt: num(meta.lastSavedAt, 0),
          exportedAt: meta.exportedAt === undefined || meta.exportedAt === null ? null : num(meta.exportedAt, null),
        },
      };
    } catch (e) {
      return emptyData();
    }
  }

  /**
   * validateImport(raw) -> { valid, errors, data, summary }  （契约 §7.1）
   * 结构校验：必须是对象，且 templates/instances/history 至少有一个为数组。
   */
  function validateImport(raw) {
    const errors = [];

    let src = raw;
    if (typeof src === 'string') {
      try {
        src = JSON.parse(src);
      } catch (e) {
        return {
          valid: false,
          errors: ['不是合法的 JSON：' + str(e && e.message)],
          data: null,
          summary: null,
        };
      }
    }

    if (!src || typeof src !== 'object' || Array.isArray(src)) {
      return {
        valid: false,
        errors: ['导入数据必须是 JSON 对象'],
        data: null,
        summary: null,
      };
    }

    const keys = ['templates', 'instances', 'history'];
    const present = [];
    keys.forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(src, k)) {
        present.push(k);
        if (!Array.isArray(src[k])) errors.push(k + ' 必须是数组');
      }
    });

    if (present.length === 0) {
      return {
        valid: false,
        errors: ['缺少 templates / instances / history 数组'],
        data: null,
        summary: null,
      };
    }

    const hasTemplates = Array.isArray(src.templates);
    const hasInstances = Array.isArray(src.instances);
    const hasHistory = Array.isArray(src.history);

    if (hasTemplates) {
      src.templates.forEach(function (t, i) {
        if (!t || typeof t !== 'object' || Array.isArray(t)) {
          errors.push('templates[' + i + '] 不是对象');
        } else if (!Array.isArray(t.steps)) {
          errors.push('templates[' + i + '].steps 不是数组');
        }
      });
    }
    if (hasInstances) {
      src.instances.forEach(function (it, i) {
        if (!it || typeof it !== 'object' || Array.isArray(it)) {
          errors.push('instances[' + i + '] 不是对象');
        } else if (!Array.isArray(it.steps)) {
          errors.push('instances[' + i + '].steps 不是数组');
        }
      });
    }
    if (hasHistory) {
      src.history.forEach(function (h, i) {
        if (!h || typeof h !== 'object' || Array.isArray(h)) {
          errors.push('history[' + i + '] 不是对象');
        }
      });
    }

    if (errors.length > 0) {
      return { valid: false, errors: errors, data: null, summary: null };
    }

    const data = normalizeData(src);
    return {
      valid: true,
      errors: [],
      data: data,
      summary: {
        templates: data.templates.length,
        instances: data.instances.length,
        history: data.history.length,
        schemaVersion: data.schemaVersion,
        exportedAt: src.exportedAt === undefined || src.exportedAt === null ? null : src.exportedAt,
      },
    };
  }

  function mergeById(currentList, incomingList, timestampKey) {
    const map = new Map();
    const order = [];
    function put(item) {
      if (!item || typeof item !== 'object') return;
      const id = str(item.id);
      if (!id) {
        map.set(utils.genId('x'), item);
        return;
      }
      if (!map.has(id)) {
        map.set(id, item);
        order.push(id);
        return;
      }
      const prev = map.get(id);
      const prevTs = num(prev[timestampKey], 0);
      const nextTs = num(item[timestampKey], 0);
      // 时间相同无法证明导入数据更新；保留本地内容，尤其是没有 updatedAt 的 v1 实例。
      if (nextTs > prevTs) map.set(id, item);
    }
    toArray(currentList).forEach(put);
    toArray(incomingList).forEach(put);
    return order.map(function (id) { return map.get(id); });
  }

  /**
   * mergeData(current, incoming) -> Data  （契约 §7.1）
   * 按 id 合并：同 id 保留 updatedAt 较新者；history 去重后按 completedAt 降序。
   */
  function mergeData(current, incoming) {
    const a = normalizeData(current);
    const b = normalizeData(incoming);

    const templates = mergeById(a.templates, b.templates, 'updatedAt');
    const instances = mergeById(a.instances, b.instances, 'updatedAt');

    const seenEvents = new Set();
    const history = mergeById(a.history, b.history, 'completedAt').filter(function (h) {
      if (!h.instanceId) return true;
      // 缺失 history.id 的导入会生成新 ID；用确切执行、终态和时间去重，不能按模板名称去重。
      const key = JSON.stringify([h.instanceId, h.status, h.completedAt]);
      if (seenEvents.has(key)) return false;
      seenEvents.add(key);
      return true;
    }).sort(function (x, y) {
      return y.completedAt - x.completedAt;
    });
    reconcileHistory(instances, history);

    return {
      schemaVersion: Math.max(a.schemaVersion, b.schemaVersion, SCHEMA_VERSION),
      templates: templates,
      instances: instances,
      history: history,
      meta: {
        lastSavedAt: Math.max(a.meta.lastSavedAt, b.meta.lastSavedAt),
        exportedAt: a.meta.exportedAt !== null ? a.meta.exportedAt : b.meta.exportedAt,
      },
    };
  }

  /** exportPayload(data) -> object  （契约 §7.1） */
  function exportPayload(data, now) {
    const d = normalizeData(data);
    return {
      app: 'sop-workflow',
      schemaVersion: d.schemaVersion,
      exportedAt: nowOr(now),
      templates: d.templates,
      instances: d.instances,
      history: d.history,
    };
  }

  // ============ IO（依赖 window.api，契约 §7.2）============

  function getApi() {
    if (typeof globalThis !== 'undefined' && globalThis.window && globalThis.window.api) {
      return globalThis.window.api;
    }
    return null;
  }

  function errText(e) {
    return e && e.message ? String(e.message) : String(e);
  }

  function ioUnavailable(name) {
    return { ok: false, error: 'window.api.' + name + ' 不可用' };
  }

  /** load() -> Promise<{ ok, data, recovered, source, error }>  必须调用 normalizeData */
  function load() {
    const api = getApi();
    if (!api || typeof api.loadData !== 'function') {
      return Promise.resolve({
        ok: false,
        data: emptyData(),
        recovered: false,
        source: 'none',
        error: ioUnavailable('loadData').error,
      });
    }
    return Promise.resolve()
      .then(function () { return api.loadData(); })
      .then(function (res) {
        if (!res || typeof res !== 'object') {
          return {
            ok: false,
            data: emptyData(),
            recovered: false,
            source: 'none',
            error: 'load-data 返回结构非法',
          };
        }
        // 兼容旧 main.js：直接返回裸数据对象（无 { ok, data } 包装）
        const hasWrapper = Object.prototype.hasOwnProperty.call(res, 'data');
        const rawData = hasWrapper ? res.data : res;
        return {
          ok: res.ok !== false,
          data: normalizeData(rawData),
          recovered: res.recovered === true,
          source: str(res.source) || 'file',
          error: res.error ? str(res.error) : null,
        };
      })
      .catch(function (e) {
        return {
          ok: false,
          data: emptyData(),
          recovered: false,
          source: 'none',
          error: errText(e),
        };
      });
  }

  /**
   * save(data) -> Promise<{ ok, error, savedAt }>
   * IRON RULE：ok:false 时调用方不得关闭弹窗 / 切换页面 / 清空输入。
   */
  function save(data, now) {
    const api = getApi();
    if (!api || typeof api.saveData !== 'function') {
      return Promise.resolve({ ok: false, error: ioUnavailable('saveData').error, savedAt: null });
    }
    const ts = nowOr(now);
    const payload = normalizeData(data);
    payload.meta.lastSavedAt = ts;
    return Promise.resolve()
      .then(function () { return api.saveData(payload); })
      .then(function (res) {
        if (!res || typeof res !== 'object') {
          return { ok: false, error: 'save-data 返回结构非法', savedAt: null };
        }
        if (res.ok === false) {
          return { ok: false, error: res.error ? str(res.error) : '保存失败', savedAt: null };
        }
        return { ok: true, error: null, savedAt: num(res.savedAt, ts) };
      })
      .catch(function (e) {
        return { ok: false, error: errText(e), savedAt: null };
      });
  }

  /** exportToFile() -> Promise<{ ok, canceled, filePath, error }> */
  function exportToFile() {
    const api = getApi();
    if (!api || typeof api.exportData !== 'function') {
      return Promise.resolve({ ok: false, canceled: false, filePath: null, error: ioUnavailable('exportData').error });
    }
    return Promise.resolve()
      .then(function () { return api.exportData(); })
      .then(function (res) {
        const r = res && typeof res === 'object' ? res : {};
        return {
          ok: r.ok !== false,
          canceled: r.canceled === true,
          filePath: r.filePath ? str(r.filePath) : null,
          error: r.error ? str(r.error) : null,
        };
      })
      .catch(function (e) {
        return { ok: false, canceled: false, filePath: null, error: errText(e) };
      });
  }

  /** importFromFile() -> Promise<{ ok, canceled, data, filePath, error }> */
  function importFromFile() {
    const api = getApi();
    if (!api || typeof api.importData !== 'function') {
      return Promise.resolve({
        ok: false,
        canceled: false,
        data: null,
        filePath: null,
        error: ioUnavailable('importData').error,
      });
    }
    return Promise.resolve()
      .then(function () { return api.importData(); })
      .then(function (res) {
        const r = res && typeof res === 'object' ? res : {};
        const canceled = r.canceled === true;
        const rawData = r.data === undefined ? null : r.data;
        const data = rawData === null ? null : normalizeData(rawData);
        const result = {
          ok: r.ok !== false,
          canceled: canceled,
          data: data,
          filePath: r.filePath ? str(r.filePath) : null,
          error: r.error ? str(r.error) : null,
        };
        if (data) result.summary = validateImport(rawData).summary;
        return result;
      })
      .catch(function (e) {
        return { ok: false, canceled: false, data: null, filePath: null, error: errText(e) };
      });
  }

  /** getFileInfo() -> Promise<{ ok, filePath, backupDir, size, mtime, backups }> */
  function getFileInfo() {
    const api = getApi();
    if (!api || typeof api.getDataFileInfo !== 'function') {
      return Promise.resolve({
        ok: false,
        filePath: null,
        backupDir: null,
        size: 0,
        mtime: 0,
        backups: [],
        error: ioUnavailable('getDataFileInfo').error,
      });
    }
    return Promise.resolve()
      .then(function () { return api.getDataFileInfo(); })
      .then(function (res) {
        const r = res && typeof res === 'object' ? res : {};
        return {
          ok: r.ok !== false,
          filePath: r.filePath ? str(r.filePath) : null,
          backupDir: r.backupDir ? str(r.backupDir) : null,
          size: num(r.size, 0),
          mtime: num(r.mtime, 0),
          backups: toArray(r.backups),
          error: r.error ? str(r.error) : null,
        };
      })
      .catch(function (e) {
        return {
          ok: false,
          filePath: null,
          backupDir: null,
          size: 0,
          mtime: 0,
          backups: [],
          error: errText(e),
        };
      });
  }

  return {
    dataStore: {
      SCHEMA_VERSION: SCHEMA_VERSION,
      CATEGORIES: CATEGORIES,
      STATUS: STATUS,
      normalizeData: normalizeData,
      validateImport: validateImport,
      mergeData: mergeData,
      exportPayload: exportPayload,
      load: load,
      save: save,
      exportToFile: exportToFile,
      importFromFile: importFromFile,
      getFileInfo: getFileInfo,
    },
  };
});
