# duet.

**DSH 语音操控和语音播报**

https://github.com/user-attachments/assets/83152138-c292-4057-a820-efc2bc96f33a

duet，意为「二重奏」。这里的 duet 使用全双工语音模型，可以边听边说，
让你与 DSH 的交流不必一人一句地等待。

说出需求、修改输入、发送任务、切换会话——把键盘上的操作交给声音。你可以随时插话、补充或纠正。处理任务之外，也可以聊聊天。

当然，你也可以用 duet 帮你只播报结果，让你不用一直盯着屏幕。

最重要的是，duet 语音服务目前可以免费使用。

## 安装

支持 DSH Web 和 Desktop。当前版本已通过 DSH `0.2.0-rc.1` 的 Web 集成测试。

### Web

需要 Node.js 22 LTS（22.19.0 起）或 24 及以上版本。

安装并打开 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：

```bash
npm install -g @deepseek-ai/dsh
dsh web
```

在另一个终端为 Web profile 安装插件，再重启 DSH：

```bash
dsh plugin --profile web add dsh-duet
dsh web
```

### Desktop

在 DSH Desktop 的插件管理页面选择“添加插件”，输入 `dsh-duet` 并安装。
安装后若未出现 duet 按钮，退出并重新打开 DSH Desktop。

### 更新

Web 用户重新运行 `dsh plugin --profile web add dsh-duet@latest`，然后重启 DSH。
Desktop 用户在插件管理页面更新。

## 使用

duet 支持两种模式。

使用前，请先在 DSH 中创建或选择一个 workspace。

| 按钮 | 模式 | 用途 |
| --- | --- | --- |
| 喇叭 | 播报模式 | 任务完成后，进行简短的播报 |
| 双向箭头 | 交互模式 | 开口操作 DSH、自由聊天，也可以在回复过程中插话 |

### 目前支持的语音操作

| 操作 | 你可以这样说 |
| --- | --- |
| 输入内容 | “输入，帮我整理一下这周的计划” |
| 修改内容 | “把这周改成下周” |
| 清空输入框 | “清空输入框” |
| 发送任务 | “发送”“提交” |
| 新建会话 | “新建一个会话，叫旅行计划” |
| 切换会话 | “切换到第二个会话”“切换到旅行计划” |
| 重命名会话 | “把当前会话改名为周末安排” |
| 分叉会话 | “从当前会话分叉一个新会话” |
| 归档会话 | “归档这个会话” |
| 回答 DSH 的问题 | “选第二个”“用中文就好” |
| 自由聊天 | “什么是全双工语音交互？” |

## 麦克风与隐私

duet 通过服务器提供语音服务。根据所使用的功能，以下信息会上传至服务器，用于理解语音、执行会话操作、生成回复和语音播报：

- 交互模式开启期间，麦克风采集的交互音频。
- 交互所需的会话信息，例如会话标识、名称、运行状态和当前会话名称。
- 交互所需的输入框内容、任务结果。

请勿在交互中提供密码、密钥等敏感内容。

**目前仅支持中文。**

## 许可证

Copyright 2026 YuMS。本项目采用 [Apache License 2.0](LICENSE)。
第三方图标的许可声明见 [HEROICONS-LICENSE.txt](HEROICONS-LICENSE.txt)。
