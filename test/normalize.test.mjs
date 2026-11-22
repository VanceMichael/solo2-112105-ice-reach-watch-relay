import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeRow, canonize, findAlias, buildReplacementIndex } from '../src/domain/normalize.mjs';

const aliases = [{
  alias: '南一旧', post: '南一', deltaM: 12,
  fromTime: '2026-11-23T00:00:00+08:00',
  toTime: '2026-11-23T07:30:00+08:00',
}];

test('哨点别名里程修订只在声明时段内适用', () => {
  const inside = normalizeRow({
    id: 'S22', at: '2026-11-23T07:00:00+08:00', fromM: 208, toM: 248,
    bank: '南', quality: 'clear', post: '南一旧',
  }, 'south', 'south', aliases);
  assert.deepEqual(inside.interval, { from: 220, to: 260 });
  assert.deepEqual(inside.recordedInterval, { from: 208, to: 248 });
  assert.deepEqual(inside.aliasApplied, { alias: '南一旧', post: '南一', deltaM: 12 });

  const atBoundary = normalizeRow({
    id: 'S22b', at: '2026-11-23T07:30:00+08:00', fromM: 208, toM: 248,
    bank: '南', quality: 'clear', post: '南一旧',
  }, 'south', 'south', aliases);
  assert.deepEqual(atBoundary.interval, { from: 208, to: 248 }); // 右开，07:30 已失效
  assert.equal(atBoundary.aliasApplied, null);

  assert.equal(findAlias('南一旧', Date.parse('2026-11-23T07:29:59+08:00'), aliases)?.deltaM, 12);
  assert.equal(findAlias('南一', Date.parse('2026-11-23T07:00:00+08:00'), aliases), null);
});

test('跨岸转录归并为同一观察，不增加覆盖', () => {
  const records = [
    normalizeRow({
      id: 'S21', at: '2026-11-23T06:41:00+08:00', fromM: 20, toM: 220,
      bank: '南', quality: 'clear', post: '南一',
    }, 'south', 'south', aliases),
    normalizeRow({
      id: 'N15', at: '2026-11-23T07:15:00+08:00', fromM: 80, toM: 120,
      bank: '北', quality: 'clear', post: '北二', copyOf: 'S21',
    }, 'north', 'north', aliases),
  ];
  const { observations } = canonize(records);
  assert.equal(observations.length, 1);
  const canonical = observations[0];
  assert.equal(canonical.id, 'S21');
  assert.equal(canonical.bank, '南'); // 覆盖归南岸原件，不变成北岸观察
  assert.deepEqual(canonical.sources.map(s => s.role), ['original', 'transcript']);
  assert.deepEqual(canonical.sources.map(s => s.stationId), ['south', 'north']);
});

test('悬挂转录保留为独立现场观察并标记', () => {
  const { observations } = canonize([
    normalizeRow({
      id: 'X9', at: '2026-11-23T07:00:00+08:00', fromM: 0, toM: 10,
      bank: '北', quality: 'clear', post: '北二', copyOf: 'GHOST',
    }, 'north', 'north', []),
  ]);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].danglingTranscript, true);
});

test('confirmed-gap 归一化为空窗而非观察', () => {
  const gap = normalizeRow({
    id: 'S25', kind: 'confirmed-gap', at: '2026-11-23T07:28:00+08:00',
    fromM: 0, toM: 20, bank: '南', post: '南一',
  }, 'south', 'south', aliases);
  assert.equal(gap.type, 'confirmed-gap');
  const { observations, gaps } = canonize([gap]);
  assert.equal(observations.length, 0);
  assert.equal(gaps.length, 1);
});

test('更正索引建立 replaces 关系', () => {
  const { observations } = canonize([
    normalizeRow({ id: 'N11', at: '2026-11-23T06:20:00+08:00', fromM: 80, toM: 190, bank: '北', quality: 'clear', post: '北二' }, 'north', 'north', []),
    normalizeRow({ id: 'N12', at: '2026-11-23T06:20:00+08:00', fromM: 135, toM: 190, bank: '北', quality: 'poor', post: '北二', replaces: 'N11' }, 'north', 'north', []),
  ]);
  const index = buildReplacementIndex(observations);
  assert.deepEqual(index.get('N11').map(r => r.id), ['N12']);
});
