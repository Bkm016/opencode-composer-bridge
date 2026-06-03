# opencode-composer-bridge

在 **OpenCode** 里用 **Cursor Composer** 时，对齐 Cursor 的工具名与参数，减少 `invalid` 和参数校验失败。

## 做什么

| 类别 | 工具 | 行为 |
|------|------|------|
| 读写改 | `read`、`write`、`edit` 及 `Write`、`StrReplace`、`search_replace` 等 | 插件实现；支持 `path` / `filePath`、`contents` / `content`；`edit` 兼容 CRLF |
| 目录 / 终端 | `list_dir`、`ListDir`、`LS`、`run_terminal_cmd` | 插件实现（列目录、本地 PowerShell/sh） |
| 搜内容 / 找文件 | `grep`、`glob` | **不覆盖**，用 OpenCode 内置（ripgrep）；`tool.execute.before` 做参数别名 |
| Cursor 专用名 | `Grep`、`Glob`、`codebase_search`、`file_search` | 经 OpenCode **服务端** `find` API（与内置同源 ripgrep） |
| 占位说明 | `ApplyPatch`、`Delete`、`MultiEdit` 等 | 提示改用 `edit` / `bash` / `apply_patch` |

`tool.execute.before` 会把常见 Cursor 字段归一，例如：`query` → `pattern`，`glob_pattern` → `pattern`，`target_directory` → `path`。

## 安装

改 `~/.config/opencode/opencode.json`（Windows：`%USERPROFILE%\.config\opencode\opencode.json`），在 `plugin` 中加入：

```json
"plugin": [
  "opencode-composer-bridge@git+https://github.com/bkm016/opencode-composer-bridge.git"
]
```

或把仓库 `index.ts` 复制为 `~/.config/opencode/plugins/opencode-composer-bridge.ts`。

安装或更新后 **重启 OpenCode**。

## 依赖

- **OpenCode**（`plugins` 或 git `plugin`）
- 搜代码依赖本机 **ripgrep**（由 OpenCode 内置 `grep`/`glob` 与服务端 `find` 使用，插件不单独安装 `rg`）

## License

MIT