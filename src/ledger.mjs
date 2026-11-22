// 交接回执台账。台账文件由值班席本地维护，记录每张已发出的接班回执。
// 回执范围允许是请求范围的子集（整段接或只接一部分），并登记当时依据的观察编号。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { asInterval, intersect } from './domain/interval.mjs';
import { parseTime } from './domain/time.mjs';

/**
 * @param receipt {id, group, fromM, toM, requestId?, basedOn:[observationId], issuedAt, note?}
 */
export function validateReceipt(receipt, requests) {
  const warnings = [];
  const interval = asInterval(receipt.fromM, receipt.toM);
  if (!receipt.group || typeof receipt.group !== 'string') {
    throw new Error('回执缺少责任班组 group');
  }
  if (!Array.isArray(receipt.basedOn) || receipt.basedOn.length === 0) {
    throw new Error('回执必须登记交接所依据的观察编号 basedOn');
  }
  const matching = requests.filter(r => r.group === receipt.group);
  if (!matching.length) {
    warnings.push(`班组 ${receipt.group} 当前没有对应交接请求，回执仍予登记`);
  } else {
    const inside = matching.some(r => intersect(interval, asInterval(r.fromM ?? r.from, r.toM ?? r.to)));
    if (!inside) {
      warnings.push(`回执区间 [${interval.from},${interval.to}) 落在 ${receipt.group} 的请求范围之外`);
    }
  }
  return { interval, warnings };
}

export class ReceiptLedger {
  constructor(path) {
    this.path = path;
    this.receipts = [];
    if (path && existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      this.receipts = raw.receipts ?? [];
    }
  }

  add(input, requests, { now = Date.now(), idPrefix = 'R' } = {}) {
    const { interval, warnings } = validateReceipt(input, requests);
    const receipt = {
      id: input.id ?? `${idPrefix}${String(this.receipts.length + 1).padStart(2, '0')}`,
      group: input.group,
      from: interval.from,
      to: interval.to,
      requestId: input.requestId ?? null,
      basedOn: [...input.basedOn],
      issuedAt: parseTime(input.issuedAt ?? now),
      note: input.note ?? '',
    };
    if (this.receipts.some(r => r.id === receipt.id)) {
      throw new Error(`回执编号 ${receipt.id} 已存在`);
    }
    this.receipts.push(receipt);
    return { receipt, warnings };
  }

  /** 台账对外使用统一的区间字段名 from/to，内部判定用 intersect 直接兼容。 */
  list() {
    return this.receipts.map(r => ({ ...r }));
  }

  save() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ receipts: this.receipts }, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }
}
