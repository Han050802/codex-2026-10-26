import assert from 'node:assert/strict';
import test from 'node:test';
import { createClientEditor, getIndustryOptions } from '../public/client-editor.js';

// This fixture supplies the DOM surfaces used by the editor. Tests dispatch real
// input, keyboard, click and submit handlers rather than reaching into its state.
const decode = value => String(value ?? '').replace(/&(amp|lt|gt|quot|#39);/g,
  (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[entity]));
const attributes = text => Object.fromEntries([...text.matchAll(/([\w-]+)(?:="([^"]*)")?/g)]
  .map(([, name, value]) => [name, decode(value ?? '')]));

class Element {
  constructor(tag = 'div', attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.attrs = {};
    this.dataset = {};
    this.children = [];
    this.handlers = new Map();
    this.value = '';
    this.hidden = false;
    this.isConnected = true;
    this.textContent = '';
    for (const [name, value] of Object.entries(attrs)) this.setAttribute(name, value);
    this.type ||= tag === 'input' ? 'text' : '';
    this.classList = {
      add: (...names) => this.changeClasses(names, true),
      remove: (...names) => this.changeClasses(names, false),
      toggle: (name, force) => this.changeClasses([name], force ?? !this.classes().has(name)),
    };
  }
  classes() { return new Set((this.attrs.class || '').split(/\s+/).filter(Boolean)); }
  changeClasses(names, present) {
    const values = this.classes();
    for (const name of names) present ? values.add(name) : values.delete(name);
    this.attrs.class = [...values].join(' ');
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
    if (['value', 'type', 'name', 'id'].includes(name)) this[name] = String(value);
    if (['hidden', 'disabled', 'checked'].includes(name)) this[name] = true;
  }
  getAttribute(name) { return this.attrs[name] ?? null; }
  removeAttribute(name) { delete this.attrs[name]; }
  append(node) { node.parentElement = this; this.children.push(node); return node; }
  addEventListener(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(handler);
  }
  removeEventListener(type, handler) { this.handlers.get(type)?.delete(handler); }
  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.classes().has(selector.slice(1));
    if (selector.startsWith('[')) {
      const [, name, value] = selector.match(/^\[([\w-]+)(?:=["']?([^"'\]]+)["']?)?\]$/) || [];
      return name in this.attrs && (value === undefined || this.attrs[name] === value);
    }
    return this.tagName.toLowerCase() === selector;
  }
  querySelectorAll(selector) {
    const selectors = selector.split(',');
    return this.children.flatMap(child => [
      ...(selectors.some(part => child.matches(part.trim())) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  getBoundingClientRect() { return { top: 100, bottom: 130 }; }
  scrollIntoView() {}
  focus() { this.ownerDocument.activeElement = this; }
  set innerHTML(html) {
    this.html = html;
    this.children = [];
    // paintOptions renders buttons in the real listbox; keep their real data,
    // highlighted state and text so keyboard and mouse paths share one fixture.
    for (const [, attrs, label] of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
      const button = this.append(new Element('button', attributes(attrs)));
      button.textContent = decode(label);
      button.ownerDocument = this.ownerDocument;
    }
  }
  get innerHTML() { return this.html || ''; }
}

async function emit(target, type, values = {}) {
  const event = { type, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...values };
  for (let node = target; node; node = node.parentElement) {
    for (const handler of node.handlers.get(type) || []) await handler(event);
  }
  return event;
}

function fixture(t, options = {}) {
  const priorDocument = globalThis.document, priorWindow = globalThis.window;
  const document = new Element('document'), window = new Element('window');
  globalThis.document = document;
  globalThis.window = window;
  const calls = [], saved = [];
  const editor = createClientEditor({ period: '2026-10', users: [{ id: 1, name: '合成会计' }],
    api: async (url, request) => { calls.push({ url, ...request }); return { id: 9, ...request.body }; },
    onSaved: result => saved.push(result), ...options });
  const rendered = editor.render();
  const container = document.append(new Element());
  const root = container.append(new Element('section', { 'data-client-editor': '' }));
  const form = root.append(new Element('form', { id: 'client-editor-form' }));
  form.elements = {};
  const summary = form.append(new Element('div', { class: 'ce-error-summary', hidden: '' }));
  root.append(new Element('span', { class: 'ce-dirty-state' }));
  root.append(new Element('div', { class: 'ce-scroll' }));
  const holders = new Map(), wrappers = new Map();
  for (const match of rendered.matchAll(/<(input|textarea)\b([^>]*)>(?:([^<]*)<\/textarea>)?/g)) {
    const [, tag, attrsText, text] = match, attrs = attributes(attrsText), input = new Element(tag, attrs);
    if (tag === 'textarea') input.value = decode(text || '');
    const name = input.dataset.ceInput || input.dataset.ceCombo || input.dataset.ceValue;
    let parent = form;
    if (name) {
      if (!holders.has(name)) {
        const holder = form.append(new Element('div', { 'data-ce-field': name }));
        holder.append(new Element('div', { class: 'ce-field-error', hidden: '' }));
        holders.set(name, holder);
      }
      parent = holders.get(name);
      if (input.dataset.ceCombo) {
        parent = parent.append(new Element('div', { 'data-ce-select': name }));
        wrappers.set(name, parent);
        parent.append(new Element('div', { role: 'listbox', hidden: '' }));
      } else if (input.dataset.ceValue) parent = wrappers.get(name);
    }
    parent.append(input);
    if (input.name) form.elements[input.name] = input;
  }
  const submit = form.append(new Element('button', { type: 'submit' }));
  const own = node => { node.ownerDocument = document; node.children.forEach(own); };
  own(document);
  editor.bind(container);
  t.after(() => { editor.destroy(); globalThis.document = priorDocument; globalThis.window = priorWindow; });
  const input = root.querySelector('[data-ce-combo="industry"]');
  const canonical = form.querySelector('[data-ce-value="industry"]');
  const list = wrappers.get('industry').querySelector('[role=listbox]');
  const change = async (name, value) => {
    const control = form.querySelector(`[data-ce-input="${name}"]`) || form.querySelector(`[data-ce-value="${name}"]`);
    control.value = value;
    await emit(control, control.dataset.ceValue ? 'change' : 'input');
  };
  const type = async value => {
    input.focus();
    await emit(input, 'focusin');
    input.value = value;
    await emit(input, 'input');
  };
  const valid = async () => {
    for (const [name, value] of Object.entries({ name: '合成客户', enterprise_name: '合成企业有限公司', tax_no: 'TESTINDUSTRY202610', region: '北京', accountant_id: '1' })) await change(name, value);
  };
  const leaveField = async () => {
    const next = form.querySelector('[data-ce-input="enterprise_name"]');
    next.focus();
    await emit(input, 'focusout', { relatedTarget: next });
    await emit(next, 'focusin', { relatedTarget: input });
    await emit(next, 'click');
  };
  return { editor, rendered, root, form, input, canonical, list, calls, saved, summary, submit,
    type, valid, change, leaveField, key: key => emit(input, 'keydown', { key }),
    save: () => emit(form, 'submit') };
}

test('custom prefix Enter keeps typed industry instead of replacing it with an existing longer match', async t => {
  const f = fixture(t);
  await f.type('软件');
  assert.deepEqual(f.list.children.map(node => node.dataset.value), ['软件', '软件和信息技术服务业']);
  const event = await f.key('Enter');
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.input.value, '软件');
  assert.equal(f.canonical.value, '软件');
  assert.equal(f.list.hidden, true);
  assert.equal(f.editor.isDirty(), true);
});

test('ArrowDown followed by Enter explicitly chooses an existing industry match', async t => {
  const f = fixture(t);
  await f.type('软件');
  await f.key('ArrowDown');
  assert.equal(f.input.getAttribute('aria-activedescendant'), 'ce-option-industry-1');
  await f.key('Enter');
  assert.equal(f.input.value, '软件和信息技术服务业');
  assert.equal(f.canonical.value, '软件和信息技术服务业');
});

test('raw custom input survives leaving the field and is sent in the new-client save payload', async t => {
  const f = fixture(t);
  await f.valid();
  await f.type('合成低空设备维护业');
  await f.leaveField();
  assert.equal(f.list.hidden, true);
  assert.equal(f.input.value, '合成低空设备维护业');
  await f.save();
  assert.equal(f.calls.length, 1, f.summary.textContent);
  assert.equal(f.calls[0].url, '/api/clients');
  assert.equal(f.calls[0].method, 'POST');
  assert.equal(f.calls[0].body.industry, '合成低空设备维护业');
  assert.equal(f.calls[0].body.profile_mode, true);
  assert.equal(f.saved.length, 1);
});

test('an industry returned by the backend is searchable and selectable with a mouse', async t => {
  const f = fixture(t, { industries: ['合成储能设备维护业'] });
  await f.type('储能');
  assert.deepEqual(f.list.children.map(node => node.dataset.value), ['储能', '合成储能设备维护业']);
  await emit(f.list.children[1], 'click');
  assert.equal(f.input.value, '合成储能设备维护业');
  assert.equal(f.canonical.value, '合成储能设备维护业');
  assert.equal(f.list.hidden, true);
});

test('case-insensitive trimmed industry duplicates appear once and an exact match wins Enter', async t => {
  const values = getIndustryOptions(['  AI设备维护业  ', 'ai设备维护业', 'AI设备维护业', '', '  ', '制造业']);
  assert.deepEqual(values.filter(value => value.toLowerCase() === 'ai设备维护业'), ['AI设备维护业']);
  assert.equal(values.filter(value => value === '制造业').length, 1);
  const f = fixture(t, { industries: ['AI设备维护业', 'ai设备维护业'] });
  await f.type('ai设备维护业');
  assert.deepEqual(f.list.children.map(node => node.dataset.value), ['AI设备维护业']);
  await f.key('Enter');
  assert.equal(f.canonical.value, 'AI设备维护业');
});
