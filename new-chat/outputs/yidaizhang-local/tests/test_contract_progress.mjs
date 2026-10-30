import assert from 'node:assert/strict';
import test from 'node:test';
import { getAgencyExpiry, renderAgencyExpiry, nextContractMonth } from '../public/contract-progress.js';

const period = '2026-10';
const contract = (id, overrides = {}) => ({ id, client_id: 7, start_period: '2026-01', end_period: period, status: 'active', ...overrides });
const expiry = contracts => getAgencyExpiry(contracts, 7, period);

test('a deadline enters the reminder in its month and becomes overdue the following month', () => {
  const contracts = [contract(1)];
  assert.equal(getAgencyExpiry(contracts, 7, '2026-09').state, 'active');
  assert.equal(expiry(contracts).state, 'due');
  assert.equal(getAgencyExpiry(contracts, 7, '2026-11').state, 'overdue');
  const html = renderAgencyExpiry(expiry(contracts), 7);
  assert.match(html, /agency-expiry-due/);
  assert.match(html, /本月到期 · 请询问是否续约/);
  assert.match(html, /data-action="agency-contract" data-client="7"/);
  assert.equal(contracts[0].status, 'active', 'reading a deadline never changes a contract or disables a client');
});

test('other clients and terminated contracts cannot extend the service deadline', () => {
  const actual = expiry([contract(1), contract(2, { client_id: 8, end_period: '2029-12' }), contract(3, { status: 'terminated', end_period: '2028-10' })]);
  assert.equal(actual.state, 'due');
  assert.equal(actual.contract.id, 1);
});

test('a continuous renewal clears the old reminder, independent of record order', () => {
  const records = [contract(3, { start_period: '2027-11', end_period: '2028-10' }), contract(1), contract(2, { start_period: '2026-11', end_period: '2027-10' })];
  const actual = expiry(records);
  assert.equal(actual.state, 'active');
  assert.equal(actual.endPeriod, '2028-10');
  assert.equal(actual.contract.id, 3);
  assert.doesNotMatch(renderAgencyExpiry(actual, 7), /agency-expiry-due|本月到期/);
});

test('a future contract after a service gap does not suppress this month’s reminder', () => {
  const records = [contract(1), contract(2, { start_period: '2026-12', end_period: '2027-11' })];
  assert.equal(expiry(records).state, 'due');
  assert.equal(getAgencyExpiry(records, 7, '2026-11').state, 'overdue');
  assert.equal(getAgencyExpiry(records, 7, '2026-12').state, 'active');
});

test('missing, terminated and not yet started service have explicit states', () => {
  assert.equal(expiry([]).state, 'missing');
  assert.match(renderAgencyExpiry(expiry([]), 7), /未签合同 · 设置/);
  assert.equal(expiry([contract(1, { status: 'terminated' })]).state, 'terminated');
  assert.match(renderAgencyExpiry(expiry([contract(1, { status: 'terminated' })]), 7), /已终止 · 新签合同/);
  const future = expiry([contract(1, { start_period: '2027-01', end_period: '2027-12' })]);
  assert.equal(future.state, 'upcoming');
  assert.match(renderAgencyExpiry(future, 7), /服务尚未开始/);
});

test('December renewal rolls into January and invalid ranges cannot produce a reminder', () => {
  assert.equal(nextContractMonth('2026-12'), '2027-01');
  const actual = getAgencyExpiry([contract(1, { end_period: '2026-12' }), contract(2, { start_period: '2027-01', end_period: '2027-12' })], 7, '2026-12');
  assert.equal(actual.endPeriod, '2027-12');
  assert.equal(actual.state, 'active');
  assert.equal(expiry([contract(1, { start_period: '2026-11', end_period: '2026-10' })]).state, 'missing');
  assert.equal(expiry([contract(1, { end_period: '<script>' })]).state, 'missing');
  assert.equal(expiry(null).state, 'missing');
});
