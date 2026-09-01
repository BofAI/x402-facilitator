# TRON `settlement_pending` 持久化与对账需求

## 1. 背景与目标

TRON 交易广播成功后，SDK 可能在同步等待窗口内无法确认最终链上结果，并返回：

```json
{
  "success": false,
  "errorReason": "settlement_pending",
  "transaction": "<txid>",
  "network": "tron:mainnet"
}
```

此结果表示交易已广播，但支付效果仍未知，不能等同于失败，也不能安全重试广播。当前 Facilitator 会把所有 `success: false` 结果持久化为 `failed`，且没有后台对账能力，重试 `/settle` 时仍可能再次调用 SDK。

本需求的目标是让 x402-facilitator 成为结算状态的持久化与恢复边界：

- 可靠保存带交易哈希的未决结算；
- 在再次结算前拦截已存在的未决或终态记录；
- 通过只读链上查询将未决记录推进到可信终态；
- 在进程重启、多实例运行和 RPC 暂时不可用时保持“不重复广播、不误判失败”。

## 2. 范围

### 2.1 包含

- `exact`、`upto` 方案的授权身份幂等检查；
- `settlement_pending` 的数据库持久化；
- TRON 未决交易的后台对账与按需刷新；
- 现有 `GET /payments/tx/:hash` 的未决状态查询；
- 对账任务的生命周期、并发安全、监控和超时约束；
- batch settlement 交易哈希的状态对账边界。

### 2.2 不包含

- SDK 内部的广播、回执轮询和错误分类实现；
- Resource Server 的通道预留、凭证重放保护或业务状态机；
- 自动重发、替换或加速任何已广播交易；
- 新建通用 `/status` API；
- 首版引入 worker lease、任务尝试次数、`next_reconcile_at` 或单独的操作意图表。

## 3. 状态模型

数据库 `settlements.status` 必须支持以下语义：

| 状态 | 语义 | 是否终态 |
| --- | --- | --- |
| `pending` | 已获得交易哈希，但链上最终效果未知 | 否 |
| `success` | 已确认交易成功，且支付效果与预期一致 | 是 |
| `reverted` | 已确认交易在链上执行回滚 | 是 |
| `failed` | 广播前失败，或已确认交易成功执行但支付效果明确不符合预期 | 是 |

`settlement_pending` 是 SDK/HTTP 响应中的 `errorReason`，对应数据库的 `pending` 状态。任何没有交易哈希的记录都不得标记为 `pending`。

对 TRON 而言，仅由 FullNode 最新头返回的“已打包”结果不具备足够终局性。持久化为 `success`、`reverted` 或“链上效果不匹配”的 `failed` 前，必须取得已固化（solidified）的交易回执；未固化、数据不完整或 RPC 不可用时必须继续保持 `pending`。

## 4. 功能需求

### 4.1 `/settle` 调用前的幂等检查

对于具有 nonce 的 `exact`、`upto` 请求，Facilitator 必须在调用 SDK `settle` 前：

1. 从请求中提取并规范化授权身份 `(network, scheme, asset, payer, nonce)`；
2. 查询相同授权身份的已有结算记录；
3. 按以下规则处理：

| 已有记录 | `/settle` 行为 |
| --- | --- |
| `pending` 且有 `txHash` | 不调用 SDK；重建并返回 `success: false`、`errorReason: settlement_pending` 和原 `transaction` |
| `success` | 不调用 SDK；返回已保存的成功结果 |
| `reverted`，或有 `txHash` 的 `failed` | 不调用 SDK；返回已保存的终态结果 |
| 无 `txHash` 的广播前 `failed` | 允许再次调用 SDK |
| 无记录 | 调用 SDK |

幂等查询可以跨 seller 执行，因为链上授权身份是全局防重边界；响应只能包含 x402 结算结果字段，不得泄露其他 seller 的内部信息。

### 4.2 SDK 返回后的持久化

- SDK 返回 `settlement_pending` 且包含交易哈希时，保存 `status = pending`、`txHash` 和 `errorReason = settlement_pending`，不得保存为 `failed`。
- SDK 返回 `settlement_pending` 但没有交易哈希时，视为 SDK 契约异常：不得创建无法对账的 `pending` 记录，并产生高优先级告警。
- 广播前失败且没有交易哈希时，保存为 `failed`；该记录不阻止后续重试。
- TRON 的同步结果如果不能证明回执已固化，即使 SDK 已返回成功或回滚，也只能在数据库中保存为 `pending` 并使用 `settlement_pending` 作为可重建原因，随后由对账流程确认终态。HTTP 响应仍保持 SDK 的原始协议结果。
- 数据库写入失败不得篡改已经取得的 SDK 响应或丢弃其中的交易哈希；必须记录高优先级结构化日志和指标。

### 4.3 后台对账任务

Facilitator 必须提供进程内后台任务，周期性扫描 `status = pending` 且 `txHash` 非空的记录。

每条记录的处理必须满足：

1. 仅调用链上回执/交易查询能力，禁止调用 `settle` 或任何广播接口；
2. 使用 SolidityNode 或等价的已固化回执来源判断 TRON 终态；
3. 回执确认执行成功后，校验目标合约、调用数据以及可验证的转账/事件效果与原支付要求一致，再转为 `success`；
4. 回执明确执行回滚时，转为 `reverted` 并保存稳定、可返回的错误原因；
5. 回执已固化且能够明确证明支付效果错误或缺失时，转为 `failed`；
6. 交易未固化、未查到、RPC 暂时不可用、回执字段不完整或效果仍无法确定时，保持 `pending` 并按退避策略稍后重查；
7. 长时间未决只能触发告警，禁止按 TTL 自动转为 `failed`。

对账任务必须支持可配置且有上限的扫描批量、并发数、轮询间隔、单次 RPC 超时和退避参数。所有配置必须在启动时校验，非法值应阻止服务进入就绪状态。

### 4.4 并发与数据库一致性

- 多个实例或 worker 可以重复读取同一条 `pending` 记录，但终态更新必须使用比较并交换：`UPDATE ... WHERE id = ? AND status = 'pending'`。
- 只有成功更新一行的 worker 可以记录状态转换成功；更新零行表示其他 worker 已完成处理。
- 禁止在数据库事务或行锁持有期间执行远程 RPC。
- 首版无需分布式 worker lease；重复的只读回执查询是可接受的。
- 状态一旦进入终态，不得由后台任务改回 `pending` 或改写为另一终态。

### 4.5 查询接口

- 继续使用现有 `GET /payments/tx/:hash`，保持其认证、seller 隔离和响应形状兼容。
- 查询到 `pending` 记录时，可以触发一次有严格超时的只读刷新；刷新不得广播交易。
- 返回前应重新读取或使用 CAS 更新后的最新状态，避免返回已知过期结果。
- 不新增通用状态查询接口。

### 4.6 进程生命周期

- 服务启动并完成数据库初始化后启动对账任务，使重启前遗留的 `pending` 自动恢复处理。
- 服务关闭时先停止接收新的对账工作，等待受控的在途查询结束或超时，再关闭数据库连接。
- 对账任务初始化失败必须影响健康/就绪状态，不能静默降级为“服务在线但永不对账”。

### 4.7 Batch settlement 边界

- batch deposit、voucher、claim、refund 没有逐支付 nonce 时，不得使用空 nonce 参与 `exact`/`upto` 授权身份查询。
- 已生成交易哈希的 batch 操作可以复用交易哈希持久化和对账能力。
- 通道预留、签名凭证防重和业务回滚仍由 Resource Server 负责；Facilitator 不修改其通道存储。

## 5. 数据与迁移要求

现有字段 `network`、`scheme`、`asset`、`payer`、`nonce`、`amount`、`tx_hash`、`status`、`error_reason` 和 `created_at` 已能表达状态与定位交易。首版不强制新增 `updated_at`、尝试次数、下次执行时间或 worker lease 字段。

但现有记录没有 `payTo` 等完整预期支付效果，不能独立验证回执是否把正确资产和金额交付给正确接收方。实现必须持久化足够的最小验证上下文，不能仅凭“交易执行成功”判定支付成功。

实现必须：

- 保存至少包含接收方、资产、金额及方案所需目标/调用约束的版本化验证上下文；具体使用独立字段还是结构化字段由实现设计决定；
- 为授权身份查询和 `pending` 扫描提供与实际查询匹配的索引；
- 保持 Drizzle schema、启动 DDL 和 schema contract test 一致；
- 对已部署数据库需要的索引、约束或字段变更提供显式、幂等的迁移，不能依赖 `CREATE TABLE IF NOT EXISTS` 升级已有表；
- 保留原始 `txHash` 和稳定的 `errorReason`，以便重建协议响应；
- 规范化授权身份后再查询，避免地址大小写或网络别名造成重复广播。

## 6. 超时与可观测性

部署必须保持以下超时层级，并为响应传输保留余量：

```text
TRON 同步确认窗口 < Resource Server 到 Facilitator 的 HTTP 超时 < 外层网关超时
```

以 SDK 默认 90 秒确认窗口为例，调用方 HTTP 超时至少应为 120 秒，外层网关必须更长。任何自定义值都必须保持同样的层级关系；可能包含赞助流程的路径还需单独评估更长预算。

至少暴露以下结构化指标或等价观测信号：

- 当前 `pending` 数量及最老记录年龄；
- 对账查询次数、延迟和按结果分类的计数；
- `pending -> success/reverted/failed` 转换计数；
- RPC 超时/不可用计数；
- 已取得交易哈希但数据库写入失败计数；
- 超过告警阈值仍未决的记录计数。

日志不得输出 API key、完整签名或完整支付 payload；应包含可关联的 `txHash`、network、scheme 和记录 ID。

## 7. 依赖与发布约束

- 实现依赖的 x402 SDK 版本必须稳定返回带交易哈希的 `settlement_pending`，并提供不会触发广播的 TRON 回执查询能力；依赖升级应在实现 PR 中显式完成和验证。
- 数据库迁移或索引必须先于依赖它们的应用版本生效，或与应用保持向后兼容。
- 首次启用 worker 时应从保守的批量和并发配置开始，并监控 RPC 错误率和积压年龄。
- 本需求不要求修改 npm package 版本。

## 8. 已接受的首版限制

- 两个实例可能在首次记录落库前同时处理同一授权。链上 nonce 仍应保证最多一笔成功，但可能产生一次额外的回滚交易和资源消耗；首版不引入广播前全局锁。
- 广播成功与 `pending` 入库之间仍存在进程崩溃窗口。首版不引入 durable outbox/operation intent；一旦已取得 `txHash` 但保存失败，必须保留 HTTP 响应并高优先级告警。
- 无法从链上取得充分证据时，记录可能长期保持 `pending`；这是比误判失败并重试广播更安全的行为。

## 9. 验收标准

实现 PR 至少需要自动化覆盖以下场景：

1. 相同授权已有 `pending` 时不调用 SDK，并返回原交易哈希和 `settlement_pending`；
2. 相同授权已有 `success` 时不调用 SDK，并返回已保存成功结果；
3. 相同授权已有带交易哈希的 `reverted`/`failed` 时不调用 SDK；
4. 相同授权仅有无交易哈希的广播前 `failed` 时允许重试；
5. batch 请求不会用空 nonce 命中授权身份幂等逻辑；
6. SDK 返回带交易哈希的 `settlement_pending` 时保存为 `pending`，而不是 `failed`；
7. SDK 返回无交易哈希的 `settlement_pending` 时不创建 `pending` 并产生告警；
8. TRON 交易仅已打包但未固化时保持 `pending`；
9. 已固化成功回执只有在目标、调用和支付效果验证通过后才转为 `success`；
10. 已固化回滚转为 `reverted`，已固化且效果明确不匹配转为 `failed`；
11. RPC 不可用、未查到交易或数据不完整时保持 `pending` 并退避，且从不广播；
12. 超过未决告警阈值时发出告警但仍保持 `pending`；
13. 两个 worker 同时处理同一记录时，只有一个 CAS 终态更新成功；
14. `GET /payments/tx/:hash` 能返回刷新后的最新状态，且保持现有认证和响应兼容；
15. 已广播结果保存失败时，HTTP 响应仍保留 SDK 返回的交易哈希，并记录高优先级信号；
16. 服务重启后会继续处理已有 `pending`，关闭时在数据库断开前停止 worker；
17. 配置校验覆盖非法并发、批量、间隔、退避和 RPC 超时值；
18. 集成测试验证 90 秒同步确认窗口、至少 120 秒调用方 HTTP 超时及更长外层超时的配置关系。
