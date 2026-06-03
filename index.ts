/**
 * OpenCode Plugin: opencode-composer-bridge
 *
 * Cursor / Composer 工具名与参数 → OpenCode（read/write/edit + 别名；grep/glob 走内置）。
 *
 * @author sky
 */

const CURSOR_TOOL_MAP =
  "StrReplace/search_replace→edit; Write→write; Read→read; list_dir/LS→read或glob; Grep/codebase_search→grep; Glob/file_search→glob; run_terminal_cmd→bash; ApplyPatch(Cursor)→edit或apply_patch(patchText); Delete→bash。"

import fs from "fs"
import path from "path"
import { spawnSync } from "child_process"
import { tool, type Plugin, type PluginInput } from "@opencode-ai/plugin"

type ArgRecord = Record<string, unknown>

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
const MAX_BYTES = 50 * 1024
const MAX_BYTES_LABEL = `${MAX_BYTES / 1024} KB`
const SAMPLE_BYTES = 4096
const PATH_KEYS = ["filePath", "path", "file", "filepath", "file_path"]
const GLOB_PATTERN_KEYS = ["pattern", "glob_pattern", "glob", "file_pattern"]
const GREP_PATTERN_KEYS = ["pattern", "query", "search", "regex"]
const SEARCH_ROOT_KEYS = ["path", "target_directory", "directory", "cwd", "dir", "root"]
const RUN_CMD_KEYS = ["command", "cmd"]
const WORKDIR_KEYS = ["workdir", "working_directory", "cwd", "directory"]
const DEFAULT_SHELL_TIMEOUT_MS = 120_000
const WRITE_BODY_KEYS = ["content", "contents", "text", "body"]
const EDIT_OLD_KEYS = ["oldString", "old_string", "old_str", "oldText", "old_text"]
const EDIT_NEW_KEYS = ["newString", "new_string", "new_str", "newText", "new_text"]

const keysReceived = (args: ArgRecord): string => {
  const keys = Object.keys(args).filter((k) => args[k] !== undefined && args[k] !== null)
  return keys.length ? keys.join(", ") : "(空对象)"
}

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

const pickString = (args: ArgRecord, keys: string[], trim = true): string | undefined => {
  for (const key of keys) {
    const v = args[key]
    if (typeof v === "string") {
      const s = trim ? v.trim() : v
      if (trim && s.length === 0) continue
      return s
    }
  }
  return undefined
}

const resolveFilePath = (args: ArgRecord, toolName: string): string => {
  const v = pickString(args, PATH_KEYS)
  if (v) return v
  missingParam(toolName, "filePath", PATH_KEYS, [{ path: "src/Foo.kt" }], args)
}

const resolveWriteContent = (args: ArgRecord, toolName: string): string => {
  const v = pickString(args, WRITE_BODY_KEYS, false)
  if (v !== undefined) return v
  missingParam(toolName, "content", WRITE_BODY_KEYS, [{ path: "a.kt", contents: "..." }], args)
}

const resolveAbs = (file: string, directory: string): string =>
  path.isAbsolute(file) ? path.normalize(file) : path.resolve(directory, file)

const normalizeWin = (p: string): string => (process.platform === "win32" ? path.normalize(p) : p)

const resolveReplaceStrings = (
  args: ArgRecord,
  toolName: string,
): { oldString: string; newString: string; replaceAll: boolean } => {
  const oldString = pickString(args, EDIT_OLD_KEYS, false)
  const newString = pickString(args, EDIT_NEW_KEYS, false)
  if (oldString === undefined) {
    missingParam(toolName, "oldString", EDIT_OLD_KEYS, [{ path: "a.kt", oldString: "x", newString: "y" }], args)
  }
  if (newString === undefined) {
    missingParam(toolName, "newString", EDIT_NEW_KEYS, [{ path: "a.kt", oldString: "x", newString: "y" }], args)
  }
  return {
    oldString,
    newString,
    replaceAll: args.replaceAll === true || args.replace_all === true,
  }
}

const newlineVariants = (oldString: string, newString: string): { old: string; neu: string }[] => {
  const baseOld = oldString.replace(/\r\n/g, "\n")
  const baseNew = newString.replace(/\r\n/g, "\n")
  const crlfOld = baseOld.replace(/\n/g, "\r\n")
  const crlfNew = baseNew.replace(/\n/g, "\r\n")
  const out: { old: string; neu: string }[] = [{ old: oldString, neu: newString }]
  if (crlfOld !== oldString || crlfNew !== newString) out.push({ old: crlfOld, neu: crlfNew })
  if (baseOld !== oldString) out.push({ old: baseOld, neu: baseNew })
  const seen = new Set<string>()
  return out.filter((v) => {
    if (seen.has(v.old)) return false
    seen.add(v.old)
    return true
  })
}

const countOccurrences = (text: string, needle: string): number => {
  if (!needle) return 0
  let n = 0
  let i = 0
  while ((i = text.indexOf(needle, i)) !== -1) {
    n++
    i += needle.length
  }
  return n
}

const applyTextReplace = (
  text: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string | null => {
  for (const { old, neu } of newlineVariants(oldString, newString)) {
    if (!text.includes(old)) continue
    const count = countOccurrences(text, old)
    if (count > 1 && !replaceAll) {
      throw new Error(
        "Found multiple matches for oldString. Provide more surrounding lines or use replaceAll.",
      )
    }
    return replaceAll ? text.split(old).join(neu) : text.replace(old, neu)
  }
  return null
}

const performFileReplace = (directory: string, args: ArgRecord, toolName: string): string => {
  const filepath = normalizeWin(resolveAbs(resolveFilePath(args, toolName), directory))
  if (!fs.existsSync(filepath)) throw new Error(fileNotFoundHint(filepath))
  const text = fs.readFileSync(filepath, "utf8")
  const { oldString, newString, replaceAll } = resolveReplaceStrings(args, toolName)
  const next = applyTextReplace(text, oldString, newString, replaceAll)
  if (next === null) {
    const hint =
      text.includes("\r\n") && !oldString.includes("\r\n")
        ? "\n\n提示: 该文件使用 CRLF 换行。请用 read 复制原文作为 oldString。"
        : ""
    throw new Error(`oldString not found in content${hint}`)
  }
  fs.writeFileSync(filepath, next, "utf8")
  return "Wrote file successfully."
}

type MultiEditEntry = { path?: string; filePath?: string; oldString?: string; newString?: string; old_string?: string; new_string?: string; replaceAll?: boolean; replace_all?: boolean }

const performMultiEdit = (directory: string, args: ArgRecord, toolName: string): string => {
  const raw = args.edits ?? args.changes ?? args.operations
  if (!Array.isArray(raw) || raw.length === 0) {
    return `[${toolName}] 未提供 edits 数组。示例: {"edits":[{"path":"a.kt","oldString":"x","newString":"y"}]}`
  }
  const results: string[] = []
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i] as MultiEditEntry
    const sub: ArgRecord = {
      path: entry.path ?? entry.filePath,
      filePath: entry.filePath ?? entry.path,
      oldString: entry.oldString ?? entry.old_string,
      newString: entry.newString ?? entry.new_string,
      replaceAll: entry.replaceAll ?? entry.replace_all,
    }
    try {
      const msg = performFileReplace(directory, sub, toolName)
      results.push(`[${i + 1}] ${pickString(sub, PATH_KEYS) ?? "?"}: ${msg}`)
    } catch (e) {
      results.push(`[${i + 1}] ${pickString(sub, PATH_KEYS) ?? "?"}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return results.join("\n")
}

const performWrite = (directory: string, args: ArgRecord, toolName: string): string => {
  const filepath = normalizeWin(resolveAbs(resolveFilePath(args, toolName), directory))
  const body = resolveWriteContent(args, toolName)
  fs.mkdirSync(path.dirname(filepath), { recursive: true })
  fs.writeFileSync(filepath, body, "utf8")
  return "Wrote file successfully."
}

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

const fileNotFoundHint = (filepath: string): string => {
  const dir = path.dirname(filepath)
  const base = path.basename(filepath)
  try {
    const similar = fs
      .readdirSync(dir)
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
    // 目录不可读
  }
  return `File not found: ${filepath}`
}

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
  const names = fs.readdirSync(filepath).sort((a, b) => a.localeCompare(b))
  const items: string[] = []
  for (const name of names) {
    const full = path.join(filepath, name)
    try {
      items.push(fs.lstatSync(full).isDirectory() ? `${name}/` : name)
    } catch {
      items.push(name)
    }
  }
  const start = offset - 1
  return { items: items.slice(start, start + limit), total: items.length }
}

const formatDirectoryListing = (filepath: string, offset: number, limit: number): string => {
  const { items, total } = listDirectory(filepath, offset, limit)
  const truncated = offset - 1 + items.length < total
  return [
    `<path>${filepath}</path>`,
    `<type>directory</type>`,
    `<entries>`,
    items.join("\n"),
    truncated ? `\n(Showing ${items.length} of ${total} entries.)` : `\n(${total} entries)`,
    `</entries>`,
  ].join("\n")
}

const resolveListDirPath = (args: ArgRecord, directory: string): string => {
  const raw = pickString(args, PATH_KEYS)
  const rel = raw ?? "."
  return normalizeWin(resolveAbs(rel, directory))
}

const resolveShellCommand = (args: ArgRecord): string | undefined => {
  const v = pickString(args, RUN_CMD_KEYS, false)
  if (v !== undefined && v.length > 0) return v
  return undefined
}

/** Cursor run_terminal_cmd：本地 shell 执行，语义对齐 bash（非 OpenCode 持久会话） */
const runBridgedShell = (directory: string, args: ArgRecord, toolName: string): string => {
  const command = resolveShellCommand(args)
  if (!command) {
    return `[${toolName}] 未提供 command，未执行。示例: {"command":"echo ok"}`
  }
  const workdirRaw = pickString(args, WORKDIR_KEYS)
  const cwd = workdirRaw
    ? normalizeWin(resolveAbs(workdirRaw, directory))
    : directory
  if (!fs.existsSync(cwd)) throw new Error(`[${toolName}] workdir 不存在: ${cwd}`)
  const timeoutMs =
    typeof args.timeout === "number" && args.timeout > 0
      ? Math.min(args.timeout, 600_000)
      : DEFAULT_SHELL_TIMEOUT_MS
  const isWin = process.platform === "win32"
  const result = spawnSync(
    isWin ? "powershell.exe" : "/bin/sh",
    isWin ? ["-NoProfile", "-Command", command] : ["-c", command],
    {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      shell: false,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    },
  )
  const err = result.error as NodeJS.ErrnoException | undefined
  if (err?.code === "ETIMEDOUT") {
    throw new Error(`[${toolName}] 超时（${timeoutMs}ms）。请缩短命令或增大 timeout。`)
  }
  const stdout = (result.stdout ?? "").toString()
  const stderr = (result.stderr ?? "").toString()
  const code = result.status ?? (result.signal ? -1 : 0)
  const parts: string[] = [`[${toolName}] exit=${code} cwd=${cwd}`, ""]
  if (stdout) parts.push(stdout.trimEnd())
  if (stderr) {
    if (stdout) parts.push("")
    parts.push(`[stderr]\n${stderr.trimEnd()}`)
  }
  if (!stdout && !stderr) parts.push("(无输出)")
  return parts.join("\n")
}

/** 内置/插件 write·read·edit 调用前：Cursor 字段 → OpenCode 校验认可的键 */
const normalizeIoToolArgs = (toolName: string, a: ArgRecord): void => {
  const isWrite = toolName === "write" || toolName === "Write"
  const isRead = toolName === "read"
  const isEdit =
    toolName === "edit" ||
    toolName === "StrReplace" ||
    toolName === "strreplace" ||
    toolName === "search_replace"
  if (isWrite || isRead || isEdit) {
    const fp = pickString(a, PATH_KEYS)
    if (fp) {
      if (!a.path) a.path = fp
      if (!a.filePath) a.filePath = fp
    }
  }
  if (isWrite) {
    const body = pickString(a, WRITE_BODY_KEYS, false)
    if (body !== undefined) {
      if (a.content === undefined) a.content = body
      if (a.contents === undefined) a.contents = body
    }
  }
  if (isEdit) {
    const old = pickString(a, EDIT_OLD_KEYS, false)
    const neu = pickString(a, EDIT_NEW_KEYS, false)
    if (old !== undefined) {
      if (a.oldString === undefined) a.oldString = old
      if (a.old_string === undefined) a.old_string = old
    }
    if (neu !== undefined) {
      if (a.newString === undefined) a.newString = neu
      if (a.new_string === undefined) a.new_string = neu
    }
  }
}

const patchToolParametersForCursor = (toolID: string, parameters: unknown): void => {
  if (!parameters || typeof parameters !== "object") return
  const schema = parameters as Record<string, unknown>
  if (schema.type !== "object") return
  const props = (schema.properties ?? {}) as Record<string, unknown>
  schema.properties = props
  schema.additionalProperties = true

  const pathProps = {
    path: { type: "string", description: "File path" },
    filePath: { type: "string", description: "Alias of path (Cursor)" },
    file: { type: "string", description: "Alias of path" },
  }

  if (toolID === "write" || toolID === "Write") {
    Object.assign(props, pathProps, {
      content: { type: "string", description: "File body" },
      contents: { type: "string", description: "Alias of content (Cursor)" },
      text: { type: "string" },
      body: { type: "string" },
    })
    schema.required = []
    return
  }
  if (toolID === "read") {
    Object.assign(props, pathProps, {
      offset: { type: "integer" },
      limit: { type: "integer" },
    })
    schema.required = []
    return
  }
  if (toolID === "edit" || toolID === "StrReplace" || toolID === "search_replace") {
    Object.assign(props, pathProps, {
      oldString: { type: "string" },
      newString: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replaceAll: { type: "boolean" },
      replace_all: { type: "boolean" },
    })
    schema.required = []
  }
}

const normalizeBuiltinToolArgs = (toolName: string, a: ArgRecord): void => {
  const isGrep =
    toolName === "grep" ||
    toolName === "Grep" ||
    toolName === "codebase_search"
  const isGlob =
    toolName === "glob" || toolName === "Glob" || toolName === "file_search"
  if (!isGrep && !isGlob) return

  if (isGrep) {
    if (!pickString(a, ["pattern"]) && pickString(a, ["query", "search", "regex"])) {
      const p = pickString(a, GREP_PATTERN_KEYS)
      if (p) a.pattern = p
    }
    const inc = pickString(a, ["include", "glob"], false)
    if (inc && !a.include) a.include = inc.startsWith("**/") ? inc.slice(3) : inc
    for (const k of ["query", "search", "regex", "glob", "glob_pattern", "file_pattern"]) {
      delete a[k]
    }
  }

  if (isGlob) {
    if (!pickString(a, ["pattern"]) && pickString(a, GLOB_PATTERN_KEYS)) {
      const p = pickString(a, GLOB_PATTERN_KEYS)
      if (p) a.pattern = p
    }
    const root = pickString(a, SEARCH_ROOT_KEYS)
    if (root && !a.path) a.path = root
    for (const k of ["glob_pattern", "glob", "file_pattern", "target_directory", "directory", "cwd", "dir", "root"]) {
      delete a[k]
    }
    if (!pickString(a, ["pattern"])) a.pattern = "**/*"
  }
}

const coerceGrepPattern = (a: ArgRecord): string | undefined => {
  const p = pickString(a, ["pattern", "query", "search", "regex"])
  if (p) return p
  const onlyPath = pickString(a, PATH_KEYS) ?? pickString(a, SEARCH_ROOT_KEYS)
  if (onlyPath && fs.existsSync(onlyPath) && fs.statSync(onlyPath).isFile()) {
    return path.basename(onlyPath)
  }
  return undefined
}

const coerceFileFindQuery = (a: ArgRecord): string => {
  const q = pickString(a, ["pattern", "query", "glob_pattern", "glob", "file_pattern"])
  if (q) return q
  const p = pickString(a, PATH_KEYS) ?? pickString(a, SEARCH_ROOT_KEYS)
  if (p) {
    const base = path.basename(p.replace(/\\/g, "/"))
    if (base && base !== "." && base !== "..") return base.includes("*") ? base : `**/*${base}*`
  }
  return "**/*"
}

const resolveSearchDirectory = (a: ArgRecord, ctxDir: string): string => {
  const raw = pickString(a, SEARCH_ROOT_KEYS) ?? pickString(a, PATH_KEYS) ?? "."
  const abs = normalizeWin(resolveAbs(raw, ctxDir))
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
    return path.dirname(abs)
  }
  return abs
}

const softSearchHint = (toolName: string, kind: "text" | "files"): string =>
  `[${toolName}] 未提供搜索内容，未执行检索。\n` +
  (kind === "text"
    ? '请传入 pattern / query，例如: {"pattern":"Foo","path":"."}'
    : '请传入 pattern / query，例如: {"pattern":"**/*.kt","path":"."} 或 {"query":"README"}')

const TOOL_DOC = {
  read:
    "Read file. Required: filePath OR path. Optional: offset, limit (1-based). Example: {\"path\":\"a.kt\",\"offset\":1,\"limit\":50}",
  write:
    "Write file. Required: (filePath|path) + content OR contents. Example: {\"path\":\"out.txt\",\"contents\":\"...\"}",
  edit:
    "Edit file. Required: (filePath|path) + oldString + newString. Example: {\"path\":\"a.kt\",\"oldString\":\"x\",\"newString\":\"y\"}",
  StrReplace:
    "Same as edit (Cursor alias). Example: {\"path\":\"a.kt\",\"old_string\":\"x\",\"new_string\":\"y\"}",
  glob:
    "Glob files. Required: pattern OR glob_pattern. Optional: path OR target_directory. Example: {\"pattern\":\"**/*.kt\",\"path\":\".\"}",
  grep:
    "Grep content. Required: pattern OR query. Optional: path, include/glob, head_limit. Example: {\"pattern\":\"Foo|Bar\",\"path\":\".\",\"glob\":\"**/*.kt\",\"head_limit\":25}",
}

type FindTextRow = {
  path: { text: string }
  lines: { text: string }
  line_number: number
}

const formatSdkError = (err: unknown): string => {
  if (err == null) return "unknown"
  if (typeof err === "string") return err
  if (typeof err === "object") {
    const o = err as Record<string, unknown>
    if (typeof o.message === "string") return o.message
    if (typeof o.error === "string") return o.error
    try {
      return JSON.stringify(err)
    } catch {
      return String(err)
    }
  }
  return String(err)
}

const unwrapSdkData = <T>(res: { data?: T; error?: unknown }): T => {
  if (res.error) {
    throw new Error(`[opencode find API] ${formatSdkError(res.error)}`)
  }
  if (res.data === undefined) throw new Error("[opencode find API] 无返回数据")
  return res.data
}

const formatFindTextResults = (rows: FindTextRow[], cap: number): string => {
  if (rows.length === 0) return "No files found"
  const truncated = rows.length > cap
  const slice = truncated ? rows.slice(0, cap) : rows
  const lines: string[] = [
    `Found ${rows.length} matches${truncated ? ` (showing first ${cap})` : ""}`,
  ]
  let current = ""
  for (const row of slice) {
    const fp = row.path.text
    if (current !== fp) {
      if (current !== "") lines.push("")
      current = fp
      lines.push(`${fp}:`)
    }
    const text =
      row.lines.text.length > MAX_LINE_LENGTH
        ? row.lines.text.substring(0, MAX_LINE_LENGTH) + "..."
        : row.lines.text
    lines.push(`  Line ${row.line_number}: ${text}`)
  }
  if (truncated) {
    lines.push("")
    lines.push(`(Truncated: ${cap} of ${rows.length} shown.)`)
  }
  return lines.join("\n")
}

const cursorSearchArgSchema = {
  pattern: tool.schema.string().optional(),
  query: tool.schema.string().optional(),
  search: tool.schema.string().optional(),
  regex: tool.schema.string().optional(),
  path: tool.schema.string().optional(),
  target_directory: tool.schema.string().optional(),
  include: tool.schema.string().optional(),
  glob: tool.schema.string().optional(),
  glob_pattern: tool.schema.string().optional(),
  file_pattern: tool.schema.string().optional(),
  head_limit: tool.schema.coerce.number().int().positive().optional(),
  headLimit: tool.schema.coerce.number().int().positive().optional(),
  limit: tool.schema.coerce.number().int().positive().optional(),
  num: tool.schema.coerce.number().int().positive().optional(),
}

const makeSdkTextSearchTool = (description: string, client: PluginInput["client"]) =>
  tool({
    description: `${description}（经 OpenCode 服务端 ripgrep，等同内置 grep）`,
    args: cursorSearchArgSchema,
    async execute(args, ctx) {
      const a = { ...(args as ArgRecord) }
      normalizeBuiltinToolArgs("grep", a)
      const pattern = coerceGrepPattern(a)
      if (!pattern) return softSearchHint(description, "text")
      const directory = resolveSearchDirectory(a, ctx.directory)
      let rows: FindTextRow[]
      try {
        const res = await client.find.text({
          query: { directory, pattern },
        })
        rows = unwrapSdkData(res) as FindTextRow[]
      } catch (e) {
        return `[${description}] 检索失败: ${e instanceof Error ? e.message : String(e)}\nNo files found`
      }
      const cap =
        typeof a.head_limit === "number"
          ? Math.min(a.head_limit, 500)
          : typeof a.limit === "number"
            ? Math.min(a.limit, 500)
            : 100
      return formatFindTextResults(rows, cap)
    },
  })

const makeSdkFileSearchTool = (description: string, client: PluginInput["client"]) =>
  tool({
    description: `${description}（经 OpenCode 服务端，等同内置 glob）`,
    args: {
      ...cursorSearchArgSchema,
      query: tool.schema.string().optional(),
    },
    async execute(args, ctx) {
      const a = { ...(args as ArgRecord) }
      normalizeBuiltinToolArgs("glob", a)
      const query = coerceFileFindQuery(a)
      const directory = resolveSearchDirectory(a, ctx.directory)
      const limit =
        typeof a.limit === "number" ? Math.min(a.limit, 500) : typeof a.head_limit === "number" ? Math.min(a.head_limit, 500) : 100
      let paths: string[]
      try {
        const res = await client.find.files({
          query: { directory, query, limit },
        })
        paths = unwrapSdkData(res) as string[]
      } catch (e) {
        return `[${description}] 检索失败: ${e instanceof Error ? e.message : String(e)}\nNo files found`
      }
      if (paths.length === 0) return "No files found"
      const truncated = paths.length > limit
      const shown = truncated ? paths.slice(0, limit) : paths
      const out = [`Found ${paths.length} path(s)${truncated ? ` (showing first ${limit})` : ""}`, ...shown]
      if (truncated) out.push("", `(Truncated: ${limit} of ${paths.length} shown.)`)
      return out.join("\n")
    },
  })

const pathArgSchema = {
  filePath: tool.schema.string().optional(),
  path: tool.schema.string().optional(),
  file: tool.schema.string().optional(),
}

const editArgSchema = {
  ...pathArgSchema,
  oldString: tool.schema.string().optional(),
  newString: tool.schema.string().optional(),
  old_string: tool.schema.string().optional(),
  new_string: tool.schema.string().optional(),
  replaceAll: tool.schema.boolean().optional(),
  replace_all: tool.schema.boolean().optional(),
}

const writeArgSchema = {
  ...pathArgSchema,
  content: tool.schema.string().optional(),
  contents: tool.schema.string().optional(),
}

const makeEditTool = (id: string, description: string) =>
  tool({
    description,
    args: editArgSchema,
    async execute(args, ctx) {
      return performFileReplace(ctx.directory, args as ArgRecord, id)
    },
  })

const makeWriteTool = (id: string, description: string) =>
  tool({
    description,
    args: writeArgSchema,
    async execute(args, ctx) {
      return performWrite(ctx.directory, args as ArgRecord, id)
    },
  })

const multiEditEntrySchema = tool.schema.object({
  path: tool.schema.string().optional(),
  filePath: tool.schema.string().optional(),
  oldString: tool.schema.string().optional(),
  newString: tool.schema.string().optional(),
  old_string: tool.schema.string().optional(),
  new_string: tool.schema.string().optional(),
  replaceAll: tool.schema.boolean().optional(),
  replace_all: tool.schema.boolean().optional(),
})

const multiEditArgSchema = {
  edits: tool.schema.array(multiEditEntrySchema).optional(),
  changes: tool.schema.array(multiEditEntrySchema).optional(),
  operations: tool.schema.array(multiEditEntrySchema).optional(),
}

const makeMultiEditTool = (id: string) =>
  tool({
    description: `Cursor「${id}」→ 按 edits/changes 数组依次 StrReplace。`,
    args: multiEditArgSchema,
    async execute(args, ctx) {
      return performMultiEdit(ctx.directory, args as ArgRecord, id)
    },
  })

const cursorStub = (name: string, use: string) =>
  tool({
    description: `Cursor「${name}」→ 请用 **${use}**。`,
    args: { note: tool.schema.string().optional() },
    async execute() {
      return `[${name}] 请改用: ${use}。（${CURSOR_TOOL_MAP}）`
    },
  })

const listDirArgSchema = {
  ...pathArgSchema,
  offset: tool.schema.coerce.number().int().positive().optional(),
  limit: tool.schema.coerce.number().int().positive().optional(),
}

const makeListDirTool = (id: string) =>
  tool({
    description: `Cursor「${id}」→ 列目录（同 read 对目录）。path 默认当前工作目录。`,
    args: listDirArgSchema,
    async execute(args, ctx) {
      const a = args as ArgRecord
      const filepath = resolveListDirPath(a, ctx.directory)
      if (!fs.existsSync(filepath)) throw new Error(fileNotFoundHint(filepath))
      if (!fs.statSync(filepath).isDirectory()) {
        throw new Error(`[${id}] 不是目录: ${filepath}（请用 read 读文件）`)
      }
      const limit = (args.limit as number | undefined) ?? DEFAULT_READ_LIMIT
      const offset = (args.offset as number | undefined) || 1
      return formatDirectoryListing(filepath, offset, limit)
    },
  })

const runTerminalArgSchema = {
  command: tool.schema.string().optional(),
  cmd: tool.schema.string().optional(),
  workdir: tool.schema.string().optional(),
  working_directory: tool.schema.string().optional(),
  cwd: tool.schema.string().optional(),
  directory: tool.schema.string().optional(),
  timeout: tool.schema.coerce.number().int().positive().optional(),
  description: tool.schema.string().optional(),
}

const makeRunTerminalTool = (id: string) =>
  tool({
    description: `Cursor「${id}」→ 本地 shell（PowerShell/sh）。优先用 OpenCode **bash** 若需持久会话。`,
    args: runTerminalArgSchema,
    async execute(args, ctx) {
      return runBridgedShell(ctx.directory, args as ArgRecord, id)
    },
  })

export const OpencodeComposerBridgePlugin: Plugin = async (input) => {
  const { client } = input
  return {
    "tool.definition": async (
      input: { toolID: string },
      output: { description: string; parameters: unknown },
    ) => {
      const id = input.toolID
      const extra = TOOL_DOC[id as keyof typeof TOOL_DOC]
      if (extra) output.description = `${output.description}\n\n[opencode-composer-bridge] ${extra}`
      patchToolParametersForCursor(id, output.parameters)
    },

    "experimental.chat.system.transform": async (
      _input: { sessionID?: string },
      output: { system: string[] },
    ) => {
      output.system.push(
        `## Cursor / Composer → OpenCode\n${CURSOR_TOOL_MAP}\n` +
          "改文件: **edit**。整文件: **write**。搜代码: **grep** / **glob**（内置）；**Grep** / **Glob** / **codebase_search** 走服务端 find。终端: **bash**。",
      )
    },

    "tool.execute.before": async (
      input: { tool: string },
      output: { args: unknown },
    ) => {
      const name = input.tool
      const a = (output.args ?? {}) as ArgRecord
      output.args = a
      normalizeIoToolArgs(name, a)
      normalizeBuiltinToolArgs(name, a)
    },

    tool: {
      list_dir: makeListDirTool("list_dir"),
      ListDir: makeListDirTool("ListDir"),
      LS: makeListDirTool("LS"),
      ApplyPatch: cursorStub("ApplyPatch", "StrReplace / edit（patch 传参易被截断）"),
      Delete: cursorStub("Delete", "bash（勿在插件内自动删文件）"),
      delete_file: cursorStub("delete_file", "bash"),
      MultiEdit: makeMultiEditTool("MultiEdit"),
      run_terminal_cmd: makeRunTerminalTool("run_terminal_cmd"),
      run_terminal_command: makeRunTerminalTool("run_terminal_command"),
      codebase_search: makeSdkTextSearchTool("Cursor codebase_search", client),
      file_search: makeSdkFileSearchTool("Cursor file_search", client),
      Grep: makeSdkTextSearchTool("Cursor Grep", client),
      Glob: makeSdkFileSearchTool("Cursor Glob", client),

      read: tool({
        description: TOOL_DOC.read,
        args: {
          ...pathArgSchema,
          offset: tool.schema.coerce.number().int().positive().optional(),
          limit: tool.schema.coerce.number().int().positive().optional(),
        },
        async execute(args, ctx) {
          const a = args as ArgRecord
          let filepath = normalizeWin(resolveAbs(resolveFilePath(a, "read"), ctx.directory))
          if (!fs.existsSync(filepath)) throw new Error(fileNotFoundHint(filepath))
          const stat = fs.statSync(filepath)
          const limit = (args.limit as number | undefined) ?? DEFAULT_READ_LIMIT
          const offset = (args.offset as number | undefined) || 1
          if (stat.isDirectory()) {
            return formatDirectoryListing(filepath, offset, limit)
          }
          const sample = Buffer.alloc(Math.min(SAMPLE_BYTES, stat.size))
          const fd = fs.openSync(filepath, "r")
          try {
            fs.readSync(fd, sample, 0, sample.length, 0)
          } finally {
            fs.closeSync(fd)
          }
          if (isBinaryFile(filepath, sample)) throw new Error(`Cannot read binary file: ${filepath}`)
          const file = readTextLines(filepath, offset, limit)
          if (file.count < offset && !(file.count === 0 && offset === 1)) {
            throw new Error(`Offset ${offset} is out of range (${file.count} lines)`)
          }
          let output = [`<path>${filepath}</path>`, `<type>file</type>`, "<content>\n"].join("\n")
          output += file.raw.map((line, i) => `${i + offset}: ${line}`).join("\n")
          const last = offset + file.raw.length - 1
          const next = last + 1
          if (file.cut) {
            output += `\n\n(Output capped at ${MAX_BYTES_LABEL}. Lines ${offset}-${last}. offset=${next})`
          } else if (file.more) {
            output += `\n\n(Lines ${offset}-${last} of ${file.count}. offset=${next})`
          } else {
            output += `\n\n(End of file - ${file.count} lines)`
          }
          return `${output}\n</content>`
        },
      }),

      write: makeWriteTool("write", TOOL_DOC.write),
      Write: makeWriteTool("Write", "Cursor alias → same as write."),

      edit: makeEditTool("edit", TOOL_DOC.edit),
      StrReplace: makeEditTool("StrReplace", TOOL_DOC.StrReplace),
      strreplace: makeEditTool("strreplace", TOOL_DOC.StrReplace),
      search_replace: makeEditTool("search_replace", "Cursor alias → same as edit."),
    },
  }
}

export default OpencodeComposerBridgePlugin