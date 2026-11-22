import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveSlices, responsibleAt } from '../src/domain/responsibility.mjs';

const boundary = {
  responsibility: [
    { start: 0, end: 160, group: '北班', banks: ['北', '南'] },
    { start: 160, end: 260, group: '南班', banks: ['南'] },
  ],
  reassignments: [
    { fromM: 125, toM: 195, group: '机巡班', effective: '2026-11-23T07:30:00+08:00', banks: ['北', '南'] },
  ],
};

test('改派生效前按起始责任表切片', () => {
  const slices = resolveSlices(boundary, '2026-11-23T07:00:00+08:00');
  assert.deepEqual(slices.map(s => [s.from, s.to, s.group]),
    [[0, 160, '北班'], [160, 260, '南班']]);
  assert.deepEqual(responsibleAt(boundary, '2026-11-23T07:00:00+08:00', 150).banks, ['北', '南']);
});

test('改派生效后按生效区间替代，切片保留两岸要求', () => {
  const slices = resolveSlices(boundary, '2026-11-23T12:00:00+08:00');
  assert.deepEqual(slices.map(s => [s.from, s.to, s.group]),
    [[0, 125, '北班'], [125, 195, '机巡班'], [195, 260, '南班']]);
  const mid = responsibleAt(boundary, '2026-11-23T12:00:00+08:00', 150);
  assert.equal(mid.group, '机巡班');
  assert.deepEqual(mid.banks, ['北', '南']);
  assert.equal(mid.source.kind, 'reassignment');

  // 改派区间外仍为原责任表
  assert.equal(responsibleAt(boundary, '2026-11-23T12:00:00+08:00', 200).group, '南班');
  assert.equal(responsibleAt(boundary, '2026-11-23T12:00:00+08:00', 100).group, '北班');
});

test('责任线之外的里程无担责班组', () => {
  assert.equal(responsibleAt(boundary, '2026-11-23T12:00:00+08:00', 300), null);
});
