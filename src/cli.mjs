#!/usr/bin/env node
// 换班采集与交接工具命令行。
//
// 子命令：
//   collect  采集一次来源快照（分页、空窗、取件失败原样落盘）
//   report   依据快照 + 请求 + 回执生成换班交接单
//   confirm  登记一张接班回执（可整段、可只接一部分）
//   query    查询某里程点在指定时刻由谁接、凭证与卡点
//
// 用法见 README，或运行 `node src/cli.mjs <command> --help`。

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { collectSnapshot } from './pickup/http-source.mjs';
import { createMemorySource } from './pickup/memory-source.mjs';
import { loadCatalogue, scenarioFromCatalogue } from './pickup/scenario.mjs';
import { buildReport, queryPoint } from './engine.mjs';
import { renderText, renderJson } from './report.mjs';
import { ReceiptLedger } from './ledger.mjs';
import { parseTime, formatTime } from './domain/time.mjs';

const HELP = `流凌观察换班采集与交接工具

collect   --origin <url> --out <snapshot.json> [--release <发布名>]
report    --snapshot <file> --requests <file> [--receipts <file>] [--at <iso>] [--cutoff <iso>] [--json]
confirm   --receipts <file> --requests <file> --group <班组> --from <m> --to <m>
          --based-on <观察编号,编号> [--request-id <id>] [--at <iso>] [--note <文本>]
query     --snapshot <file> --requests <file> [--receipts <file>] --mileage <m> [--at <iso>] [--cutoff <iso>] [--json]

离线演练：report/query 可用 --catalogue sources/exchange.json --release <首发|改派|勘误> 代替 --snapshot。
--cutoff 为回执截止时刻（此后到达的记录视为事后补交），缺省取最晚回执的发出时刻。
`;

function readJson(path, fallback = undefined) {
  if (!path) {
    if (fallback !== undefined) return fallback;
    throw new Error('缺少必需的 JSON 文件参数');
  }
  if (!existsSync(path)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`文件不存在: ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

/** 快照是含 Map 的内存结构，落盘时把 books Map 转为数组；读取时还原。 */
function serializeSnapshot(snapshot) {
  return {
    ...snapshot,
    books: [...snapshot.books.values()],
  };
}
function deserializeSnapshot(raw) {
  return { ...raw, books: new Map((raw.books ?? []).map(b => [b.bookId, b])) };
}

async function loadSnapshot(args) {
  if (args.catalogue) {
    const catalogue = loadCatalogue(args.catalogue);
    const releaseName = args.release ?? catalogue.releases.at(-1).name;
    const scenario = scenarioFromCatalogue(catalogue, releaseName);
    const source = createMemorySource(scenario);
    return source.collectSnapshot();
  }
  const raw = readJson(args.snapshot);
  return deserializeSnapshot(raw);
}

function loadRequests(path) {
  const raw = readJson(path, { relays: [] });
  return (raw.relays ?? raw.requests ?? []).map((r, i) => ({
    id: r.id ?? `Q${String(i + 1).padStart(2, '0')}`,
    group: r.group,
    fromM: r.fromM ?? r.from,
    toM: r.toM ?? r.to,
  }));
}

function loadReceipts(path) {
  if (!path || !existsSync(path)) return [];
  return readJson(path).receipts ?? [];
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || ['-h', '--help', 'help'].includes(command)) {
    process.stdout.write(HELP);
    return;
  }

  const stringOpts = ['origin', 'out', 'release', 'snapshot', 'requests', 'receipts',
    'catalogue', 'at', 'cutoff', 'group', 'request-id', 'note', 'based-on', 'mileage', 'from', 'to'];
  const parsed = parseArgs({
    args: rest,
    options: {
      ...Object.fromEntries(stringOpts.map(o => [o, { type: 'string' }])),
      json: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  }).values;

  switch (command) {
    case 'collect':
      return cmdCollect(parsed);
    case 'report':
      return cmdReport(parsed);
    case 'confirm':
      return cmdConfirm(parsed);
    case 'query':
      return cmdQuery(parsed);
    default:
      throw new Error(`未知子命令: ${command}\n\n${HELP}`);
  }
}

async function cmdCollect(args) {
  if (!args.origin) throw new Error('collect 需要 --origin <url>');
  const out = args.out ?? 'data/snapshot.json';

  if (args.release) {
    const switched = await fetch(`${args.origin}/_desk/releases/${encodeURIComponent(args.release)}`, { method: 'POST' });
    if (!switched.ok) throw new Error(`切换资料档失败（${switched.status}）：${await switched.text()}`);
  }
  const snapshot = await collectSnapshot(args.origin);
  writeJson(out, serializeSnapshot(snapshot));

  const lines = [`采集完成 → ${out}`, `资料档：${snapshot.releaseName ?? '未知'}`];
  for (const book of snapshot.books.values()) {
    lines.push(book.complete
      ? `· ${book.bookId}: 已取全 ${book.pagesFetched} 页`
      : `· ${book.bookId}: 未取全（${book.error?.message ?? '游标 ' + book.next}），不得宣告无记录`);
  }
  process.stdout.write(lines.join('\n') + '\n');
}

async function cmdReport(args) {
  const snapshot = await loadSnapshot(args);
  const requests = loadRequests(args.requests);
  const receipts = loadReceipts(args.receipts);
  const cutoff = resolveCutoff(args, receipts);
  const report = buildReport(snapshot, {
    requests,
    receipts,
    at: args.at,
    receiptCutoff: cutoff,
  });
  process.stdout.write(args.json ? renderJson(report) : renderText(report));
  process.stdout.write('\n');
}

/** 回执截止时刻：显式 --cutoff 优先，否则取最晚一张回执的发出时刻，无回执则与判定时刻一致。 */
function resolveCutoff(args, receipts) {
  if (args.cutoff) return args.cutoff;
  if (receipts.length) return new Date(Math.max(...receipts.map(r => r.issuedAt))).toISOString();
  return args.at;
}

async function cmdConfirm(args) {
  if (!args.group || args.from === undefined || args.to === undefined || !args['based-on']) {
    throw new Error('confirm 需要 --group、--from、--to、--based-on');
  }
  const requests = loadRequests(args.requests);
  const ledger = new ReceiptLedger(args.receipts ?? 'data/receipts.json');
  const { receipt, warnings } = ledger.add({
    group: args.group,
    fromM: Number(args.from),
    toM: Number(args.to),
    requestId: args['request-id'] ?? null,
    basedOn: args['based-on'].split(',').map(s => s.trim()).filter(Boolean),
    issuedAt: args.at ? parseTime(args.at) : Date.now(),
    note: args.note ?? '',
  }, requests);
  ledger.save();
  process.stdout.write(`已登记回执 ${receipt.id}：${receipt.group} 接手 [${receipt.from},${receipt.to})，依据 ${receipt.basedOn.join('、')}\n`);
  for (const warning of warnings) process.stdout.write(`⚠ ${warning}\n`);
}

async function cmdQuery(args) {
  if (args.mileage === undefined) throw new Error('query 需要 --mileage <米>');
  const snapshot = await loadSnapshot(args);
  const requests = loadRequests(args.requests);
  const receipts = loadReceipts(args.receipts);
  const result = queryPoint(snapshot, {
    mileage: Number(args.mileage),
    at: args.at,
    requests,
    receipts,
    receiptCutoff: resolveCutoff(args, receipts),
  });
  if (args.json) {
    process.stdout.write(renderJson(result) + '\n');
    return;
  }
  process.stdout.write(renderQueryText(result) + '\n');
}

function renderQueryText(q) {
  const lines = [];
  lines.push(`里程点 ${q.point}m @ ${formatTime(q.at)}`);
  if (!q.inResponsibility) {
    lines.push(`不在任何责任线内：${q.blockers[0]?.message ?? ''}`);
    return lines.join('\n');
  }
  lines.push(`担责班组：${q.responsibility.group}（要求岸别：${q.responsibility.banks.join('、')}，来源：${q.responsibility.source.ref}）`);
  for (const b of q.coverage.banks) {
    lines.push(`  ${b.bank}岸：${b.status}${b.pickupComplete ? '' : '（簿未取全）'}`);
    for (const p of b.proofs) {
      const stations = p.sources.map(s => `${s.stationId}/${s.recordId}`).join('，');
      const mark = p.proves ? '证明覆盖' : '仅现场观察';
      lines.push(`    凭证 ${p.observationId}（${p.quality} @${formatTime(p.at).slice(11, 19)}）${mark}，原件/转录：${stations}${p.supersededHere ? '，该点已被更正' : ''}`);
    }
    for (const gap of b.signedGaps) {
      lines.push(`    站点签发空窗 ${gap.id}（${gap.stationId}）`);
    }
  }
  lines.push(`接管：${q.takeover.takenOver ? q.takeover.receipts.map(r => `${r.id}（依据 ${r.basedOn.join('、')}）`).join('，') : '尚无回执'}`);
  if (q.ready) {
    lines.push('结论：交接齐备。');
  } else {
    lines.push('未齐，卡点：');
    for (const blocker of q.blockers) {
      const kind = { pickup: '取件', observation: '有效观察', takeover: '人员接管', responsibility: '责任线' }[blocker.kind];
      lines.push(`  · [${kind}] ${blocker.message}`);
    }
  }
  return lines.join('\n');
}

main(process.argv.slice(2)).catch(err => {
  process.stderr.write(`错误：${err.message}\n`);
  process.exit(1);
});
