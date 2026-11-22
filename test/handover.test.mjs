import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveTakeover, resolveContinuation, resolveRechecks } from '../src/domain/handover.mjs';

const slice = { from: 125, to: 195, group: '机巡班', banks: ['北', '南'] };
const requests = [{ group: '机巡班', from: 145, to: 175 }];

test('无回执时改派不等于接手，整段进入旧班延续', () => {
  const takeover = resolveTakeover(slice, requests, []);
  assert.equal(takeover.status, 'none');
  assert.deepEqual(takeover.notTaken, [{ from: 125, to: 195 }]);
  const continuation = resolveContinuation(slice, takeover, () => '北班', requests);
  assert.deepEqual(continuation.map(c => [c.interval.from, c.interval.to, c.oldGroup]),
    [[125, 195, '北班']]);
  assert.match(continuation[0].reason, /无交接请求|回执未发出/);
});

test('接班员只接一部分时状态为 partial，未接区间仍由旧班值守', () => {
  const receipts = [{ id: 'R01', group: '机巡班', from: 145, to: 160, to2: undefined, issuedAt: 1, basedOn: ['N11'] }];
  const takeover = resolveTakeover(slice, requests, receipts);
  assert.equal(takeover.status, 'partial');
  assert.deepEqual(takeover.takenByIncoming, [{ from: 145, to: 160 }]);
  const continuation = resolveContinuation(slice, takeover, () => '北班', requests);
  // [125,145) 无请求；[160,195) 在请求范围内但回执未覆盖
  assert.deepEqual(continuation.map(c => [c.interval.from, c.interval.to]),
    [[125, 145], [160, 195]]);
  assert.match(continuation[0].reason, /无交接请求/);
  assert.match(continuation[1].reason, /回执未发出/);
});

test('整段确认后无旧班延续', () => {
  const receipts = [{ id: 'R01', group: '机巡班', from: 125, to: 195, issuedAt: 1, basedOn: ['N11'] }];
  const takeover = resolveTakeover(slice, requests, receipts);
  assert.equal(takeover.status, 'complete');
  assert.deepEqual(takeover.notTaken, []);
  assert.deepEqual(resolveContinuation(slice, takeover, () => '北班', requests), []);
});

test('事后更正交接依据：重判并新增补查，回执仍留存', () => {
  const receipts = [{
    id: 'R01', group: '机巡班', from: 125, to: 195,
    issuedAt: Date.parse('2026-11-23T11:00:00+08:00'), basedOn: ['N11'],
  }];
  const observations = [
    { id: 'N11', interval: { from: 80, to: 190 }, replaces: null, at: Date.parse('2026-11-23T06:20:00+08:00'), quality: 'clear', sources: [] },
    { id: 'N12', interval: { from: 135, to: 190 }, replaces: 'N11', at: Date.parse('2026-11-23T11:30:00+08:00'), quality: 'poor', sources: [] },
  ];
  const { rechecks, affectedReceipts } = resolveRechecks([slice], receipts, observations, {
    receiptCutoff: Date.parse('2026-11-23T11:10:00+08:00'),
  });
  assert.equal(rechecks.length, 1);
  assert.deepEqual(rechecks[0].interval, { from: 135, to: 190 });
  assert.equal(rechecks[0].group, '机巡班');
  assert.equal(rechecks[0].late, true);
  assert.ok(affectedReceipts.has('R01'));
});

test('补交记录若未更正交接依据，不产生补查责任', () => {
  const receipts = [{
    id: 'R01', group: '机巡班', from: 125, to: 195,
    issuedAt: Date.parse('2026-11-23T11:00:00+08:00'), basedOn: ['N11'],
  }];
  const observations = [
    { id: 'N11', interval: { from: 80, to: 190 }, replaces: null, at: 1, quality: 'clear', sources: [] },
    { id: 'N14', interval: { from: 190, to: 225 }, replaces: null, at: Date.parse('2026-11-23T11:30:00+08:00'), quality: 'poor', sources: [] },
  ];
  const { rechecks } = resolveRechecks([slice], receipts, observations, {
    receiptCutoff: Date.parse('2026-11-23T11:10:00+08:00'),
  });
  assert.deepEqual(rechecks, []);
});
