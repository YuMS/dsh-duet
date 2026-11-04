# 3D 形象（实验）

在设置中打开“3D 形象”，或点击交互模式左侧的头像按钮，即可显示或隐藏角色。
默认使用本机悬浮窗口；DSH 安装在服务器时，可选择“仅在网页端显示”，让角色出现在侧栏上方。

## 交互体验

- 角色会随声音动嘴，并根据“好的”“不行”“哈哈”等文字点头、摇头或微笑；空闲时会轻微转头。
- 字幕显示在角色上方，跟随实际语音播放；打断后保留已经说出的内容。
- 输入内容时显示键盘气泡，网页中的气泡随后飞向 DSH 输入框。
- 教学、连接提示和确认框可在形象旁展示；隐藏角色和语音评分跟随发起操作的位置。
- 角色支持大、中、小三种尺寸。桌面窗口可以拖动，右键菜单提供打开 DSH、待处理事项、气泡样式、任务通知和教学入口。
- 任务通知可以独立于语音模式使用，提示任务完成和待处理事项。
- 设置中可修改助手昵称，也支持语音改名。昵称最多 5 个汉字或 2 个英文单词，中英混用时最多 5 个字符。

首次启用声音或开始教学时，按提示回到 DSH 页面点击对应按钮。

## 构建

使用 Node.js 22.19+；桌面构建还需在目标系统安装 Rust 和 Tauri 2 的系统依赖。

```sh
npm ci
node scripts/prepare-avatar-assets.mjs
npm run build:avatar
npm test
npm run check
npm run test:browser
npm run test:avatar
npm run test:avatar:desktop
```

资源也可从本地导入，见 [角色资源](avatar-assets.md)。

在目标桌面系统构建辅助窗口：

```sh
node scripts/build-avatar-desktop.mjs --check
npm run build:avatar:desktop
cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml
node scripts/test-avatar-native.mjs
```

构建产物位于 `desktop/bin/<platform>-<arch>/`。本版桌面形象支持 macOS Apple Silicon 和 Windows x64；其他平台可使用网页形象。
GitHub Actions 的 `Build avatar plugin package` 工作流分别构建这两个平台，并汇总为插件安装包。

## 代码入口

| 目录 | 内容 |
| --- | --- |
| `src/avatar/` | 共用渲染、动作、嘴型、字幕与桌面前端 |
| `src/client/avatar*.mjs` | DSH 页面、形象和提示交互 |
| `src/host/avatar*.mjs` | 桌面进程与资源加载 |
| `desktop/src-tauri/` | 原生置顶窗口、拖动与鼠标穿透 |
| `scripts/build-avatar*.mjs` | 网页和桌面构建 |
