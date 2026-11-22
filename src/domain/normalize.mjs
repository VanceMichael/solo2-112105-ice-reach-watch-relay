// 值守簿记录归一化。
// 职责：
//  1. 应用哨点别名与里程修订——别名与 deltaM 只在声明的 [fromTime, toTime) 生效区间内适用；
//  2. 区分现场观察、跨岸转录（copyOf）、站点签发空窗（confirmed-gap）与更正（replaces）；
//  3. 同一观察的跨岸转录不增加覆盖，只作为同一 canonical 观察的持有凭证保留。

import { asInterval } from './interval.mjs';
import { parseTime } from './time.mjs';

/**
 * 归一化一条值守簿原始行。
 * @param {object} row 来源原始记录
 * @param {string} bookId 值守簿标识（如 north / south）
 * @param {string} stationId 岸站标识（本协议中与簿一致）
 * @param {Array}  aliases /dispatch/posts 的 aliases 列表
 */
export function normalizeRow(row, bookId, stationId, aliases = []) {
  const at = parseTime(row.at);
  const base = {
    id: String(row.id),
    bookId,
    stationId,
    at,
    bank: row.bank ?? null,
    post: row.post ?? null,
    raw: row,
  };

  // 站点主动签发的空窗：进入缺测清单，不是“没取到”。
  if (row.kind === 'confirmed-gap') {
    return {
      ...base,
      type: 'confirmed-gap',
      interval: asInterval(row.fromM, row.toM),
    };
  }

  const interval = asInterval(row.fromM, row.toM);
  const alias = row.post ? findAlias(row.post, at, aliases) : null;

  const record = {
    ...base,
    type: 'observation',
    interval,
    // 记录簿上的原始里程区间（修订前），供追溯
    recordedInterval: { ...interval },
    quality: row.quality === 'poor' ? 'poor' : 'clear',
    isTranscript: typeof row.copyOf === 'string' && row.copyOf.length > 0,
    copyOf: row.copyOf ?? null,
    replaces: row.replaces ?? null,
    aliasApplied: alias
      ? { alias: alias.alias, post: alias.post, deltaM: alias.deltaM }
      : null,
  };

  // 哨点搬移：别名在生效区间内，起止里程加 deltaM。修订只对该生效区间的记录适用。
  if (alias) {
    record.interval = {
      from: interval.from + alias.deltaM,
      to: interval.to + alias.deltaM,
    };
  }
  return record;
}

/** 找某哨点名在某时刻适用的别名声明；超出声明时段一律不修订。 */
export function findAlias(postName, at, aliases) {
  for (const alias of aliases) {
    if (alias.alias !== postName) continue;
    const from = parseTime(alias.fromTime);
    const to = parseTime(alias.toTime);
    if (at >= from && at < to) return alias;
  }
  return null;
}

/**
 * 把一批归一化记录按“同一观察”归并。
 * 规则：copyOf 指向同编号原件的转录不另立观察，只追加持有凭证；
 *       没有对应原件的转录（悬挂转录）保留为独立现场观察并标记。
 * 返回 canonical 观察列表与空窗列表。
 */
export function canonize(records) {
  const observations = records.filter(r => r.type === 'observation');
  const gaps = records.filter(r => r.type === 'confirmed-gap');

  const byId = new Map();
  for (const rec of observations) byId.set(rec.id, rec);

  const canonicals = [];
  const consumedTranscriptIds = new Set();

  // 原件先立账
  for (const rec of observations) {
    if (rec.isTranscript) continue;
    canonicals.push(buildCanonical(rec, observations, byId, consumedTranscriptIds));
  }
  // 悬挂转录（找不到原件）自身作为现场观察保留
  for (const rec of observations) {
    if (!rec.isTranscript || consumedTranscriptIds.has(rec.id)) continue;
    canonicals.push({
      id: rec.id,
      bank: rec.bank,
      interval: rec.interval,
      quality: rec.quality,
      at: rec.at,
      // 无原件可依，转录件本身作为现场观察，但保留来源说明
      danglingTranscript: true,
      sources: [{
        stationId: rec.stationId,
        bookId: rec.bookId,
        recordId: rec.id,
        role: 'dangling-transcript',
        copyOf: rec.copyOf,
        quality: rec.quality,
        at: rec.at,
      }],
      replaces: rec.replaces,
    });
  }
  return { observations: canonicals, gaps };
}

function buildCanonical(primary, all, byId, consumedTranscriptIds) {
  const sources = [{
    stationId: primary.stationId,
    bookId: primary.bookId,
    recordId: primary.id,
    role: 'original',
    quality: primary.quality,
    at: primary.at,
  }];

  // 收录指向该原件的全部转录件（同一观察，不增加覆盖）
  for (const rec of all) {
    if (!rec.isTranscript || rec.copyOf !== primary.id) continue;
    consumedTranscriptIds.add(rec.id);
    sources.push({
      stationId: rec.stationId,
      bookId: rec.bookId,
      recordId: rec.id,
      role: 'transcript',
      quality: rec.quality,
      at: rec.at,
    });
  }

  return {
    id: primary.id,
    bank: primary.bank,
    interval: primary.interval,
    quality: primary.quality,
    at: primary.at,
    danglingTranscript: false,
    sources,
    replaces: primary.replaces,
  };
}

/**
 * 建立更正关系索引。replaces 指向的旧观察在“被更正条目覆盖的里程内”失效，
 * 跨出更正条目里程的部分仍沿用原记录。
 */
export function buildReplacementIndex(canonicalObservations) {
  const index = new Map(); // 旧编号 -> 更正观察列表（支持链式与多段更正）
  for (const obs of canonicalObservations) {
    if (!obs.replaces) continue;
    if (!index.has(obs.replaces)) index.set(obs.replaces, []);
    index.get(obs.replaces).push(obs);
  }
  return index;
}
