# 流凌河段的跨辖区联巡接力：采集与交接工具

河道进入流凌观察期后，一条河心观察线可能前半段归上游岸站、后半段归下游岸站，也可能被临时改派到对岸。
本工具在每次换班时回答三件事：

1. 哪些河段在本班有**有效观察**（重点段两岸各自有观察，普通段按班令岸别判断）；
2. 谁已经**确认接手**（交接回执，可整段可部分）；
3. 哪段应继续请**旧班值守**到交接齐备。

仅使用 Node.js 22 标准库，无第三方依赖。`origin/` 是本地资料联调站，`src/` 是采集与交接工具，`test/` 是规则测试。

## 快速开始

```sh
# 终端 1：启动资料联调站（首发 / 改派 / 勘误 三档合成资料）
npm run origin

# 终端 2：采集当前档（分页、空窗、取件失败原样落盘）
node src/cli.mjs collect --origin http://127.0.0.1:4178 --release 改派 --out data/snap.json

# 出换班交接单（文本）或机器可读 JSON
node src/cli.mjs report  --snapshot data/snap.json --requests sources/requests.json
node src/cli.mjs report  --snapshot data/snap.json --requests sources/requests.json --json

# 接班员登记回执（整段或只接一部分，必须登记依据的观察编号）
node src/cli.mjs confirm --receipts data/receipts.json --requests sources/requests.json \
  --group 机巡班 --from 145 --to 175 --based-on N11,S21

# 查同一里程点在指定时刻由谁接、由哪些站的哪些原件证明、卡在哪个环节
node src/cli.mjs query --snapshot data/snap.json --requests sources/requests.json \
  --receipts data/receipts.json --mileage 150
```

离线演练无需启动联调站，直接用 `--catalogue sources/exchange.json --release <首发|改派|勘误>` 代替 `--snapshot`：

```sh
node src/cli.mjs report --catalogue sources/exchange.json --release 勘误 \
  --requests sources/requests.json --receipts data/receipts.json
```

## 命令

| 命令 | 作用 | 关键参数 |
| --- | --- | --- |
| `collect` | 逐页采集调度责任线、站位公示、两岸值守簿 | `--origin --release --out` |
| `report` | 生成换班交接单（文本/`--json`） | `--snapshot\|--catalogue --requests --receipts --at --cutoff` |
| `confirm` | 登记接班回执并持久化 | `--group --from --to --based-on [--request-id --at --note]` |
| `query` | 单里程点交接查询 | `--mileage [--at --cutoff --json]` |

- `--at`：责任与覆盖的判定时刻，缺省取值班窗结束时刻。
- `--cutoff`：回执截止时刻；此后到达的记录视为**事后补交**。缺省取最晚一张回执的发出时刻。

## 领域规则与实现位置

| 业务规则 | 实现 |
| --- | --- |
| 责任线与临时改派带生效时间，按判定时刻切责任段，行政区班组只用于找班组 | `src/domain/responsibility.mjs` |
| 河轴里程统一左闭右开 `[from,to)`（米） | `src/domain/interval.mjs` |
| 哨点别名与 `deltaM` 里程修订只在声明的 `[fromTime,toTime)` 内适用，原始里程留痕 | `src/domain/normalize.mjs` |
| `copyOf` 跨岸转录归并为同一观察，**不增加一次覆盖**，只追加持有凭证 | `src/domain/normalize.mjs` |
| `clear` 才能证明覆盖；`poor` 低能见度只作现场观察留档 | `src/domain/coverage.mjs` |
| 重点段须本窗内两岸各自有效观察；普通段按班令要求岸别判断 | `src/domain/coverage.mjs` |
| 分页未取全（如 503）**不得宣告无记录**，记 `pickup-incomplete` 卡点 | `src/pickup/`, `src/domain/coverage.mjs` |
| 站点签发的 `confirmed-gap` 是正式空窗，明确进入缺测清单，优先级高于取件状态 | `src/domain/coverage.mjs` |
| 跨边界观察按当前责任切片裁剪，各责任人只引用自己应承担的区间 | `src/domain/coverage.mjs` |
| 改派无回执时新责任人不被默认接手；未确认区间由旧班按原责任线分段继续值守 | `src/domain/handover.mjs` |
| 旧班延续不掩盖新辖段缺岸观察，覆盖缺口始终单列 | `src/engine.mjs` 的 `missingList` |
| 回执可整段或部分确认，范围是请求范围的子集，必须登记依据观察编号 | `src/ledger.mjs` |
| 回执后补交的 `poor` 记录只作现场观察保留 | `src/domain/handover.mjs` |
| 补交记录若 `replaces` 了交接依据的有效记录：覆盖重判、接管回执留存、指定里程新增补查责任 | `src/domain/handover.mjs` 的 `resolveRechecks` |
| 更正只在更正条目里程内使旧记录失效，跨出部分仍沿用原记录 | `src/domain/coverage.mjs` 的更正链 |

### 单点查询的三类卡点

`query` 对未齐的里程点给出卡点归类：

- **取件（pickup）**：要求岸别的值守簿分页未取全，不能下无记录结论；
- **有效观察（observation）**：簿已取全但缺本窗内 `clear` 观察，或站点已签发空窗；
- **人员接管（takeover）**：覆盖已齐但责任班组没有交接回执（改派不等于接手）。

## 三档合成资料的叙事（`sources/exchange.json`）

- **首发**：南岸值守簿第二页返回 503——已取到的观察仍可用，未取全处只报取件卡点，不能宣告无记录。
- **改派**：`07:30` 起 `[125,195)` 改派机巡班（两岸重点段）；第二页取到，含 `confirmed-gap` 空窗；
  哨点「南一旧」在生效时段内里程 `+12`；机巡班无回执时由原北班/南班分段延续。
- **勘误**：`N12(poor)` 更正 `N11` 的 `[135,190)`——该里程覆盖由 clear 退化为缺有效观察；
  若回执依据过 `N11`，重判后接管留存并新增补查责任；`N14(poor)` 未更正任何依据，只留作现场观察。

## 测试

```sh
npm test          # 联调站协议测试 + 全部领域规则测试（39 项）
```

测试覆盖：区间代数、别名修订时段、转录归并、空窗与取件未全的优先级、更正链重判、
改派切片、部分接管与旧班分段延续、事后补查，以及三档资料的端到端叙事和真实 HTTP 取件。

## 目录

```
origin/                 资料联调站（既有，模拟各业务来源）
sources/                合成资料与交接请求
src/
  cli.mjs               命令行入口
  engine.mjs            换班报告与单点查询编排
  ledger.mjs            交接回执台账（本地持久化）
  report.mjs            文本 / JSON 渲染
  domain/               区间、时刻、归一化、责任线、覆盖判定、交接判定
  pickup/               HTTP 与内存来源适配器、分页采集、场景装载
test/                   单元测试与端到端测试
data/                   本地快照与回执（git 忽略，仅保留 .gitkeep）
```
