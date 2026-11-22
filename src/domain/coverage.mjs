// 覆盖判定（核心规则）。
//
// 判定口径：
//  - 重点河段（要求两岸）须本值班窗内两岸各自有有效观察；普通段按班令要求的岸别判断。
//  - quality=clear 才能证明覆盖；quality=poor 只留作现场观察。
//  - copyOf 转录在归一化阶段已并入同一 canonical 观察，不增加覆盖。
//  - replaces 更正：旧观察在“被更正条目覆盖的里程内”失效，跨出部分仍沿用；
//    更正件若为 poor，则该里程由 clear 退化为无有效观察（仅现场记录）。
//  - confirmed-gap 是站点签发的正式空窗，明确进入缺测清单。
//  - 分页未取全不得宣告无记录：相关簿未取全且无其他定论时记 pickup-incomplete。
//  - 观察时刻须落在值班窗内；窗外记录保留为现场观察，不证明本窗覆盖。

import { intersect, merge, subtractAll } from './interval.mjs';
import { parseTime } from './time.mjs';

/** 在某里程点解析一条 canonical 观察是否被更正链取代，返回当前生效的观察（可能是自身）。 */
function effectiveAtPoint(obs, point, replacementIndex, guard = new Set()) {
  if (guard.has(obs.id)) return obs; // 防御更正环
  guard.add(obs.id);
  const replacements = replacementIndex.get(obs.id);
  if (!replacements) return obs;
  const hit = replacements.find(r => point >= r.interval.from && point < r.interval.to);
  if (!hit) return obs;
  return effectiveAtPoint(hit, point, replacementIndex, guard);
}

/** 取一条观察在某区间内“仍生效”的部分（扣除所有更正件覆盖的里程，含链式更正）。 */
export function effectivePart(obs, within, replacementIndex, seen = new Set()) {
  if (seen.has(obs.id)) return intersect(obs.interval, within) ? [intersect(obs.interval, within)] : [];
  seen.add(obs.id);
  const own = intersect(obs.interval, within);
  if (!own) return [];
  const cutters = [];
  for (const rep of replacementIndex.get(obs.id) ?? []) {
    const hit = intersect(rep.interval, own);
    if (hit) cutters.push(hit);
  }
  return subtractAll(own, cutters);
}

/** 取一条观察在某区间内“已被哪条更正取代”的明细，供报告追溯。 */
export function supersededParts(obs, within, replacementIndex) {
  const own = intersect(obs.interval, within);
  if (!own) return [];
  const out = [];
  for (const rep of replacementIndex.get(obs.id) ?? []) {
    const hit = intersect(rep.interval, own);
    if (hit) {
      out.push({ by: rep.id, interval: hit, quality: rep.quality, at: rep.at });
    }
  }
  return out;
}

function inWindow(at, shift) {
  return at >= parseTime(shift.start) && at < parseTime(shift.end);
}

/**
 * 判定一个责任切片的覆盖情况。
 *
 * @param slice 责任切片 {from,to,group,banks}
 * @param ctx { observations: canonical[], gaps: normalized gap[], replacementIndex,
 *              pickups: Map<bookId,BookPickup>, shift, bankBook: {北:'north',南:'south'} }
 */
export function adjudicateSlice(slice, ctx) {
  const { observations, gaps, replacementIndex, pickups, shift, bankBook } = ctx;
  const relevant = observations
    .map(obs => ({ obs, hit: intersect(obs.interval, slice) }))
    .filter(x => x.hit);
  const relevantGaps = gaps
    .map(g => ({ gap: g, hit: intersect(g.interval, slice) }))
    .filter(x => x.hit);

  // 收集切片内全部断点，用微段保证每段内结论恒定
  const cuts = new Set([slice.from, slice.to]);
  for (const { hit } of relevant) { cuts.add(hit.from); cuts.add(hit.to); }
  for (const { hit } of relevantGaps) { cuts.add(hit.from); cuts.add(hit.to); }
  const points = [...cuts].sort((a, b) => a - b);

  const bankResults = slice.banks.map(bank => {
    const bookId = bankBook[bank];
    const pickup = pickups.get(bookId);
    const pickupIncomplete = !pickup || !pickup.complete;
    const bankObs = relevant.filter(({ obs }) => obs.bank === bank);
    const bankGaps = relevantGaps.filter(({ gap }) => gap.bank === bank);

    const buckets = {
      'confirmed-gap': [],
      'pickup-incomplete': [],
      'no-valid-observation': [],
    };
    const coveredMicro = [];

    for (let i = 0; i < points.length - 1; i++) {
      const micro = { from: points[i], to: points[i + 1] };
      const mid = (micro.from + micro.to) / 2;

      const signedGap = bankGaps.some(({ hit }) => mid >= hit.from && mid < hit.to);
      if (signedGap) {
        buckets['confirmed-gap'].push(micro);
        continue;
      }

      // 找该点生效且能证明覆盖的观察：窗内、clear、未被更正为失效/低能见度
      let proven = false;
      for (const { obs } of bankObs) {
        if (!(mid >= obs.interval.from && mid < obs.interval.to)) continue;
        if (!inWindow(obs.at, shift)) continue;
        const effective = effectiveAtPoint(obs, mid, replacementIndex);
        if (effective.quality === 'clear' && inWindow(effective.at, shift)) {
          proven = true;
          break;
        }
      }

      if (proven) {
        coveredMicro.push(micro);
      } else if (pickupIncomplete) {
        buckets['pickup-incomplete'].push(micro);
      } else {
        buckets['no-valid-observation'].push(micro);
      }
    }

    const covered = merge(coveredMicro);
    const missing = {
      'confirmed-gap': merge(buckets['confirmed-gap']),
      'pickup-incomplete': merge(buckets['pickup-incomplete']),
      'no-valid-observation': merge(buckets['no-valid-observation']),
    };

    // 证明与现场观察明细（裁剪到切片，标注生效/被取代部分）
    const proofs = bankObs.map(({ obs }) => buildProof(obs, slice, replacementIndex, shift));
    const signedGaps = bankGaps.map(({ gap, hit }) => ({
      id: gap.id, stationId: gap.stationId, bookId: gap.bookId, at: gap.at, interval: hit,
    }));

    return {
      bank,
      bookId,
      pickupComplete: !pickupIncomplete,
      pickupError: pickup?.error ?? null,
      covered,
      missing,
      proofs,
      signedGaps,
      fullyCovered: covered.length > 0 &&
        Object.values(missing).every(list => list.length === 0),
    };
  });

  return {
    slice,
    banks: bankResults,
    fullyCovered: bankResults.every(b => b.fullyCovered),
    pickupIncomplete: bankResults.some(b => !b.pickupComplete),
  };
}

function buildProof(obs, slice, replacementIndex, shift) {
  const within = intersect(obs.interval, slice);
  const effective = merge(effectivePart(obs, within, replacementIndex));
  const superseded = supersededParts(obs, within, replacementIndex);
  return {
    observationId: obs.id,
    bank: obs.bank,
    at: obs.at,
    inWindow: inWindow(obs.at, shift),
    quality: obs.quality,
    interval: within,
    effectiveParts: effective,
    supersededParts: superseded,
    sources: obs.sources,
    danglingTranscript: obs.danglingTranscript,
    // 能否在其生效里程内证明覆盖：窗内且 clear
    proves: inWindow(obs.at, shift) && obs.quality === 'clear' && effective.length > 0,
  };
}

/**
 * 单点判定：某里程点在某时刻的覆盖结论，供交接查询。
 * 返回每个要求岸别的状态与凭证；不依赖责任切片时可显式传 banks。
 */
export function adjudicatePoint(point, at, ctx, banks) {
  const pseudoSlice = { from: point, to: point + 1, banks, group: null };
  const result = adjudicateSlice(pseudoSlice, ctx);
  const statusOf = missing => {
    if (missing['confirmed-gap'].length) return 'confirmed-gap';
    if (missing['pickup-incomplete'].length) return 'pickup-incomplete';
    if (missing['no-valid-observation'].length) return 'no-valid-observation';
    return 'covered';
  };
  return {
    at: parseTime(at),
    point,
    banks: result.banks.map(b => ({
      bank: b.bank,
      bookId: b.bookId,
      pickupComplete: b.pickupComplete,
      pickupError: b.pickupError,
      status: b.covered.length ? 'covered' : statusOf(b.missing),
      proofs: b.proofs
        .filter(p => p.interval && point >= p.interval.from && point < p.interval.to)
        .map(p => ({
          observationId: p.observationId,
          quality: p.quality,
          at: p.at,
          inWindow: p.inWindow,
          proves: p.proves && p.effectiveParts.some(iv => point >= iv.from && point < iv.to),
          supersededHere: p.supersededParts.some(iv => point >= iv.interval.from && point < iv.interval.to),
          sources: p.sources,
        })),
      signedGaps: b.signedGaps.filter(g => point >= g.interval.from && point < g.interval.to),
    })),
  };
}
