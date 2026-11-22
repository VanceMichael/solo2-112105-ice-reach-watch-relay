// 端到端：三档发布（首发 → 改派 → 勘误）驱动完整换班叙事，
// 覆盖分页未取全、改派切片、空窗确认、转录去重、里程修订、更正重判与单点查询。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildReport, queryPoint } from '../src/engine.mjs';
import { snapshotOf, httpSnapshot, requests } from './helpers/fixtures.mjs';

const SHIFT_END = '2026-11-23T12:00:00+08:00';
const receipt = (id, group, from, to, basedOn, at = '2026-11-23T11:00:00+08:00') =>
  ({ id, group, from, to, basedOn, issuedAt: Date.parse(at), note: '' });

function findSlice(report, group) {
  return report.slices.find(s => s.slice.group === group);
}
function bankOf(section, bank) {
  return section.coverage.banks.find(b => b.bank === bank);
}

test('首发档：分页 503 时不得宣告无记录，取件未全成为卡点', async () => {
  const snapshot = await snapshotOf('首发');
  const south = snapshot.books.get('south');
  assert.equal(south.complete, false);
  assert.equal(south.pagesFetched, 1);
  assert.equal(south.next, 'next23');
  assert.equal(south.error.status, 503);

  const report = buildReport(snapshot, { requests: requests(), receipts: [], at: SHIFT_END });
  assert.equal(report.ok, true);

  // 已取到的 S21/S22 仍可证明部分覆盖；未取全的簿在无定论处报 pickup-incomplete
  const northSection = findSlice(report, '北班');
  assert.deepEqual(northSection.slice, { from: 0, to: 160, group: '北班', banks: ['北', '南'], source: northSection.slice.source });
  assert.deepEqual(bankOf(northSection, '北').covered, [{ from: 80, to: 160 }]);
  // 南岸 S21 覆盖 [20,220)，首页已取到；[0,20) 无定论且簿未取全 → pickup-incomplete
  assert.deepEqual(bankOf(northSection, '南').covered, [{ from: 20, to: 160 }]);
  assert.deepEqual(bankOf(northSection, '南').missing['pickup-incomplete'], [{ from: 0, to: 20 }]);
  // 绝不能把未取全误报成 no-valid-observation
  assert.equal(bankOf(northSection, '南').missing['no-valid-observation'].length, 0);

  // 转录 N15 不增加北岸覆盖，只作为 S21 的持有凭证
  const s21 = bankOf(northSection, '南').proofs.find(p => p.observationId === 'S21');
  assert.deepEqual(s21.sources.map(s => s.stationId), ['south', 'north']);
  assert.deepEqual(s21.sources.map(s => s.role), ['original', 'transcript']);

  // 无任何回执：整段旧班延续
  assert.ok(report.continuation.length > 0);
  assert.deepEqual(report.continuation.map(c => c.interval),
    report.slices.map(s => ({ from: s.slice.from, to: s.slice.to })));
});

test('首发档：同样的取件失败经真实 HTTP 适配器复现', async t => {
  const snapshot = await httpSnapshot(t, '首发');
  assert.equal(snapshot.books.get('south').complete, false);
  assert.equal(snapshot.books.get('south').error.status, 503);
  const report = buildReport(snapshot, { requests: requests(), receipts: [], at: SHIFT_END });
  assert.equal(report.pickup.anyIncomplete, true);
});

test('改派档：责任按生效时间切片，跨边界观察按应承担区间分别引用', async () => {
  const snapshot = await snapshotOf('改派');
  assert.equal(snapshot.books.get('south').complete, true); // 第二页取到，含 confirmed-gap
  const report = buildReport(snapshot, { requests: requests(), receipts: [], at: SHIFT_END });

  assert.deepEqual(report.slices.map(s => [s.slice.from, s.slice.to, s.slice.group]),
    [[0, 125, '北班'], [125, 195, '机巡班'], [195, 260, '南班']]);

  // 机巡班重点段（两岸）：北岸 N11 只在 [125,190) 作证，南岸 S21 覆盖全段
  const mobile = findSlice(report, '机巡班');
  assert.deepEqual(mobile.slice.banks, ['北', '南']);
  assert.deepEqual(bankOf(mobile, '北').covered, [{ from: 125, to: 190 }]);
  assert.deepEqual(bankOf(mobile, '北').missing['no-valid-observation'], [{ from: 190, to: 195 }]);
  assert.deepEqual(bankOf(mobile, '南').covered, [{ from: 125, to: 195 }]);
  // 旧班延续不能掩盖新辖段缺一岸：缺口单列
  assert.ok(report.missingList.some(m => m.group === '机巡班' && m.bank === '北'));

  // 改派无回执：机巡班不被默认接手；改派区间 [125,195) 横跨原责任线（界点 160），
  // 旧班逐区间分别为北班 [125,160) 与南班 [160,195)
  assert.equal(mobile.takeover.status, 'none');
  assert.deepEqual(mobile.continuation.map(c => [c.interval.from, c.interval.to, c.oldGroup]),
    [[125, 160, '北班'], [160, 195, '南班']]);
  // 请求 [145,175) 落在两段内，两段都属“有请求但回执未发出”
  assert.ok(mobile.continuation.every(c => /回执未发出/.test(c.reason)));

  // 站点签发空窗进入缺测清单（S25: 南岸 [0,20)），空窗结论优先于取件状态
  const north = findSlice(report, '北班');
  assert.deepEqual(bankOf(north, '南').missing['confirmed-gap'], [{ from: 0, to: 20 }]);
  assert.deepEqual(bankOf(north, '南').covered, [{ from: 20, to: 125 }]);
  assert.ok(report.missingList.some(m => m.reason === 'confirmed-gap' && m.bank === '南'));

  // 哨点里程修订：S22 原 [208,248) 在生效时段内 +12 → [220,260)，落在南班切片
  const south = findSlice(report, '南班');
  const s22 = bankOf(south, '南').proofs.find(p => p.observationId === 'S22');
  assert.deepEqual(s22.interval, { from: 220, to: 260 });
  assert.equal(s22.sources[0].stationId, 'south');
});

test('改派档：回执确认部分接手，未确认区间继续旧班值守', async () => {
  const snapshot = await snapshotOf('改派');
  const receipts = [
    // 机巡班只接请求 [145,175) 中的 [145,170)
    receipt('R01', '机巡班', 145, 170, ['N11', 'S21']),
    // 南班整段接
    receipt('R02', '南班', 195, 260, ['S21', 'S22']),
  ];
  const report = buildReport(snapshot, { requests: requests(), receipts, at: SHIFT_END });

  const mobile = findSlice(report, '机巡班');
  assert.equal(mobile.takeover.status, 'partial');
  assert.deepEqual(mobile.takeover.takenByIncoming, [{ from: 145, to: 170 }]);
  const kept = mobile.continuation.map(c => [c.interval.from, c.interval.to]);
  assert.deepEqual(kept, [[125, 145], [170, 195]]);

  const south = findSlice(report, '南班');
  assert.equal(south.takeover.status, 'complete');
  assert.equal(south.continuation.length, 0);
});

test('勘误档：事后 poor 更正触发重判，回执留存并新增补查责任', async () => {
  const snapshot = await snapshotOf('勘误');
  // 回执在更正被采集前发出；cutoff 取早于 N12 的时刻模拟“回执已发出后才收到补交”
  const cutoff = '2026-11-23T06:10:00+08:00';
  const receipts = [receipt('R01', '机巡班', 125, 195, ['N11', 'S21'])];
  const report = buildReport(snapshot, {
    requests: requests(), receipts, at: SHIFT_END, receiptCutoff: cutoff,
  });

  const mobile = findSlice(report, '机巡班');
  // N12(poor) 更正 N11 的 [135,190)：北岸覆盖由 [125,190) 退化为 [125,135)
  assert.deepEqual(bankOf(mobile, '北').covered, [{ from: 125, to: 135 }]);
  assert.deepEqual(bankOf(mobile, '北').missing['no-valid-observation'],
    [{ from: 135, to: 195 }]);

  // 接管回执留存不撤销
  assert.equal(mobile.takeover.status, 'complete');
  assert.deepEqual(report.receiptsKept.map(r => r.id), ['R01']);

  // 指定里程新增补查责任（更正里程 ∩ 回执范围）
  assert.equal(report.rechecks.length, 1);
  assert.deepEqual(report.rechecks[0].interval, { from: 135, to: 190 });
  assert.equal(report.rechecks[0].group, '机巡班');
  assert.equal(report.rechecks[0].late, true);
  assert.equal(report.rechecks[0].correctionId, 'N12');

  // N14 是未更正任何交接依据的 poor 补交：只作现场观察，不产生补查
  const n14 = report.fieldObservations.find(o => o.id === 'N14');
  assert.ok(n14.retained);
  assert.ok(n14.reasons.some(r => r.includes('低能见度')));
  assert.ok(!report.rechecks.some(r => r.correctionId === 'N14'));
});

test('单点查询：给出担责班组、原件凭证与三类卡点', async () => {
  const snapshot = await snapshotOf('改派');

  // 已覆盖但无人接管 → 卡在人员接管
  const q1 = queryPoint(snapshot, { mileage: 150, at: SHIFT_END, requests: requests(), receipts: [] });
  assert.equal(q1.responsibility.group, '机巡班');
  assert.equal(q1.takeover.takenOver, false);
  assert.deepEqual(q1.blockers.map(b => b.kind), ['takeover']);
  const northProof = q1.coverage.banks.find(b => b.bank === '北').proofs;
  assert.ok(northProof.some(p => p.observationId === 'N11' && p.proves));

  // 有回执且两岸覆盖 → 交接齐备
  const q2 = queryPoint(snapshot, {
    mileage: 150, at: SHIFT_END, requests: requests(),
    receipts: [receipt('R01', '机巡班', 145, 175, ['N11', 'S21'])],
  });
  assert.equal(q2.ready, true);

  // 北岸缺口点 → 卡在有效观察
  const q3 = queryPoint(snapshot, { mileage: 192, at: SHIFT_END, requests: requests(), receipts: [] });
  assert.ok(q3.blockers.some(b => b.kind === 'observation' && b.bank === '北'));

  // 空窗点 → 明确缺测而非取件问题
  const q4 = queryPoint(snapshot, { mileage: 10, at: SHIFT_END, requests: requests(), receipts: [] });
  assert.ok(q4.blockers.some(b => b.status === 'confirmed-gap'));
});

test('单点查询：首发档分页未取全时卡在取件', async () => {
  const snapshot = await snapshotOf('首发');
  const q = queryPoint(snapshot, { mileage: 10, at: SHIFT_END, requests: requests(), receipts: [] });
  assert.ok(q.blockers.some(b => b.kind === 'pickup'));
  const south = q.coverage.banks.find(b => b.bank === '南');
  assert.equal(south.pickupComplete, false);
});

test('部分接管的旧班延续按原责任线边界分段，原因区分有无请求', async () => {
  const snapshot = await snapshotOf('改派');
  const receipts = [receipt('R01', '机巡班', 145, 170, ['N11', 'S21'])];
  const report = buildReport(snapshot, { requests: requests(), receipts, at: SHIFT_END });
  const mobile = findSlice(report, '机巡班');
  // 未接区间 [125,145) 属原北班线；[170,195) 整体在原南班线（界点 160 以南）
  const entries = mobile.continuation.map(c => [c.interval.from, c.interval.to, c.oldGroup]);
  assert.deepEqual(entries, [
    [125, 145, '北班'],
    [170, 195, '南班'],
  ]);
  assert.ok(mobile.continuation.every(c => c.oldGroup === '北班' || c.oldGroup === '南班'));
});

test('截止时刻之后的非更正 poor 补交只留现场观察，不改变覆盖结论', async () => {
  const snapshot = await snapshotOf('勘误');
  const cutoff = '2026-11-23T06:10:00+08:00';
  const before = buildReport(snapshot, {
    requests: requests(), receipts: [], at: SHIFT_END, receiptCutoff: cutoff,
  });
  // N14 是 poor 且不 replaces 任何记录：任何回执组合都不应产生 N14 补查
  const receipts = [receipt('R09', '南班', 195, 225, ['S21'], '2026-11-23T06:05:00+08:00')];
  const after = buildReport(snapshot, {
    requests: requests(), receipts, at: SHIFT_END, receiptCutoff: cutoff,
  });
  assert.ok(!after.rechecks.some(r => r.correctionId === 'N14'));
  const n14 = after.fieldObservations.find(o => o.id === 'N14');
  assert.ok(n14.retained && n14.reasons.some(r => r.includes('低能见度')));
  // 南班切片南岸覆盖不受 N14 影响（它本就 poor）
  const southBefore = before.slices.find(s => s.slice.group === '南班').coverage.banks[0];
  const southAfter = after.slices.find(s => s.slice.group === '南班').coverage.banks[0];
  assert.deepEqual(southBefore.covered, southAfter.covered);
});
