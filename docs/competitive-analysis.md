# 竞品分析：sandbox-runtime / wasmer / CubeSandbox × hourglass

> 会话：2026-10-17（竞品扩展轮）
> 方法：三份源码级深度调研（本地 clone：`D:\Aiproject\sandbox-runtime` @ v0.0.80、
> `D:\Aiproject\wasmer` @ v7.5.0+65、`D:\Aiproject\CubeSandbox` @ v0.7.3+14），
> 全部结论给出 file:line 证据；实验对比在本地 Docker privileged 容器内执行
> （框架：`scripts/sandbox-compare/`，版本锁：`versions.lock.json`）。
> 注：实验 lane 锁定 SRT **0.0.79**（npm）与 wasmer **7.3.0**（官方二进制——
> v7.4+ 要求 GLIBC 2.38+，超出 bookworm 基镜像）；源码分析基于更新的树
> （0.0.80 / 7.5.0+65），差异处单独标注。

## 0. 一句话定位

| 项目 | 一句话定位 | 隔离等级 |
|---|---|---|
| **sandbox-runtime (SRT)** | Anthropic 的"OS 原语包装器 + 进程内智能代理"：seatbelt/bwrap/WFP 三平台一致策略语义，为 Claude Code 等 AI agent 服务 | 进程级（OS 原语组合） |
| **wasmer** | WebAssembly 运行时，"轻量沙箱 for apps and AI agents"：能力沙箱 + WASIX 扩展 | 进程内（结构隔离，无 syscall 面） |
| **CubeSandbox** | 腾讯开源的 KVM MicroVM 沙箱池：模板内存快照 + XFS reflink CoW，E2B 兼容 API，多租户 | 硬件级（独立内核） |
| **hourglass (DSH-PLUGIN)** | DSH 治理插件：在既有 bwrap 隔离之上叠加审计账本 / 网络出口 / 读保护 / 资源配额 / 能力清单 / 策略回归 | 进程级（复用 DSH bwrap）+ 治理层 |

四个项目不在同一层：SRT 与 hourglass 同层（进程级 + 策略），wasmer 是另一种
隔离范式（能力模型），Cube 是更重的硬件隔离 + 服务化。可比性在于**同一组攻击
语义用例**（FS/NET/RES/ROB）下的真实副作用判定，与治理能力的产品化程度。

---

## 1. anthropics/sandbox-runtime（SRT）

**版本**：0.0.80（本地 clone，2026-10-16）；实验 lane 为 npm 0.0.79。TypeScript
（Node ≥22.12），Apache-2.0，"Beta Research Preview"。约一年 875 commits / 20 个
tagged 版本（约每 1-2 周一版），30+ 贡献者（Anthropic 员工为主）。运行时 npm
依赖仅 4 个（commander/zod/node-forge/socks5-server）。

### 架构
- **无 daemon，单进程模型**：`srt` 每次运行是一个前台 Node 进程；库形态
  `SandboxManager.initialize()` 在同进程内启动网络代理与违规监控器，
  `wrapWithSandbox()` 返回 shell 字符串由调用方 spawn（`src/sandbox/sandbox-manager.ts`，
  3149 行）。
- 核心模块：CLI（`src/cli.ts` 616 行）、Linux 后端（`linux-sandbox-utils.ts` 3930 行）、
  macOS 后端（`macos-sandbox-utils.ts` 1725 行）、Windows 后端
  （`windows-sandbox-utils.ts` 2457 行 + Rust 助手 `vendor/srt-win-src` 23 模块）、
  网络栈（mux/http/socks/tls-terminate 代理 + MITM CA + 请求过滤 + SSRF 地址守卫）。
- 配置模型 `~/.srt-settings.json`（zod 校验）：filesystem（denyRead/allowRead/
  allowWrite/denyWrite）、network（allowedDomains/deniedDomains/…）、credentials
  （envVars/files，deny|mask）、violation 忽略、若干显式弱化开关；支持
  `--control-fd` 运行中热更（仅网络类键）。

### 隔离机制
- **Linux**：bwrap `--ro-bind / /` 整树只读起步；写用 `--bind` 恢复、denyRead 用
  `--tmpfs` 遮蔽（与 hourglass P2b 同型）；`--unshare-net` + bind 挂载的 unix
  socket 代理 + 沙箱内 socat 桥（与 hourglass P2a 同型）；`--unshare-pid
  --unshare-user --cap-drop ALL`；seccomp 二段式：嵌套 userns 的 PID1 装 BPF，
  封 `socket(AF_UNIX/AF_VSOCK)`、io_uring（防 IORING_OP_SOCKET 绕过）、以及
  0.0.80 新增的 namespaces 过滤器（unshare/setns/mount/pivot_root 等 → EPERM，
  `vendor/seccomp-src/seccomp-unix-block.c`）。
- **macOS**：Seatbelt SBPL 动态生成（deny default 起步 + 必备许可），deny 路径
  附 `file-write-unlink` 防改名绕过；读 deny-then-allow、写 allow-only——与
  hourglass 读写两方向策略相反的优先级设计（allow 优先读 / deny 优先写）。
- **Windows**（alpha）：`srt-sandbox` 独立账户 + WFP 双过滤器（ALE_AUTH_CONNECT
  层 loopback 代理区间 PERMIT + 该 SID 全部 connect BLOCK）+ 只加性 NTFS ACE；
  `initialize()` 做**行为级** WFP 围栏验证，失败即抛错（fail-closed）。
- **强制 deny 自保护**（不可配置移除）：`.bashrc`/`.gitconfig`/`.git/hooks`/
  `.mcp.json`/`.claude/commands` 等运营路径默认写保护，Linux 上用 ripgrep 扫描
  allowWrite 树内嵌套危险路径（深度默认 3）。

### 优缺点小结
**优点**
1. 三平台一致策略语义（同一份 srt-settings 跨 darwin/linux/win32），这是四者中
   唯一做到的；
2. fail-closed 纪律贯穿（空/坏配置拒跑、代理死亡 503、ask 非 true 即拒、WFP
   行为级验证）；
3. 网络治理深度第一：域名策略 + TLS MITM（凭据 mask/inject、AWS SigV4 重签）+
   SSRF 解析地址守卫（无二次解析 TOCTOU、云元数据端点内置拒绝集）+ 外部 decider
   协议；
4. 模型可读的违规归因：`<sandbox_violations>` 注入 stderr、deny reason 全程
   消毒传递（SSH 带内）；
5. 文档与测试密度罕见地高（README 1082 行；2330 个测试 + 10 个属性测试，覆盖
   symlink 逃逸/命名空间逃逸/glob 拼写攻击/SSRF/凭据外泄等对抗场景）。

**缺点**
1. Linux 每命令 wrap 成本随策略规模增长：ripgrep 扫描 allowWrite 树 + denyRead
   glob 展开遍历整树（官方注释直言大树可到秒级）；
2. Windows alpha 缺口多（per-exec 读写路径、DNS 未围栏、代理 token 在 argv 可见）；
3. 无资源配额面（rlimit/cgroup 均未暴露）——实验 lane RES 全部 unsupported；
4. 无审计账本概念（违规记录面向模型反馈，非防篡改证据链）；
5. 仓库无 CHANGELOG、无独立 benchmark 数据。

---

## 2. wasmerio/wasmer

**版本**：源码 clone 为 v7.5.0+65（2026-10-15）；实验 lane 锁定 **v7.3.0** 官方
二进制（v7.4+ 构建于 ubuntu-24.04，要求 GLIBC 2.38+，超出 bookworm 基镜像——
这本身是二进制分发兼容性的一个竞品观察点）。
Rust（edition 2024），MIT。20,988 commits（2018 起），极度活跃。定位已从通用
wasm 运行时转向 "Lightweight sandboxes for your apps and AI agents"。

### 架构
- Workspace 分层：`lib/api`（sys/v8/js 三 flavor）、`lib/cli`、编译器三后端
  （Singlepass/Cranelift/LLVM + V8 运行时）、`lib/vm`（trap/mmap/中断注册表）、
  `lib/wasix`（WASI preview1 + 约 100 个 WASIX 扩展 syscall）、`lib/journal`
  （快照/恢复）、**`lib/virtual-fs` / `lib/virtual-net`（沙箱边界的核心抽象）**。
- CLI 命令面：run/compile/validate/inspect/cache + 包管理（registry 取代已退役的
  WAPM）+ Wasmer Edge 云（deploy/app/cron/ssh）。`create-exe` 已删除，AOT 产物是
  `.wasmu` 序列化预编译件（支持 `--target` 交叉）。
- 运行形态：**同进程内嵌**——host 进程实例化模块，guest 代码只能调用宿主注册的
  导入函数；WASM 线性内存边界由编译后代码硬件保证。

### 隔离机制（对对比测试关键）
- **能力沙箱模型**：默认 guest 的 `/` 是 `RootFileSystemBuilder` 造的**虚拟内存
  根**（memfs + /dev + 虚拟 wasmer 命令），不含任何宿主目录——默认拒绝；
  `--volume HOST:GUEST` 显式授予（旧 `--dir`/`--mapdir` 兼容但弃用）；
  `path_open` 全部在 virtual-fs 的 inode 树上解析（`lib/wasix/src/syscalls/wasi/path_open.rs:29-79`），
  路径逃逸出预打开集合无路径可达宿主。
- **网络**：WASIX socket 面（sock_* 全套）由 CLI 门控：不带 `--net` 时
  `AskingNetworking` 交互询问（非 TTY 即拒），`--net` 直通，`--net=<ruleset>`
  按 `dns/ipv4/ipv6 × allow/deny` 规则过滤（`lib/virtual-net/src/ruleset.rs`）；
  另有独立的 `--http-client` 能力。**WASI preview1（本实验 fixture 的目标）没有
  socket 导入——网络攻击面结构性不存在。**
- **资源治理**：燃料计量（`lib/middlewares/src/metering.rs`）与内存上限
  （`LimitingTunables`，examples/tunables_limit_memory.rs）**均为嵌入层 API，CLI
  不暴露**——这本身是重要竞品结论：治理面留给嵌入方。
- 快照/恢复（journal）：`--snapshot-on firstlisten/firststdin/firstenviron`
  明确用于加速冷启动。

### 优缺点小结
**优点**
1. 结构隔离强度高于任何 OS 原语组合：guest 无 syscall 直通面，攻击面=宿主注册
   的导入函数集合本身；
2. 跨平台一致（linux/mac/windows 全支持，含 iOS via SDK）；
3. 启动开销小（进程内实例化，无 namespace/syscall 重排），支持预编译与 journal
   快照进一步压缩；
4. 能力显式授予模型天然最小权限（不映射即不存在）；
5. 引擎层有确定性与计量钩子（fuel metering、deterministic 编译测试）。

**缺点**
1. **负载必须 wasm 化**——对"运行任意 shell 命令"的 LLM agent 场景不可用
   （bash.wasm 类载体损耗大且生态退潮）；
2. CLI 治理面缺失：资源上限/计量全部要嵌入集成，命令行用户拿不到；
3. WASIX 是自家扩展而非标准（preview2/component model 未支持），生态分叉；
4. 审计/可观测性为零（无违规日志、无账本概念）；
5. 默认交互式网络询问在非 TTY 环境的行为对自动化不友好。

---

## 3. TencentCloud/CubeSandbox

**版本**：v0.7.3+14（master e0c1820，2026-10-16）。Rust + Go + OpenResty/Lua +
eBPF C 多语言，Apache-2.0，CNCF Landscape 收录。**实验 lane 为证据支撑的 not-run**
（见 §5）。

### 架构
- **控制面/数据面分离的多租户沙箱池**：Client --E2B REST--> CubeAPI（Rust/Axum，
  :3000）--gRPC--> CubeMaster（Go，调度）--> Cubelet（Go，节点代理，内嵌
  containerd）--> CubeShim（Rust，containerd shim v2，kata fork）--> CubeHypervisor
  （Rust，Cloud Hypervisor fork）--> MicroVM；Redis 为元数据 single source of
  truth，MySQL 持久化。
- **沙箱创建 = 从模板快照恢复**：模板构建 = OCI 镜像 → 临时 VM 冷启动 → HTTP
  probe 等**应用初始化完成**（进程/内存级预热）→ 冻结文件系统+内存为快照；运行时
  Cubelet 用 CubeCoW 的 XFS reflink `FICLONE` O(1) 克隆 rootfs、CubeShim
  `restore_vm()` 恢复内存快照——这是亚百毫秒冷启动的根源。
- 节点级资源池：TAP 设备预建池（默认 500）、cgroup 对象池、reflink 池；
  暂停态"零 CPU/内存成本"；soft-dirty 增量快照。

### 隔离机制
- 每沙箱独立 Linux 内核（KVM MicroVM）+ VMM seccomp 最小系统面；
- 网络：每沙箱独立 TAP + CubeVS（3 个 eBPF 程序内核态转发）+ 强制拒绝网段
  （10/8、127/8、169.254/16、172.16/12、192.168/16 不可配置绕过）+ DNS 学习式
  域名策略 + CubeEgress（OpenResty TPROXY + TLS MITM，L7 出站**默认拒绝**）；
- 文件：CoW 卷 + Volume 框架（s3/cos/host-mount/nfs 插件）；
- 资源：硬配额=VM 尺寸（vCPU/内存模板定义，毫核粒度）+ virtio 限速 + 节点调度
  配额；
- 审计：CubeEgress 每请求 JSONL（三级 none/metadata/full），secret 写日志前脱敏；
  凭证托管在代理侧注入（沙箱内不可见）。

### 优缺点小结
**优点**
1. 硬件级多租户隔离（独立内核），四者中最强隔离边界；
2. 性能工程化最深的冷启动路径：模板内存快照 + reflink + 对象池——官方基准
   创建 47.8ms 单并发 / 180.9/s 吞吐（20 并发，裸金属），从快照恢复 63.9ms；
3. 完整产品化：E2B 兼容 REST + 三语 SDK + WebUI + Helm/K8s + 模板中心；
4. 治理细节成熟：出站 fail-closed、强制拒绝网段、暂停/恢复/快照/回滚/克隆
   生命周期、per-sandbox 访问 token。

**缺点**
1. 部署门槛高：硬性要求 /dev/kvm + XFS(reflink) 数据卷 + systemd + cgroup v2
   （installer 直接 die）——单机 Docker/普通容器环境不可运行；
2. 资源重量级：即便 CoW 摊薄，每实例实摊 ~21.5-25.7MB + VM 开销预留；
3. 非云原生 K8s 对象（Big Pod + hostNetwork DaemonSet + CoreDNS patch），
   与既有集群治理模型有摩擦；
4. 命令执行链路长（CubeProxy→envd Connect RPC），首命令延迟 ≠ 创建延迟；
5. 腾讯生态软绑定（镜像仓库/PVM 内核/Terraform）。

---

## 4. hourglass 现状（对比基线）

六个包（audit / net / read / rsrc / capabilities / policy-ci），DSH 仓库零修改，
在 bwrap rung 之上叠加：网络出口（--unshare-net + allowlist 代理，fail-closed）、
敏感读遮蔽（tmpfs）、prlimit 资源配额（nproc 配 setpriv 降权）、追加式审计账本
（hash chain + 三层事实关联）、能力清单（enforced 必须有 test-result 证据）、
策略回归 CI。v18 矩阵 43 case × 4 subject：DSH-PLUGIN 42/1/0（唯一 fail =
NET-13 有意暴露的 Harness 代调用边界且已审计）。

## 5. 逐维度对比

| 维度 | SRT 0.0.79 | wasmer 7.3.0 | CubeSandbox 0.7.3 | **hourglass (DSH-PLUGIN)** |
|---|---|---|---|---|
| **架构** | 单进程包装器+进程内代理；无 daemon | 进程内嵌入运行时；CLI+SDK | 控制面/数据面分离的 VM 池服务 | DSH 插件（cordis fiber）；宿主侧代理+装饰器 |
| **隔离机制** | bwrap/seatbelt/WFP + seccomp 二段式 | WASM 能力模型（无 syscall 面） | KVM 独立内核 + eBPF + L7 MITM | 复用 DSH bwrap；net/read/rsrc 装饰器叠加 |
| **文件策略** | ro-root + bind 恢复写 + tmpfs 遮蔽读；强制 deny 自保护清单 | --volume 显式授予；默认 memfs 根 | CoW 卷 + volume 插件 | workspace-write + tmpfs 遮蔽（同型 SRT） |
| **网络策略** | 域名 allow/deny + TLS MITM + SSRF 守卫 + 凭据注入 | --net ruleset（WASIX）/preview1 无 socket | eBPF + 强制拒绝网段 + L7 默认拒绝 | --unshare-net + allowlist 代理（域名级） |
| **资源配额** | ✗ 无配置面 | 嵌入层有（fuel/内存 Tunables），CLI ✗ | VM 尺寸硬配额 + 毫核调度 | prlimit 五项（nproc 需 uid 降权） |
| **审计/证据** | 违规 store（面向模型反馈） | ✗ | egress JSONL 三级 + 脱敏 | **hash-chain 账本 + 三层事实关联 + 能力清单** |
| **性能开销**（本地实测/官方） | 288ms median（本地） | 见 PERF 章节（本地实测） | 47.8ms 创建（官方，裸金属；本地不可复现） | 243ms median；审计 append 0.011ms/条 |
| **平台** | linux+darwin 成熟，win32 alpha | linux/mac/win + iOS SDK | 仅 Linux（KVM+x86_64/arm64） | 仅 Linux（DSH bwrap rung） |
| **负载形态** | 任意命令 | 仅 wasm 模块 | 任意命令（VM 内） | 任意命令（DSH 会话） |
| **部署/集成** | npm -g；Claude Code/MCP 包装 | curl/npm 安装；SDK 四语言 | 一键脚本/Helm/TF；E2B SDK 零改动 | pnpm workspace 插件（六包，DSH 零修改） |
| **多租户** | ✗（单用户桌面语义） | ✗ | ✓（池化+配额+配额隔离） | ✗（单会话语义） |
| **策略回归** | ✗ | ✗ | ✗ | ✓ policy-ci（golden 回放 diff） |

## 6. hourglass 的差距与可提升功能点

按"已实测的缺口 → 竞品已验证的解法"归纳：

**G1 资源治理停留在 rlimit，进程数限制依赖 uid 降权Hack**（实测 RES-04：userns
内 CAP_SYS_ADMIN 豁免 RLIMIT_NPROC，解法是 setpriv 降权，代价是权限模型变化）。
SRT 无配额面、wasmer 配额在嵌入层、Cube 用 VM 尺寸+调度配额。**提升点：cgroup v2
per-call 配额（pids/cpu/memory），final-report 下一步建议 #1 的正式化。**

**G2 无模型可读的违规归因**。审计账本面向事后取证，但拒绝发生时模型只看到命令
失败。SRT 的 `<sandbox_violations>` 注入 + deniedDomainReasons 把"为什么被拒"
带回模型，形成自我纠正闭环。**提升点：把 audit 分类与 policy-ci reason 在
result hook 注入结构化归因。**

**G3 无强制自保护清单**。SRT 默认写保护 .bashrc/.git/hooks/.mcp.json 等持久化
路径（含 ripgrep 扫描 allowWrite 树内嵌套危险路径）；hourglass 的 readDeny 默认
空集、无运营路径自保护。**提升点：内置 deny-write 清单 + 嵌套扫描（可选）。**

**G4 会话生命周期无快照/回滚/预热**。Cube 的模板快照（内存级预热 + reflink CoW）
与运行中快照/回滚是 agent 试错场景的刚需；hourglass 每次冷启动、误操作不可逆。
**提升点：workspace 快照 + 增量回滚，账本锚定回滚事件。**

**G5 网络治理缺 SSRF 地址守卫与凭据治理**。SRT 的 resolved-address-guard（无
TOCTOU、云元数据端点内置拒绝）与凭据 mask/inject 是同层可直接借鉴的能力；
hourglass 的 NET 层只有域名判定（虽 NET-04 IP 直连已被 --unshare-net 兜底）。

**G6 平台覆盖仅 Linux**。SRT 三平台一致的代价是三套后端；hourglass 依赖 DSH 的
bwrap rung。短期不追平台，长期若 DSH 增加 darwin/win32 rung，策略层语义模型
（policy-ci）已是平台无关的资产。

**G7 配额阈值与观测**。ADR-002 已定阈值依据，但无运行期资源观测（Cube 有
resource metrics API；SRT 有 RSS 上报）。提升点：confine 结束时把 rlimit 命中
事件写入账本（os_observation 层的诚实升级路径）。

## 7. 创新点（基于以上对比结论）

### 创新 1：cgroup v2 per-call 配额墙（对齐竞品资源治理，解决 RES-04 边界）
- **价值**：进程数/CPU/内存的内核级硬限制不再依赖 rlimit+uid 降权组合（G1）；
  cgroup pids 控制器不受 CAP_SYS_ADMIN 豁免影响，是 RES-04 的唯一无降权解法；
  同时获得竞品对等的资源治理叙事（Cube=VM 尺寸，SRT=无，hourglass=cgroup v2）。
- **思路**：`@hourglass/sandbox-rsrc` 增加可选 cgroup 后端：confine 前在
  `system.slice/hourglass-<callId>` 创建 cgroup（pids.max/cpu.max/memory.max），
  将 bwrap 进程迁入，调用结束销毁；容器 privileged 前提下已验证可写 cgroupfs。
  降权路径保留为兼容回退。配额命中（OOM/pids 拒绝）通过账本 end 记录
  `os_observation=cgroup-event`——三层事实关联的 os 层第一次有真实内核事件。
- **优先级**：**P1（最高）**。实测边界已确认、环境已具备（privileged 容器）、
  竞品对比的显性差距；预计 2-3 天含 case 扩展（RES-04 v2 断言 cgroup 路径）。

### 创新 2：模型可读的拒绝归因闭环（SRT 验证过的产品化路径）
- **价值**：把"命令被拒"从黑盒失败变成"被拒 + 原因 + 建议动作"，减少 agent
  重试风暴（G2）；审计账本已有七类分类与 policy-ci 的 reason 语义模型，缺的只是
  回注通道——这是 hourglass 独有的"账本→反馈"组合，SRT 没有账本、Cube 没有
  模型反馈。
- **思路**：result hook 在 end 记录落账后，向工具结果追加一段结构化
  `sandbox_denial`（outcome.kind、被拒的规范化域名/路径、策略条目 id、
  policy-ci fixture 引用）；对 DANGEROUS 模式追加 unrestricted 披露。全部字段
  复用 classify.ts 与 policy-ci 的既有输出，零新语义。
- **优先级**：**P1**。改动小（一个 hook + schema 字段）、价值直接；需配套 2 个
  AUD case（归因字段在场/危险模式披露）防回归。

### 创新 3：会话快照与回滚（借鉴 Cube 的快照经济学，差异化定位）
- **价值**：agent 试错回滚是 bwrap 类轻沙箱没有、Cube 用整 VM 换来的能力；
  hourglass 可以在文件层以 XFS reflink/btrfs snapshot（或 overlayfs upperdir
  归档）实现 workspace 快照 + 秒级回滚，成本远低于 VM（G4）。配合 hash-chain
  账本锚定 rollback 事件，形成"可审计的时光机"——竞品均无此组合。
- **思路**：`@hourglass/sandbox-snap`：confine 装饰器在 workspace 挂载
  overlayfs（lower=快照链），`/snapshot` 显式命令或工具调用触发 upperdir 封存
  + 新 overlay 层；回滚=卸载层。账本记录 snapshot/rollback 事件（谁、何时、
  影响 callId 集）。退化环境（无 overlayfs）fail-closed 声明 unsupported。
- **优先级**：**P2**。价值高但工程量中等（挂载生命周期管理、与 MOUNT_GUARD
  协同），且依赖内核特性矩阵测试；作为下一个迭代的头部特性。

---

## 8. 证据索引

- SRT：`src/sandbox/sandbox-manager.ts`、`linux-sandbox-utils.ts:3604-3898`、
  `resolved-address-guard.ts:47-57`、`vendor/seccomp-src/seccomp-unix-block.c`、
  README.md:419-602/740-806/964-1006/1063-1074、docs/srt-proxy.md。
- wasmer：`lib/cli/src/commands/run/wasi.rs:71-77,505-563`、
  `lib/wasix/src/syscalls/wasi/path_open.rs:29-79`、
  `lib/virtual-fs/src/builder.rs:14-38`、`lib/virtual-net/src/ruleset.rs:1-44`、
  `lib/middlewares/src/metering.rs`、docs/journal.md、docs/ARCHITECTURE.md。
- Cube：`docs/architecture/overview.md:20-145`、`docs/architecture/network.md`、
  `CubeShim/shim/src/hypervisor/config.rs:161-171`、`Cubelet/config/config.toml:81`、
  `deploy/one-click/install.sh:913,1058-1119`、
  `docs/blog/posts/2026-06-01-cubesandbox-perf-benchmark.md:158-172`、openapi.yml。
- hourglass：`packages/*/src`、`scripts/sandbox-compare/*`、reports/final-report.md、
  docs/ADR-001/002。
