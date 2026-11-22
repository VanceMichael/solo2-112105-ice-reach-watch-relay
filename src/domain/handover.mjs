// 交接判定：请求范围、接班回执、旧班延续、事后更正重判与补查责任。
//
// 关键纪律：
//  - 改派不会让新责任人在没有交接回执时被默认为已接手；
//  - 接班员可确认整段或只接一部分（回执范围是请求范围的子集）；
//  - 旧班的延续范围不能掩盖新辖段缺了一岸观察（覆盖缺口始终单列）；
//  - 回执发出后的补交 poor 记录只作现场观察；明确更正交接所用有效记录时，
//    当前覆盖重判、接管仍留存，并对指定里程新增补查责任。

import { intersect, merge, subtractAll, formatInterval } from './interval.mjs';
import { parseTime } from './time.mjs';

function clip(interval, slice) {
  return intersect(interval, slice);
}

/**
 * 计算一个切片上的接管情况。
 * @returns { requested:区间[], receipts:[{receipt,interval}], takenByIncoming:区间[],
 *            notTaken:区间[], status:'none'|'partial'|'complete' }
 */
export function resolveTakeover(slice, requests, receipts) {
  const groupRequests = requests
    .filter(r => r.group === slice.group)
    .map(r => clip(r, slice))
    .filter(Boolean);
  const requested = merge(groupRequests);

  const groupReceipts = receipts
    .filter(r => r.group === slice.group)
    .map(r => ({ receipt: r, interval: clip(r, slice) }))
    .filter(x => x.interval);
  const taken = merge(groupReceipts.map(x => x.interval));

  const notTaken = subtractAll(slice, taken);
  let status = 'none';
  if (taken.length) {
    const wholeCovered = merge([...taken, ...notTaken]).length === taken.length &&
      taken.some(iv => iv.from === slice.from && iv.to === slice.to);
    status = wholeCovered ? 'complete' : 'partial';
  }
  return { requested, receipts: groupReceipts, takenByIncoming: taken, notTaken, status };
}

/**
 * 旧班延续：切片上未被新班回执确认的区间，应由旧班继续值守到交接齐备。
 * 旧班逐区间按“换班窗前的责任表”确定（改派区间可能横跨多条原责任线），
 * 因此先用原责任线边界细分未接区间，再逐段标注旧班；
 * 没有请求覆盖的区间原因是无交接请求，有请求但无回执的原因是回执未发出。
 *
 * @param previousOf 以里程点返回班开始时担责班组的函数
 * @param previousCuts 班开始时责任表的边界点（含切片两端）
 */
export function resolveContinuation(slice, takeover, previousOf, requests, previousCuts = []) {
  if (!takeover.notTaken.length) return [];
  const requestedHere = merge(requests
    .filter(r => r.group === slice.group)
    .map(r => clip(r, slice))
    .filter(Boolean));

  const cuts = new Set([slice.from, slice.to, ...previousCuts]);
  const points = [...cuts].filter(p => p > slice.from && p < slice.to).sort((a, b) => a - b);
  const boundaries = [slice.from, ...points, slice.to];

  const out = [];
  for (const iv of takeover.notTaken) {
    for (let i = 0; i < boundaries.length - 1; i++) {
      const seg = { from: Math.max(iv.from, boundaries[i]), to: Math.min(iv.to, boundaries[i + 1]) };
      if (!(seg.to > seg.from)) continue;
      const coveredByRequest = requestedHere.some(r => intersect(r, seg));
      out.push({
        interval: seg,
        oldGroup: previousOf((seg.from + seg.to) / 2) ?? slice.group,
        reason: coveredByRequest ? '回执未发出，旧班继续值守' : '无交接请求，旧班继续值守',
      });
    }
  }
  return out;
}

/**
 * 事后更正重判。
 * 对每条带 replaces 的观察，若它晚于某张已发回执、且更正到该回执所依据的观察编号，
 * 则在回执确认范围与更正里程的交集上生成补查责任；接管回执本身保留不撤销。
 *
 * @returns { rechecks:[{group,interval,receiptId,correctionId,supersededId,quality,reason}],
 *            affectedReceipts:Set }
 */
export function resolveRechecks(slices, receipts, canonicalObservations, now) {
  const rechecks = [];
  const affectedReceipts = new Set();
  const corrections = canonicalObservations.filter(o => o.replaces);

  for (const correction of corrections) {
    const isLate = correction.at > now.receiptCutoff;
    for (const receipt of receipts) {
      const basedOn = new Set(receipt.basedOn ?? []);
      if (!basedOn.has(correction.replaces)) continue;

      // 补查里程 = 更正里程 ∩ 回执确认范围 ∩ 该班组当前责任切片
      const slice = slices.find(s => s.group === receipt.group && intersect(s, correction.interval));
      if (!slice) continue;
      const withinReceipt = intersect(correction.interval, receipt);
      const interval = withinReceipt ? intersect(withinReceipt, slice) : null;
      if (!interval) continue;

      affectedReceipts.add(receipt.id);
      rechecks.push({
        group: receipt.group,
        interval,
        receiptId: receipt.id,
        correctionId: correction.id,
        supersededId: correction.replaces,
        quality: correction.quality,
        late: isLate,
        reason: isLate
          ? `回执 ${receipt.id} 发出后收到更正 ${correction.id}（${correction.quality === 'poor' ? '低能见度' : correction.quality}），覆盖已重判，接管留存，需补查`
          : `回执 ${receipt.id} 依据的 ${correction.replaces} 被 ${correction.id} 更正，需补查`,
      });
    }
  }
  return { rechecks, affectedReceipts };
}

/** 现场观察清单：所有不（再）能证明覆盖、但必须留档的记录及原因。 */
export function collectFieldObservations(canonicalObservations, ctx, now) {
  const { shift, replacementIndex } = ctx;
  const out = [];
  for (const obs of canonicalObservations) {
    const reasons = [];
    const inWindow = obs.at >= parseTime(shift.start) && obs.at < parseTime(shift.end);
    if (!inWindow) reasons.push('窗外记录');
    if (obs.quality === 'poor') reasons.push('低能见度，仅现场记录');
    if (obs.danglingTranscript) reasons.push('悬挂转录，无原件');
    const superseded = replacementIndex.has(obs.id)
      ? replacementIndex.get(obs.id).map(r => `${r.id} 更正 ${formatInterval(intersect(r.interval, obs.interval) ?? r.interval)}`).join('；')
      : null;
    if (superseded) reasons.push(`部分里程已被取代：${superseded}`);
    const isTranscriptOnly = obs.sources.length > 0 && obs.sources.every(s => s.role === 'transcript');
    if (isTranscriptOnly && !obs.danglingTranscript) reasons.push('仅转录件，覆盖归原件');

    const lateAfterCutoff = obs.at > now.receiptCutoff;
    if (lateAfterCutoff && !obs.replaces) reasons.push('回执发出后补交，仅作现场观察保留');

    out.push({
      id: obs.id,
      bank: obs.bank,
      at: obs.at,
      quality: obs.quality,
      interval: obs.interval,
      sources: obs.sources,
      replaces: obs.replaces,
      reasons,
      retained: true, // 规则要求：补交记录只当现场观察保留，不删除
    });
  }
  return out;
}
