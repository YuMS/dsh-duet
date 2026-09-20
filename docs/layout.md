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
地址等配置优先读取 `DUET_*`，旧环境变量仅在 `src/host/environment.mjs` 兼容。
公开试用访问凭证与默认地址统一放在 `src/host/service-defaults.mjs`；不读取本地或环境变量中的鉴权凭证。
该凭证仅用于内置服务地址，切换到其他服务不会携带它；连接配置文件只保存地址。

旧 HTTP 路径、协议字段、Cookie、浏览器存储键和互斥锁标识保持稳定，
确保升级不会清除授权、快捷键、麦克风选择或反馈身份，也不会让新旧页面同时采集音频。
旧浏览器模块地址由 `src/host/assets.mjs` 提供兼容导出；新页面使用 `/duet/assets/`。
`duplex` 作为全双工模型的协议字段仍保留，不是插件品牌名称。

两种语音模式都要求 DSH 已有 workspace：浏览器在授权和音频启动前检查，Host 在连接外部服务前再次检查。
会话编号由 `browserSessionCatalog` 统一供 RPC 与状态同步使用，排除归档及子代理会话。
DSH 0.1.5 使用其已保存的活动排序，0.1.6 的近期排序根据实时更新时间计算；手动排序保留页面设置。
待答问题同时支持 0.1.5 的 `pendingInteractions` 和 0.1.6 的 `sessionStatus.pendingInteraction`。
