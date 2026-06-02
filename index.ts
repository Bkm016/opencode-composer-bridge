/**
 * OpenCode Plugin: opencode-composer-bridge
 *
 * Cursor / Composer 工具名与参数 → OpenCode（read/write/edit/glob/grep + 别名）。
 * 参数别名、CRLF 友好 edit、rg/fast-glob；无同名内置的 Cursor 工具为说明型占位。
 *
 * @author sky
 */

const CURSOR_TOOL_MAP =
  "StrReplace/search_replace→edit; Write→write; Read→read; list_dir/LS→read或glob; Grep/codebase_search→grep; Glob/file_search→glob; ApplyPatch(Cursor)→edit或apply_patch(patchText); Delete→bash。"

import fs from "fs"
import path from "path"
import { spawnSync } from "child_process"
import { tool } from "@opencode-ai/plugin"

type ArgRecord = Record<string, unknown>

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
const MAX_BYTES = 50 * 1024
const MAX_BYTES_LABEL = `${MAX_BYTES / 1024} KB`
const SAMPLE_BYTES = 4096
const GLOB_LIMIT = 100
const GREP_LIMIT = 100

/** 列出本次调用里模型实际传入的键名 */
const keysReceived = (args: ArgRecord): string => {
  const keys = Object.keys(args).filter((k) => args[k] !== undefined && args[k] !== null)
  return keys.length ? keys.join(", ") : "(空对象)"
}

/** 缺参时抛出带示例的错误（示例仅用占位路径） */
const missingParam = (
  toolName: string,
  canonical: string,
  aliases: string[],
  examples: object[],
  received: ArgRecord,
): never => {
  const ex = examples.map((e) => JSON.stringify(e, null, 2)).join("\n\n或\n\n")
  throw new Error(
    `[${toolName}] 缺少必填参数「${canonical}」。\n` +
      `可用参数名: ${aliases.join(" / ")}\n` +
      `你本次传入的键: ${keysReceived(received)}\n\n` +
      `正确示例:\n${ex}`,
  )
}

/** 解析 StrReplace / edit 的 old/new 文本 */
const resolveReplaceStrings = (
  args: ArgRecord,
  toolName: string,
): { oldString: string; newString: string; replaceAll?: boolean } => {
  const oldKeys = ["oldString", "old_string", "old_str", "oldText", "old_text"]
  const newKeys = ["newString", "new_string", "new_str", "newText", "new_text"]
  let oldString: string | undefined
  let newString: string | undefined
  for (const k of oldKeys) {
    const v = args[k]
    if (typeof v === "string") {
      oldString = v
      break
    }
  }
  for (const k of newKeys) {
    const v = args[k]
    if (typeof v === "string") {
      newString = v
      break
    }
  }
  if (oldString === undefined) {
    missingParam(toolName, "oldString", oldKeys, [{ path: "a.kt", oldString: "x", newString: "y" }], args)
  }
  if (newString === undefined) {
    missingParam(toolName, "newString", newKeys, [{ path: "a.kt", oldString: "x", newString: "y" }], args)
  }
  return {
    oldString,
    newString,
    replaceAll: args.replaceAll === true || args.replace_all === true,
  }
}

/** 将片段在 LF / CRLF 两种形式间展开，便于与 Windows 文本匹配 */
const newlineVariants = (oldString: string, newString: string): { old: string; neu: string }[] => {
  const baseOld = oldString.replace(/\r\n/g, "\n")
  const baseNew = newString.replace(/\r\n/g, "\n")
  const crlfOld = baseOld.replace(/\n/g, "\r\n")
  const crlfNew = baseNew.replace(/\n/g, "\r\n")
  const out: { old: string; neu: string }[] = [{ old: oldString, neu: newString }]
  if (crlfOld !== oldString || crlfNew !== newString) {
    out.push({ old: crlfOld, neu: crlfNew })
  }
  if (baseOld !== oldString) {
    out.push({ old: baseOld, neu: baseNew })
  }
  const seen = new Set<string>()
  return out.filter((v) => {
    const k = v.old
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** 在文件内容中做替换；自动尝试 CRLF / LF 变体 */
const applyTextReplace = (
  text: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string | null => {
  for (const { old, neu } of newlineVariants(oldString, newString)) {
    if (!text.includes(old)) continue
    const count = text.split(old).length - 1
    if (count > 1 && !replaceAll) {
      throw new Error(
        "Found multiple matches for oldString. Provide more surrounding lines or use replaceAll.",
      )
    }
    return replaceAll ? text.split(old).join(neu) : text.replace(old, neu)
  }
  return null
}

/** 执行与 edit 相同的字符串替换 */
const performFileReplace = (
  directory: string,
  args: ArgRecord,
  toolName: string,
): string => {
  const rel = resolveFilePath(args, toolName)
  const filepath = normalizeWin(resolveAbs(rel, directory))
  if (!fs.existsSync(filepath)) {
    throw new Error(fileNotFoundHint(filepath))
  }
  const text = fs.readFileSync(filepath, "utf8")
  const { oldString, newString, replaceAll } = resolveReplaceStrings(args, toolName)
  const next = applyTextReplace(text, oldString, newString, replaceAll ?? false)
  if (next === null) {
    const hint =
      text.includes("\r\n") && !oldString.includes("\r\n")
        ? "\n\n提示: 该文件使用 CRLF 换行。请用 read 复制原文作为 oldString，或让 oldString 使用 \\n（插件会自动尝试 CRLF 匹配）。"
        : ""
    throw new Error(`oldString not found in content${hint}`)
  }
  fs.writeFileSync(filepath, next, "utf8")
  return "Wrote file successfully."
}

const resolveFilePath = (args: ArgRecord, toolName: string): string => {
  const aliases = ["filePath", "path", "file", "filepath", "file_path"]
  for (const key of aliases) {
    const v = args[key]
    if (typeof v === "string" && v.trim().length > 0) return v.trim()
  }
  missingParam(toolName, "filePath", aliases, [{ path: "src/Foo.kt", offset: 1, limit: 80 }], args)
}

const resolveGlobPattern = (args: ArgRecord): string => {
  const aliases = ["pattern", "glob_pattern", "glob", "file_pattern"]
  for (const key of aliases) {
    const v = args[key]
    if (typeof v === "string" && v.trim().length > 0) return v.trim()
  }
  missingParam(
    "glob",
    "pattern",
    aliases,
    [
      { pattern: "**/icon_trait*", path: "." },
      { glob_pattern: "**/*.kt", target_directory: "." },
    ],
    args,
  )
}

const resolveGrepPattern = (args: ArgRecord): string => {
  const aliases = ["pattern", "query", "search", "regex"]
  for (const key of aliases) {
    const v = args[key]
    if (typeof v === "string" && v.trim().length > 0) return v.trim()
  }
  missingParam(
    "grep",
    "pattern",
    aliases,
    [{ pattern: "class Foo", path: "." }, { query: "TODO", include: "*.kt" }],
    args,
  )
}

const resolveSearchRoot = (args: ArgRecord, fallback: string): string => {
  const aliases = ["path", "target_directory", "directory", "cwd", "dir", "root"]
  for (const key of aliases) {
    const v = args[key]
    if (typeof v === "string" && v.trim().length > 0) return v.trim()
  }
  return fallback
}

const resolveAbs = (file: string, directory: string): string => {
  if (path.isAbsolute(file)) return path.normalize(file)
  return path.resolve(directory, file)
}

const normalizeWin = (p: string): string => (process.platform === "win32" ? path.normalize(p) : p)

/** 与官方 read 一致的二进制判定（基于扩展名 + 采样） */
const isBinaryFile = (filepath: string, bytes: Buffer): boolean => {
  const ext = path.extname(filepath).toLowerCase()
  const binExt = new Set([
    ".zip", ".tar", ".gz", ".exe", ".dll", ".so", ".class", ".jar", ".war", ".7z",
    ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".bin", ".dat", ".wasm", ".pyc", ".pyo",
  ])
  if (binExt.has(ext)) return true
  if (bytes.length === 0) return false
  let nonPrintable = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return true
    if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) nonPrintable++
  }
  return nonPrintable / bytes.length > 0.3
}

/** 文件未找到时给出 Did you mean（对齐官方） */
const fileNotFoundHint = (filepath: string): string => {
  const dir = path.dirname(filepath)
  const base = path.basename(filepath)
  try {
    const items = fs.readdirSync(dir)
    const similar = items
      .filter(
        (item) =>
          item.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(item.toLowerCase()),
      )
      .slice(0, 3)
      .map((item) => path.join(dir, item))
    if (similar.length > 0) {
      return `File not found: ${filepath}\n\nDid you mean one of these?\n${similar.join("\n")}`
    }
  } catch {
    // 目录不可读则只报 not found
  }
  return `File not found: ${filepath}`
}

/** 按官方规则读取文本行（行数上限 + 输出字节上限） */
const readTextLines = (
  filepath: string,
  offset: number,
  limit: number,
): { raw: string[]; count: number; cut: boolean; more: boolean } => {
  const content = fs.readFileSync(filepath, "utf8")
  const allLines = content.split(/\r?\n/)
  const count = allLines.length
  const start = Math.max(offset - 1, 0)
  const slice = allLines.slice(start, start + limit)
  const raw: string[] = []
  let bytes = 0
  let cut = false
  let more = start + slice.length < count
  for (const text of slice) {
    if (raw.length >= limit) {
      more = true
      break
    }
    const line =
      text.length > MAX_LINE_LENGTH ? text.substring(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : text
    const size = Buffer.byteLength(line, "utf8") + (raw.length > 0 ? 1 : 0)
    if (bytes + size > MAX_BYTES) {
      cut = true
      more = true
      break
    }
    raw.push(line)
    bytes += size
  }
  return { raw, count, cut, more }
}

const listDirectory = (filepath: string, offset: number, limit: number): { items: string[]; total: number } => {
  const names = fs.readdirSync(filepath)
  const items: string[] = []
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    const full = path.join(filepath, name)
    try {
      const st = fs.lstatSync(full)
      if (st.isDirectory()) items.push(name + "/")
      else items.push(name)
    } catch {
      items.push(name)
    }
  }
  const start = offset - 1
  return { items: items.slice(start, start + limit), total: items.length }
}

const runRipgrep = (args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } => {
  const result = spawnSync("rg", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  })
  const ok = result.status === 0 || result.status === 1
  return {
    ok,
    stdout: (result.stdout ?? "").toString(),
    stderr: (result.stderr ?? "").toString(),
  }
}

const globWithRipgrep = (search: string, pattern: string): string[] => {
  const { ok, stdout } = runRipgrep(["--files", "-g", pattern, search], search)
  if (!ok && !stdout) return []
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((rel) => path.resolve(search, rel))
}

const globWithFastGlob = async (search: string, pattern: string): Promise<string[]> => {
  const fg = await import("fast-glob")
  const entries = await fg.default(pattern, {
    cwd: search,
    absolute: true,
    onlyFiles: true,
    suppressErrors: true,
  })
  return entries as string[]
}

const grepWithRipgrep = (
  cwd: string,
  pattern: string,
  include?: string,
  singleFile?: string,
): { path: string; line: number; text: string }[] => {
  const args = ["-n", "--no-heading", pattern]
  if (include) args.push("-g", include)
  if (singleFile) args.push(singleFile)
  else args.push(cwd)
  const { stdout } = runRipgrep(args, cwd)
  const rows: { path: string; line: number; text: string }[] = []
  for (const row of stdout.split(/\r?\n/)) {
    if (!row) continue
    const m = row.match(/^(.+?):(\d+):(.*)$/)
    if (!m) continue
    const p = path.isAbsolute(m[1]) ? m[1] : path.join(cwd, m[1])
    rows.push({ path: normalizeWin(p), line: Number(m[2]), text: m[3] })
  }
  return rows
}

const TOOL_DOC = {
  read:
    "Read file. Required: filePath OR path. Optional: offset, limit (1-based). Example: {\"path\":\"a.kt\",\"offset\":1,\"limit\":50}",
  write: "Write file. Required: (filePath|path) + content. Example: {\"path\":\"out.txt\",\"content\":\"hi\"}",
  edit:
    "Edit file. Required: (filePath|path) + oldString + newString. Example: {\"path\":\"a.kt\",\"oldString\":\"x\",\"newString\":\"y\"}",
  StrReplace:
    "Same as edit (Cursor alias). Use edit or StrReplace — NOT unavailable. Example: {\"path\":\"a.kt\",\"old_string\":\"x\",\"new_string\":\"y\"}",
  glob:
    "Glob files. Required: pattern OR glob_pattern. Optional: path OR target_directory. Example: {\"pattern\":\"**/*.kt\",\"path\":\".\"}",
  grep:
    "Grep content. Required: pattern OR query. Optional: path, include. Example: {\"pattern\":\"Foo\",\"path\":\".\",\"include\":\"*.kt\"}",
}

const cursorStub = (name: string, use: string) =>
  tool({
    description: `Cursor「${name}」→ 请用 **${use}**。`,
    args: { note: tool.schema.string().optional() },
    async execute() {
      throw new Error(`[${name}] ${CURSOR_TOOL_MAP}\n请改用: ${use}`)
    },
  })

const OpencodeComposerBridgePlugin = async () => {
  return {
    "tool.definition": async (
      input: { toolID: string },
      output: { description: string; parameters: unknown },
    ) => {
      const extra = TOOL_DOC[input.toolID as keyof typeof TOOL_DOC]
      if (extra) {
        output.description = `${output.description}\n\n[opencode-composer-bridge] ${extra}`
      }
      if (input.toolID === "edit") {
        output.description =
          `${output.description}\n\n[opencode-composer-bridge] 改文件用 **edit** / **StrReplace**（勿调未在列表中的工具名 → invalid）。`
      }
    },

    "experimental.chat.system.transform": async (
      _input: { sessionID?: string },
      output: { system: string[] },
    ) => {
      output.system.push(
        `## Cursor / Composer → OpenCode\n${CURSOR_TOOL_MAP}\n` +
          "改文件: **edit**（path + oldString + newString）。整文件: **write**。勿用未注册工具名。",
      )
    },

    tool: {
      list_dir: cursorStub("list_dir", "read（path=目录）或 glob"),
      ListDir: cursorStub("ListDir", "read 或 glob"),
      LS: cursorStub("LS", "read 或 glob"),
      ApplyPatch: cursorStub("ApplyPatch", "edit 或 apply_patch"),
      Delete: cursorStub("Delete", "bash"),
      delete_file: cursorStub("delete_file", "bash"),
      MultiEdit: cursorStub("MultiEdit", "多次 edit"),
      codebase_search: cursorStub("codebase_search", "grep"),
      file_search: cursorStub("file_search", "glob"),
      read: tool({
        description: TOOL_DOC.read,
        args: {
          filePath: tool.schema.string().optional(),
          path: tool.schema.string().optional(),
          file: tool.schema.string().optional(),
          offset: tool.schema.coerce.number().int().positive().optional(),
          limit: tool.schema.coerce.number().int().positive().optional(),
        },
        async execute(args, ctx) {
          const a = args as ArgRecord
          let filepath = resolveFilePath(a, "read")
          filepath = resolveAbs(filepath, ctx.directory)
          filepath = normalizeWin(filepath)
          if (!fs.existsSync(filepath)) {
            throw new Error(fileNotFoundHint(filepath))
          }
          const stat = fs.statSync(filepath)
          const limit = (args.limit as number | undefined) ?? DEFAULT_READ_LIMIT
          const offset = (args.offset as number | undefined) || 1
          if (stat.isDirectory()) {
            const { items, total } = listDirectory(filepath, offset, limit)
            const truncated = offset - 1 + items.length < total
            const body = [
              `<path>${filepath}</path>`,
              `<type>directory</type>`,
              `<entries>`,
              items.join("\n"),
              truncated
                ? `\n(Showing ${items.length} of ${total} entries. Use 'offset' parameter to read beyond entry ${offset + items.length})`
                : `\n(${total} entries)`,
              `</entries>`,
            ].join("\n")
            return body
          }
          const sample = Buffer.alloc(Math.min(SAMPLE_BYTES, stat.size))
          const fd = fs.openSync(filepath, "r")
          try {
            fs.readSync(fd, sample, 0, sample.length, 0)
          } finally {
            fs.closeSync(fd)
          }
          if (isBinaryFile(filepath, sample)) {
            throw new Error(`Cannot read binary file: ${filepath}`)
          }
          const file = readTextLines(filepath, offset, limit)
          if (file.count < offset && !(file.count === 0 && offset === 1)) {
            throw new Error(`Offset ${offset} is out of range for this file (${file.count} lines)`)
          }
          let output = [`<path>${filepath}</path>`, `<type>file</type>`, "<content>\n"].join("\n")
          output += file.raw.map((line, i) => `${i + offset}: ${line}`).join("\n")
          const last = offset + file.raw.length - 1
          const next = last + 1
          if (file.cut) {
            output += `\n\n(Output capped at ${MAX_BYTES_LABEL}. Showing lines ${offset}-${last}. Use offset=${next} to continue.)`
          } else if (file.more) {
            output += `\n\n(Showing lines ${offset}-${last} of ${file.count}. Use offset=${next} to continue.)`
          } else {
            output += `\n\n(End of file - total ${file.count} lines)`
          }
          output += "\n</content>"
          return output
        },
      }),

      write: tool({
        description: TOOL_DOC.write,
        args: {
          filePath: tool.schema.string().optional(),
          path: tool.schema.string().optional(),
          content: tool.schema.string(),
        },
        async execute(args, ctx) {
          const rel = resolveFilePath(args as ArgRecord, "write")
          const filepath = normalizeWin(resolveAbs(rel, ctx.directory))
          fs.mkdirSync(path.dirname(filepath), { recursive: true })
          fs.writeFileSync(filepath, args.content, "utf8")
          return "Wrote file successfully."
        },
      }),

      Write: tool({
        description: "Cursor alias → same as write.",
        args: {
          filePath: tool.schema.string().optional(),
          path: tool.schema.string().optional(),
          content: tool.schema.string(),
        },
        async execute(args, ctx) {
          const rel = resolveFilePath(args as ArgRecord, "Write")
          const filepath = normalizeWin(resolveAbs(rel, ctx.directory))
          fs.mkdirSync(path.dirname(filepath), { recursive: true })
          fs.writeFileSync(filepath, args.content, "utf8")
          return "Wrote file successfully."
        },
      }),

      edit: tool({
        description: `${TOOL_DOC.edit} Do not use Cursor-only names; StrReplace is also registered with the same behavior.`,
        args: {
          filePath: tool.schema.string().optional(),
          path: tool.schema.string().optional(),
          oldString: tool.schema.string().optional(),
          newString: tool.schema.string().optional(),
          old_string: tool.schema.string().optional(),
          new_string: tool.schema.string().optional(),
          replaceAll: tool.schema.boolean().optional(),
          replace_all: tool.schema.boolean().optional(),
        },
        async execute(args, ctx) {
          return performFileReplace(ctx.directory, args as ArgRecord, "edit")
        },
      }),

      StrReplace: tool({
        description: TOOL_DOC.StrReplace,
        args: {
          filePath: tool.schema.string().optional(),
          path: tool.schema.string().optional(),
          oldString: tool.schema.string().optional(),
          newString: tool.schema.string().optional(),
          old_string: tool.schema.string().optional(),
          new_string: tool.schema.string().optional(),
          replaceAll: tool.schema.boolean().optional(),
          replace_all: tool.schema.boolean().optional(),
        },
        async execute(args, ctx) {
          return performFileReplace(ctx.directory, args as ArgRecord, "StrReplace")
        },
      }),

      strreplace: tool({
        description: TOOL_DOC.StrReplace,
        args: {
          filePath: tool.schema.string().optional(),
          path: tool.schema.string().optional(),
          oldString: tool.schema.string().optional(),
          newString: tool.schema.string().optional(),
          old_string: tool.schema.string().optional(),
          new_string: tool.schema.string().optional(),
          replaceAll: tool.schema.boolean().optional(),
          replace_all: tool.schema.boolean().optional(),
        },
        async execute(args, ctx) {
          return performFileReplace(ctx.directory, args as ArgRecord, "strreplace")
        },
      }),

      search_replace: tool({
        description: "Cursor alias → same as edit.",
        args: {
          filePath: tool.schema.string().optional(),
          path: tool.schema.string().optional(),
          oldString: tool.schema.string().optional(),
          newString: tool.schema.string().optional(),
          old_string: tool.schema.string().optional(),
          new_string: tool.schema.string().optional(),
          replaceAll: tool.schema.boolean().optional(),
          replace_all: tool.schema.boolean().optional(),
        },
        async execute(args, ctx) {
          return performFileReplace(ctx.directory, args as ArgRecord, "search_replace")
        },
      }),

      glob: tool({
        description: TOOL_DOC.glob,
        args: {
          pattern: tool.schema.string().optional(),
          glob_pattern: tool.schema.string().optional(),
          glob: tool.schema.string().optional(),
          file_pattern: tool.schema.string().optional(),
          path: tool.schema.string().optional(),
          target_directory: tool.schema.string().optional(),
          directory: tool.schema.string().optional(),
          cwd: tool.schema.string().optional(),
        },
        async execute(args, ctx) {
          const a = args as ArgRecord
          const pattern = resolveGlobPattern(a)
          const search = normalizeWin(resolveAbs(resolveSearchRoot(a, ctx.directory), ctx.directory))
          if (!fs.existsSync(search)) {
            throw new Error(`glob path must exist: ${search}`)
          }
          const st = fs.statSync(search)
          if (!st.isDirectory()) {
            throw new Error(`glob path must be a directory: ${search}`)
          }
          let paths = globWithRipgrep(search, pattern)
          if (paths.length === 0) {
            try {
              paths = await globWithFastGlob(search, pattern)
            } catch {
              paths = []
            }
          }
          const withMtime = paths.map((p) => {
            try {
              return { path: p, mtime: fs.statSync(p).mtimeMs }
            } catch {
              return { path: p, mtime: 0 }
            }
          })
          withMtime.sort((x, y) => y.mtime - x.mtime)
          let truncated = false
          if (withMtime.length > GLOB_LIMIT) {
            truncated = true
            withMtime.length = GLOB_LIMIT
          }
          const output: string[] = []
          if (withMtime.length === 0) output.push("No files found")
          else {
            output.push(...withMtime.map((f) => f.path))
            if (truncated) {
              output.push("")
              output.push(
                `(Results are truncated: showing first ${GLOB_LIMIT} results. Consider using a more specific path or pattern.)`,
              )
            }
          }
          return output.join("\n")
        },
      }),

      grep: tool({
        description: TOOL_DOC.grep,
        args: {
          pattern: tool.schema.string().optional(),
          query: tool.schema.string().optional(),
          search: tool.schema.string().optional(),
          regex: tool.schema.string().optional(),
          path: tool.schema.string().optional(),
          target_directory: tool.schema.string().optional(),
          include: tool.schema.string().optional(),
          glob: tool.schema.string().optional(),
        },
        async execute(args, ctx) {
          const a = args as ArgRecord
          const pattern = resolveGrepPattern(a)
          const requested = normalizeWin(
            resolveAbs(resolveSearchRoot(a, ctx.directory), ctx.directory),
          )
          if (!fs.existsSync(requested)) {
            return "No files found"
          }
          const info = fs.statSync(requested)
          const cwd = info.isDirectory() ? requested : path.dirname(requested)
          const singleFile = info.isDirectory() ? undefined : requested
          const include = (a.include ?? a.glob) as string | undefined
          let rows = grepWithRipgrep(cwd, pattern, include, singleFile)
          if (rows.length === 0) {
            return "No files found"
          }
          const times = new Map<string, number>()
          for (const p of new Set(rows.map((r) => r.path))) {
            try {
              times.set(p, fs.statSync(p).mtimeMs)
            } catch {
              // 跳过不可 stat 的路径
            }
          }
          const matches = rows
            .map((r) => ({ ...r, mtime: times.get(r.path) ?? 0 }))
            .filter((r) => times.has(r.path))
          matches.sort((x, y) => y.mtime - x.mtime)
          const total = matches.length
          const truncated = total > GREP_LIMIT
          const final = truncated ? matches.slice(0, GREP_LIMIT) : matches
          const output = [`Found ${total} matches${truncated ? ` (showing first ${GREP_LIMIT})` : ""}`]
          let current = ""
          for (const match of final) {
            if (current !== match.path) {
              if (current !== "") output.push("")
              current = match.path
              output.push(`${match.path}:`)
            }
            const text =
              match.text.length > MAX_LINE_LENGTH
                ? match.text.substring(0, MAX_LINE_LENGTH) + "..."
                : match.text
            output.push(`  Line ${match.line}: ${text}`)
          }
          if (truncated) {
            output.push("")
            output.push(
              `(Results truncated: showing ${GREP_LIMIT} of ${total} matches (${total - GREP_LIMIT} hidden). Consider using a more specific path or pattern.)`,
            )
          }
          return output.join("\n")
        },
      }),
    },
  }
}

export { OpencodeComposerBridgePlugin }
export default OpencodeComposerBridgePlugin