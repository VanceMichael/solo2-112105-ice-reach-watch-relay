// 河轴里程区间工具。全项目统一采用左闭右开 [from, to)，单位为米（与调度 axisUnit 一致）。

/** 解析里程数；接受数字或可去空白的字符串（如 "K1+250" 以后再扩展，当前为纯米数）。 */
export function parseM(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const text = value.trim();
    const n = Number(text);
    if (Number.isFinite(n)) return n;
  }
  throw new TypeError(`无法解析的里程值: ${String(value)}`);
}

/** 规范化一个区间，保证 from < to 且为有限数。 */
export function asInterval(from, to) {
  const start = parseM(from);
  const end = parseM(to);
  if (!(end > start)) throw new RangeError(`区间无效: [${from}, ${to})，要求 from < to`);
  return { from: start, to: end };
}

/** 两区间交集；不相交返回 null（端点相接视为不相交，因为左闭右开下没有公共点）。 */
export function intersect(a, b) {
  const from = Math.max(a.from, b.from);
  const to = Math.min(a.to, b.to);
  return to > from ? { from, to } : null;
}

export function contains(interval, point) {
  const p = parseM(point);
  return p >= interval.from && p < interval.to;
}

/** a − b：从 a 中扣除 b 覆盖的部分，返回 0~2 个不相交区间。 */
export function subtract(a, b) {
  const hit = intersect(a, b);
  if (!hit) return [{ ...a }];
  const out = [];
  if (a.from < hit.from) out.push({ from: a.from, to: hit.from });
  if (hit.to < a.to) out.push({ from: hit.to, to: a.to });
  return out;
}

/** 从 base 中扣除全部 cutters，返回剩余的不相交区间列表（已合并相邻片段）。 */
export function subtractAll(base, cutters) {
  let rest = [{ ...base }];
  for (const cutter of cutters) {
    rest = rest.flatMap(piece => subtract(piece, cutter));
  }
  return merge(rest);
}

/** 合并相交或相邻的区间。 */
export function merge(intervals) {
  const sorted = intervals
    .map(iv => asInterval(iv.from, iv.to))
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.from <= last.to) last.to = Math.max(last.to, iv.to);
    else out.push({ ...iv });
  }
  return out;
}

/** 总长度。 */
export function totalLength(intervals) {
  return intervals.reduce((sum, iv) => sum + (iv.to - iv.from), 0);
}

/** 人类可读的里程区间，如 [125,195)。 */
export function formatInterval(iv) {
  return `[${iv.from},${iv.to})`;
}

/** 把一组区间格式化为字符串。 */
export function formatIntervals(intervals) {
  if (!intervals.length) return '无';
  return intervals.map(formatInterval).join('、');
}
