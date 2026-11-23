# duet-guard 连接守护：实现与测试报告

> 版本：2.0.0 · 测试日期：2026-11-04 · 环境：Windows + Chromium 157

## 1. 背景

实际语音交流中观察到两类问题：

1. **多次断联**：WebSocket 断开后 UI 停留在「已开启」，需要手动点两次才能恢复；
2. **断连后记忆丢失 / 错位**：重连后 `epoch/cursor` 恢复失败（见 `docs/boundary-analysis.md`），表现为上下文丢失或答非所问。

本守护脚本只做**客户端兜底**：插件自身重连失效时，用 UI 层操作把连接拉回来，缩短静默断连窗口，并保留事件序列便于排查。它不能修复服务端 epoch 变化导致的上下文丢失。

## 2. 实现要点

| 能力 | 做法 |
|---|---|
| 常驻运行 | MV3 content script，匹配 `http://127.0.0.1/*`、`http://localhost/*`，随页面自动注入 |
| 扫描周期 | 5 秒（`SCAN_MS`），首扫延迟 600ms 等待渲染稳定 |
| 断连判定 | `data-mode != off` 且（`[data-duet-mark]` 非绿 或 对应按钮 `aria-pressed != true`） |
| 重连策略 | UI 显示已关闭 → 单击一次重新开启；UI 显示开启但已断（半死）→ 关闭后 1.2s 再开启 |
| 退避 | 2s → 4s → 8s → 16s → 30s，5 次失败后 `giveup` |
| 用户意图优先 | 检测到 `data-mode=off` 立即复位计数并停止自动开启 |
| 防打架 | `aria-busy="true"` 时跳过本轮点击 |
| 可观测 | 事件日志最多 500 条，`window.__duetGuardLog` / `DuetGuard.log` 可导出 |

## 3. 测试方法

本机未安装 dsh-duet（`profiles/web/cordis.patch.yml` 为空），无法对真实插件做端到端测试，故用**同构 DOM 夹具**验证状态机：

- 正常断连：按钮状态变为关闭、标记变灰 → 验证「单击恢复」与「用户主动关闭不打扰」；
- 半死连接：按钮仍为开启、标记变灰 → 验证「关闭→开启」路径。

夹具按钮行为与 Duet 一致：点击切换 `aria-pressed` 与 `data-mode`，开启时标记转绿（`rgb(127, 214, 166)`）。

## 4. 测试结果

### 4.1 正常断连

```
2000ms   injected_disconnect
7005ms   fixture_click {to:on}
7104ms   observed_reconnect {latencyMs:5104}
12005ms  injected_user_off
20001ms  summary
```

| 检查项 | 结果 |
|---|---|
| 守护脚本加载 | ✅ |
| 检测并恢复连接 | ✅ |
| 恢复耗时 | **5104 ms**（扫描 ≤5s + 退避 2s） |
| 用户关闭后不再点击 | ✅ 0 次 |
| 用户关闭后复位 | ✅ `status=idle, attempts=0` |
| 点击次数 | **1**（无二次点击误关） |

### 4.2 半死连接

```
1502ms  injected_half_dead
7005ms  fixture_click {to:off}
8206ms  fixture_click {to:on}
8302ms  observed_reconnect {latencyMs:6800}
```

| 检查项 | 结果 |
|---|---|
| 走 toggle 路径（关→开） | ✅ 2 次点击，间隔 1.2s |
| 最终连通 | ✅ `finalLive=true` |
| 恢复耗时 | **6800 ms** |
| 守护状态 | ✅ `healthy` |

### 4.3 测试中发现并修复的缺陷

| 缺陷 | 现象 | 修复 |
|---|---|---|
| 二次点击误关 | 断连后 UI 已显示关闭，脚本「先关再开」的第二次点击把刚恢复的连接又关掉 | 按 `aria-pressed` 区分单次/切换路径 |
| 首扫误判 | 页面样式尚未应用时首次扫描误判为断连 | 首扫延迟 600ms |
| 用户脚本头被注释符截断 | `@match http://127.0.0.1:*/*` 中的 `*/` 提前结束块注释，整脚本语法错误 | 改为 `http://127.0.0.1/*` |

第一条在首轮测试真实出现（恢复后紧跟一次 `to:off` 点击），修复后复测通过。

## 5. 使用方法

扩展（推荐）：`edge://extensions` → 开发人员模式 → 加载解压缩的扩展 → 选择 `duet-guard/`。

控制台：F12 → Console → 粘贴 `duet-guard/guard.js` 全文。
Tampermonkey：把 `==UserScript==` 头移到文件顶部保存。

运行时接口：

```js
DuetGuard.status   // {status, mode, attempts, lastHealthyAt}
DuetGuard.log      // 事件日志
DuetGuard.scan() / DuetGuard.stop() / DuetGuard.reset()
```

## 6. 边界与风险

- **仅 UI 层**：无法恢复 `epoch` 变化导致的上下文丢失；根治需插件侧保留 `resume`。
- **选择器依赖**：`#dsh-duet-controls`、`[data-voice]`、`[data-duet-mark]`、`data-mode`、`aria-busy`；插件改版需同步。
- **可能覆盖用户意图**：切换路径存在 1.2s 窗口；已用 off 复位与短窗口降低概率。
- **夹具≠真机**：结果只证明状态机正确，真实 1006/1013 断开仍需真机复验。

## 7. 建议上游吸收

1. `ws.onclose` 后保留 `resultResume`，避免在线模式清除 `epoch/cursor`；
2. 暴露连接状态事件（如 `duet:connection-state`），外部守护无需读取 DOM 样式；
3. 校正 `aria-pressed` 与真实传输状态，消除「显示开启但已断」的半死态。
