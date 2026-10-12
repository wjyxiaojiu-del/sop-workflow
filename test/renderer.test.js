'use strict';
// Controller regressions: real core/render/controller in a lightweight DOM and IPC fixture.
// This covers data/interaction contracts, not browser layout or Electron integration.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const ok = { ok: true, savedAt: 1000, error: null };
const fail = { ok: false, error: 'injected disk failure', savedAt: null };
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

function makeHarness() {
  const ids = new Map();
  let document;
  function simple(node, selector) {
    selector = selector.trim().replace(/:not\(\[type="radio"\]\)/g, '');
    if (!selector || !node) return false;
    const tag = selector.match(/^[a-z][\w-]*/i);
    if (tag && node.tagName !== tag[0].toUpperCase()) return false;
    const id = selector.match(/#([\w-]+)/);
    if (id && node.id !== id[1]) return false;
    for (const hit of selector.matchAll(/\.([\w-]+)/g)) if (!node.classList.contains(hit[1])) return false;
    for (const hit of selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
      const value = node.getAttribute(hit[1]);
      if (value === null || (hit[2] !== undefined && value !== hit[2])) return false;
    }
    return true;
  }
  function matches(node, selectors) {
    return selectors.split(',').some(selector => {
      const parts = selector.trim().split(/\s+/);
      if (!simple(node, parts.pop())) return false;
      let parent = node.parentNode;
      while (parts.length) {
        const part = parts.pop();
        while (parent && !simple(parent, part)) parent = parent.parentNode;
        if (!parent) return false;
        parent = parent.parentNode;
      }
      return true;
    });
  }
  class Element {
    constructor(tag = 'div', id = '', cls = '') {
      this.tagName = tag.toUpperCase(); this.id = id; this.className = cls;
      this.attrs = {}; this.children = []; this.parentNode = null; this.style = {};
      this.value = ''; this.textContent = ''; this.checked = false; this.disabled = false;
      this.listeners = {}; this._html = '';
      if (id) ids.set(id, this);
      this.classList = {
        contains: name => this.className.split(/\s+/).includes(name),
        toggle: (name, on) => {
          const names = new Set(this.className.split(/\s+/).filter(Boolean));
          const enabled = on === undefined ? !names.has(name) : on;
          if (enabled) names.add(name); else names.delete(name);
          this.className = [...names].join(' '); return enabled;
        },
      };
    }
    getAttribute(name) { if (name === 'id') return this.id || null; return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
    contains(node) { return node === this || this.children.some(c => c.contains(node)); }
    removeChild(node) { this.children.splice(this.children.indexOf(node), 1); node.parentNode = null; }
    focus() { document.activeElement = this; }
    select() {}
    closest(selector) { for (let node = this; node; node = node.parentNode) if (matches(node, selector)) return node; return null; }
    querySelectorAll(selector) { const all = []; const walk = n => n.children.forEach(c => { if (matches(c, selector)) all.push(c); walk(c); }); walk(this); return all; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    click() { document.clickHandler?.({ target: this, stopPropagation() {} }); }
    set innerHTML(html) {
      if (this.contains(document.activeElement) && document.activeElement !== this) document.activeElement = document.body;
      for (const child of this.children) child.parentNode = null;
      this.children = []; this._html = html;
      if (this.id === 'instance-checklist') {
        for (const tag of html.matchAll(/<div\s+([^>]*class="(?:checklist-item|flow-node executable)[^>]+)>/g)) {
          const attrs = Object.fromEntries([...tag[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
          const child = this.appendChild(new Element('div', '', attrs.class));
          for (const [key, value] of Object.entries(attrs)) child.setAttribute(key, value);
        }
      }
      if (this.id === 'steps-editor') this.parseSteps(html);
      if (this.id === 'variables-form') {
        for (const match of html.matchAll(/<input[^>]+data-var="([^"]+)"[^>]*>/g)) {
          const child = this.appendChild(new Element('input', '', 'variable-input'));
          child.setAttribute('data-var', match[1]);
        }
      }
    }
    get innerHTML() { return this._html; }
    insertAdjacentHTML(where, html) { assert.equal(where, 'beforeend'); this._html += html; this.parseSteps(html); }
    parseSteps(html) {
      for (const match of html.matchAll(/class="step-editor-item" data-step-id="([^"]+)"([\s\S]*?)(?=<div class="step-editor-item"|$)/g)) {
        const row = this.appendChild(new Element('div', '', 'step-editor-item')); row.setAttribute('data-step-id', match[1]);
        row.appendChild(new Element('span', '', 'step-number'));
        const title = row.appendChild(new Element('input', '', 'step-title-input'));
        title.value = /class="step-title-input" value="([^"]*)"/.exec(match[2])?.[1] || '';
        const note = row.appendChild(new Element('textarea', '', 'step-note-input'));
        note.value = /class="step-note-input"[^>]*>([^<]*)</.exec(match[2])?.[1] || '';
        const subs = row.appendChild(new Element('div', '', 'sub-steps-editor'));
        for (const sub of match[2].matchAll(/class="sub-step-input" data-sub-id="([^"]+)"[\s\S]*?class="sub-step-field" value="([^"]*)"/g)) {
          const subrow = subs.appendChild(new Element('div', '', 'sub-step-input')); subrow.setAttribute('data-sub-id', sub[1]);
          subrow.appendChild(new Element('input', '', 'sub-step-field')).value = sub[2];
        }
      }
    }
  }
  document = {
    readyState: 'loading', activeElement: null, body: new Element('body'),
    getElementById: id => ids.get(id) || null,
    createElement: tag => new Element(tag),
    querySelector: selector => document.body.querySelector(selector),
    querySelectorAll: selector => document.body.querySelectorAll(selector),
    addEventListener: (name, fn) => { document[name + 'Handler'] = fn; },
  };
  document.activeElement = document.body;
  const add = (id, tag = 'div', parent = document.body, cls = '') => parent.appendChild(new Element(tag, id, cls));
  for (const name of ['templates', 'instances', 'history', 'template-detail', 'instance-detail']) add('view-' + name);
  for (const id of ['modal-template', 'modal-variables', 'modal-confirm', 'modal-import']) add(id, 'div', document.body, 'modal-overlay').style.display = 'none';
  for (const id of ['input-template-name', 'input-template-desc', 'input-template-category', 'input-template-tags', 'input-template-favorite']) add(id, 'input', ids.get('modal-template'));
  add('steps-editor', 'div', ids.get('modal-template'));
  for (const id of ['btn-add-step', 'btn-save-template', 'btn-cancel-template']) add(id, 'button', ids.get('modal-template'));
  for (const id of ['modal-template-title', 'modal-confirm-title', 'modal-confirm-message', 'running-badge', 'template-detail', 'instance-status-badge', 'instance-progress-text', 'instance-checklist', 'import-summary']) add(id);
  add('variables-form', 'div', ids.get('modal-variables'));
  for (const id of ['btn-confirm-ok', 'btn-confirm-cancel', 'btn-confirm-discard']) add(id, 'button', ids.get('modal-confirm'));
  for (const id of ['detail-favorite-toggle', 'btn-start-instance', 'btn-pause-instance', 'btn-resume-instance', 'btn-finish-instance', 'btn-abandon-instance']) add(id, 'button');
  add('instance-progress-fill', 'div', add('progress-bar'));
  add('instance-exec-notes', 'textarea'); add('search-templates', 'input');
  add('recovery-text', 'span', add('recovery-banner'), 'recovery-text');
  const timers = new Map(); let timerId = 0;
  const saves = [], exports = [], toasts = [], errors = [], dirty = [];
  let saveImpl = async () => ok;
  let loadResult = { ok: true, data: { schemaVersion: 2, templates: [], instances: [], history: [], meta: {} } };
  let closeCount = 0, cancelCount = 0;
  const api = {
    setDirtyState: value => dirty.push(value), confirmClose: () => { closeCount++; }, cancelClose: () => { cancelCount++; },
    onCloseRequested: cb => { api.closeRequested = cb; }, onDataRecovered: cb => { api.recovered = cb; },
  };
  const core = Object.assign({}, ...['utils', 'progress', 'template-service', 'instance-service', 'data-store'].map(name => require(path.join(root, 'core', name + '.js'))));
  core.dataStore = Object.assign({}, core.dataStore, {
    save: data => { const snapshot = clone(data); saves.push(snapshot); return saveImpl(snapshot); },
    load: async () => loadResult,
    exportToFile: async () => { exports.push(saves.length ? clone(saves.at(-1)) : null); return { ok: true }; },
  });
  const context = vm.createContext({
    window: { api }, document, SOPCore: core, console: { error: (...args) => errors.push(args) },
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'render.js'), 'utf8'), context);
  context.SOPRender.toast = (message, type) => toasts.push({ message, type });
  let source = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  source = source.replace("  if (document.readyState === 'loading') {", `  globalThis.hooks = { state, init, bindEvents, openTemplateModal, saveTemplate, markEditorDirty, onKeydown, onDocumentClick, scheduleNotesSave, flushNotes, persistData, commitChange, handleCloseRequested, runConfirm, activeModal, openInstanceDetail, renderCurrent, startInstance, confirmVariables, createInstance, finishCurrent, abandonCurrent, duplicateTemplate, toggleChecklistItem, doExport, openModal, showView, reportSaveFailure };\n  if (document.readyState === 'loading') {`);
  vm.runInContext(source, context);
  const h = context.hooks;
  const template = name => core.templateService.createTemplate({ name: name || 'Sample', steps: [{ id: 's0', title: 'First', subSteps: [{ id: 'ss0', title: 'Child', done: false }] }, { id: 's1', title: 'Second' }] }, 100);
  const instance = (t, id) => Object.assign(core.instanceService.createInstance(t, {}, 200), { id });
  function beginEditor(t = null) {
    h.openTemplateModal(t); ids.get('input-template-name').value = t?.name || 'New template';
    ids.get('steps-editor').querySelector('.step-title-input').value = 'First'; h.markEditorDirty();
  }
  function typeNotes(value) { const notes = ids.get('instance-exec-notes'); notes.value = value; notes.focus(); h.scheduleNotesSave({ target: notes }); }
  return { h, core, R: context.SOPRender, document, ids, saves, exports, toasts, errors, dirty, timers, api,
    template, instance, beginEditor, typeNotes, get: id => ids.get(id), setSave: fn => { saveImpl = fn; }, setLoad: value => { loadResult = value; },
    get closeCount() { return closeCount; }, get cancelCount() { return cancelCount; },
  };
}
function twoInstances(x) { const t = x.template(); const a = x.instance(t, 'a'), b = x.instance(t, 'b'); b.executionNotes = 'B original'; x.h.state.data.templates = [t]; x.h.state.data.instances = [a, b]; x.h.openInstanceDetail('a'); return { t, a, b }; }
function key(x, value, ctrl = false) { let prevented = false; x.h.onKeydown({ key: value, ctrlKey: ctrl, preventDefault() { prevented = true; } }); return prevented; }

test('failed new template stays staged; retry creates one template', async () => {
  const x = makeHarness(); x.beginEditor(); x.setSave(async () => fail);
  assert.equal(await x.h.saveTemplate(), false); assert.equal(x.h.activeModal(), 'modal-template');
  assert.equal(x.get('input-template-name').value, 'New template');
  assert.equal(x.h.state.data.templates.length, 0, 'failed template must not enter committed memory');
  x.setSave(async () => ok); assert.equal(await x.h.saveTemplate(), true);
  assert.equal(x.h.state.data.templates.length, 1); assert.equal(x.h.state.data.templates[0].version, 1);
});
test('save failure logs diagnostic error', async () => { const x = makeHarness(); x.h.reportSaveFailure(fail); assert.equal(x.errors.length, 1); });
test('Ctrl+F does not dismiss dirty template modal', async () => { const x = makeHarness(); x.beginEditor(); key(x, 'f', true); assert.equal(x.h.activeModal(), 'modal-template'); assert.equal(x.h.state.isDirty, true); });
test('notes are dirty immediately and captured against originating instance', async () => {
  const x = makeHarness(); twoInstances(x); x.typeNotes('A draft');
  assert.equal(x.h.state.isDirty, true, 'dirty before 600ms'); x.h.openInstanceDetail('b'); await x.h.flushNotes();
  assert.equal(x.h.state.data.instances.find(i => i.id === 'a').executionNotes, 'A draft');
  assert.equal(x.h.state.data.instances.find(i => i.id === 'b').executionNotes, 'B original');
  assert.equal(x.get('instance-exec-notes').value, 'B original');
});
test('close before notes debounce prompts and persists notes before exit', async () => {
  const x = makeHarness(); twoInstances(x); x.typeNotes('pending note'); x.h.handleCloseRequested();
  assert.equal(x.closeCount, 0); assert.equal(x.h.activeModal(), 'modal-confirm');
  await x.h.runConfirm('ok'); assert.equal(x.closeCount, 1); assert.equal(x.saves.at(-1).instances[0].executionNotes, 'pending note');
});
test('older save cannot clear newer notes dirty state', async () => {
  const x = makeHarness(); twoInstances(x); x.typeNotes('first'); const gate = deferred(); x.setSave(() => gate.promise);
  const p = x.h.flushNotes(); await settle(); x.typeNotes('second'); gate.resolve(ok); await p;
  assert.equal(x.h.state.isDirty, true); assert.equal(x.h.state.data.instances[0].executionNotes, 'second');
  x.setSave(async () => ok); await x.h.flushNotes(); assert.equal(x.saves.at(-1).instances[0].executionNotes, 'second'); assert.equal(x.h.state.isDirty, false);
});
test('writes are serialized and take latest note snapshot when dequeued', async () => {
  const x = makeHarness(); twoInstances(x); x.typeNotes('first'); const first = deferred(); x.setSave(() => first.promise);
  const p1 = x.h.persistData(); await settle(); x.typeNotes('second'); const p2 = x.h.persistData(); await settle();
  assert.equal(x.saves.length, 1, 'second IPC must wait for first'); x.setSave(async () => ok); first.resolve(ok); await Promise.all([p1, p2]);
  assert.equal(x.saves.at(-1).instances[0].executionNotes, 'second'); assert.equal(x.h.state.isDirty, false);
});
test('editing during template save keeps new input dirty and open', async () => {
  const x = makeHarness(); x.beginEditor(); const gate = deferred(); x.setSave(() => gate.promise);
  const p = x.h.saveTemplate(); await settle(); x.get('input-template-name').value = 'Newer name'; x.h.markEditorDirty(); gate.resolve(ok); await p;
  assert.equal(x.h.activeModal(), 'modal-template'); assert.equal(x.get('input-template-name').value, 'Newer name'); assert.equal(x.h.state.isDirty, true);
  x.setSave(async () => ok); await x.h.saveTemplate(); assert.equal(x.h.state.data.templates.length, 1); assert.equal(x.h.state.data.templates[0].name, 'Newer name');
});
test('variable creation failure retains inputs/modal and retry creates once', async () => {
  const x = makeHarness(); const t = x.template(); t.steps[0].title = 'Hello {{target}}'; x.h.state.data.templates = [t]; x.h.state.currentTemplateId = t.id; x.h.startInstance();
  const field = x.get('variables-form').querySelector('.variable-input'); field.value = 'Alice'; x.setSave(async () => fail); x.h.confirmVariables(); await settle();
  assert.equal(x.h.activeModal(), 'modal-variables'); assert.equal(field.value, 'Alice'); assert.equal(x.h.state.data.instances.length, 0);
  x.setSave(async () => ok); x.h.confirmVariables(); await settle(); assert.equal(x.h.state.data.instances.length, 1); assert.equal(x.h.activeModal(), null);
});
test('completion failure keeps confirmation and retry has one history record', async () => {
  const x = makeHarness(); twoInstances(x); x.setSave(async () => fail); await x.h.finishCurrent(false); await x.h.runConfirm('ok');
  assert.equal(x.h.activeModal(), 'modal-confirm'); assert.equal(x.h.state.data.history.length, 0); assert.equal(x.h.state.data.instances[0].status, 'running');
  x.setSave(async () => ok); await x.h.runConfirm('ok'); assert.equal(x.h.activeModal(), null); assert.equal(x.h.state.data.history.length, 1); assert.equal(x.h.state.data.instances[0].status, 'completed');
});
test('abandon failure is retryable without duplicate history', async () => {
  const x = makeHarness(); twoInstances(x); x.setSave(async () => fail); x.h.abandonCurrent(); await x.h.runConfirm('ok'); x.setSave(async () => ok); await x.h.runConfirm('ok');
  assert.equal(x.h.state.data.history.length, 1); assert.equal(x.h.state.data.instances[0].status, 'abandoned');
});
test('failed duplicate does not leave hidden extra copy before retry', async () => {
  const x = makeHarness(); const t = x.template(); x.h.state.data.templates = [t]; x.h.state.currentTemplateId = t.id;
  x.setSave(async () => fail); await x.h.duplicateTemplate(); x.setSave(async () => ok); await x.h.duplicateTemplate();
  assert.equal(x.h.state.data.templates.length, 2); assert.equal(x.h.state.data.templates[0].name, 'Sample - 副本');
});
test('checklist redraw restores same keyboard item focus', async () => {
  const x = makeHarness(); twoInstances(x); const item = x.get('instance-checklist').querySelector('[data-sub-index="0"]'); item.focus(); await x.h.toggleChecklistItem(item);
  assert.notEqual(x.document.activeElement, x.document.body); assert.equal(x.document.activeElement.getAttribute('data-sub-index'), '0'); assert.equal(x.document.activeElement.getAttribute('aria-checked'), 'true');
});
test('checklist async redraw does not steal focus from notes', async () => {
  const x = makeHarness(); twoInstances(x); const item = x.get('instance-checklist').querySelector('[data-sub-index="0"]'); item.focus(); const gate = deferred(); x.setSave(() => gate.promise);
  const p = x.h.toggleChecklistItem(item); await settle(); x.typeNotes('while saving'); gate.resolve(ok); await p;
  assert.equal(x.document.activeElement, x.get('instance-exec-notes')); assert.equal(x.get('instance-exec-notes').value, 'while saving');
});
test('export refuses stale disk data after pending note save failure', async () => {
  const x = makeHarness(); twoInstances(x); x.typeNotes('new export note'); x.setSave(async () => fail); await x.h.doExport(); assert.equal(x.exports.length, 0); assert.equal(x.h.state.isDirty, true);
  x.setSave(async () => ok); await x.h.doExport(); assert.equal(x.exports.length, 1); assert.equal(x.exports[0].instances[0].executionNotes, 'new export note');
});
test('no-backup recovery explicitly reports empty fallback error', async () => {
  const x = makeHarness(); x.setLoad({ ok: true, data: x.h.state.data, recovered: true, source: 'empty', error: 'all backup files unreadable' }); await x.h.init();
  assert.match(x.get('recovery-text').textContent, /无可用备份|没有可用备份|无法.*备份/);
  assert.ok(x.toasts.some(t => t.type === 'error' && /备份/.test(t.message))); assert.doesNotMatch(x.get('recovery-text').textContent, /已从.*备份恢复/);
});
test('save-and-exit does not discard notes typed during the save', async () => {
  const x = makeHarness(); twoInstances(x); x.typeNotes('first'); x.h.handleCloseRequested(); const gate = deferred(); x.setSave(() => gate.promise);
  const p = x.h.runConfirm('ok'); await settle(); x.typeNotes('second'); gate.resolve(ok); await p;
  assert.equal(x.closeCount, 0); assert.equal(x.h.activeModal(), 'modal-confirm'); assert.equal(x.h.state.isDirty, true);
  x.setSave(async () => ok); await x.h.runConfirm('ok'); assert.equal(x.closeCount, 1); assert.equal(x.saves.at(-1).instances[0].executionNotes, 'second');
});
test('Ctrl+S performs one save and exposes a failure instead of silent retry', async () => {
  const x = makeHarness(); twoInstances(x); x.typeNotes('manual save'); x.setSave(async () => fail); key(x, 's', true); await settle();
  assert.equal(x.saves.length, 1); assert.equal(x.h.state.isDirty, true); assert.ok(x.toasts.some(t => t.type === 'error'));
});
test('rapid checklist saves preserve both changes and serialize IPC', async () => {
  const x = makeHarness(); twoInstances(x); const items = x.get('instance-checklist').querySelectorAll('[data-step-index]');
  const child = items.find(n => n.getAttribute('data-sub-index') === '0'); const second = items.find(n => n.getAttribute('data-step-index') === '1');
  const gate = deferred(); x.setSave(() => gate.promise); const p1 = x.h.toggleChecklistItem(child); await settle(); const p2 = x.h.toggleChecklistItem(second); await settle();
  assert.equal(x.saves.length, 1); x.setSave(async () => ok); gate.resolve(ok); await Promise.all([p1, p2]);
  assert.equal(x.h.state.data.instances[0].steps[0].subSteps[0].done, true); assert.equal(x.h.state.data.instances[0].steps[1].done, true);
});
test('variable collection preserves own __proto__ key safely', async () => {
  const x = makeHarness(); const t = x.template(); t.steps[0].title = 'Hello {{__proto__}}'; x.h.state.data.templates = [t]; x.h.state.currentTemplateId = t.id; x.h.startInstance();
  x.get('variables-form').querySelector('.variable-input').value = 'safe value'; await x.h.confirmVariables();
  assert.equal(x.h.state.data.instances[0].variables.__proto__, 'safe value'); assert.equal(x.h.state.data.instances[0].steps[0].title, 'Hello safe value');
});
test('Space toggles focused checklist, while Escape protects dirty editor', async () => {
  const x = makeHarness(); x.h.bindEvents(); twoInstances(x); x.get('instance-checklist').querySelector('[data-sub-index="0"]').focus();
  assert.equal(key(x, ' '), true); await settle(); assert.equal(x.h.state.data.instances[0].steps[0].subSteps[0].done, true);
  x.beginEditor(); assert.equal(key(x, 'Escape'), true); assert.equal(x.h.activeModal(), 'modal-confirm');
  await x.h.runConfirm('cancel'); assert.equal(x.h.activeModal(), 'modal-template'); assert.equal(x.h.state.isDirty, true);
});
test('add-step event route appends row and focuses new title', async () => {
  const x = makeHarness(); x.beginEditor(); const editor = x.get('steps-editor'); const count = editor.children.length;
  x.h.onDocumentClick({ target: x.get('btn-add-step'), stopPropagation() {} }); assert.equal(editor.children.length, count + 1); assert.equal(x.document.activeElement, editor.children.at(-1).querySelector('.step-title-input'));
});

test('native change on hiding a saved editor does not create phantom unsaved changes', async () => {
  const x = makeHarness(); x.h.bindEvents(); x.beginEditor();
  const modal = x.get('modal-template');
  const input = x.get('steps-editor').querySelector('.step-title-input');
  let display = modal.style.display;
  // Real Chromium emits change/blur after Ctrl+S hides the focused text field.
  Object.defineProperty(modal.style, 'display', {
    get: () => display,
    set: value => {
      display = value;
      if (value === 'none') for (const fn of modal.listeners.change || []) fn({ target: input });
    },
  });
  assert.equal(await x.h.saveTemplate(), true);
  assert.equal(display, 'none');
  assert.equal(x.h.state.isDirty, false, 'already saved text must not dirty a hidden editor');
  assert.equal(x.dirty.at(-1), false);
  x.h.handleCloseRequested();
  assert.equal(x.closeCount, 1, 'clean close must not demand another save');
  assert.equal(x.h.activeModal(), null);
});

test('blur-only change during template save is not a newer input revision', async () => {
  const x = makeHarness(); x.h.bindEvents(); x.beginEditor();
  const gate = deferred(); x.setSave(() => gate.promise);
  const pending = x.h.saveTemplate(); await settle();
  const modal = x.get('modal-template');
  for (const fn of modal.listeners.change || []) fn({ target: x.get('input-template-name') });
  gate.resolve(ok);
  assert.equal(await pending, true);
  assert.equal(x.h.state.isDirty, false);
  assert.equal(x.h.activeModal(), null);
});

test('category and favorite input events still mark visible editor dirty', () => {
  for (const id of ['input-template-category', 'input-template-favorite']) {
    const x = makeHarness(); x.h.bindEvents(); x.h.openTemplateModal(null);
    assert.equal(x.h.state.isDirty, false);
    const input = x.get(id); input.value = '科研'; input.checked = true;
    for (const fn of x.get('modal-template').listeners.input || []) fn({ target: input });
    assert.equal(x.h.state.isDirty, true, id);
  }
});
