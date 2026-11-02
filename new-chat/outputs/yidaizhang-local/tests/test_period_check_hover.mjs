import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import {
  renderPeriodCheckRows, bindPeriodCheckDetails, clearPeriodCheckDetails,
} from '../public/period-checks.js';

// Reuse the workspace UI harness; this app has no production DOM dependency.
const require = createRequire(new URL('../../../work/ui-tests/package.json', import.meta.url));
const { parseHTML } = require('linkedom');
const settle = () => new Promise(resolve => setTimeout(resolve, 210));
const unsafe = '<img src=x onerror="alert(1)"> & "原始记录"';
const book = {
  client: { id: 71 }, period: '2026-09',
  checks: [
    {
      severity: 'error', message: `2张凭证未审核 ${unsafe}`,
      details: {
        reason: `检查原因 ${unsafe}`, action: `处理建议 ${unsafe}`,
        columns: [{ key: 'summary', label: `凭证摘要 ${unsafe}` }, { key: 'amount_fen', label: '金额', format: 'money' }],
        rows: [{ summary: `第一条 ${unsafe}`, amount_fen: 123456 }, { summary: '第二条', amount_fen: -890 }],
        total: 3, truncated: true,
      },
    },
    {
      severity: 'warning', message: '现金流量分类需要复核',
      details: {
        reason: '货币资金分录尚未分类', action: '核对银行和现金分录后补充分类',
        columns: [{ key: 'summary', label: '摘要' }], rows: [{ summary: '银行付款' }],
        total: 1, truncated: false,
      },
    },
  ],
};

function fixture(t, input = book) {
  clearPeriodCheckDetails();
  const { window, document } = parseHTML('<!doctype html><html><body><main id="content"></main><button id="outside">外部按钮</button></body></html>');
  const prior = new Map(['window', 'document', 'Element', 'HTMLElement'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries({ window, document, Element: window.Element, HTMLElement: window.HTMLElement })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(document, 'activeElement', { configurable: true, writable: true, value: document.body });
  window.innerWidth = 1024;
  window.innerHeight = 768;
  window.requestAnimationFrame = callback => setTimeout(callback, 0);
  window.cancelAnimationFrame = clearTimeout;
  const content = document.getElementById('content');
  const rows = renderPeriodCheckRows(input);
  assert.ok(Array.isArray(rows), 'The check renderer supplies complete rows to the existing table.');
  content.innerHTML = `<table><tbody>${rows.join('')}</tbody></table>`;
  for (const element of content.querySelectorAll('*')) {
    element.getBoundingClientRect = () => element.testRect || {
      x: 220, y: 180, left: 220, top: 180, right: 800, bottom: 220,
      width: 580, height: 40, toJSON() {},
    };
    if (element.hasAttribute('data-period-check-popup')) {
      element.getBoundingClientRect = () => ({
        x: 220, y: 228, left: 220, top: 228, right: 800, bottom: 488,
        width: 580, height: 260, toJSON() {},
      });
    }
  }
  const emit = (target, type, values = {}) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries(values)) Object.defineProperty(event, key, { value, configurable: true });
    target.dispatchEvent(event);
    return event;
  };
  const focus = target => {
    const previous = document.activeElement;
    document.activeElement = target;
    if (previous && previous !== target) emit(previous, 'focusout', { relatedTarget: target });
    emit(target, 'focusin', { relatedTarget: previous });
  };
  bindPeriodCheckDetails(content);
  t.after(() => {
    clearPeriodCheckDetails();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return {
    window, document, content, emit, focus, outside: document.getElementById('outside'),
    row: index => content.querySelector(`[data-period-check="${index}"]`),
    triggers: index => [...content.querySelectorAll(`[data-period-check-trigger="${index}"]`)],
    popup: index => content.querySelector(`[data-period-check-popup="${index}"]`),
  };
}

function visible(f, index, expected = true) {
  const popup = f.popup(index);
  assert.ok(popup, `Check ${index} has a detail popup.`);
  assert.equal(popup.hidden, !expected, `Check ${index} popup should be ${expected ? 'visible' : 'hidden'}.`);
  for (const trigger of f.triggers(index)) {
    assert.equal(trigger.getAttribute('aria-expanded'), String(expected), 'Both cells expose the current expansion state.');
  }
}

test('details render safe text, readable money and accessible hidden popups', t => {
  const snapshot = JSON.stringify(book);
  const f = fixture(t);
  assert.equal(f.content.querySelectorAll('[data-period-check]').length, 2);
  assert.equal(f.triggers(0).length, 2, 'Both severity and message cells have keyboard triggers.');
  const popup = f.popup(0);
  assert.equal(popup.id, 'period-check-detail-0');
  assert.equal(popup.getAttribute('role'), 'tooltip');
  visible(f, 0, false);
  assert.equal(f.content.querySelector('img, script, svg'), null, 'Record text cannot create active HTML.');
  assert.ok(f.content.textContent.includes(unsafe));
  assert.ok(popup.textContent.includes(`检查原因 ${unsafe}`));
  assert.ok(popup.textContent.includes(`处理建议 ${unsafe}`));
  assert.ok(popup.textContent.includes(`凭证摘要 ${unsafe}`));
  assert.ok(popup.textContent.includes(`第一条 ${unsafe}`));
  assert.match(popup.textContent, /1,234\.56/);
  assert.match(popup.textContent, /-8\.90/);
  assert.match(popup.textContent, /3/, 'The total count remains visible when only a sample is supplied.');
  for (const element of f.content.querySelectorAll('*')) {
    assert.ok([...element.attributes].every(attr => !/^on/i.test(attr.name)), 'User text cannot inject event attributes.');
  }
  for (const trigger of f.triggers(0)) {
    assert.equal(trigger.tagName, 'BUTTON');
    assert.equal(trigger.getAttribute('aria-controls'), popup.id);
    assert.equal(trigger.type, 'button');
  }
  assert.equal(JSON.stringify(book), snapshot, 'Rendering and binding do not mutate accounting records.');
});

test('hovering either check cell opens details and leaving the row closes them', async t => {
  const f = fixture(t);
  const cells = [...f.row(0).children].filter(element => element.tagName === 'TD');
  assert.equal(cells.length, 2);
  for (const cell of cells) {
    f.emit(cell, 'mouseover', { relatedTarget: f.outside });
    visible(f, 0);
    f.emit(cell, 'mouseout', { relatedTarget: f.outside });
    await settle();
    visible(f, 0, false);
  }
});

test('moving from the trigger into the detail popup keeps the scrollable details open', async t => {
  const f = fixture(t);
  const trigger = f.triggers(0)[1], popup = f.popup(0);
  f.emit(trigger, 'mouseover', { relatedTarget: f.outside });
  f.emit(trigger, 'mouseout', { relatedTarget: popup });
  f.emit(popup, 'mouseover', { relatedTarget: trigger });
  await settle();
  visible(f, 0);
  popup.scrollTop = 80;
  f.emit(popup, 'scroll');
  visible(f, 0);
  f.emit(popup, 'mouseout', { relatedTarget: f.outside });
  await settle();
  visible(f, 0, false);
});

test('crossing rows immediately switches the single visible detail popup', async t => {
  const f = fixture(t);
  const first = f.triggers(0)[0], second = f.triggers(1)[1];
  f.emit(first, 'mouseover', { relatedTarget: f.outside });
  visible(f, 0);
  f.emit(first, 'mouseout', { relatedTarget: second });
  f.emit(second, 'mouseover', { relatedTarget: first });
  visible(f, 0, false);
  visible(f, 1);
  await settle();
  visible(f, 1);
});

test('keyboard focus opens details, Escape dismisses them, and focus can move into the popup', async t => {
  const f = fixture(t);
  f.focus(f.triggers(0)[1]);
  visible(f, 0);
  f.focus(f.popup(0));
  await settle();
  visible(f, 0);
  f.emit(f.popup(0), 'keydown', { key: 'Escape' });
  visible(f, 0, false);
  f.focus(f.triggers(1)[0]);
  visible(f, 1);
  f.focus(f.outside);
  await settle();
  visible(f, 1, false);
});

test('Escape does not reopen under the stationary pointer until it leaves the row', async t => {
  const f = fixture(t);
  const trigger = f.triggers(0)[1];
  f.emit(trigger, 'mouseover', { relatedTarget: f.outside });
  f.emit(trigger, 'keydown', { key: 'Escape' });
  visible(f, 0, false);
  f.emit(f.triggers(0)[0], 'mouseover', { relatedTarget: trigger });
  visible(f, 0, false);
  f.emit(trigger, 'mouseout', { relatedTarget: f.outside });
  await settle();
  f.emit(trigger, 'mouseover', { relatedTarget: f.outside });
  visible(f, 0);
});

test('click pins hover-open details, toggles them, and outside pointer or click dismisses them', async t => {
  const f = fixture(t);
  const trigger = f.triggers(0)[1];
  f.emit(trigger, 'mouseover', { relatedTarget: f.outside });
  f.emit(trigger, 'click');
  visible(f, 0);
  f.emit(trigger, 'mouseout', { relatedTarget: f.outside });
  await settle();
  visible(f, 0);
  f.emit(trigger, 'click');
  visible(f, 0, false);
  f.emit(trigger, 'click', { pointerType: 'touch' });
  visible(f, 0);
  f.emit(f.outside, 'pointerdown', { pointerType: 'touch' });
  visible(f, 0, false);
  f.emit(trigger, 'click');
  visible(f, 0);
  f.emit(f.outside, 'click');
  visible(f, 0, false);
});

test('cleanup hides details and unbinds events; rebinding does not duplicate click handlers', t => {
  const f = fixture(t);
  const trigger = f.triggers(0)[0];
  f.emit(trigger, 'click');
  visible(f, 0);
  clearPeriodCheckDetails();
  visible(f, 0, false);
  f.emit(trigger, 'mouseover', { relatedTarget: f.outside });
  f.emit(trigger, 'click');
  f.focus(trigger);
  visible(f, 0, false);
  bindPeriodCheckDetails(f.content);
  bindPeriodCheckDetails(f.content);
  f.emit(trigger, 'click');
  visible(f, 0);
  f.emit(trigger, 'click');
  visible(f, 0, false);
});
