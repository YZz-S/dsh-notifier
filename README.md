# dsh-notifier

DeepSeek Harness（dsh）系统通知插件：当任务完成，或需要你在页面中手动输入 / 确认信息时，发送一条**操作系统原生通知**，让你切到别的窗口时也不会错过关键节点。

## 功能

- **任务完成通知**：顶层会话从 `running` 回到 `idle`（一个回合结束）时，发送「任务已完成」
- **需要确认 / 输入通知**：触发审批（`approval/request`，例如需要你确认执行某个工具）时，发送「需要确认」，并带上工具名与原因
- **不干预审批流程**：审批通知走 waterfall 的 `next()` 透传，绝不抢答、不改变审批结果
- **跨平台**：Windows（Toast + 气泡兜底）/ macOS（`osascript`）/ Linux（`notify-send`）

## 触发的事件

| 事件 | 模式 | 通知内容 |
| --- | --- | --- |
| `agent/status` → `idle`（顶层会话，且此前为 `running`） | emit | 任务已完成 |
| `approval/request` | waterfall | 工具 X 需要你在页面中确认（+ 原因） |

## 文件说明

| 文件 | 说明 |
| --- | --- |
| `index.js` | 可安装的 Host 半边（`dsh.bundle` 入口，ES module） |
| `cordis.patch.yml` | bundle 补丁：插入 `notifier` 插件行 |
| `host.js` | 动态用法（`cordis_define` 的 `code.host`） |
| `package.json` | 声明 `dsh.bundle` 的可安装包元信息 |
| `README.md` | 本说明 |
| `LICENSE` | MIT 许可证 |

## 安装（dsh.bundle）

本仓库同时是可安装的 dsh 插件包（`package.json` 声明 `dsh.bundle`）：

```sh
dsh plugin --profile web add github:YZz-S/dsh-notifier
```

安装后任务完成或需要人工确认/输入时自动发送系统通知（纯 Host 插件，无需刷新页面）。
动态用法（`cordis_define` 加载 `host.js`）仍保留，两种方式二选一。

## 使用方法

### 方式一：动态 Cordis 插件（临时运行）

在 dsh Web GUI 的会话中，用 Cordis 工具定义并运行：

1. 调用 `cordis_define`：`code.host` 粘贴 `host.js` 的内容（`plugin.kind: 'new'`，`idPrefix` 取 3–6 个小写字母）
2. 调用 `cordis_run` 激活（纯 Host 插件，无需刷新页面）
3. 下一次任务完成或需要确认时即会弹出系统通知

> 注意：动态插件的生命周期与当前 dsh 进程相同。重启 dsh 后需重新定义运行。

### 方式二：安装为正式插件（推荐）

见上文「## 安装（dsh.bundle）」：`dsh plugin --profile web add github:YZz-S/dsh-notifier`。

## 工作原理

**通知命令（按顺序降级探测，取第一个可用）**：

1. `powershell`（Windows）→ WinRT Toast，使用系统已注册的 PowerShell AppID（因此**无需写注册表**）；Toast 抛出异常时自动降级为气泡通知
2. `osascript`（macOS）→ `display notification … with title …`
3. `notify-send`（Linux）

标题 / 正文通过 PowerShell 单引号转义后内嵌进 `-Command` 脚本；由 `subprocess.spawn` 以 `argv` 数组派生，Node 侧负责正确的命令行引号处理。

**顶层会话过滤**：`agent/status` 会覆盖所有 agent（含子代理）。插件用 `agents.roots()` 判断是否为顶层会话，只对顶层会话发「任务已完成」通知，避免子代理结束刷屏；`agents` 服务不可用时降级为不过滤。

## 隐私说明

- **不发起任何网络请求**
- **不采集、不上传任何数据**
- **不写文件、不写注册表**（Windows Toast 使用系统已注册的 PowerShell AppID）
- 仅在本地派生通知命令，副作用全部挂在插件 Fiber 上，停止即清理

## 已知限制

- `subprocess` 服务不可用时插件静默停用
- Windows Toast 以「Windows PowerShell」作为来源应用名显示（这是不写注册表的代价）
- `agent/status` → `idle` 在每次顶层回合结束时触发，属于「回合/任务完成」语义
- 动态插件为进程级生命周期，重启后需重新运行

## 开源前检查

- [x] 无硬编码密钥 / Token / 密码（已扫描 `api[_-]?key`、`secret`、`token`、`password`、私钥头等模式）
- [x] 无个人信息（用户名、机器路径、内部 IP、邮箱）
- [x] 无网络端点（插件不发起任何网络请求）
- [x] MIT 许可证齐全，README 完整
- [x] 无遥测 / 无第三方数据收集
- [x] 代码仅使用 dsh 动态插件公开接口（Services / ctx.on / subprocess），副作用全部挂在插件 Fiber 上，停止即清理

## License

[MIT](./LICENSE)
