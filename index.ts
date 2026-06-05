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
const SEARCH_RESULT_CAP = 100
const SEARCH_RESULT_MAX = 500

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

const EDIT_TOOL_NAMES = new Set(["edit", "StrReplace", "strreplace", "search_replace"])
const WRITE_TOOL_NAMES = new Set(["write", "Write"])
const GREP_TOOL_NAMES = new Set(["grep", "Grep", "codebase_search"])
const GLOB_TOOL_NAMES = new Set(["glob", "Glob", "file_search"])

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

const mirrorString = (a: ArgRecord, fromKeys: string[], ...targetKeys: string[]) => {
  const v = pickString(a, fromKeys, false)
  if (v === undefined) return
  for (const k of targetKeys) {
    if (a[k] === undefined) a[k] = v
  }
}

const resolveAbs = (file: string, directory: string): string =>
  path.isAbsolute(file) ? path.normalize(file) : path.resolve(directory, file)

const normalizeWin = (p: string): string => (process.platform === "win32" ? path.normalize(p) : p)

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

/** 仅当父目录不存在时创建；已存在目录或 EEXIST 不报错（Windows 上对已有 Desktop 等会 EEXIST） */
const ensureParentDir = (filepath: string) => {
  const parent = path.dirname(filepath)
  if (!parent || parent === "." || parent === filepath) return
  if (process.platform === "win32") {
    const parsed = path.parse(parent)
    if (parsed.root === parent) return
  }
  try {
    if (fs.existsSync(parent)) {
      const st = fs.statSync(parent)
      if (st.isDirectory()) return
      throw new Error(`路径已存在且不是目录: ${parent}`)
    }
    fs.mkdirSync(parent, { recursive: true })
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === "EEXIST") return
    throw e
  }
}

const performWrite = (directory: string, args: ArgRecord, toolName: string): string => {
  const filepath = normalizeWin(resolveAbs(resolveFilePath(args, toolName), directory))
  const body = resolveWriteContent(args, toolName)
  ensureParentDir(filepath)
  fs.writeFileSync(filepath, body, "utf8")
  return "Wrote file successfully."
}

type MultiEditEntry = {
  path?: string
  filePath?: string
  oldString?: string
  newString?: string
  old_string?: string
  new_string?: string
  replaceAll?: boolean
  replace_all?: boolean
}

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

const formatReadFileOutput = (
  filepath: string,
  file: { raw: string[]; count: number; cut: boolean; more: boolean },
  offset: number,
): string => {
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
}

const runBridgedShell = (directory: string, args: ArgRecord, toolName: string): string => {
  const command = pickString(args, RUN_CMD_KEYS, false)
  if (!command) {
    return `[${toolName}] 未提供 command，未执行。示例: {"command":"echo ok"}`
  }
  const workdirRaw = pickString(args, WORKDIR_KEYS)
  const cwd = workdirRaw ? normalizeWin(resolveAbs(workdirRaw, directory)) : directory
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

const normalizeIoToolArgs = (toolName: string, a: ArgRecord): void => {
  if (WRITE_TOOL_NAMES.has(toolName) || toolName === "read" || EDIT_TOOL_NAMES.has(toolName)) {
    mirrorString(a, PATH_KEYS, "path", "filePath")
  }
  if (WRITE_TOOL_NAMES.has(toolName)) {
    mirrorString(a, WRITE_BODY_KEYS, "content", "contents")
  }
  if (EDIT_TOOL_NAMES.has(toolName)) {
    mirrorString(a, EDIT_OLD_KEYS, "oldString", "old_string")
    mirrorString(a, EDIT_NEW_KEYS, "newString", "new_string")
  }
}

const JSON_PATH_PROPS = {
  path: { type: "string", description: "File path" },
  filePath: { type: "string", description: "Alias of path (Cursor)" },
  file: { type: "string", description: "Alias of path" },
}

const patchToolParametersForCursor = (toolID: string, parameters: unknown): void => {
  if (!parameters || typeof parameters !== "object") return
  const schema = parameters as Record<string, unknown>
  if (schema.type !== "object") return
  const props = (schema.properties ?? {}) as Record<string, unknown>
  schema.properties = props
  schema.additionalProperties = true
  schema.required = []

  if (WRITE_TOOL_NAMES.has(toolID)) {
    Object.assign(props, JSON_PATH_PROPS, {
      content: { type: "string", description: "File body" },
      contents: { type: "string", description: "Alias of content (Cursor)" },
      text: { type: "string" },
      body: { type: "string" },
    })
    return
  }
  if (toolID === "read") {
    Object.assign(props, JSON_PATH_PROPS, { offset: { type: "integer" }, limit: { type: "integer" } })
    return
  }
  if (EDIT_TOOL_NAMES.has(toolID)) {
    Object.assign(props, JSON_PATH_PROPS, {
      oldString: { type: "string" },
      newString: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replaceAll: { type: "boolean" },
      replace_all: { type: "boolean" },
    })
  }
}

const normalizeBuiltinToolArgs = (toolName: string, a: ArgRecord): void => {
  if (GREP_TOOL_NAMES.has(toolName)) {
    if (!pickString(a, ["pattern"])) {
      const p = pickString(a, GREP_PATTERN_KEYS)
      if (p) a.pattern = p
    }
    const inc = pickString(a, ["include", "glob"], false)
    if (inc && !a.include) a.include = inc.startsWith("**/") ? inc.slice(3) : inc
    for (const k of ["query", "search", "regex", "glob", "glob_pattern", "file_pattern"]) delete a[k]
  }
  if (GLOB_TOOL_NAMES.has(toolName)) {
    if (!pickString(a, ["pattern"])) {
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

const resolveSearchDirectory = (a: ArgRecord, ctxDir: string): string => {
  const raw = pickString(a, SEARCH_ROOT_KEYS) ?? pickString(a, PATH_KEYS) ?? "."
  const abs = normalizeWin(resolveAbs(raw, ctxDir))
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return path.dirname(abs)
  return abs
}

const searchResultLimit = (a: ArgRecord): number => {
  if (typeof a.head_limit === "number") return Math.min(a.head_limit, SEARCH_RESULT_MAX)
  if (typeof a.limit === "number") return Math.min(a.limit, SEARCH_RESULT_MAX)
  return SEARCH_RESULT_CAP
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

const looksLikeGlobPattern = (q: string): boolean => /[*?[\]]/.test(q)

const SKIP_DIR_NAMES = new Set([".git", "node_modules", ".svn", ".hg"])

const globPatternToRegExp = (glob: string): RegExp => {
  const g = glob.replace(/\\/g, "/")
  let re = "^"
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === "*" && g[i + 1] === "*") {
      if (g[i + 2] === "/") {
        re += "(?:.*/)?"
        i += 2
      } else {
        re += ".*"
        i += 1
      }
    } else if (c === "*") {
      re += "[^/]*"
    } else if (c === "?") {
      re += "[^/]"
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    }
  }
  re += "$"
  return new RegExp(re, "i")
}

const listPathsMatchingGlob = (rootDir: string, pattern: string, cap: number): string[] => {
  const root = normalizeWin(path.resolve(rootDir))
  const re = globPatternToRegExp(pattern)
  const out: string[] = []
  const walk = (dir: string) => {
    if (out.length >= cap) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      if (out.length >= cap) return
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        if (SKIP_DIR_NAMES.has(ent.name)) continue
        walk(full)
        continue
      }
      if (!ent.isFile()) continue
      const rel = path.relative(root, full).replace(/\\/g, "/")
      if (re.test(rel) || re.test(ent.name)) out.push(full)
    }
  }
  walk(root)
  return out.sort((a, b) => a.localeCompare(b))
}

const formatPathList = (paths: string[], limit: number): string => {
  if (paths.length === 0) return "No files found"
  const truncated = paths.length > limit
  const shown = truncated ? paths.slice(0, limit) : paths
  const out = [`Found ${paths.length} path(s)${truncated ? ` (showing first ${limit})` : ""}`, ...shown]
  if (truncated) out.push("", `(Truncated: ${limit} of ${paths.length} shown.)`)
  return out.join("\n")
}

const globAliasStubNote = (label: string): string =>
  `\n\n[${label}] 通配/大目录更稳更快：请优先用内置 **glob**（小写）。${CURSOR_TOOL_MAP}`

const softSearchHint = (toolName: string, kind: "text" | "files"): string =>
  `[${toolName}] 未提供搜索内容，未执行检索。\n` +
  (kind === "text"
    ? '请传入 pattern / query，例如: {"pattern":"Foo","path":"."}'
    : '请传入 pattern / query，例如: {"pattern":"**/*.kt","path":"."}')

type FindTextRow = { path: { text: string }; lines: { text: string }; line_number: number }

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
  if (res.error) throw new Error(`[opencode find API] ${formatSdkError(res.error)}`)
  if (res.data === undefined) throw new Error("[opencode find API] 无返回数据")
  return res.data
}

const formatFindTextResults = (rows: FindTextRow[], cap: number): string => {
  if (rows.length === 0) return "No files found"
  const truncated = rows.length > cap
  const slice = truncated ? rows.slice(0, cap) : rows
  const lines: string[] = [`Found ${rows.length} matches${truncated ? ` (showing first ${cap})` : ""}`]
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

const TOOL_DOC = {
  read:
    'Read file. Required: filePath OR path. Optional: offset, limit (1-based line numbers). Directory path lists entries. Example: {"path":"a.kt","offset":1,"limit":50}',
  write:
    'Write file. Required: (filePath|path) + (content OR contents). Example: {"path":"out.txt","contents":"..."}',
  edit:
    'Edit file. Required: (filePath|path) + oldString + newString (or old_string/new_string). Example: {"path":"a.kt","oldString":"x","newString":"y"}',
  StrReplace:
    'Same as edit (Cursor alias). Required: path + old_string + new_string. Example: {"path":"a.kt","old_string":"x","new_string":"y"}',
  glob:
    'Glob files. Required: pattern OR glob_pattern. Optional: path OR target_directory. Example: {"pattern":"**/*.kt","path":"."}',
  grep:
    'Grep content. Required: pattern OR query. Optional: path, include/glob, head_limit. Example: {"pattern":"Foo|Bar","path":".","glob":"**/*.kt","head_limit":25}',
}

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

const makeSdkTextSearchTool = (label: string, client: PluginInput["client"]) =>
  tool({
    description: `${label}（OpenCode 服务端 ripgrep）`,
    args: cursorSearchArgSchema,
    async execute(args, ctx) {
      const a = { ...(args as ArgRecord) }
      normalizeBuiltinToolArgs("grep", a)
      const pattern = coerceGrepPattern(a)
      if (!pattern) return softSearchHint(label, "text")
      const directory = resolveSearchDirectory(a, ctx.directory)
      try {
        const res = await client.find.text({ query: { directory, pattern } })
        return formatFindTextResults(unwrapSdkData(res) as FindTextRow[], searchResultLimit(a))
      } catch (e) {
        return `[${label}] 检索失败: ${e instanceof Error ? e.message : String(e)}\nNo files found`
      }
    },
  })

const makeSdkFileSearchTool = (label: string, client: PluginInput["client"]) =>
  tool({
    description: `Cursor「${label}」→ 有结果；通配/大目录请优先内置 **glob**`,
    args: { ...cursorSearchArgSchema, query: tool.schema.string().optional() },
    async execute(args, ctx) {
      const a = { ...(args as ArgRecord) }
      normalizeBuiltinToolArgs("glob", a)
      const query = coerceFileFindQuery(a)
      const directory = resolveSearchDirectory(a, ctx.directory)
      const limit = searchResultLimit(a)
      const stub = globAliasStubNote(label)
      if (looksLikeGlobPattern(query)) {
        const paths = listPathsMatchingGlob(directory, query, Math.min(limit, SEARCH_RESULT_MAX))
        return formatPathList(paths, limit) + stub
      }
      try {
        const res = await client.find.files({ query: { directory, query, limit } })
        const paths = unwrapSdkData(res) as string[]
        return formatPathList(paths, limit) + stub
      } catch (e) {
        return `[${label}] 检索失败: ${e instanceof Error ? e.message : String(e)}\nNo files found` + stub
      }
    },
  })

const cursorStub = (name: string, use: string) =>
  tool({
    description: `Cursor「${name}」→ ${use}`,
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
    description: `Cursor「${id}」→ 列目录`,
    args: listDirArgSchema,
    async execute(args, ctx) {
      const a = args as ArgRecord
      const filepath = normalizeWin(resolveAbs(pickString(a, PATH_KEYS) ?? ".", ctx.directory))
      if (!fs.existsSync(filepath)) throw new Error(fileNotFoundHint(filepath))
      if (!fs.statSync(filepath).isDirectory()) {
        throw new Error(`[${id}] 不是目录: ${filepath}`)
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
    description: `Cursor「${id}」→ 本地 shell`,
    args: runTerminalArgSchema,
    async execute(args, ctx) {
      return runBridgedShell(ctx.directory, args as ArgRecord, id)
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

const makeMultiEditTool = (id: string) =>
  tool({
    description: `Cursor「${id}」→ 批量 edit`,
    args: {
      edits: tool.schema.array(multiEditEntrySchema).optional(),
      changes: tool.schema.array(multiEditEntrySchema).optional(),
      operations: tool.schema.array(multiEditEntrySchema).optional(),
    },
    async execute(args, ctx) {
      return performMultiEdit(ctx.directory, args as ArgRecord, id)
    },
  })

export const OpencodeComposerBridgePlugin: Plugin = async (input) => {
  const { client } = input
  return {
    "tool.definition": async (inp: { toolID: string }, output: { description: string; parameters: unknown }) => {
      const extra = TOOL_DOC[inp.toolID as keyof typeof TOOL_DOC]
      if (extra) output.description = `${output.description}\n\n[opencode-composer-bridge] ${extra}`
      patchToolParametersForCursor(inp.toolID, output.parameters)
    },

    "experimental.chat.system.transform": async (_input, output: { system: string[] }) => {
      output.system.push(
        `## Cursor / Composer → OpenCode\n${CURSOR_TOOL_MAP}\n` +
          "改文件: **edit**。整文件: **write**。搜代码: **grep** / **glob**；**Grep** / **Glob** / **codebase_search** 走服务端 find。终端: **bash**。",
      )
    },

    "tool.execute.before": async (inp: { tool: string }, output: { args: unknown }) => {
      const a = (output.args ?? {}) as ArgRecord
      output.args = a
      normalizeIoToolArgs(inp.tool, a)
      normalizeBuiltinToolArgs(inp.tool, a)
    },

    tool: {
      list_dir: makeListDirTool("list_dir"),
      ListDir: makeListDirTool("ListDir"),
      LS: makeListDirTool("LS"),
      ApplyPatch: cursorStub("ApplyPatch", "StrReplace / edit"),
      Delete: cursorStub("Delete", "bash（勿在插件内删文件）"),
      delete_file: cursorStub("delete_file", "bash"),
      MultiEdit: makeMultiEditTool("MultiEdit"),
      run_terminal_cmd: makeRunTerminalTool("run_terminal_cmd"),
      run_terminal_command: makeRunTerminalTool("run_terminal_command"),
      codebase_search: makeSdkTextSearchTool("codebase_search", client),
      file_search: makeSdkFileSearchTool("file_search", client),
      Grep: makeSdkTextSearchTool("Grep", client),
      Glob: makeSdkFileSearchTool("Glob", client),
      read: tool({
        description: TOOL_DOC.read,
        args: {
          ...pathArgSchema,
          offset: tool.schema.coerce.number().int().positive().optional(),
          limit: tool.schema.coerce.number().int().positive().optional(),
        },
        async execute(args, ctx) {
          const a = args as ArgRecord
          const filepath = normalizeWin(resolveAbs(resolveFilePath(a, "read"), ctx.directory))
          if (!fs.existsSync(filepath)) throw new Error(fileNotFoundHint(filepath))
          const stat = fs.statSync(filepath)
          const limit = (args.limit as number | undefined) ?? DEFAULT_READ_LIMIT
          const offset = (args.offset as number | undefined) || 1
          if (stat.isDirectory()) return formatDirectoryListing(filepath, offset, limit)
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
          return formatReadFileOutput(filepath, file, offset)
        },
      }),
      write: makeWriteTool("write", TOOL_DOC.write),
      Write: makeWriteTool("Write", "Cursor alias → write"),
      edit: makeEditTool("edit", TOOL_DOC.edit),
      StrReplace: makeEditTool("StrReplace", TOOL_DOC.StrReplace),
      strreplace: makeEditTool("strreplace", TOOL_DOC.StrReplace),
      search_replace: makeEditTool("search_replace", "alias → edit"),
    },
  }
}

export default OpencodeComposerBridgePlugin