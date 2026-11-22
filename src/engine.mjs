// 换班引擎：把一次采集快照 + 交接请求/回执，裁成语义化的换班报告与单点查询结论。

import { asInterval, intersect, merge } from './domain/interval.mjs';
import { parseTime, formatClock } from './domain/time.mjs';
import { canonize, normalizeRow, buildReplacementIndex } from './domain/normalize.mjs';
import { resolveSlices, responsibleAt, responsibilitySpan } from './domain/responsibility.mjs';
import { adjudicateSlice, adjudicatePoint } from './domain/coverage.mjs';
import { resolveTakeover, resolveContinuation, resolveRechecks, collectFieldObservations } from './domain/handover.mjs';

const BANK_BOOK = { 北: 'north', 南: 'south' };
const BOOK_BANK = { north: '北', south: '南' };

// 便利再导出，外部只需从 engine 一处引用
export {
  asInterval, intersect, merge,
  formatInterval, formatIntervals, totalLength,
} from './domain/interval.mjs';
export { formatClock } from './domain/time.mjs';
export { BOOK_BANK };

/** 归一化整本快照（应用别名修订、归并转录、建立更正索引）。 */
export function buildContext(snapshot, shift) {
  const aliases = snapshot.posts?.aliases ?? [];
  const allRecords = [];
  for (const [bookId, pickup] of snapshot.books) {
    for (const page of pickup.pages) {
      for (const row of page.rows) {
        allRecords.push(normalizeRow(row, bookId, pickup.stationId ?? bookId, aliases));
      }
    }
  }
  const { observations, gaps } = canonize(allRecords);
  const replacementIndex = buildReplacementIndex(observations);
  return { observations, gaps, replacementIndex, aliases, shift, bankBook: BANK_BOOK };
}

/**
 * 生成换班报告。
 * @param snapshot SourceSnapshot
 * @param options { shift, at(判定时刻，默认班末), requests:[{group,fromM,toM}],
 *                   receipts: ReceiptLedger 回执数组, receiptCutoff: 回执基准时刻 }
 */
export function buildReport(snapshot, options = {}) {
  if (!snapshot.boundary) {
    return {
      ok: false,
      errors: [snapshot.boundaryError?.message ?? '缺少调度责任线，无法判定'].filter(Boolean),
      generatedAt: Date.now(),
    };
  }
  const boundary = snapshot.boundary;
  const shift = options.shift ?? boundary.shifts[0];
  const at = parseTime(options.at ?? shift.end);
  const cutoff = parseTime(options.receiptCutoff ?? at);
  const requests = (options.requests ?? []).map(r => ({
    group: r.group,
    ...asInterval(r.fromM ?? r.from, r.toM ?? r.to),
    id: r.id ?? null,
  }));
  const receipts = (options.receipts ?? []).map(r => ({
    ...r,
    ...asInterval(r.from ?? r.fromM, r.to ?? r.toM),
    issuedAt: parseTime(r.issuedAt),
  }));

  const ctx = buildContext(snapshot, shift);
  const slices = resolveSlices(boundary, at);
  const span = responsibilitySpan(boundary);

  const sections = slices.map(slice => {
    const coverageCtx = { ...ctx, pickups: snapshot.books };
    const judged = adjudicateSlice(slice, coverageCtx);
    const takeover = resolveTakeover(slice, requests, receipts);

    // 旧班组逐区间按换班开始时刻的责任表确定（改派区间可横跨原北班/南班责任线）
    const previousOf = point => responsibleAt(boundary, shift.start, point)?.group ?? null;
    const previousCuts = boundary.responsibility.flatMap(l => [l.start, l.end]);
    const continuation = resolveContinuation(slice, takeover, previousOf, requests, previousCuts);

    return {
      slice,
      coverage: judged,
      takeover,
      continuation,
    };
  });

  const now = { receiptCutoff: cutoff };
  const { rechecks, affectedReceipts } = resolveRechecks(slices, receipts, ctx.observations, now);
  const fieldObservations = collectFieldObservations(ctx.observations, ctx, now);

  // 责任表之外的请求（找不到任何切片承接）
  const danglingRequests = requests.filter(req =>
    !slices.some(s => s.group === req.group && intersect(s, req)));

  const missingList = buildMissingList(sections);
  const summary = buildSummary(sections);

  return {
    ok: true,
    generatedAt: Date.now(),
    releaseName: snapshot.releaseName,
    river: boundary.river,
    shift: { id: shift.id, start: parseTime(shift.start), end: parseTime(shift.end) },
    judgedAt: at,
    receiptCutoff: cutoff,
    pickup: summarizePickup(snapshot),
    span,
    slices: sections,
    missingList,
    continuation: sections.flatMap(s => s.continuation),
    rechecks,
    receiptsKept: receipts.filter(r => affectedReceipts.has(r.id)).map(r => ({
      id: r.id, group: r.group, interval: { from: r.from, to: r.to },
      note: '覆盖虽经更正重判，接管回执留存不撤销',
    })),
    fieldObservations,
    danglingRequests,
    summary,
  };
}

function summarizePickup(snapshot) {
  const books = [];
  for (const [bookId, pickup] of snapshot.books) {
    books.push({
      bookId,
      stationId: pickup.stationId,
      complete: pickup.complete,
      pagesFetched: pickup.pagesFetched,
      next: pickup.next,
      error: pickup.error,
    });
  }
  return {
    releaseName: snapshot.releaseName,
    books,
    anyIncomplete: books.some(b => !b.complete),
    boundaryError: snapshot.boundaryError,
    postsError: snapshot.postsError,
  };
}

function buildMissingList(sections) {
  const list = [];
  for (const section of sections) {
    const { slice } = section;
    for (const bank of section.coverage.banks) {
      for (const [reason, intervals] of Object.entries(bank.missing)) {
        for (const interval of intervals) {
          list.push({
            group: slice.group,
            slice: { from: slice.from, to: slice.to },
            bank: bank.bank,
            bookId: bank.bookId,
            reason,
            interval,
          });
        }
      }
    }
  }
  return list;
}

function buildSummary(sections) {
  return sections.map(section => {
    const { slice, coverage, takeover } = section;
    const missingMeters = Object.values(
      section.coverage.banks.flatMap(b => Object.values(b.missing)),
    ).flat().reduce((sum, iv) => sum + (iv.to - iv.from), 0);
    return {
      group: slice.group,
      interval: { from: slice.from, to: slice.to },
      banks: slice.banks.join('+'),
      fullyCovered: coverage.fullyCovered,
      pickupIncomplete: coverage.pickupIncomplete,
      takeover: takeover.status,
      missingMeters,
    };
  });
}

/**
 * 单点交接查询：同一里程点在指定时刻由谁接、由哪些站的哪些原件证明覆盖，
 * 未齐时指出卡在取件、有效观察还是人员接管。
 */
export function queryPoint(snapshot, options) {
  const point = typeof options.mileage === 'number' ? options.mileage : Number(options.mileage);
  if (!Number.isFinite(point)) throw new TypeError('查询里程无效');
  const boundary = snapshot.boundary;
  const shift = options.shift ?? boundary.shifts[0];
  const at = parseTime(options.at ?? shift.end);
  const cutoff = parseTime(options.receiptCutoff ?? at);
  const requests = (options.requests ?? []).map(r => ({
    group: r.group, ...asInterval(r.fromM ?? r.from, r.toM ?? r.to),
  }));
  const receipts = (options.receipts ?? []).map(r => ({
    ...r, ...asInterval(r.from ?? r.fromM, r.to ?? r.toM), issuedAt: parseTime(r.issuedAt),
  }));

  const responsible = responsibleAt(boundary, at, point);
  const ctx = { ...buildContext(snapshot, shift), pickups: snapshot.books };

  if (!responsible) {
    return {
      point, at, inResponsibility: false,
      responsibility: null,
      blockers: [{ kind: 'responsibility', message: '该里程不在任何责任线内' }],
    };
  }

  const pointCoverage = adjudicatePoint(point, at, ctx, responsible.banks);

  // 人员接管：该点是否被责任班组的某张回执覆盖
  const coveringReceipts = receipts
    .filter(r => r.group === responsible.group && point >= r.from && point < r.to)
    .map(r => ({
      id: r.id, group: r.group, interval: { from: r.from, to: r.to },
      basedOn: r.basedOn, issuedAt: r.issuedAt,
    }));
  const requestHere = requests.some(r => r.group === responsible.group && point >= r.from && point < r.to);

  const blockers = [];
  for (const b of pointCoverage.banks) {
    if (b.status !== 'covered') {
      const kindMap = {
        'confirmed-gap': 'observation',
        'no-valid-observation': 'observation',
        'pickup-incomplete': 'pickup',
      };
      blockers.push({
        kind: kindMap[b.status],
        bank: b.bank,
        status: b.status,
        message: blockerMessage(b),
      });
    }
  }
  if (!blockers.length && coveringReceipts.length === 0) {
    blockers.push({
      kind: 'takeover',
      message: requestHere
        ? `${responsible.group} 已有交接请求但回执未发出，不能默认接手`
        : `该点无交接请求，${responsible.group} 尚未接手，旧班继续值守`,
    });
  }

  return {
    point,
    at,
    inResponsibility: true,
    responsibility: {
      group: responsible.group,
      banks: responsible.banks,
      source: responsible.source,
    },
    coverage: pointCoverage,
    takeover: {
      requested: requestHere,
      receipts: coveringReceipts,
      takenOver: coveringReceipts.length > 0,
    },
    blockers,
    ready: blockers.length === 0,
  };
}

function blockerMessage(bankStatus) {
  switch (bankStatus.status) {
    case 'confirmed-gap':
      return `${bankStatus.bank}岸站点已签发空窗（confirmed-gap），列入缺测`;
    case 'pickup-incomplete':
      return `${bankStatus.bank}岸值守簿分页未取全（${bankStatus.pickupError?.message ?? '有遗留游标'}），不能宣告无记录`;
    case 'no-valid-observation':
      return `${bankStatus.bank}岸缺少本窗内 clear 有效观察（低能见度或转录不证明覆盖）`;
    default:
      return `${bankStatus.bank}岸未齐`;
  }
}
