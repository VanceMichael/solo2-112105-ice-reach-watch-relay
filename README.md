# 流凌河段的跨辖区联巡接力

资料联调站以本地合成资料模拟分别维护的业务来源。用 Node.js 22.23.4 启动，支持在同一进程中切换来源发布。启动后地址默认是 `http://127.0.0.1:4178`，可用环境变量 `PORT` 修改。

```sh
npm run origin
npm test
```

`npm run origin` 为独立的来源服务。`npm test` 另起临时端口验证资料站，不需要预先启动来源进程。资料领取仅需 Node.js 标准库。

联调站的 `GET /_desk/releases` 返回发布名与当前档。值台可向 `/_desk/releases/发布名` 发送 POST 切换资料，发布名按 UTF-8 进行 URL 编码。可选档位为首发、改派、勘误。切换后各来源从当前档的内容响应，业务数据以原接口的版本字段与时间为准。联调档位名称仅用于控制资料站。

## 来源协议

调度 `/dispatch/boundary` 以河轴自上游往下游为准，米数区间左闭右开。`responsibility` 给起始班表、各区间要求的岸别。`reassignments` 从其生效时刻起替代对应区间的责任表。换班按指定时刻查看责任，观测在同一值班窗覆盖的区间仍可被下一责任人引用。站位公示在 `/dispatch/posts`，旧站号在注明的时段需把起止里程加上 `deltaM`。
`/books/north` 和 `/books/south` 是两岸值守簿。分页延续字段为 `next`，查询参数 `cursor`。`quality=clear` 可证明覆盖，`poor` 留为现场记录。`copyOf` 是跨岸转录。`replaces` 指定更正的原记录，跨出更正条目里程的部分仍沿用原记录，`confirmed-gap` 是站点主动确认的空段。
`requests.json` 表示各班手头的交接请求范围。负责人确认时可以缩小范围。

`sources/exchange.json` 保存联调站的来源记录和原件载荷，`sources/requests.json` 保存业务席可用的请求材料。材料中的单位、标识、组织及记录内容均为合成。
