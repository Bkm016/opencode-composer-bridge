# opencode-composer-bridge

本插件用于在 **OpenCode** 中运行 **Cursor Composer 2.5** 时，对齐双方工具名与参数约定。Composer 侧常使用 `StrReplace`、`path`、`glob_pattern` 等字段；OpenCode 内置工具要求 `edit`、`filePath`、`pattern` 等。不一致时会出现 `invalid` 或 schema 校验失败。插件在 OpenCode 侧完成名称与参数的映射，使读写、编辑与搜索类工具调用可正常执行。

## 功能

- 注册 Cursor 侧常用工具名（如 `StrReplace`、`Write`、`search_replace`），行为对应 `edit`、`write` 等
- 参数别名：`path` / `filePath`，`glob_pattern`、`target_directory` / `pattern`、`path` 等
- 覆盖 `read`、`write`、`edit`、`glob`、`grep`；`edit` 支持 Windows CRLF 与 LF 自动匹配
- `glob`、`grep` 优先调用 `rg`；`glob` 在无 `rg` 时回退 `fast-glob`
- 对 `list_dir`、`ApplyPatch` 等无内置同名工具的名称，返回 OpenCode 侧应使用的工具说明

## 安装

任选其一，完成后重启 OpenCode。

### 通过 `plugin`（推荐）

在 `~/.config/opencode/opencode.json`（Windows：`%USERPROFILE%\.config\opencode\opencode.json`）的 `plugin` 中加入：

```json
"plugin": [
  "opencode-composer-bridge@git+https://github.com/bkm016/opencode-composer-bridge.git"
]
```

由 OpenCode 拉取仓库并安装 `package.json` 中的依赖（含 `fast-glob`）。

### 手动复制

将本仓库 `index.ts` 复制为：

`~/.config/opencode/plugins/opencode-composer-bridge.ts`

在 `~/.config/opencode` 目录执行：

```bash
npm install fast-glob
```

## 依赖

| 项 | 是否必须 | 说明 |
|----|----------|------|
| OpenCode | 是 | 支持 `plugins/*.ts` 或 `plugin` git 包 |
| `fast-glob` | **glob 必需** | `plugin` git 安装会自动装；仅复制 `index.ts` 时须在 `~/.config/opencode` 执行 `npm install fast-glob`，否则 glob 会报错 |
| `rg`（ripgrep） | grep 强烈建议；glob 可选 | **grep** 依赖 `rg`；**glob** 优先 `rg`，失败再用 `fast-glob`。未装 `rg` 时 glob 仍可用（仅 fast-glob） |

## License

MIT