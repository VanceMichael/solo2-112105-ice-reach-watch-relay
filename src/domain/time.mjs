// 时刻工具。内部一律以 epoch 毫秒（number）表示，输入接受 ISO 8601 字符串（含时区偏移）。

/** 解析 ISO 时刻为 epoch 毫秒；非法值直接抛错，避免静默错班。 */
export function parseTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`无法解析的时刻: ${String(value)}`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new TypeError(`无法解析的时刻: ${value}`);
  return ms;
}

/** 可选时刻解析：空值返回 null。 */
export function parseOptionalTime(value) {
  return value === null || value === undefined || value === '' ? null : parseTime(value);
}

/** 格式化为 +08:00 的本地时刻字符串（业务资料统一东八区）。 */
export function formatTime(ms, timeZone = '+08:00') {
  if (ms === null || ms === undefined) return '—';
  const d = new Date(ms);
  const sign = timeZone[0];
  const [hh, mm] = timeZone.slice(1).split(':').map(Number);
  const offsetMs = (hh * 60 + mm) * 60 * 1000 * (sign === '-' ? -1 : 1);
  const local = new Date(ms + offsetMs);
  const pad = n => String(n).padStart(2, '0');
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ` +
    `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}${timeZone}`;
}

/** 仅时分秒，用于紧凑报告。 */
export function formatClock(ms, timeZone = '+08:00') {
  return formatTime(ms, timeZone).slice(11, 19);
}
