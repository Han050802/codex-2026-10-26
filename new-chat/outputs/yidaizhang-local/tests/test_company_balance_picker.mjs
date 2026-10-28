import assert from 'node:assert/strict';
import {companyBalanceTest as ui} from '../public/company-balance.js';

const accounts=[
  {code:'1001',name:'库存现金',category:'asset'},
  {code:'1101',name:'短期投资',category:'asset'},
  {code:'110101',name:'股票',category:'asset'},
  {code:'11010101',name:'A股',category:'asset'},
  {code:'110102',name:'债券',category:'asset',disabled:true},
  {code:'2202',name:'应付账款',category:'liability'},
  {code:'6001',name:'主营业务收入',category:'income'},
  {code:'6401',name:'主营业务成本',category:'expense'},
];
const state={accounts,category:'',treeCode:'',expandedCategories:new Set(),expandedAccounts:new Set(),search:'',disabled:false};
const codes=()=>ui.pickerFiltered(state).map(a=>a.code);
assert.equal(codes().length,7);
let tree=ui.pickerTree(state,{});
assert.match(tree,/data-picker-category="asset"/);
assert.doesNotMatch(tree,/data-picker-tree-code="1101"/,'collapsed category hides accounts');
state.expandedCategories.add('asset'); tree=ui.pickerTree(state,{});
assert.match(tree,/data-picker-tree-code="1101"/);
assert.doesNotMatch(tree,/data-picker-tree-code="110101"/,'collapsed account hides children');
assert.doesNotMatch(tree,/data-picker-tree-code="110102"/,'disabled accounts are hidden');
state.expandedAccounts.add('1101'); tree=ui.pickerTree(state,{});
assert.match(tree,/data-picker-tree-code="110101"/);
assert.doesNotMatch(tree,/data-picker-tree-code="11010101"/,'nested nodes remain collapsed');
state.expandedAccounts.add('110101'); tree=ui.pickerTree(state,{});
assert.match(tree,/data-picker-tree-code="11010101"/);
state.expandedAccounts.delete('1101'); tree=ui.pickerTree(state,{});
assert.doesNotMatch(tree,/data-picker-tree-code="110101"/,'collapsing a parent hides all nested nodes');
state.expandedCategories.delete('asset'); tree=ui.pickerTree(state,{});
assert.doesNotMatch(tree,/data-picker-tree-code="1101"/,'collapsing a category hides its accounts');
state.category='asset'; state.treeCode='1101';
assert.deepEqual(codes(),['1101','110101','11010101'],'account filter includes itself and descendants only');
state.search='股票'; assert.deepEqual(codes(),['110101','11010101'],'search also matches full account names');
state.search=''; state.disabled=true; assert.deepEqual(codes(),['1101','110101','11010101','110102']);
state.treeCode='1001'; assert.deepEqual(codes(),['1001'],'leaf filter selects only leaf');
state.treeCode=''; state.category='profit'; assert.deepEqual(codes(),['6001','6401'],'profit groups income and expense');
state.category='liability'; assert.deepEqual(codes(),['2202']);
state.category=''; assert.equal(codes().length,8,'all categories restores all subjects');
console.log('picker hierarchy and filtering checks passed');
