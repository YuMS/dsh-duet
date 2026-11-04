# 角色资源

角色资源包括 `character.glb` 和 `portrait.png`，由 `avatar-assets.lock.json` 统一管理版本、下载地址和文件校验信息。

## 获取资源

按清单获取对应版本：

```sh
node scripts/prepare-avatar-assets.mjs
```

也可以将两个文件放在同一目录后导入：

```sh
node scripts/prepare-avatar-assets.mjs --from /path/to/exports
```

资源保存在 `.cache/avatar-assets/<version>/`。检查本地资源：

```sh
node scripts/prepare-avatar-assets.mjs --check
```

更新角色时使用新的资源版本，并同步更新清单。发布包包含对应的角色资源和各平台程序，用户安装后即可使用。
