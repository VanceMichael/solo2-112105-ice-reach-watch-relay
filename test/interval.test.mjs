import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  intersect, subtract, subtractAll, merge, contains, asInterval,
} from '../src/domain/interval.mjs';

test('区间：左闭右开下端点相接不算相交', () => {
  assert.deepEqual(intersect({ from: 0, to: 160 }, { from: 160, to: 260 }), null);
  assert.ok(contains({ from: 0, to: 160 }, 0));
  assert.ok(contains({ from: 0, to: 160 }, 159.9));
  assert.equal(contains({ from: 0, to: 160 }, 160), false);
});

test('区间：减法与多片段扣除', () => {
  assert.deepEqual(subtract({ from: 0, to: 100 }, { from: 40, to: 60 }),
    [{ from: 0, to: 40 }, { from: 60, to: 100 }]);
  assert.deepEqual(subtractAll({ from: 0, to: 100 }, [{ from: 20, to: 30 }, { from: 70, to: 110 }]),
    [{ from: 0, to: 20 }, { from: 30, to: 70 }]);
  assert.deepEqual(merge([{ from: 0, to: 10 }, { from: 10, to: 20 }, { from: 25, to: 30 }]),
    [{ from: 0, to: 20 }, { from: 25, to: 30 }]);
});

test('区间：非法区间直接报错', () => {
  assert.throws(() => asInterval(100, 100), /from < to/);
  assert.throws(() => asInterval('x', 10), /无法解析/);
});
