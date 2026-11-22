// 责任线解析。调度源发布带生效时间的起始班表与临时改派，
// 河心观察线以同一河轴里程标识，班组（行政区名称只用来找班组）在时间轴上分段担责。

import { asInterval, intersect, merge } from './interval.mjs';
import { parseTime } from './time.mjs';

/**
 * 由起始责任表 + 临时改派，构造换班判定时刻 at 的责任切片。
 * 改派从其 effective 时刻起替代对应区间的责任表（含岸别要求）。
 *
 * @returns 责任切片数组，按里程升序，互不重叠：
 *   { from,to,group,banks,source:{kind:'responsibility'|'reassignment',ref} }
 */
export function resolveSlices(boundary, at) {
  const point = parseTime(at);
  const baseLines = boundary.responsibility.map((line, i) => ({
    ...asInterval(line.start, line.end),
    group: line.group,
    banks: [...line.banks],
    source: { kind: 'responsibility', ref: `责任线#${i}` },
  }));

  const activeReassign = (boundary.reassignments ?? [])
    .filter(r => parseTime(r.effective) <= point)
    .map((r, i) => ({
      ...asInterval(r.fromM, r.toM),
      group: r.group,
      banks: [...r.banks],
      effective: parseTime(r.effective),
      source: { kind: 'reassignment', ref: `改派#${i}（${r.group}）` },
    }))
    // 同一里程后生效的改派优先
    .sort((a, b) => a.from - b.from || b.effective - a.effective);

  // 用所有边界点把河轴切成微段，再逐微段决定担责来源
  const cuts = new Set();
  for (const line of baseLines) { cuts.add(line.from); cuts.add(line.to); }
  for (const r of activeReassign) { cuts.add(r.from); cuts.add(r.to); }
  const points = [...cuts].sort((a, b) => a - b);

  const micro = [];
  for (let i = 0; i < points.length - 1; i++) {
    micro.push({ from: points[i], to: points[i + 1] });
  }

  const slices = [];
  for (const m of micro) {
    const mid = (m.from + m.to) / 2;
    const reassignment = activeReassign.find(r => mid >= r.from && mid < r.to);
    if (reassignment) {
      slices.push({ ...m, group: reassignment.group, banks: [...reassignment.banks], source: reassignment.source });
      continue;
    }
    const line = baseLines.find(l => mid >= l.from && mid < l.to);
    if (line) {
      slices.push({ ...m, group: line.group, banks: [...line.banks], source: line.source });
    }
  }

  // 相邻且同班组、同岸别要求、同来源的微段合并，保持来源可追溯
  const merged = [];
  for (const s of slices) {
    const last = merged[merged.length - 1];
    if (last && last.to === s.from && last.group === s.group &&
        last.source.kind === s.source.kind && last.source.ref === s.source.ref &&
        sameBanks(last.banks, s.banks)) {
      last.to = s.to;
    } else {
      merged.push({ ...s, banks: [...s.banks] });
    }
  }
  return merged;
}

function sameBanks(a, b) {
  return a.length === b.length && a.every(x => b.includes(x));
}

/** 指定时刻指定里程点由谁担责；落在任何责任线之外返回 null。 */
export function responsibleAt(boundary, at, mileage) {
  const slices = resolveSlices(boundary, at);
  return slices.find(s => mileage >= s.from && mileage < s.to) ?? null;
}

/** 责任表覆盖的全里程范围。 */
export function responsibilitySpan(boundary) {
  return merge(boundary.responsibility.map(l => asInterval(l.start, l.end)));
}

/** 把一组区间裁剪到某个切片内。 */
export function clipToSlice(intervals, slice) {
  const out = [];
  for (const iv of intervals) {
    const hit = intersect(iv, slice);
    if (hit) out.push(hit);
  }
  return merge(out);
}
