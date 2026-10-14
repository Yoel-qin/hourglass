# hourglass

DSH（DeepSeek Harness）沙箱治理插件 + 可复现开源沙箱对比测试框架。
全部测试在 Docker privileged 容器内运行，判定只认真实副作用（文件快照差分 /
服务端 canary 记录 / 内核资源错误信号），从不以 stderr 文本断言作主判据。

## 插件（六个包，DSH 仓库零修改）

- **@hourglass/sandbox-audit** — 追加式结构化审计账本：每次工具调用产生
  begin（策略快照，`tools/pre-execute`）+ end（终态分类，`tools/result`）两条
  按 `callId` 关联的记录；七类拒绝分类只认结构化信号（`result.value.sandbox`
  消费者契约优先，纯 stderr 片段永不升级为 sandbox-denial）；三层事实关联中
  os_observation 恒记 `unavailable`（不伪造内核事件）；参数默认脱敏；只读查询
  命令 `/sandbox-audit`。
- **@hourglass/sandbox-net**（P2a）— Linux 网络出口强制：OS 层 bwrap
  `--unshare-net` 内核级拒绝一切直连；策略层 host 侧 allowlist 代理经
  bind-mounted unix socket + 沙箱内 TCP→unix 桥成为唯一出口。域名判定复用
  policy-ci 的 NET-09 规范化（大小写/尾点/userinfo/IP literal/子域后缀）。
  空 allowlist 即 deny-all；代理死亡或非 bwrap rung 一律 fail-closed；
  `unrestricted` 模式零语义漂移但被审计记录（AUD-15）。
- **@hourglass/sandbox-read**（P2b）— 敏感读保护：deny-read 路径在沙箱内被
  空 tmpfs 遮蔽——直接读与 symlink/硬链接别名（解析后落在遮蔽路径上）同样
  不可获得内容；默认空集（opt-in）；非 bwrap rung fail-closed。
- **@hourglass/sandbox-rsrc**（P3）— 资源配额：prlimit 硬上限
  （RLIMIT_AS/CPU/FSIZE/NOFILE + NPROC）注入命令前缀，内核强制。nproc 需
  `setpriv` uid 降权配合（userns 内 root 的 CAP_SYS_ADMIN 会豁免 RLIMIT_NPROC，
  降权到无 capability 的 uid 后限制真实生效）；该强制伴随 uid 降权，沙箱内
  进程需普通文件权限才能写。空配置零改变。
- **@hourglass/sandbox-capabilities** — 强制能力清单：五能力 × 五后端矩阵，
  `enforced` 只能由 probe/test-result 证据支撑（静态存在未运行 → `unknown`）；
  查询命令 `/sandbox-capabilities`。
- **@hourglass/policy-ci** — 策略回归：合成固定 fixture + 纯函数语义模型 →
  决策回放与 diff（allow→deny / deny→allow / reason-only / to-not-replayable）；
  CI 零网络、零模型、零真实会话语料；golden 字节稳定。

设计决策见 [docs/ADR-001](docs/ADR-001-hourglass-plugin-scope.md)。

## 快速开始（Docker）

```bash
# 0) 宿主预下载 vendor tarballs（容器内 GitHub 访问不可靠，见 docker/Dockerfile 注记）
#    docker/vendor/{nsjail-3.6,kafel-master,dsh-d743267,codex-0.162.1}.tar.gz

# 1) 构建测试镜像（固定 DSH commit 与竞品版本，见 scripts/sandbox-compare/versions.lock.json）
docker build -t hourglass-test -f docker/Dockerfile .

# 2) 一键全套：版本锁 gate → 单测（含 REAL-composition）→ smoke-p1 对比 → PERF 基线 → ROB-04 千次循环
docker run --rm --privileged -v "$(pwd)/reports:/opt/reports" \
  hourglass-test /usr/local/bin/hourglass-entrypoint run-all

# 或分项运行：gates | unit | compare | perf | rob04
# 全量矩阵（37 case × 4 subject）：
docker run --rm --privileged -v "$(pwd)/reports:/opt/reports" --entrypoint bash hourglass-test -c \
  'cd /opt/dsh && node --experimental-strip-types /opt/hourglass/scripts/sandbox-compare/run.ts --smoke=all --out=/opt/reports/runs/my-run'

# 或交互式进入
docker run --rm -it --privileged hourglass-test bash
```

容器必须 `--privileged`：bwrap/nsjail 需要创建 user/mount/pid namespace，
Docker Desktop on WSL2 对非特权容器阻止这些调用（实测）。容器是专用一次性测试
环境：不挂载宿主目录（除 reports 输出），测试数据全部为合成 canary
（`DSH_SYNTHETIC_CANARY_*`）。

## 对比矩阵（v15：37 case × 4 subject = 148 结果）

| 对象 | pass / fail / unsupported | 说明 |
|---|---|---|
| **DSH-PLUGIN** | **36 / 1 / 0** | 唯一 fail = NET-13 有意暴露的 Harness 代调用边界（该调用已被完整审计） |
| DSH-BASE | 14 / 12 / 9 | 插件前基线的诚实缺口画像 |
| SRT 0.0.79 | 19 / 2 / 16 | NET-01 = 环境限制（SSRF 防护拒本机地址）；RES-04 = CAP 豁免 |
| NSJAIL 3.6 | 20 / 3 / 13 | 机制差异如实呈现（netns 无 allowlist 通道等） |
| Codex 0.162.1 | — | 整体 not-run（无 OpenAI 凭证，versions.lock 声明） |

case 覆盖：FS（01-09/10/11/12，含穿越/symlink/硬链接/父目录攻击/解释器变体）、
NET（01-07/09-14，含代理剥离/IP 直连/原生 TCP/IPv6/并发会话/unix-socket/
代调用/生命周期）、RES（01-06，墙钟/CPU/内存/进程数/文件大小/fd）、
AUD（02/11/15，分类区分/结构化事实/danger 披露）、ROB（01-04，fail-closed/
代理死亡/非法配置/千次循环）。AUD-01/04/05/07/08 等由 87 个单测直接覆盖。

**能力清单（v9 实测，test-result 证据）**：DSH-PLUGIN 五项全部 enforced
（fileRead / fileWrite / netEgress / resourceLimits / processControl）；
DSH-BASE fileWrite=enforced 之外四项 absent。

## 性能（PERF-01，30 次/对象）

| 对象 | median | p95 | 相对 bare |
|---|---:|---:|---:|
| bare | 4ms | 5ms | — |
| DSH-BASE | 138ms | 177ms | ×34.5 |
| DSH-PLUGIN | 243ms | 281ms | ×60.8 |
| SRT | 288ms | 300ms | ×72.0 |
| NSJAIL | 9ms | 12ms | ×2.25 |

钩子级 micro-bench：审计 append **0.0113ms/记录**（begin+end 对 ≈ 0.023ms/调用）——
计划 §6.3 的 p95 ≤ 5ms 目标约 200 倍余量。PLUGIN 与 BASE 的 +105ms 端到端差值
主要来自 compare 管线的 driver 进程启动与完整工具流水，不是治理钩子本身。
阈值按计划不在报告定稿（需 ADR）。

## Testing hooks

按 DSH 平台包测试钩子约定（`SandboxInternals` 模式），hourglass 的可注入点：

- `@hourglass/sandbox-audit`：`classifyOutcome(signals)` 与
  `extractSandboxFacts(container)` 是导出的纯函数——单测注入合成信号即可覆盖
  全部分支；账本测试用临时目录驱动（strict/非 strict、断行恢复、重启续 seq）。
- `@hourglass/sandbox-capabilities`：`buildManifest({platform, backend, probes,
  tested})` 全参数注入——单一宿主覆盖所有平台分支；探测函数可替换。
- `@hourglass/policy-ci`：`decide(fixture, world)` 纯函数；fixtures 合成固定，
  golden 字节稳定。
- `@hourglass/sandbox-net` / `read` / `rsrc`：confine 重写函数
  （`wrapConfinedForNetwork` / `wrapConfinedForReadShadowing` /
  `wrapConfinedForResourceLimits`）均为导出纯函数——argv 变换与 fail-closed
  分支无需真实沙箱即可全覆盖；代理用 unix socket + 本地 HTTP 服务实测。
- 对比框架：`SubjectAdapter` 接口可注入假实现；driver 以 stdin JSON 驱动。

## 仓库布局

```
packages/audit/            @hourglass/sandbox-audit（单测 + REAL-composition loader 测试）
packages/capabilities/     @hourglass/sandbox-capabilities
packages/policy-ci/        @hourglass/policy-ci（+ golden fixtures）
packages/net/              @hourglass/sandbox-net（代理 + confine 装饰器）
packages/read/             @hourglass/sandbox-read（tmpfs 遮蔽）
packages/rsrc/             @hourglass/sandbox-rsrc（prlimit 硬上限）
scripts/sandbox-compare/   对比框架（37 case、5 adapter、driver、net-service、
                           run/perf/lifecycle/manifest + 版本锁 + smoke-p1/p2）
docker/                    三阶段 Dockerfile + compose + entrypoint（gates/unit/
                           compare/perf/rob04/run-all）
docs/                      ADR-001
reports/                   final-report.md + runs/（15 轮原始 JSON 数据）
```

## 已知边界（如实声明）

- **Harness 代调用旁路（NET-13）**：受限会话经 harness 自身的 web fetch 可到达
  deny 目标（服务端证据证实）——这是 DSH 架构的已知边界；hourglass 保证该调用
  有完整审计记录（非未审计旁路），但当前不阻断。
- **进程数硬限制的代价（RES-04）**：RLIMIT_NPROC 在 userns 内被 CAP_SYS_ADMIN
  豁免；hourglass 用 setpriv uid 降权使其生效——nproc 强制伴随 uid 降权。
  纯 cgroup pids 方案（无降权代价）属后续工作。
- **网络强制的覆盖面**：HTTP/HTTPS 走代理通道；原始 TCP/非 HTTP 协议无代理
  路径，被 OS 层整体阻断（阻断事实 ≠ 代理判定）。域名解析在 host 侧。
- **策略前进程（NET-14）**：bwrap die-with-parent 使后台进程随沙箱销毁——
  实测无幸存越权路径（比声明的边界更强）。
- Codex lane 无凭证 not-run；Windows 原生 lane 不在框架内（容器是 Linux）；
  SRT 的 allow 通道在单容器环境无法验证（其 SSRF 防护拒本机地址），deny 语义
  已全面验证。
- 未实现：RES-07/08（取消/并发配额）、ROB-05/06（CI job 属性）、AUD-09/10
  （hash chain/内核观察器，依赖立项）、P4 时间旅行（需产品负责人批准）、
  P5 eBPF（可选研究）。详见 reports/final-report.md。
