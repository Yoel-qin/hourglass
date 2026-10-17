# hourglass 源码级学习指南 —— Agent 沙箱原理、学习路线与竞品对照

> 目标读者：想**从源码层面系统理解**本项目的工程师。假设你熟悉 TypeScript/Node.js
> 与 Linux 基础，但不假设你了解沙箱技术。
> 配套材料：[README](../README.md)（安装/使用/实验数据）、
> [docs/competitive-analysis.md](competitive-analysis.md)（竞品分析全文）、
> [ADR-001](ADR-001-hourglass-plugin-scope.md) / [ADR-002](ADR-002-res-quota-thresholds.md)。
> 版本基线：DSH `d743267`；hourglass @ `3d3b40d`（2026-10-17）。
> 文中 `file:line` 均可直接跳转。

---

## 目录

- 第一部分：Agent 沙箱原理（前置知识）
- 第二部分：推荐学习顺序（路线图）
- 第三部分：逐包源码精读
- 第四部分：与竞品的机制对照
- 第五部分：动手练习（由浅入深）
- 附录：术语表 / 关键文件索引

---

# 第一部分：Agent 沙箱原理（前置知识）

## 1.1 为什么 LLM Agent 需要沙箱

Coding agent 的核心循环是"模型输出工具调用 → 宿主执行 → 结果回喂模型"。工具里
最危险的是 shell：**模型输出本质上是不可信输入**（可能被 prompt injection 污染，
也可能纯粹出错），而 shell 一旦执行，副作用发生在真实的宿主文件系统与网络上。

沙箱要回答的问题是：**当一条命令真的执行时，它能触碰的世界边界在哪里？**
这个边界必须由**内核**（而不是应用代码的自觉）来强制——应用层的"过滤命令字符串"
永远可以被编码绕过（base64、`$IFS`、别名、解释器变体……）。本项目所有判定
哲学都源于此：**只认内核强制后的真实副作用，不认文本断言**。

威胁模型具体化为五类攻击面（对应对比矩阵的五个 case 类别）：

| 类别 | 攻击者想做什么 | 内核强制手段 |
|---|---|---|
| FS-write | 越过 workspace 写宿主任意路径（含 `..` 穿越、symlink/硬链接别名、父目录攻击） | 只读根 bind + 白名单写 bind（bwrap） |
| FS-read | 读取敏感文件（`~/.ssh`、密钥） | tmpfs 遮蔽（路径级 mount） |
| NET | 绕过域名白名单外发数据（剥代理变量、IP 直连、IPv6、原生 TCP、unix socket） | 独立 netns（直连全断）+ 唯一代理通道 |
| RES | 耗尽资源（fork 炸弹、OOM、巨文件、fd 耗尽、赖着不死） | rlimit（内核限额） |
| ROB | 让治理本身失效（代理死亡后裸奔、重复挂载、非法配置放宽） | fail-closed（宁可拒绝执行） |

## 1.2 Linux 隔离原语速览（bwrap 视角）

hourglass 落在 DSH 的 **bwrap（bubblewrap）rung** 上。bwrap 是一个"无特权容器
构造器"：一次 `clone(CLONE_NEWUSER|CLONE_NEWNS|…)` + 组装 mount table。读懂
下面 8 个原语，就读懂了所有 bwrap argv：

| 原语 | 一句话语义 | 在本项目中的用法 |
|---|---|---|
| **user namespace** | 进程在新 namespace 里是 root，但对宿主无特权 → 无需 sudo 即可 mount | bwrap 默认创建；这也是 RES-04 坑的来源（见 §3.6） |
| **mount namespace** | 本进程组看到私有挂载表，host 不受影响 | 一切 `--ro-bind/--tmpfs` 都发生在这里 |
| `--ro-bind src dst` | 把宿主路径只读挂到沙箱内路径 | DSH 用 `--ro-bind / /` 做只读根 |
| `--bind src dst` | 可读写挂载 | DSH 只对 workspace/tmp 开写 |
| `--tmpfs dst` | 在 dst 挂一个空内存盘 | read 包遮蔽敏感路径；net 包放挂载点 |
| `--unshare-net` | 独立网络 namespace，**没有任何网卡** → 一切直连被内核拒绝 | net 包的 OS 层（confine.ts:111） |
| `--unshare-pid --proc /proc` | 独立 PID namespace，看不见宿主进程 | DSH 基线自带 |
| `--die-with-parent` | 父进程死则沙箱内进程全部被杀 | DSH 基线自带（NET-14 实测：后台进程随沙箱湮灭） |

关键认知：**mount 是按"解析后的路径"生效的**。symlink 先被内核解析成真实路径，
再套用挂载表——所以"在敏感路径上盖一个空 tmpfs"同时挡住直接读与一切别名读
（read 包的全部原理，§3.5）。

## 1.3 DSH（本体）的沙箱架构

hourglass 是 DSH 的**外挂插件**，DSH 仓库零修改。理解插件为什么这样挂，必须先
理解本体（以下均来自 `D:\Aiproject\deepseek-harness` @ `d743267`）：

### 词汇表层（packages/sandbox/sandbox/，seam 包）
- `SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'`——**刻意
  不含网络维度**（这是 hourglass net 包的立足点）
- `SandboxProvider.confine(argv, policy, signal): Promise<ConfinedArgv>`——
  **fail-closed 契约**：provider 不可用必须抛 `SandboxUnavailableError`
  （错误码 `SANDBOX_UNAVAILABLE`），绝不静默放行
- `ConfinedArgv { argv, enforcement: 'full'|'partial', denialSignatures, runnerFailureRules }`
  ——注意 confine 返回的是**待 spawn 的 argv**，不是已运行的进程。这就是
  "装饰器模式"得以成立的关键：插件可以在 argv 上做二次改写

### 后端层（packages/sandbox/sandbox-local/）
- `PLATFORM_CHAINS`：linux = `['bwrap','landlock']`（bwrap 不可用降级 landlock）、
  darwin = `['seatbelt']`、win32 = `['windows-acl']`
- `profiles.ts` 的 `bwrapProfileArgs` 生成形如：
  `bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --bind <workspace> <workspace> --unshare-pid --unshare-user --cap-drop ALL --die-with-parent -- <命令>`
  （workspace-write 模式；read-only 则无 `--bind`）
- hourglass 的三个执行层插件（net/read/rsrc）全部通过判断 `argv[0]==='bwrap'`
  识别 rung，非 bwrap 一律 fail-closed

### 工具管线层（packages/core/tools/src/index.ts:143-211）
插件可挂的事件（顺序即管线顺序）：
1. `tools/pre-execute`（waterfall）——审计 **begin** 记录落点
2. `tools/execute`（包裹真实分发）
3. `tools/post-execute`（waterfall）
4. `tools/result`（emit，终态冻结）——审计 **end** 记录落点
5. `ctx.tools.guard()`——同步单调拒绝（只能 deny，顺序无关）

### 消费者契约（最容易被忽略、却最重要的一条链）
`tool-bash` 执行完被 confine 的命令后，把沙箱事实**盖章在 result 的 canonical
value** 上：`result.value.sandbox = { mode, denied, enforcement?, runnerFailed? }`
（类型见 packages/shell/shell/src/types.ts:35-44 `ShellSandboxInfo`）。
audit 包的分类器**优先读这个结构化字段**（value → meta 回退，audit/index.ts:106-109），
纯 stderr 文本永不升级为 sandbox-denial——这条契约是 AUD-02/11 用例的判定基础。

### 文件栅栏（packages/fs/fs-sandbox/，与 confine 并行的第二道闸）
`SandboxedFileSystem` 覆写 ctx.fs 的写方法：read-only 抛 `FS_SANDBOX_DENIED`；
workspace-write 用 `writableRoots + isPathUnder`（词法快路径 + dev/ino 比对回退，
防 8.3/大小写别名与 TOCTOU）。**工具层文件操作走这道闸，shell 命令走 confine**——
两条路径都通向同一个审计账本。

## 1.4 一条命令的完整生命周期（把上面串起来）

```
模型输出 tool_call(bash, "curl …")
  │
  ├─ tools/pre-execute ──► audit 插件写 begin 记录（策略快照：mode + resolvedFrom）
  │
  ├─ tool-bash executor
  │    └─ ctx.sandbox.confine(['/bin/bash','-c','curl …'], policy)
  │         │
  │         │   ◄── hourglass 插件链在这里拦截（装饰 provider.confine）：
  │         │       rsrc:  argv → bwrap … -- prlimit --caps -- /bin/bash -c …
  │         │       read:  argv → bwrap … --tmpfs <敏感路径> -- …
  │         │       net:   argv → bwrap … --unshare-net --ro-bind proxy.sock …
  │         │                    -- /bin/sh launch.sh <原命令>
  │         │
  │         └─ LocalSandboxProvider 生成 bwrap argv（只读根 + workspace bind）
  │
  ├─ spawn(bwrap argv) ──► 内核强制：userns + mount ns + (netns) + rlimit
  │         沙箱内：launch.sh 导出 HTTP_PROXY=127.0.0.1:3128 → bridge.mjs
  │         把 TCP 转到 ro-bind 的 unix socket → 宿主侧 egress proxy 按
  │         allowlist 判定 → 放行/403，决策写 JSONL
  │
  ├─ 命令结束 → tool-bash 把 exitCode/stdout/stderr + sandbox 事实放进 value
  │
  └─ tools/result ──► audit 插件写 end 记录
        （classifyOutcome：SANDBOX_UNAVAILABLE→runner-failure；
         sandbox.denied→sandbox-denial；成功→allowed；…七类）
        账本 append 时挂 hash chain（prevHash→hash）
```

---

# 第二部分：推荐学习顺序（路线图）

> 原则：**先跑后读、先纯函数后副作用、先观察者后装饰器**。每阶段给出目标、
> 精读文件与自测问题；全部文件路径相对仓库根。

### 阶段 0：把它跑起来（半天）
- 目标：拿到一份真实运行报告，建立"证据长什么样"的直觉。
- 操作：README 安装节 → `docker build` → `hourglass-entrypoint run-all`；
  翻看 `reports/runs/compare-*/summary.md` 与 `perf-*/perf.json`。
- 自测：FS-02 的 PASS 理由是什么？为什么说它"只认副作用"？
  （答：宿主 outside 目录快照无新增文件，而非沙箱输出了什么错误文本。）

### 阶段 1：DSH 本体最小环（1 天）
- 精读（在 `D:\Aiproject\deepseek-harness`）：
  - `packages/sandbox/sandbox/src/`（seam 全部类型，≤300 行）
  - `packages/sandbox/sandbox-local/src/profiles.ts`（bwrap argv 生成）
  - `packages/core/tools/src/index.ts:143-211`（事件管线）
- 自测：confine 为什么返回 argv 而不是直接执行？非 bwrap rung 上 hourglass
  插件为什么必须拒绝而不是跳过？

### 阶段 2：@hourglass/sandbox-audit（1 天）——从它开始因为它是纯观察者
- 精读顺序：`types.ts`（词汇）→ `classify.ts`（分类优先级）→ `ledger.ts`
  （追加与 hash chain）→ `index.ts`（事件接线）
- 自测：为什么 stderr 里出现 "Permission denied" 不会升级为 sandbox-denial？
  begin/end 靠什么关联？篡改账本第 5 行会被 `verifyAuditChain` 在哪一步发现？

### 阶段 3：@hourglass/policy-ci（1 天）——纯函数，为 net 做语义准备
- 精读：`model.ts`（全文 173 行，全是纯函数）→ `replay.ts` → golden fixtures
- 自测：`normalizeHost` 拒绝哪些输入？`isPathInside('/a/../b','/a')` 结果？
  allowlist=`example.com` 时 `evil-example.com` 匹配吗？

### 阶段 4：@hourglass/sandbox-net（2 天）——最复杂的执行层插件
- 精读：`confine.ts`（argv 重写）→ `proxy.ts`（双通道代理）→ `index.ts`
  （生命周期：sweep/MOUNT_GUARD/fail-closed/unrestricted）
- 配套做：NET-02 用例端到端走一遍（cases.ts 定义 → dsh.ts adapter →
  net-service 服务端记录 → run.ts 判定）
- 自测：为什么代理 socket 要 `--ro-bind` 进沙箱而不是让沙箱直连？
  沙箱内为什么还需要一个 TCP→unix bridge？代理死了会发生什么？

### 阶段 5：read + rsrc（半天）——同型装饰器，举一反三
- 精读：`read/src/index.ts`（66 行）、`rsrc/src/index.ts`（110 行）
- 自测：tmpfs 遮蔽为什么对 symlink 别名同样有效？nproc 为什么要 uid 降权？

### 阶段 6：@hourglass/sandbox-capabilities（半天）
- 精读：`types.ts` → `static-matrix.ts` → `index.ts` 的 `finalizeEntry`
- 自测：静态存在但未运行的机制报什么状态？为什么？

### 阶段 7：对比测试框架（1-2 天）
- 精读顺序：`scripts/sandbox-compare/schema.ts`（词汇）→ `cases.ts`（43 用例）
  → `run.ts` 的 `verdict()` 家族（判定哲学的代码化）→ `net-service.ts` →
  `adapters/types.ts` + `adapters/dsh.ts`（最厚实的 adapter）→ `srt.ts`/
  `nsjail.ts`/`wasmer.ts`（机制映射差异）→ `perf.ts`
- 自测：verdict 为什么绝不读 adapter 自己声明的成败？"机制不可比"（unsupported）
  与"失败"（fail）的界线在哪？

### 阶段 8：竞品源码迁移阅读（各 1-2 天）
- 学习 hourglass 后去读竞品最对口的文件（第四部分末尾给了对照路由表）。

---

# 第三部分：逐包源码精读

## 3.1 @hourglass/sandbox-audit —— 追加式审计账本

**职责**：观察工具管线，为每次调用写 begin+end 两条关联记录；纯观察者，
永不参与 allow/deny（`ledger.ts:5-9` 注释明示：账本故障不能开安全洞）。

### 数据模型（types.ts）
- **三层事实关联**（types.ts:21-24）：
  `policy_decision`（策略说了什么）/ `backend_result`（后端实际报告了什么）/
  `os_observation`（内核层发生了什么）。P1 阶段 os 层恒为
  `{status:'unavailable'}`（types.ts:71-74）——**不伪造内核事件**是诚实性
  底线；创新点 1（cgroup 事件）正是这一层的升级路径。
- **七类拒绝分类** `DenialClass`（types.ts:40-48）：allowed / policy-deny /
  approval-deny / sandbox-denial / runner-failure / ordinary-failure /
  cancelled / unknown。
- **hash chain 字段**（types.ts:98-101）：每条记录带 `prevHash`（链到前条）与
  `hash`（自身内容摘要）。

### 分类器（classify.ts:46-70）——优先级即文档
```
1. errorCode = SANDBOX_UNAVAILABLE        → runner-failure
2. errorCode = ABORTED/ABORTED_BEFORE_DISPATCH → cancelled
3. sandbox.runnerFailed = true            → runner-failure   ┐ 结构化信号
4. sandbox.denied = true                  → sandbox-denial   ┘ （result.value.sandbox）
5. !isError                               → allowed
6. errorCode = FS_SANDBOX_DENIED          → policy-deny（fs 栅栏）
7. 错误消息含 'rejected escalating'       → approval-deny
8. 其余                                   → ordinary-failure（stderr 片段只是诊断，永不升级）
```
注意第 3/4 步：bash-sandbox 契约里**非零 exit 码可以包在成功 result 里**，
`denied=true` 才是权威事实。`extractSandboxFacts`（classify.ts:79-93）只认
形状正确的 `sandbox` 对象，否则返回 undefined（该层不可用，绝不猜）。

### 账本（ledger.ts）
- **追加 + 重建**：JSONL 每行一条；构造时从文件重建索引（重启可查，AUD-08），
  崩溃残留的撕裂末行直接丢弃（ledger.ts:159-160）。
- **hash chain 构造**（append，ledger.ts:181-201）：`prevHash` 取上一条记录的
  `hash`（首条链到全零 `GENESIS_HASH`，ledger.ts:66）；`hash` 覆盖**除自身外的
  整条记录的 JSON 原文**（含键序）——所以改字段、删行、重排都会断链。
- **验证**（verifyAuditChain，ledger.ts:88-126）：逐行检查 ①能解析 ②带链字段
  ③prevHash 链到前条 ④内容与自身 hash 一致；报告**首个**坏 seq。
  诚实边界：这是**检测性**而非抵抗性能力——有写权限的攻击者仍可破坏文件，
  但任何静默篡改都会暴露。
- **strict 模式**：写失败抛 `AuditLedgerError`（fail-loud）而非计数丢弃；
  两种模式下安全语义相同（账本从不管控执行）。

### 插件接线（index.ts）
- `tools/pre-execute`（index.ts:74-89）：写 begin（策略快照 `policySnapshot`
  会调 `ctx.get('sandboxPolicy').resolve()` 并区分 resolvedFrom：
  approved/session/configured/unavailable），同时记录调用开始时间。
- `tools/result`（index.ts:91-143）：提取信号（value.sandbox 优先、meta 回退，
  index.ts:106-109）→ 分类 → 写 end（含 durationMs 与结构化 error）。
  大量 `...(x===undefined?{}:{x})` 条件展开——**undefined 字段会破坏 registry
  的 lossless JSON 校验**（会话中实际踩过的坑）。
- 查询命令 `/sandbox-audit`（index.ts:145-189）：无参显示诊断+最近 20 条；
  JSON 过滤器支持 callId/tool/outcomeKind/分页。

### 单测看点（tests/）
`classify.spec.ts`（合成信号全覆盖七类）；`ledger.spec.ts`（strict/断行恢复/
重启续 seq/hash chain 三段式）；`audit.spec.ts`；REAL-composition loader 测试
（子进程真实起 cordis + driver，验证事件接线）。

## 3.2 @hourglass/policy-ci —— 策略语义模型与回归

**职责**：把策略语义做成**纯函数**，CI 里零网络/零模型回放决策并 diff。
它是 net 包的域名判定库，也是"策略变更不悄悄改变行为"的门禁。

### 模型（model.ts）
- `resolveMode`（:18-23）：`approvedMode > 最后一条 sandbox/mode 事件 >
  configuredMode`——镜像 DSH `SandboxPolicyService.resolve()` 的折叠顺序。
- `isPathInside`（:30-48）：纯词法 `..` 归一（不碰文件系统）+ 前缀比较；
  Windows 分隔符归一。
- `normalizeHost`（:58-79，NET-09 规范化）：拒 NUL/控制字符/带 scheme 的
  输入；剥 userinfo（`@` 后段）；`[IPv6]` 与裸 IPv6 走独立正则；尾点剥除；
  小写化；IPv4 octet 范围校验；**非法输入返回 undefined（拒绝），绝不宽松匹配**。
- `hostAllowedByAllowlist`（:82-88）：后缀子域匹配——`example.com` 放行
  `a.b.example.com`，**不放行** `evil-example.com`（必须 `.` 边界）。
- `decide`（:106-173）：结构校验失败 → `not-replayable`（永不默认放行，POL-05）；
  danger-full-access → allow；fs-write/delete/rename 按模式与 workspace 词法
  包含；fs-read 走 denyRead 树；net-request 走上面两个函数；spawn 放行但
  写约束仍适用。

### 回放与 golden
`replay.ts` 对 fixture 集做 decide，与 golden 文件字节比对；diff 输出分类
（allow→deny / deny→allow / reason-only / to-not-replayable）。
**改语义必先改 golden**——这就是"策略回归"的含义。

## 3.3 @hourglass/sandbox-net —— 网络出口强制（最复杂）

**双层模型**：OS 层内核拒绝一切直连 + 策层 allowlist 代理为唯一出口。

### argv 重写（confine.ts:94-120）
在 bwrap 参数与 `--` 之间插入：
```
--dir /tmp/.hourglass          # 挂载点必须放可写 tmpfs（只读根上建不了）
--unshare-net                  # ★ 独立 netns：直连全灭（内核级）
--ro-bind <host>/proxy.sock  /tmp/.hourglass/proxy.sock   # 代理入口只读注入
--ro-bind <host>/bridge.mjs  /tmp/.hourglass/bridge.mjs
--ro-bind <host>/launch.sh   /tmp/.hourglass/launch.sh
-- /bin/sh /tmp/.hourglass/launch.sh <原命令>
```
两个防御性拒绝：argv[0]≠bwrap（confine.ts:95-98）、找不到 `--` 分隔符
（:100-103）都抛 `SandboxUnavailableError`——**绝不猜、绝不裸奔**。

### 沙箱内三件套（confine.ts:32-73）
- `launch.sh`：导出 `HTTP(S)_PROXY=http://127.0.0.1:3128`（对一切代理感知
  客户端生效）→ 后台起 bridge → 轮询 ready 标记（上限 40×50ms，桥死快速失败）
  → `trap kill` → `exec "$@"`。
- `bridge.mjs`：netns 内 127.0.0.1:3128 → unix socket 的纯字节管道。
  **为什么需要它**：沙箱 netns 里没有网卡，唯一通道是 ro-bind 进来的 unix
  socket；但绝大多数 HTTP 客户端只认 TCP 代理 → 桥做协议形态转换。
- ready 标记写在 `/tmp/.hourglass-ready`（confine.ts:29）而非 ro-bind 目录内。

### 宿主侧代理（proxy.ts）
unix socket 上的 HTTP 代理，两种通道：
- **absolute-URI**（:59-95）：明文 `GET http://host/path` → `decideHost` 判定
  → 403 或转发（剥 proxy-connection 头）。
- **CONNECT**（:98-119）：`CONNECT host:port` → 判定 → 403 或建隧道。
- `decideHost`（:20-35）复用 policy-ci 的 `normalizeHost` + 后缀匹配；空
  allowlist = deny-all；每个决策记 JSONL（内存 + 文件双写）。

### 生命周期（index.ts）
- **unrestricted 模式零语义漂移**（:107-112）：直接 return，只把" unrestricted
  被使用"记为审计事实（AUD-15）。
- **MOUNT_GUARD**（:75,117-121）：cordis 对重复 `ctx.plugin()` 会静默启第二个
  fiber（链上第二层代理包装）——插件用 provider 上的 Symbol 自我拒绝。
- **sweepOrphanedRuntimes**（:28-63）：扫描 `hourglass-net-*` 目录，unix socket
  探测连接：能连上=活会话（并发场景不能误删），连不上=崩溃孤儿 → 删除。
  首个 confine `await sweep`（:144）。
- **confine 替换**（:141-152）：先 `existsSync(socketPath)` fail-closed 检查
  （代理死了拒绝一切执行），再调原 confine 并重写 argv。
- **dispose**（:161-168）：恢复原方法、清 MOUNT_GUARD、同步 rm runtime 目录。

## 3.4 @hourglass/sandbox-read —— 敏感读遮蔽

全包 66 行。核心一段（read/index.ts:48-50）：
```ts
for (const denied of denyRead) bwrapArgs.push('--tmpfs', denied)
```
**为什么这就够了**：mount 按解析后路径生效——symlink/硬链接先解析到真实路径，
再命中遮蔽挂载（FS-12 用例：symlink 别名读，内容零泄漏）。默认空集 = opt-in；
非 bwrap rung fail-closed（与 net 同型，:37-44）。

## 3.5 @hourglass/sandbox-rsrc —— 资源配额

**机制**：在 bwrap 的 `--` 之后、原命令之前插 `prlimit` 前缀
（rsrc/index.ts:83）：
```
bwrap … -- prlimit --nproc=8 --as=… --cpu=… --fsize=… --nofile=… -- <命令>
```
prlimit 设置的是**硬上限**，子孙进程全部继承；超限由内核拒绝（malloc 失败/
fork: retry/SIGXFSZ/SIGKILL）。

**RES-04 的内核坑与降权解法**（index.ts:52-97）：RLIMIT_NPROC 按 real-UID 计数，
且内核对持 `CAP_SYS_ADMIN/CAP_SYS_RESOURCE` 的进程**豁免** fork 检查——而
userns 里的 root 恰好有 CAP_SYS_ADMIN。解法：配置了 nproc 时额外包一层
`setpriv --reuid=65534 --regid=65534 --clear-groups`（NPROC_DROP_UID，:59），
降到无 capability 的 nobody 使限制真实生效。**代价声明**：沙箱内进程从此需要
普通文件权限才能写（这是 ADR-002 记录的取舍，也是创新点 1 想消除的）。

## 3.6 @hourglass/sandbox-capabilities —— 能力清单

- **词汇**（types.ts）：5 能力（fileRead/fileWrite/netEgress/resourceLimits/
  processControl）× 5 后端（bwrap/landlock/seatbelt/windows-acl/none）；
  状态四档 enforced/partial/absent/**unknown**。
- **静态矩阵**（static-matrix.ts）：每格带 `evidenceRef`（指向 DSH 源码路径
  @ commit）与 note（具体机制或其缺失），如 bwrap.netEgress = absent，
  注明 "no --unshare-net … in bwrapProfileArgs"。
- **诚实规则**（index.ts:43-60 `finalizeEntry`）：`enforced` 只有在 **probe 真的
  跑过** 或 **test-result（compare 用例）覆盖** 时保留；静态存在未运行 → 降级
  `unknown` 并保留 note。**"配置了"不是"生效了"**——这是整个项目证据观的浓缩。

## 3.7 对比测试框架（scripts/sandbox-compare/）

**判定哲学的代码化**（run.ts `verdict()` 家族，:93-244）：期望 blocked 的用例
只看外部世界证据——`file-must-not-exist`（宿主快照差分）、`no-server-request`
（服务端 canary 计数）、`limit-enforced`（内核资源错误信号）、`wall-clock`、
`cancel-converge`（pgrep -x 计数）、`crash-cleanup`、`dup-rejected`、
`tamper-detected`、`fact-chain`。adapter 返回的 stdout/stderr 只进证据链
（`stdoutTail/stderrTail`），**永不单独作为判据**。

其余组件：
- `net-service.ts`：受控本地 HTTP 服务（allow/deny 双域名），记录每个请求的
  host/path/canary；监听 0.0.0.0（SRT 的 SSRF 防护拒 loopback 上游）。
- `cases.ts`：43 用例 = 攻击语义词典；`appliesTo` 决定哪个 subject 可比。
- `adapters/`：`SubjectAdapter` 契约（available + execute → RawExecution）；
  dsh.ts 最厚（driver 子进程 + stdin JSON 协议 + 特殊 case 分支 RES-07/08、
  ROB-02/05/06、NET-13/14）；srt/nsjail 是 CLI 映射；wasmer 是 WASI 固件载体；
  cube 是证据化 not-run。
- `perf.ts`：30 次采样 median/p95 + 相对 bare 倍数。
- `versions.lock.json` + `validate-versions-lock.ts`：版本锚与声明（不可比
  必须逐条声明理由）；报告引用锁文件 sha256 → 静默漂移可检测。
- 固件：`fixtures-wasm/fs_probe.zig`（zig 编译为 WASI preview1，标记语言与
  判定正则同构：WROTE/ALLOC_OK/"No such file"/"Too many open files"…）。

---

# 第四部分：与竞品的机制对照

> 完整七维度分析见 [competitive-analysis.md](competitive-analysis.md)；这里按
> **机制实现**对照，服务于源码学习。

## 4.1 同一能力，五种实现

| 能力 | hourglass（DSH-PLUGIN） | SRT 0.0.79 | nsjail 3.6 | wasmer 7.3 | CubeSandbox |
|---|---|---|---|---|---|
| **文件写边界** | DSH bwrap 只读根 + workspace bind（profiles.ts）；插件不改 | 同型：`--ro-bind / /` + allowWrite `--bind` 恢复（linux-sandbox-utils.ts:2429,2493） | `-R /` 只读根 + `-B` 恢复写 | 能力模型：不 `--volume` 即不存在（virtual-fs inode 树，path_open.rs:29-79） | CoW 卷（XFS reflink FICLONE 克隆 rootfs） |
| **敏感读保护** | `--tmpfs` 遮蔽（read/index.ts:48-50） | 同型：denyRead 目录 tmpfs 覆盖 + allowRead 再 ro-bind 恢复（linux-sandbox-utils.ts:1999,2056）；**进化**：不存在的 deny 路径先造 mount point + 祖先 pin 防 mv/rmdir 绕过 | 无机制（unsupported） | 无（映射卷下无子路径 deny） | 无对应概念（VM 内文件系统整体私有） |
| **网络出口** | `--unshare-net` + ro-bind unix socket + 沙箱内 TCP 桥 + host 代理（confine.ts） | 同型双 hop：bind socket + **socat** 桥 3128/1080（linux-sandbox-utils.ts:3690-3739）；**进化**：TLS MITM/凭据注入/SSRF resolved-address-guard（无 TOCTOU，拒云元数据段）/外部 decider 协议 | netns 全断，**无法表达 allowlist**（机制差异） | WASIX socket 由 `--net=<ruleset>` 门控（dns/ipv4/ipv6 × allow/deny，ruleset.rs）；preview1 无 socket | eBPF 交换机 + 强制拒绝网段（10/8、169.254/16…不可配置绕过）+ CubeEgress L7 MITM 默认拒绝 |
| **资源配额** | prlimit 前缀注入 + setpriv 降权攻 nproc（rsrc/index.ts） | **无配置面**（unsupported） | 原生 rlimit 参数（--rlimit_as 单位是 MB！踩坑记录）；nproc 同样被 CAP 豁免且无降权通道 | CLI 无；嵌入层有 fuel metering（middlewares/metering.rs）与 LimitingTunables | VM 尺寸即硬配额（vCPU/内存，config.rs:161-171）+ virtio 限速 + 毫核调度 |
| **审计** | hash-chain 账本 + 三层事实关联 + 七类分类（audit 包） | ViolationStore（面向**模型反馈**：`<sandbox_violations>` 注入 stderr，无防篡改链） | 无 | 无 | CubeEgress JSONL 三级（none/metadata/full）+ secret 写前脱敏 |
| **生命周期** | sweep 孤儿（socket 探活）+ MOUNT_GUARD + die-with-parent 实测收敛 | `--new-session --die-with-parent` + stale mount point 清理 | `--mode o` 一次性 | journal 快照（--snapshot-on firstlisten 加速冷启动） | **最强**：暂停/恢复（~42ms）/快照/回滚/克隆；模板内存快照启动 47.8ms（官方） |
| **fail-closed 纪律** | 非 bwrap 拒绝、代理死拒绝、空 allowlist=deny-all、重复挂载拒绝 | 坏配置拒跑、decider 死全 503、WFP 行为级验证 | —（无策略层） | 非 TTY 网络询问即拒 | 出站无规则即拒；鉴权默认全放（需显式配 auth-callback，注意） |

## 4.2 学习迁移路由（读完 hourglass 后去读竞品哪里）

| 你刚读完的 hourglass 代码 | 最对口的竞品源码 | 对照收获 |
|---|---|---|
| net/confine.ts（argv 重写+桥） | SRT `src/sandbox/linux-sandbox-utils.ts:3604-3898` | 同型双 hop，但 SRT 用 socat 而非自写 bridge；看它如何处理凭据随代理变量传递 |
| net/proxy.ts（HTTP 代理） | SRT `src/sandbox/mux-proxy.ts` + `request-filter.ts` + `resolved-address-guard.ts` | mux 单端口判别协议、SSRF 地址守卫的无 TOCTOU 拨号、云元数据内置拒绝集 |
| read/index.ts（tmpfs 遮蔽） | SRT `linux-sandbox-utils.ts:1999-2076` | denyRead glob 展开、祖先 mount-point pin 防 mv 绕过、不存在路径的 mount point 制造 |
| rsrc/index.ts（prlimit+降权） | nsjail `run_config` 的 rlimit 族；Cube `CubeShim/.../config.rs:161-171` | 三种配额哲学：rlimit vs VM 尺寸 vs 池化调度 |
| audit/classify.ts（信号分类） | SRT `sandbox-violation-store.ts` + deny reason 消毒传递 | "事实分类"与"模型可读归因"两种产品化方向（创新点 2 的素材） |
| compare/run.ts（外部证据判定） | SRT `test/`（2330 用例的对抗性命名：symlink-boundary、tunnel-cap-refusal…） | 用例语义学：如何给攻击起名字并断言副作用 |
| 无对应（快照/回滚） | Cube `docs/architecture/overview.md` + `cubecow/` | 模板内存快照 + reflink CoW 的"快照经济学"（创新点 3 的素材） |
| 无对应（能力沙箱范式） | wasmer `lib/virtual-fs/src/builder.rs` + `lib/wasix/src/syscalls/wasi/path_open.rs` | 默认 memfs 根、inode 树路径解析——结构性隔离 vs 策略性隔离 |

## 4.3 一张定位图

```
隔离强度 ▲
         │  CubeSandbox（KVM 独立内核，多租户池，重部署）
         │  nsjail（namespace 强隔离，无策略语义）
         │  ─────────────────────────────────────────
         │  SRT ≈ hourglass（OS 原语 + 策略层；SRT 三平台/深度网络治理，
         │       hourglass 审计账本/策略回归/能力清单）
         │  ─────────────────────────────────────────
         │  wasmer（进程内能力沙箱，负载须 wasm 化）
         └──────────────────────────────────────────────► 治理/可观测能力
        （hourglass 的差异化集中在右端：hash-chain 审计 + 证据化能力清单 + policy CI）
```

---

# 第五部分：动手练习（由浅入深）

1. **读账本**：run-all 后用 `/sandbox-audit '{"outcomeKind":"sandbox-denial"}'`
   查被拒调用；找到对应 begin 记录，核对 policy.resolvedFrom。
2. **验证链**：手工篡改 JSONL 第 5 行的一个字段，跑 `verifyAuditChain`，
   观察 firstBadSeq；再删一行，观察"断链"与"篡改"的 reason 差异。
3. **语义回归**：给 policy-ci 新增 fixture（如 userinfo 绕过
   `user:pass@evil.com`），跑 replay 看 golden diff 流程。
4. **写一个用例**：模仿 FS-07 在 cases.ts 增加"写 /proc/self/mem"类攻击，
   跑通 5 个 subject，体会 appliesTo 的取舍。
5. **读懂桥**：在容器里手动复刻 net 链路——起 proxy.ts 的代理、bwrap
   --unshare-net --ro-bind …，curl 验证 allow/deny；然后拔掉 socket 验证
   fail-closed。
6. **探 nproc 坑**：容器里跑 `unshare -Ur bash -c 'ulimit -u 8; …fork 循环'`
   观察豁免；再加 setpriv 降权对比（RES-04 的第一手复现）。
7. **加一个 subject**：照 wasmer.ts 模式给 wasmtime（或 firecracker）写 adapter，
   available() 探测 + carrier 映射 + unsupported 声明进 versions.lock。
8. **创新点 1 起步**：在 rsrc 包加 cgroup v2 后端（per-call cgroup 目录 +
  pids.max/cpu.max/memory.max + 结束销毁），先让 RES-04 在无降权下通过。
9. **创新点 2 起步**：在 audit/index.ts 的 tools/result 监听里，把
  outcome.kind + policy-ci 的 reason 组装成结构化 `sandbox_denial` 附加到
  result.meta，并新增一个 AUD case 断言该字段。
10. **竞品走读**：按 §4.2 路由表通读 SRT 的 linux-sandbox-utils.ts 主流程，
    画出它的"每命令进程链"（sh→bwrap→sh→apply-seccomp→命令 + 双 socat），
    与本文 §1.4 的 hourglass 链对比。

---

# 附录 A：术语表

| 术语 | 含义 |
|---|---|
| rung / chain | DSH 按平台排列的后端优先级（linux: bwrap→landlock） |
| confine | DSH 把命令 argv 变成沙箱 argv 的动作（返回 argv，不执行） |
| ConfinedArgv | confine 的返回：argv + enforcement + denialSignatures |
| 装饰器模式 | 插件替换 provider.confine，调用原实现后二次改写 argv（net/read/rsrc 共用） |
| fail-closed | 机制不可用时拒绝执行（SandboxUnavailableError），绝不静默放行 |
| canary | 合成令牌（DSH_SYNTHETIC_CANARY_*），出现在服务端=泄漏发生 |
| 快照差分 | 判定用：执行前后对宿主目录做 SHA-256 清单对比 |
| hash chain | 每条审计记录链到前条哈希；篡改/删行/重排皆可检出 |
| 三层事实 | policy_decision / backend_result / os_observation |
| unsupported vs fail | 机制不可比（如实声明）vs 应阻断而未阻断（真实缺口） |
| not-run | 环境不满足（凭证/硬件），记录原因，永不计 PASS |

# 附录 B：关键文件索引

```
packages/audit/src/types.ts        记录 schema、三层事实、七类分类、链字段
packages/audit/src/classify.ts     classifyOutcome 优先级、extractSandboxFacts
packages/audit/src/ledger.ts       JSONL 追加、hash chain 构造/验证、断行恢复
packages/audit/src/index.ts        事件接线（begin/end）+ /sandbox-audit 命令
packages/policy-ci/src/model.ts    resolveMode/isPathInside/normalizeHost/decide
packages/policy-ci/src/replay.ts   fixture 回放与 golden diff
packages/net/src/confine.ts        argv 重写、launcher/bridge 脚本、常量
packages/net/src/proxy.ts          unix socket HTTP 代理（CONNECT+absolute-URI）
packages/net/src/index.ts          生命周期：sweep/MOUNT_GUARD/fail-closed/unrestricted
packages/read/src/index.ts         tmpfs 遮蔽装饰器（66 行）
packages/rsrc/src/index.ts         prlimit 注入 + NPROC uid 降权
packages/capabilities/src/*        静态矩阵 + 诚实规则 + /sandbox-capabilities
scripts/sandbox-compare/schema.ts  用例/主体/判定词汇
scripts/sandbox-compare/cases.ts   43 用例定义（攻击语义词典）
scripts/sandbox-compare/run.ts     runner + verdict() 家族（判定哲学）
scripts/sandbox-compare/adapters/  6 个 subject 适配器（dsh 最厚）
scripts/sandbox-compare/net-service.ts  canary 记录服务
scripts/sandbox-compare/fixtures-wasm/fs_probe.zig  WASI 探针固件
scripts/sandbox-compare/versions.lock.json  版本锚 + 不可比声明
docker/Dockerfile                  三阶段镜像（tools→dsh→test）
docker/entrypoint.sh               gates/unit/compare*/perf/rob04/run-all
docs/ADR-001, ADR-002              范围决策 / 配额阈值依据
docs/competitive-analysis.md       竞品分析全文（file:line 证据）
```

> 学习完成的检验标准：你能不看资料画出 §1.4 的命令生命周期图，说清
> "为什么判定只认外部证据"，并解释 MOUNT_GUARD 防的是什么并发缺陷。
