# DSH Duet

- 此仓库是插件源码入口，不要修改已安装的 node_modules 副本。
- 不修改 DSH 本体；使用公开的 Host/Client 服务和 bundle/profile 机制。
- 目录职责见 docs/layout.md；入口由 package.json 声明，新增模块不要平铺到根目录。
- 内部命名使用 duet；旧协议与持久化键仅作兼容，不随文件改名一起变更。
- Node 22.19+（见 package.json），npm ci；改后运行 npm test、npm run check。
- UI 改动运行 npm run test:browser。测试不能使用真实密钥或默认操作用户会话。
- 版本更新同步 package.json、PLUGIN_VERSION 与浏览器 URL 版本，check 会验证一致。
- 协议与用户数据键变更必须验证兼容性。
- 用户未授权部署时，只测试/打包，不重启 DSH 或更新线上服务。
- 不提交语音日志、Token、.env、用户反馈或安装目录。不要擅自修改发布许可或 npm publish。
