# 源码导航

| 目录 | 内容 |
| --- | --- |
| `src/host/` | DSH 插件入口、会话操作、连接配置、反馈与静态资源注册 |
| `src/client/` | DSH 页面入口、音频、输入框同步、设置页和教学 |
| `src/shared/` | 模式状态与会话目录规则 |
| `config/` | DSH bundle 声明 |
| `assets/tutorial-audio/` | 教学音频与校验清单 |
| `tests/unit/` | 模块单元测试 |
| `tests/browser/` | 设置、教学和反馈的浏览器测试 |
| `tests/host/` | 隔离 DSH 安装与运行测试 |
| `scripts/` | 测试入口与发布内容检查 |

公开入口由 `package.json` 的 `exports` 和 `dsh.bundle` 指定，不依赖根目录文件名。
浏览器资源只从显式清单提供，不会把整个源码目录作为静态目录暴露。

## 命名与兼容

新增代码使用 `duet` 命名；代码模块使用短文件名，由目录表达职责。
配置优先读取 `DUET_*`，旧环境变量仅在 `src/host/environment.mjs` 兼容。

旧 HTTP 路径、协议字段、Cookie、浏览器存储键和互斥锁标识保持稳定，
确保升级不会清除授权、快捷键、麦克风选择或反馈身份，也不会让新旧页面同时采集音频。
旧浏览器模块地址由 `src/host/assets.mjs` 提供兼容导出；新页面使用 `/duet/assets/`。
`duplex` 作为全双工模型的协议字段仍保留，不是插件品牌名称。
