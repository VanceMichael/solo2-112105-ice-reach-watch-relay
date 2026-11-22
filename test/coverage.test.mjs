import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeRow, canonize, buildReplacementIndex } from '../src/domain/normalize.mjs';
import { adjudicateSlice } from '../src/domain/coverage.mjs';

const shift = {
  id: 'n23',
  start: '2026-11-23T06:00:00+08:00',
  end: '2026-11-23T12:00:00+08:00',
};
const bankBook = { 北: 'north', 南: 'south' };

function rowsToCtx(rows, pickups) {
  const normalized = rows.map((r, i) => normalizeRow(
    r, r.bank === '北' ? 'north' : 'south', r.bank === '北' ? 'north' : 'south', []));
  const { observations, gaps } = canonize(normalized);
  return {
    observations,
    gaps,
    replacementIndex: buildReplacementIndex(observations),
    pickups: new Map(Object.entries(pickups).map(([id, complete]) =>
      [id, { bookId: id, complete, pages: [], error: complete ? null : { status: 503, message: '岸站正在归档' }, pagesFetched: 1, next: complete ? null: 'next23' }])),
    shift,
    bankBook,
  };
}

test('重点段须两岸各自有 clear 观察，缺一岸即未齐', () => {
  const ctx = rowsToCtx([
    { id: 'N1', at: '2026-11-23T06:20:00+08:00', fromM: 0, toM: 160, bank: '北', quality: 'clear' },
  ], { north: true, south: true });
  const result = adjudicateSlice({ from: 0, to: 160, group: '北班', banks: ['北', '南'] }, ctx);
  assert.equal(result.fullyCovered, false);
  const south = result.banks.find(b => b.bank === '南');
  assert.equal(south.fullyCovered, false);
  assert.deepEqual(south.missing['no-valid-observation'], [{ from: 0, to: 160 }]);
});

test('两岸齐备时重点段覆盖齐备', () => {
  const ctx = rowsToCtx([
    { id: 'N1', at: '2026-11-23T06:20:00+08:00', fromM: 0, toM: 160, bank: '北', quality: 'clear' },
    { id: 'S1', at: '2026-11-23T06:40:00+08:00', fromM: 0, toM: 160, bank: '南', quality: 'clear' },
  ], { north: true, south: true });
  const result = adjudicateSlice({ from: 0, to: 160, group: '北班', banks: ['北', '南'] }, ctx);
  assert.equal(result.fullyCovered, true);
});

test('低能见度只作现场观察，不证明覆盖', () => {
  const ctx = rowsToCtx([
    { id: 'N1', at: '2026-11-23T06:20:00+08:00', fromM: 0, toM: 160, bank: '北', quality: 'poor' },
  ], { north: true, south: true });
  const result = adjudicateSlice({ from: 0, to: 160, group: '北班', banks: ['北'] }, ctx);
  assert.equal(result.fullyCovered, false);
  assert.deepEqual(result.banks[0].missing['no-valid-observation'], [{ from: 0, to: 160 }]);
  assert.equal(result.banks[0].proofs[0].quality, 'poor');
  assert.equal(result.banks[0].proofs[0].proves, false);
});

test('分页未取全且无定论时记 pickup-incomplete，不得宣告无记录', () => {
  const ctx = rowsToCtx([], { north: true, south: false });
  const result = adjudicateSlice({ from: 160, to: 260, group: '南班', banks: ['南'] }, ctx);
  const south = result.banks.find(b => b.bank === '南');
  assert.equal(result.pickupIncomplete, true);
  assert.deepEqual(south.missing['pickup-incomplete'], [{ from: 160, to: 260 }]);
  assert.equal(south.missing['no-valid-observation'].length, 0);
});

test('站点签发空窗明确进入缺测清单，优先级高于取件未全', () => {
  const ctx = rowsToCtx([
    { id: 'G1', kind: 'confirmed-gap', at: '2026-11-23T07:28:00+08:00', fromM: 0, toM: 20, bank: '南' },
  ], { north: true, south: false });
  const result = adjudicateSlice({ from: 0, to: 160, group: '北班', banks: ['南'] }, ctx);
  assert.deepEqual(result.banks[0].missing['confirmed-gap'], [{ from: 0, to: 20 }]);
  assert.deepEqual(result.banks[0].missing['pickup-incomplete'], [{ from: 20, to: 160 }]);
});

test('replaces 更正只在更正里程内使旧 clear 失效；poor 更正导致覆盖退化', () => {
  const ctx = rowsToCtx([
    { id: 'N11', at: '2026-11-23T06:20:00+08:00', fromM: 80, toM: 190, bank: '北', quality: 'clear' },
    { id: 'N12', at: '2026-11-23T06:20:00+08:00', fromM: 135, toM: 190, bank: '北', quality: 'poor', replaces: 'N11' },
  ], { north: true, south: true });
  const result = adjudicateSlice({ from: 80, to: 190, group: '北班', banks: ['北'] }, ctx);
  // [80,135) 仍由 N11 证明；[135,190) 被 poor 的 N12 取代，无有效观察
  assert.deepEqual(result.banks[0].covered, [{ from: 80, to: 135 }]);
  assert.deepEqual(result.banks[0].missing['no-valid-observation'], [{ from: 135, to: 190 }]);
  const proof = result.banks[0].proofs.find(p => p.observationId === 'N11');
  assert.deepEqual(proof.effectiveParts, [{ from: 80, to: 135 }]);
  assert.deepEqual(proof.supersededParts.map(s => [s.by, s.interval.from, s.interval.to]),
    [['N12', 135, 190]]);
});

test('窗外记录保留但不证明本窗覆盖', () => {
  const ctx = rowsToCtx([
    { id: 'OLD', at: '2026-11-23T05:00:00+08:00', fromM: 0, toM: 160, bank: '北', quality: 'clear' },
  ], { north: true, south: true });
  const result = adjudicateSlice({ from: 0, to: 160, group: '北班', banks: ['北'] }, ctx);
  assert.equal(result.fullyCovered, false);
  assert.equal(result.banks[0].proofs[0].inWindow, false);
});

test('跨边界观察按切片裁剪后只在相交部分作证', () => {
  const ctx = rowsToCtx([
    { id: 'N11', at: '2026-11-23T06:20:00+08:00', fromM: 80, toM: 190, bank: '北', quality: 'clear' },
  ], { north: true, south: true });
  const result = adjudicateSlice({ from: 125, to: 195, group: '机巡班', banks: ['北'] }, ctx);
  assert.deepEqual(result.banks[0].covered, [{ from: 125, to: 190 }]);
  assert.deepEqual(result.banks[0].missing['no-valid-observation'], [{ from: 190, to: 195 }]);
});
