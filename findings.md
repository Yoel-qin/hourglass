# Findings — 侦察与研究记录

## 环境事实

| 项 | 值 |
|---|---|
| 宿主 OS | Windows 11 Home China 10.0.26300（x86_64） |
| Docker | 29.7.2（daemon linux x86_64），daemon 正常 |
| 宿主 Node / pnpm | v22.20.0 / 11.28.5 |
| DSH 本地路径 | D:\Aiproject\deepseek-harness |
| DSH remote | https://github.com/deepseek-ai/deepseek-harness.git |
| DSH commit | d743267388641bc76f17c45ce8b4c231aed1d32c（master，2026-10-09，= 远程 master HEAD） |
| DSH 工作区 | 干净（仅未跟踪 .mimosa/ .workbuddy/ 工具目录，不动） |

## 竞品版本锁定（2026-10-13 从 GitHub API 获取）

| 对象 | 版本 | commit SHA | 备注 |
|---|---|---|---|
| DSH | master | d743267388641bc76f17c45ce8b4c231aed1d32c | 本地 checkout 与远程一致 |
| SRT (anthropics/sandbox-runtime) | v0.0.79 | d9aac2098351ca17f3743fbaf6ecbd0051b7e00e | Apache-2.0，发布 2026-10-07；engines >=22.12.0；支持 denyRead/allowRead glob、bwrap 0.4、HTTP 代理 |
| Codex (openai/codex) | rust-v0.162.1 | 092d3acd6bec3e3a14bdc7e7a2810ab628ab759d（tag 对象 7a078f6bb4ce0dc2a81408b334ce52979d92c603） | 发布 2026-10-09；release 附带 bwrap 等资产 |
| nsjail (google/nsjail) | 3.6 | f78475530b46d0186111a9096b30725f816b55fe | tag SHA |

注：网络策略阻止 WebFetch 访问 api.github.com，但宿主 curl 可用（可能走系统代理）。

## DSH 仓库侦察

（等待 Explore agent 结果）

## DSH 沙箱子系统侦察（agent 2 结果，2026-10-13）

### 关键结论
- **网络出口控制是空白**：SandboxMode 明确排除网络；windows-acl README 明示 reads/network/process visibility 不受限。治理插件的天然落点。
- **能力清单不存在**：sandbox-policy 注释明确 "without inventorying capabilities"。后端能力事实分散在 ConfinedArgv.enforcement/denialSignatures（per-call）与 LocalSandboxProvider.selectedRunner（私有）。
- **审计先例**：`sandbox/mode` 是 log-only session 事件 + sessionProjections.register + SessionEventMap 扩展；approval/* 同模式。

### 包结构（packages/sandbox/）
| 包 | 职责 | 关键 API |
|---|---|---|
| dsh-sandbox | seam/词汇表 | `SandboxMode='read-only'|'workspace-write'|'danger-full-access'`；`SandboxEnforcement='full'|'partial'`；`SandboxPolicy extends SandboxExecutionPolicy`；`ConfinedArgv{argv,enforcement,denialSignatures,runnerFailureRules}`；`abstract SandboxProvider.confine(argv,policy,signal)` fail-closed；`SANDBOX_UNAVAILABLE`/`SandboxUnavailableError`；`canonicalPath()`/`writableRoots()`（roots.ts）；`approveEscalation()`（escalation.ts）；diagnostics.ts 分类器 |
| dsh-sandbox-policy | 策略归属 ctx.sandboxPolicy | `SandboxPolicyService.resolve(request): SandboxExecutionPolicy`（approved mode > session sandbox/mode 折叠 > 默认 read-only）；Config{mode,workspaceRoot}；sessionProjections 单元 `sandboxMode`；`setSandboxMode(session,mode)` 唯一写路径（session.append('sandbox/mode')） |
| dsh-sandbox-local | 本地后端 ctx.sandbox | `LocalSandboxProvider`；PLATFORM_CHAINS：linux=['bwrap','landlock']、darwin=['seatbelt']、win32=['windows-acl']；STATIC_ENFORCEMENT：bwrap/landlock/seatbelt=full、windows-acl=partial；DENIAL_SIGNATURES 每后端不同；**SandboxInternals 测试钩子已存在**（internals: {platform,chain,probeBwrap,probeLandlock,probeSeatbelt,landlockLauncher,seatbeltExec,windowsAclRunner*,probeWindowsAcl,rmTempDir}）；profiles.ts：bwrapProfileArgs/landlockProfileArgs/seatbeltProfileArgs |
| dsh-sandbox-windows-acl | Win ACL 后端 | `AclSandbox`（init fail-closed/spawn/dispose）、`AclWriteGrant.create(writeSid)`、`workspaceWriteSid()`、runner.ts argv 契约、exit 127 + `windows-acl-run:` 签名；WRITE_RESTRICTED 只限写 |

### fs 栅栏（packages/fs/fs-sandbox/）
- `SandboxedFileSystem extends LocalFileSystem`（ctx.fs，inject ['sandboxPolicy']）；覆写 writeText/editText；checkedTarget() read-only 抛 FS_SANDBOX_DENIED；workspace-write 用 writableRoots + isPathUnder（词法快路径 + BigInt dev/ino 回退，防 8.3/大小写别名 + TOCTOU）
- tool-fs/src/sandbox.ts 把 FS_SANDBOX_DENIED 映射为 sandboxDenialMarker(mode) + escalationHintMarker

### subprocess 消费者（result.sandbox 字段）
- `ShellSandboxInfo { mode; denied; enforcement?; runnerFailed? }`（packages/shell/shell/src/types.ts:35-44），挂 ShellRunResult.sandbox 与 ShellProcess.sandbox
- bash-sandbox/pwsh-sandbox：executor 盖章 + confine + classifyDenial；terminal-bash：spawnArgv confine + sandboxModeFences（打开持久终端时禁切 mode）；ptc-runtime-node：PtcRunSandbox + 'sandbox-unavailable'；sandbox-ssh：远端 confine（zod facts schema）
- 升级：tool-bash sandbox_permissions+justification 参数 + approveEscalation + ESCALATION_TARGETS

### 网络现状（无沙箱级网络限制）
- 全局代理：packages/util/http-proxy（ProxyPolicy、installProxyFromEnvironment、proxyRouteFor；loopback 恒 noProxy）；安装点 apps/cli/src/profile-boot.ts:249
- web-fetch-http：isPublicIpAddress（仅全局单播）+ resolvePublicAddresses + 地址 pin
- 门禁 verify-no-bare-dispatcher 强制 proxy-aware dispatchers

### CI（.github/workflows/sandbox.yml）
- 仅 push master；四 leg：ubuntu-latest/bwrap、ubuntu-24.04/landlock、ubuntu-24.04-arm/landlock、macos-latest/seatbelt；node 24；bwrap leg 装 bubblewrap + 关 apparmor_restrict_unprivileged_userns
- run-guard：vitest run vitest.e2e.config.ts 两个 e2e 文件 + grep 'Test Files 2 passed (2)'；landlock legs 加 pack rehearsal
- run-gates.ts：Gate{id,label,displayCommand,command,args,needs,after,env,quick,allowFailure}；gatesForMode switch；pnpmScript/pnpmExec helper；DSH_GATE_CONCURRENCY/FAIL_FAST

### 组合方式（关键！插件如何挂载）
- 真正产品组合：`packages/bundle/base/cordis.patch.yml`（dsh-base bundle）：sandbox→dsh-sandbox-local、sandbox-policy→dsh-sandbox-policy（config mode=DSH_PERMISSION_MODE ?? workspace-write）、bash-sandbox/pwsh-sandbox（按平台 disabled）、fs-sandbox、approval→dsh-user-approval、permission→dsh-permission-presets
- CLI 链：apps/cli/src/bin.ts → profile-boot.ts runProfile() → resolveProfileDir($DSH_HOME) → bundles 叠加 + cordis.patch.yml overlays → mount profile 根 cordis.yml（内容 []）
- PROFILE_TEMPLATES（packages/boot/app-boot/src/profile.ts）：acp/web/headless/sdk-app/sdk-minimal；bundles 如 ['@deepseek-ai/dsh-base',…]
- 插件管理：apps/cli/src/plugin.ts（dsh plugin --profile，pnpm allow-version 豁免审批）
- 测试 profile：docs/testing.md keyless 证明理念；keyless fixtures 在 packages/test-support/session-snapshot/tests/fixtures/

### 开发约定
- 插件 = cordis Service + `declare module '@deepseek-ai/cordis' { interface Context }`；`static Config: z<Config>`（schemastery）进 config catalog
- 100% per-file coverage（vitest）；doc-sync；README 双语（.zh.md + .i18n.yaml）

## DSH 插件系统与扩展点侦察（agent 1 结果，2026-10-13）

### 插件形态（二选一）
- **函数插件**：named-export `name`/`inject`/`Config`/`apply(ctx, config)`，禁止 default export。范本：packages/guard/repeat-tool-reminder/src/index.ts
- **Service 包**：default-export Service 子类（super(ctx, 'tools') 占 ctx.tools）。范本：packages/interaction/user-approval
- 目录约定 packages/<group>/<pkg>/，包名 @deepseek-ai/dsh-<name>；package.json："type":"module"、main lib/index.js、exports 含 "./src/*"；peerDeps @deepseek-ai/cordis
- bundle/profile 包有 "dsh" 字段（bundle.patch 指 cordis.patch.yml）

### tools 事件（packages/core/tools/src/index.ts:143-211）
- `tools/pre-execute`(waterfall)：(exec: ToolExecution, next) => PreToolDecision = {kind:'allow'}|{kind:'deny',reason,info?:ToolErrorInfo}|{kind:'cancel'}|{kind:'ask',reason?,displayReason?}
- `tools/execute`(waterfall around-dispatch)
- `tools/post-execute`(waterfall)：(exec, result: Readonly<ToolExecutionResult>, next) => PostToolDecision = accept|block
- `tools/result`(emit)：(exec: Readonly<ToolExecution>, result) => void，最终冻结结果，监听器失败被 contain —— **审计终态记录的落点**
- 单调 guard：`ctx.tools.guard((exec) => string | undefined)`（同步、只能 deny、顺序无关）
- ask → ctx.get('approval').request(...)，无服务降级 deny

### 审批（packages/interaction/user-approval）
- ApprovalService.request(req: ApprovalRequest): Promise<'allowed-once'|'rejected'|'cancelled'|'unavailable'>；要求 turn 打开中（审计 approval/asked+decided 必须 turn-enclosed）；fail-closed
- approveEscalation() 在 escalation.ts（拒绝文案 stop and explain）

### 存储（ctx.storage）
- Hub：storage.mount(form, facility)/form(form)/domain.open(spec)
- Domain：defineDomain({name, tables, global?}) → ctx.storage.domain.open(spec) → Domain.global.get/set + .table(name) KvTable{get,entries,keys,size,put,delete,update}；写走单一 per-domain 写链（先持久化再内存再事件）
- storage-sqlite：STORAGE_SQLITE_SCHEMA_VERSION=1（PRAGMA user_version，不就地迁移）；openDatabase(path, journalMode)
- **禁止新增自定义 session event type**（live append 不能 ignorable，老 reader 拒开）；派生状态用 projection unit 或 storage 服务

### 标识
- ToolCallId：模型返回的 tool_call id，兜底 `call-${index}`；SessionId：SessionStore.prepare mint `session-${++counter}`（可显式传入）
- 事件配对：tool/call {turn,step,callId,name,arguments} ↔ tool/result {turn,step,message,error?:{name,code,reason?},meta?}
- ToolErrorInfo { name; code; reason? }；错误码 TOOL_ABORTED/ABORTED_BEFORE_DISPATCH/UNKNOWN_TOOL/INVALID_TOOL_OUTPUT/SANDBOX_UNAVAILABLE
- **ToolErrorInfo 不含 enforcement 通用字段** —— 审计只能从消费者 result.sandbox（bash/pwsh）读，其他记 unknown

### 命令注册（packages/interaction/commands）
- ctx.inject(['commands'], (commandCtx) => commandCtx.commands.register({name(小写无斜杠), description, input?, handler}) 返回 disposer)；命令不开 model turn；事件 command/run + command/done

### 覆盖率与门禁
- vitest.config.ts：coverage v8，include packages/*/*/src/**，thresholds perFile 100%（statements/branches/functions/lines）
- doc-sync = tsx scripts/run-gates.ts doc-sync（doc-typecheck、verify-doc-graphs、verify-cordis-catalog、verify-tool-catalog、verify-config-catalog…）
- 测试分层 docs/testing.md：unit/coverage/e2e(real-API keyless 自跳过)/expected/bench/snapshot
- engines: node ^22.19.0 || >=24.0.0；packageManager pnpm@11.28.5；pnpm-workspace packages 含 vendor/*、packages/*/*、native/system、apps/*、benchmarks、website、python/sdk-runtime；**scripts/ 不在 workspace**（scripts/**/*.spec.ts 被 vitest include）

### REAL-composition 与外部插件接入（关键）
- 测试范式：packages/shell/tool-pwsh/tests/loader.spec.ts 用 runLoaderSmoke（@deepseek-ai/dsh-loader-smoke）子进程启动 tests/fixtures/loader/cordis.yml + driver.ts
- 外部插件：自己包里实现（peer 依赖 @deepseek-ai/cordis），通过 profile cordis.patch.yml `- insert: [{id, name:'<pkg>'}]` 挂载，或 dsh plugin 安装（packages/boot/plugin-manager）
- practices.md 守则：waterfall 必调 next()；顺序无关拒绝用 ctx.tools.guard()；异步询问用 pre-execute ask；参数放 Config；per-agent 注册放 agent.ctx 留 disposer
- 本机 dsh --profile web --dump-config 可看组合树

### 对 hourglass 的集成决策
- 容器内 git clone DSH（固定 commit）→ 把 hourglass 包放进 clone 的 packages/hourglass/（packages/*/* 通配自动进 workspace）→ pnpm install（--no-frozen-lockfile）→ build → vitest + loader smoke
- 用户本地 D:\Aiproject\deepseek-harness 保持只读不动
