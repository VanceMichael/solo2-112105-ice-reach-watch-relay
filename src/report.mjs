// 换班报告的文本渲染（终端可读）与 JSON 渲染。

import { formatInterval, formatIntervals } from './domain/interval.mjs';
import { formatClock, formatTime } from './domain/time.mjs';
import { BOOK_BANK } from './engine.mjs';

const REASON_TEXT = {
  'confirmed-gap': '站点签发空窗（缺测）',
  'pickup-incomplete': '分页未取全，不能宣告无记录',
  'no-valid-observation': '缺本窗内有效观察',
};

export function renderText(report) {
  if (!report.ok) {
    return [`报告无法生成：${report.errors?.join('；') ?? '未知错误'}`].join('\n');
  }
  const lines = [];
  const push = (text = '') => lines.push(text);

  push(`════════ 流凌观察换班交接单 ════════`);
  push(`河流：${report.river}　班次：${report.shift.id}（${formatClock(report.shift.start)}–${formatClock(report.shift.end)}）`);
  push(`资料档：${report.releaseName ?? '未知'}　判定时刻：${formatTime(report.judgedAt)}`);
  push(``);

  push(`【取件情况】`);
  for (const book of report.pickup.books) {
    const bank = BOOK_BANK[book.bookId] ?? book.bookId;
    if (book.complete) {
      push(`  · ${bank}岸值守簿（${book.bookId}）：已取全 ${book.pagesFetched} 页`);
    } else {
      push(`  · ${bank}岸值守簿（${book.bookId}）：仅取 ${book.pagesFetched} 页，未取全！游标 ${book.next ?? '—'}，原因：${book.error?.message ?? '未知'}`);
    }
  }
  if (report.pickup.boundaryError) push(`  · 调度责任线取件失败：${report.pickup.boundaryError.message}`);
  if (report.pickup.postsError) push(`  · 站位公示取件失败：${report.pickup.postsError.message}`);
  push(``);

  push(`【河段有效观察与接管】`);
  for (const section of report.slices) {
    const { slice, coverage, takeover } = section;
    const keyReach = slice.banks.length > 1;
    push(`  河段 ${formatInterval(slice)}　责任班组：${slice.group}（${keyReach ? '重点段·两岸' : `普通段·${slice.banks.join('/')}岸`}）　来源：${slice.source.ref}`);
    for (const bank of coverage.banks) {
      const head = `    - ${bank.bank}岸：`;
      if (bank.fullyCovered) {
        push(`${head}覆盖齐备 ${formatIntervals(bank.covered)}`);
      } else {
        const parts = [];
        if (bank.covered.length) parts.push(`已覆盖 ${formatIntervals(bank.covered)}`);
        for (const [reason, intervals] of Object.entries(bank.missing)) {
          if (intervals.length) parts.push(`${REASON_TEXT[reason]} ${formatIntervals(intervals)}`);
        }
        if (!parts.length && !bank.pickupComplete) parts.push('取件未全，暂无定论');
        push(`${head}${parts.join('；') || '无覆盖'}`);
      }
      for (const proof of bank.proofs) {
        const tags = [];
        if (!proof.inWindow) tags.push('窗外');
        if (proof.quality === 'poor') tags.push('低能见度·仅现场记录');
        if (proof.danglingTranscript) tags.push('悬挂转录');
        if (proof.supersededParts.length) tags.push(`被 ${proof.supersededParts.map(s => s.by).join('、')} 部分更正`);
        if (!proof.proves && !tags.length) tags.push('不证明覆盖');
        const stations = proof.sources.map(s => `${s.stationId}/${s.recordId}（${s.role === 'original' ? '原件' : '转录'}）`).join('，');
        push(`      凭证 ${proof.observationId} ${formatInterval(proof.interval)} 来源：${stations}${tags.length ? '　[' + tags.join('；') + ']' : ''}`);
      }
      for (const gap of bank.signedGaps) {
        push(`      空窗 ${gap.id}（${gap.stationId} 签发）${formatInterval(gap.interval)} @${formatClock(gap.at)}`);
      }
    }
    const takeoverText = {
      none: '无人确认接手',
      partial: `部分接手 ${formatIntervals(takeover.takenByIncoming)}`,
      complete: '整段已确认接手',
    }[takeover.status];
    push(`    接管：${takeoverText}${takeover.requested.length ? `（请求范围 ${formatIntervals(takeover.requested)}）` : '（无交接请求）'}`);
    for (const c of section.continuation) {
      push(`    旧班延续：${c.oldGroup} 继续值守 ${formatInterval(c.interval)}——${c.reason}`);
    }
  }
  push(``);

  push(`【缺测清单】`);
  if (!report.missingList.length) push('  无');
  for (const item of report.missingList) {
    push(`  · ${item.group} ${formatInterval(item.interval)} ${item.bank}岸：${REASON_TEXT[item.reason]}`);
  }
  push(``);

  push(`【旧班值守到交接齐备】`);
  if (!report.continuation.length) push('  无');
  for (const c of report.continuation) {
    push(`  · ${c.oldGroup} 守 ${formatInterval(c.interval)}（${c.reason}）`);
  }
  push(``);

  if (report.rechecks.length) {
    push(`【事后更正重判与补查】`);
    for (const rc of report.rechecks) {
      push(`  · ${rc.group} 补查 ${formatInterval(rc.interval)}：${rc.reason}`);
    }
    for (const kept of report.receiptsKept) {
      push(`  · 回执 ${kept.id}（${kept.group} ${formatInterval(kept.interval)}）：${kept.note}`);
    }
    push(``);
  }

  push(`【现场观察留档（不证明覆盖）】`);
  const retained = report.fieldObservations.filter(o => o.reasons.length);
  if (!retained.length) push('  无');
  for (const o of retained) {
    push(`  · ${o.id}（${o.bank}岸 ${formatInterval(o.interval)} @${formatClock(o.at)} ${o.quality}）：${o.reasons.join('；')}`);
  }

  if (report.danglingRequests.length) {
    push(``);
    push(`【请求异常】`);
    for (const req of report.danglingRequests) {
      push(`  · ${req.group} 的请求 ${formatInterval(req)} 无对应责任切片`);
    }
  }

  push(``);
  push(`【汇总】`);
  for (const s of report.summary) {
    const marks = [];
    if (!s.fullyCovered) marks.push('覆盖未齐');
    if (s.pickupIncomplete) marks.push('取件未全');
    if (s.takeover !== 'complete') marks.push(`接管:${s.takeover}`);
    push(`  · ${s.group} ${formatInterval(s.interval)}（${s.banks}）：${marks.length ? marks.join('，') : '交接齐备'}`);
  }
  return lines.join('\n');
}

export function renderJson(value) {
  return JSON.stringify(value, null, 2);
}
