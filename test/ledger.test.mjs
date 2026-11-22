import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ReceiptLedger } from '../src/ledger.mjs';

const requests = [
  { id: 'Q1', group: '机巡班', fromM: 145, toM: 175 },
  { id: 'Q2', group: '南班', fromM: 195, toM: 260 },
];

test('回执可登记整段或缩小后的部分范围，并持久化到磁盘', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'receipts.json');
  const ledger = new ReceiptLedger(path);
  const { receipt, warnings } = ledger.add({
    group: '机巡班', fromM: 145, toM: 160, basedOn: ['N11'],
    issuedAt: '2026-11-23T11:00:00+08:00',
  }, requests);
  assert.equal(receipt.id, 'R01');
  assert.deepEqual(warnings, []); // 部分范围仍在请求内
  ledger.save();

  const reopened = new ReceiptLedger(path);
  assert.equal(reopened.list().length, 1);
  assert.deepEqual([reopened.list()[0].from, reopened.list()[0].to], [145, 160]);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).receipts[0].basedOn, ['N11']);
});

test('无依据观察编号的回执被拒绝', () => {
  const ledger = new ReceiptLedger(null);
  assert.throws(() => ledger.add({ group: '南班', fromM: 195, toM: 260, basedOn: [] }, requests),
    /basedOn/);
});

test('请求范围之外与无请求班组只告警不拒绝', () => {
  const ledger = new ReceiptLedger(null);
  const outside = ledger.add({ group: '机巡班', fromM: 0, toM: 10, basedOn: ['X'] }, requests);
  assert.ok(outside.warnings[0].includes('请求范围之外'));
  const orphan = ledger.add({ group: '陌生班', fromM: 0, toM: 10, basedOn: ['X'] }, requests);
  assert.ok(orphan.warnings[0].includes('没有对应交接请求'));
});

test('回执编号不可重复', () => {
  const ledger = new ReceiptLedger(null);
  ledger.add({ id: 'R9', group: '南班', fromM: 195, toM: 260, basedOn: ['S21'] }, requests);
  assert.throws(() => ledger.add({ id: 'R9', group: '南班', fromM: 195, toM: 260, basedOn: ['S21'] }, requests),
    /已存在/);
});
