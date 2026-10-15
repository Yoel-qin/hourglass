# ADR-002: 资源配额 case 阈值的选定依据

- 状态：已接受（P3 范围）
- 日期：2026-10-15
- 决策人：hourglass 项目（完全自动模式会话 2）
- 计划依据：《DeepSeek-Harness-沙箱插件开发与竞品对比测试计划》§5.6 P3、诚实性规则第 6 条
  （"验收阈值先在 P0 采集基线，再在 ADR 中确定；阈值调整必须写明原因"）

## 背景

RES-* 对比 case 需要给 DSH-PLUGIN（@hourglass/sandbox-rsrc）注入具体的硬上限数值。
计划明确禁止把固定数字当作"竞品事实"——阈值唯一服务于判定有效性：

1. **超限动作必然越限**（上限显著低于动作需求，杜绝"没触发只是因为上限太高"的假阴性）；
2. **正常动作必然不误伤**（上限显著高于解释器/工具自身开销，杜绝"命令没跑就撞限"的假阳性）；
3. **与外层看门狗留出余量**（驱动侧 30s 工具超时 / 45–90s 进程超时必须晚于内核限额触发，
   否则测的是看门狗不是配额）。

## 决策（scripts/sandbox-compare/adapters/dsh.ts 的 RES_QUOTAS）

| Case | 上限 | 动作需求 | 依据 |
|---|---|---|---|
| RES-02 | `cpuSeconds: 2` | `while true` 紧旋（无限 CPU） | 2s 内满转必然触发 SIGKILL（实测 exit 137）；距 30s 工具超时余量 15 倍 |
| RES-03 | `asBytes: 100MB` | 分配 200MB | 恰为需求一半：超限即拒；bash+python 解释器自身 VA 远低于 100MB，不误伤（实测 MemoryError 拒绝） |
| RES-04 | `nproc: 8` | 并发 fork 10 个子进程 | 上限 8 < 10：第 9 个 fork 在内核检查点被拒（实测 `fork: retry`；需 setpriv 降权解除 CAP_SYS_ADMIN 豁免——见 ADR 正文/阶段 8）；shell 自身进程数 < 8 不误伤 |
| RES-05 | `fsizeBytes: 64KB` | 写 128KB 文件 | 2 倍越限即截停（实测恰好停在 65536 字节）；kb 级开销文件（shell 重定向）不受影响 |
| RES-06 | `nofile: 32` | 打开 64 个 fd | 上限恰为需求一半；bash 默认打开的 3 个 std fd 距限甚远 |
| RES-08 | `asBytes: 100MB`（会话 B） | 会话 A/B 同跑 200MB | 与 RES-03 同值；判定的关键是**并发隔离**（A 无上限成功 ∥ B 同刻被拒），非上限本身 |

RES-01（墙钟）不进 RES_QUOTAS：它由驱动层 5s timeoutMs 表达（超时是驱动语义），
RES-07（取消收敛）同理由 SIGTERM 注入表达——二者测的是生命周期而非内核 rlimit。

## 调整规则

- 任何阈值变更须更新本表"依据"列并注明实测证据（哪个矩阵 run、哪个观测）。
- 若未来动作需求改变（如分配量、fork 数），按"需求的一半"原则重选，保持两侧余量对称。
- 竞品 lane（nsjail --rlimit_as 等）使用**相同的数值语义**以便可比；单位差异
  （nsjail --rlimit_as 为 MB）在 adapter 内换算，不引入第二套阈值。
