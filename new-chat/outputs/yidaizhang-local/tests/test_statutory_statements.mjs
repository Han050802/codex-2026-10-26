import assert from 'node:assert/strict';
import {createStatutoryBalanceXlsx, createStatutoryProfitXlsx} from '../public/statement-xlsx.js';

function unzipStored(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const files = new Map();
  let offset = 0;
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    const start = offset + 30 + nameLength + extraLength;
    files.set(name, decoder.decode(bytes.subarray(start, start + size)));
    offset = start + size;
  }
  return files;
}

const statement = {
  company: '元石银河',
  period: '2026-09',
  date: '2026-09-30',
  balance_sheet: {
    title: '资产负债表',
    form_no: '会小企01表',
    rows: [
      {asset_name: '货币资金', asset_line: '1', asset_ending_fen: 24648020, asset_begin_fen: null, equity_name: '短期借款', equity_line: '31', equity_ending_fen: null, equity_begin_fen: null},
      {asset_name: '资产总计', asset_line: '30', asset_ending_fen: 24648020, asset_begin_fen: 0, equity_name: '负债和所有者权益总计', equity_line: '53', equity_ending_fen: 24648020, equity_begin_fen: 0},
    ],
  },
  profit: {
    title: '利润表',
    form_no: '会小企02表',
    rows: [
      {name: '一、营业收入', line: '1', month_fen: null, ytd_fen: 15520000},
      {name: '四、净利润（净亏损以"－"号填列）', line: '32', month_fen: 0, ytd_fen: 14648020},
    ],
  },
};

const balance = unzipStored(createStatutoryBalanceXlsx(statement));
const balanceSheet = balance.get('xl/worksheets/sheet1.xml');
assert.match(balanceSheet, /会小企01表/);
assert.match(balanceSheet, /编制单位：元石银河/);
assert.match(balanceSheet, /<v>246480\.20<\/v>/);
assert.match(balanceSheet, /<v>0\.00<\/v>/);
assert.doesNotMatch(balanceSheet, /<v>0<\/v>/);
assert.match(balance.get('xl/workbook.xml'), /元石银河_资产负债表_202609/);
const profit = unzipStored(createStatutoryProfitXlsx(statement)).get('xl/worksheets/sheet1.xml');
assert.match(profit, /会小企02表/);
assert.match(profit, /一、营业收入/);
assert.match(profit, /<v>155200\.00<\/v>/);
assert.match(profit, /<v>146480\.20<\/v>/);
assert.match(profit, /<v>0\.00<\/v>/);
console.log('statutory workbook keeps form labels, exact yuan amounts, and blank zero detail cells');
