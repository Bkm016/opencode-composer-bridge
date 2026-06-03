/**
 * OpenCode Plugin: opencode-composer-bridge
 *
 * Cursor / Composer 工具名与参数 → OpenCode（read/write/edit/glob/grep + 别名）。
 *
 * @author sky
 */

const CURSOR_TOOL_MAP =
  "StrReplace/search_replace→edit; Write→write; Read→read; list_dir/LS→read或glob; Grep/codebase_search→grep; Glob/file_search→glob; run_terminal_cmd→bash; ApplyPatch(Cursor)→edit或apply_patch(patchText); Delete→bash。"

import fs from "fs"
import path from "path"
import { spawnSync } from "child_process"
import { tool, type ToolContext } from "@opencode-ai/plugin"

type ArgRecord = Record<string, unknown>

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
const MAX_BYTES = 50 * 1024
const MAX_BYTES_LABEL = `${MAX_BYTES / 1024} KB`
const SAMPLE_BYTES = 4096
const GLOB_LIMIT = 100
const GLOB_STAT_CAP = 400
const GREP_LIMIT = 100
const RG_TIMEOUT_MS = 30_000
/** 低于此耗时的 ETIMEDOUT 视为 spawn 失败误报，不算真超时（Windows 常见） */
const RG_TIMEOUT_TRUST_MS = 5000

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

const resolveGlobPattern = (args: ArgRecord): string => {
  const v = pickString(args, GLOB_PATTERN_KEYS)
  if (v) return v
  missingParam("glob", "pattern", GLOB_PATTERN_KEYS, [{ pattern: "**/*.kt", path: "." }], args)
}

const resolveGrepPattern = (args: ArgRecord): string => {
  const v = pickString(args, GREP_PATTERN_KEYS)
  if (v) return v
  missingParam("grep", "pattern", GREP_PATTERN_KEYS, [{ pattern: "Foo", path: "." }], args)
}

const resolveSearchRoot = (args: ArgRecord, fallback: string): string =>
  pickString(args, SEARCH_ROOT_KEYS) ?? fallback

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

const resolveListDirPath = (args: ArgRecord, directory: string, toolName: string): string => {
  const raw = pickString(args, PATH_KEYS)
  const rel = raw ?? "."
  return normalizeWin(resolveAbs(rel, directory))
}

const resolveShellCommand = (args: ArgRecord, toolName: string): string => {
  const v = pickString(args, RUN_CMD_KEYS, false)
  if (v !== undefined && v.length > 0) return v
  missingParam(toolName, "command", RUN_CMD_KEYS, [{ command: "echo ok" }], args)
}

/** Cursor run_terminal_cmd：本地 shell 执行，语义对齐 bash（非 OpenCode 持久会话） */
const runBridgedShell = (directory: string, args: ArgRecord, toolName: string): string => {
  const command = resolveShellCommand(args, toolName)
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

const msSince = (start: bigint): number => Number(process.hrtime.bigint() - start) / 1e6

let cachedRgExe: string | null = null

/** 解析 rg 可执行文件路径；spawn 使用 shell:false，不走 cmd */
const resolveRgExecutable = (): string => {
  if (cachedRgExe) return cachedRgExe
  if (process.platform === "win32") {
    const w = spawnSync("where.exe", ["rg"], {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    })
    if (w.status === 0) {
      const line = w.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0)
      if (line) {
        cachedRgExe = line
        return cachedRgExe
      }
    }
  }
  cachedRgExe = "rg"
  return cachedRgExe
}

type RgResult = {
  ok: boolean
  stdout: string
  stderr: string
  elapsedMs: number
  timedOut: boolean
  spawnFailed: boolean
}

const runRipgrep = (args: string[], cwd: string): RgResult => {
  const t0 = process.hrtime.bigint()
  const result = spawnSync(resolveRgExecutable(), args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    shell: false,
    timeout: RG_TIMEOUT_MS,
  })
  const elapsedMs = msSince(t0)
  const errCode = (result.error as NodeJS.ErrnoException | undefined)?.code
  const timedOut =
    (result.signal === "SIGTERM" && elapsedMs >= RG_TIMEOUT_MS - 500) ||
    (errCode === "ETIMEDOUT" && elapsedMs >= RG_TIMEOUT_TRUST_MS)
  const spawnFailed =
    !timedOut &&
    elapsedMs < RG_TIMEOUT_TRUST_MS &&
    (result.error != null || result.status === null || (result.status != null && result.status > 1))
  const ok = !timedOut && !spawnFailed && (result.status === 0 || result.status === 1)
  return {
    ok,
    stdout: (result.stdout ?? "").toString(),
    stderr: (result.stderr ?? "").toString(),
    elapsedMs,
    timedOut,
    spawnFailed,
  }
}

const globWithRipgrep = (search: string, pattern: string): RgResult & { paths: string[] } => {
  const rg = runRipgrep(["--files", "-g", pattern], search)
  if (!rg.ok && !rg.stdout) {
    return { ...rg, paths: [] }
  }
  const paths = rg.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((rel) => (path.isAbsolute(rel) ? rel : path.resolve(search, rel)))
  return { ...rg, paths }
}

const FAST_GLOB_INSTALL =
  "在 ~/.config/opencode 执行: npm install fast-glob（或通过 opencode.json 的 plugin git 安装本包，会自动装依赖）。"

const globWithFastGlob = async (search: string, pattern: string): Promise<string[]> => {
  let fg: { default: (p: string, o: object) => Promise<string[]> }
  try {
    fg = await import("fast-glob")
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`[glob] 无法加载 fast-glob: ${msg}\n${FAST_GLOB_INSTALL}`)
  }
  return (await fg.default(pattern, {
    cwd: search,
    absolute: true,
    onlyFiles: true,
    suppressErrors: true,
  })) as string[]
}

const grepWithRipgrep = (
  cwd: string,
  pattern: string,
  include?: string,
  singleFile?: string,
): { path: string; line: number; text: string }[] => {
  const args = ["-n", "--no-heading", pattern]
  if (include) args.push("-g", include)
  args.push(singleFile ?? ".")
  const { stdout, timedOut, elapsedMs, spawnFailed, stderr } = runRipgrep(args, cwd)
  if (timedOut) {
    throw new Error(
      `[rg] 超时（约 ${Math.round(elapsedMs)}ms，上限 ${RG_TIMEOUT_MS / 1000}s）。请缩小 path 或 pattern。`,
    )
  }
  if (spawnFailed && !stdout.trim()) {
    const hint = stderr.trim() || "请确认已安装 ripgrep（rg 在 PATH）"
    throw new Error(`[rg] 未能执行搜索（约 ${Math.round(elapsedMs)}ms）。${hint}`)
  }
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

const sortPathsByMtime = (paths: string[], cap: number): { path: string; mtime: number }[] => {
  const subset = paths.length > cap ? paths.slice(0, cap) : paths
  const withMtime: { path: string; mtime: number }[] = []
  for (const p of subset) {
    try {
      withMtime.push({ path: p, mtime: fs.statSync(p).mtimeMs })
    } catch {
      // 跳过
    }
  }
  withMtime.sort((x, y) => y.mtime - x.mtime)
  return withMtime
}

const runGlob = async (directory: string, args: ArgRecord): Promise<string> => {
  const t0 = process.hrtime.bigint()
  const pattern = resolveGlobPattern(args)
  const search = normalizeWin(resolveAbs(resolveSearchRoot(args, directory), directory))
  if (!fs.existsSync(search)) throw new Error(`glob path must exist: ${search}`)
  if (!fs.statSync(search).isDirectory()) throw new Error(`glob path must be a directory: ${search}`)
  let paths: string[] = []
  let rgMs = 0
  let fgMs = 0
  let globEngine = ""

  const tRg = process.hrtime.bigint()
  const rgOut = globWithRipgrep(search, pattern)
  rgMs = msSince(tRg)

  if (!rgOut.timedOut && rgOut.paths.length > 0) {
    paths = rgOut.paths
    globEngine = `rg ${rgMs.toFixed(1)}ms`
  } else {
    if (rgOut.timedOut) {
      globEngine = `rg 超时约 ${Math.round(rgOut.elapsedMs)}ms → `
    } else if (rgOut.stderr && /not found|ENOENT|不是内部|无法将/i.test(rgOut.stderr)) {
      globEngine = "rg 未安装 → "
    } else if (rgOut.paths.length === 0) {
      globEngine = "rg 无匹配 → "
    }
    const tFg = process.hrtime.bigint()
    paths = await globWithFastGlob(search, pattern)
    fgMs = msSince(tFg)
    globEngine += `fast-glob ${fgMs.toFixed(1)}ms`
    if (rgOut.timedOut && paths.length === 0) {
      throw new Error(
        `[glob] rg 超时（约 ${Math.round(rgOut.elapsedMs)}ms）且 fast-glob 无结果。path=${search} pattern=${pattern}`,
      )
    }
  }

  const tStat = process.hrtime.bigint()
  const totalFound = paths.length
  const withMtime = sortPathsByMtime(paths, GLOB_STAT_CAP)
  const statMs = msSince(tStat)
  const truncated = withMtime.length > GLOB_LIMIT
  const shown = truncated ? withMtime.slice(0, GLOB_LIMIT) : withMtime
  const timingParts = [`total ${msSince(t0).toFixed(1)}ms`, globEngine, `stat/sort ${statMs.toFixed(1)}ms`]
  const out: string[] = [`[glob timing] ${timingParts.join(", ")} | found ${totalFound} path(s)`]
  if (shown.length === 0) out.push("No files found")
  else {
    out.push(...shown.map((f) => f.path))
    if (truncated || totalFound > GLOB_STAT_CAP) {
      out.push("")
      out.push(
        `(Showing ${shown.length} of ${totalFound} paths; stat capped at ${GLOB_STAT_CAP}. Narrow path or pattern.)`,
      )
    }
  }
  return out.join("\n")
}

const runGrep = (directory: string, args: ArgRecord): string => {
  const t0 = process.hrtime.bigint()
  const pattern = resolveGrepPattern(args)
  const requested = normalizeWin(resolveAbs(resolveSearchRoot(args, directory), directory))
  if (!fs.existsSync(requested)) {
    return `[grep timing] total ${msSince(t0).toFixed(1)}ms | found 0 matches\nNo files found`
  }
  const info = fs.statSync(requested)
  const cwd = info.isDirectory() ? requested : path.dirname(requested)
  const singleFile = info.isDirectory() ? undefined : requested
  const include = pickString(args, ["include", "glob"], false)
  const tRg = process.hrtime.bigint()
  const rows = grepWithRipgrep(cwd, pattern, include, singleFile)
  const rgMs = msSince(tRg)
  if (rows.length === 0) {
    return `[grep timing] total ${msSince(t0).toFixed(1)}ms, rg ${rgMs.toFixed(1)}ms | found 0 matches\nNo files found`
  }
  const tPost = process.hrtime.bigint()
  const times = new Map<string, number>()
  for (const p of new Set(rows.map((r) => r.path))) {
    try {
      times.set(p, fs.statSync(p).mtimeMs)
    } catch {
      // 跳过
    }
  }
  const matches = rows
    .map((r) => ({ ...r, mtime: times.get(r.path) ?? 0 }))
    .filter((r) => times.has(r.path))
  matches.sort((x, y) => y.mtime - x.mtime)
  const total = matches.length
  const truncated = total > GREP_LIMIT
  const final = truncated ? matches.slice(0, GREP_LIMIT) : matches
  const postMs = msSince(tPost)
  const output = [
    `[grep timing] total ${msSince(t0).toFixed(1)}ms (rg ${rgMs.toFixed(1)}ms, post ${postMs.toFixed(1)}ms) | found ${total} match(es)`,
    `Found ${total} matches${truncated ? ` (showing first ${GREP_LIMIT})` : ""}`,
  ]
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
    output.push(`(Truncated: ${GREP_LIMIT} of ${total} shown.)`)
  }
  return output.join("\n")
}

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
    "Grep content. Required: pattern OR query. Optional: path, include. Example: {\"pattern\":\"Foo\",\"path\":\".\",\"include\":\"*.kt\"}",
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

const globArgSchema = {
  pattern: tool.schema.string().optional(),
  glob_pattern: tool.schema.string().optional(),
  glob: tool.schema.string().optional(),
  file_pattern: tool.schema.string().optional(),
  path: tool.schema.string().optional(),
  target_directory: tool.schema.string().optional(),
  directory: tool.schema.string().optional(),
  cwd: tool.schema.string().optional(),
}

const grepArgSchema = {
  pattern: tool.schema.string().optional(),
  query: tool.schema.string().optional(),
  search: tool.schema.string().optional(),
  regex: tool.schema.string().optional(),
  path: tool.schema.string().optional(),
  target_directory: tool.schema.string().optional(),
  include: tool.schema.string().optional(),
  glob: tool.schema.string().optional(),
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

const makeGrepTool = (id: string, description: string) =>
  tool({
    description,
    args: grepArgSchema,
    async execute(args, ctx) {
      return runGrep(ctx.directory, args as ArgRecord)
    },
  })

const cursorStub = (name: string, use: string) =>
  tool({
    description: `Cursor「${name}」→ 请用 **${use}**。`,
    args: { note: tool.schema.string().optional() },
    async execute() {
      throw new Error(`[${name}] ${CURSOR_TOOL_MAP}\n请改用: ${use}`)
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
      const filepath = resolveListDirPath(a, ctx.directory, id)
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

const hasAnyKey = (a: ArgRecord, keys: string[]) =>
  keys.some((k) => typeof a[k] === "string" && String(a[k]).trim().length > 0)

export const OpencodeComposerBridgePlugin = async () => {
  return {
    "tool.definition": async (
      input: { toolID: string },
      output: { description: string; parameters: unknown },
    ) => {
      const extra = TOOL_DOC[input.toolID as keyof typeof TOOL_DOC]
      if (extra) output.description = `${output.description}\n\n[opencode-composer-bridge] ${extra}`
    },

    "experimental.chat.system.transform": async (
      _input: { sessionID?: string },
      output: { system: string[] },
    ) => {
      output.system.push(
        `## Cursor / Composer → OpenCode\n${CURSOR_TOOL_MAP}\n` +
          "改文件: **edit**。整文件: **write**。终端: **bash**（勿用 run_terminal_cmd）。",
      )
    },

    "tool.execute.before": async (
      input: { tool: string },
      output: { args: unknown },
    ) => {
      const name = input.tool
      const a = (output.args ?? {}) as ArgRecord
      if (name === "grep" || name === "Grep") {
        if (!hasAnyKey(a, GREP_PATTERN_KEYS)) {
          throw new Error(`[${name}] 缺少 pattern（禁止 {}）。示例: {"pattern":"Foo","path":"."}`)
        }
      }
      if (name === "glob" || name === "Glob") {
        if (!hasAnyKey(a, GLOB_PATTERN_KEYS)) {
          throw new Error(`[${name}] 缺少 pattern。示例: {"pattern":"**/*.kt","path":"."}`)
        }
      }
    },

    tool: {
      list_dir: makeListDirTool("list_dir"),
      ListDir: makeListDirTool("ListDir"),
      LS: makeListDirTool("LS"),
      ApplyPatch: cursorStub("ApplyPatch", "edit 或 apply_patch"),
      Delete: cursorStub("Delete", "bash"),
      delete_file: cursorStub("delete_file", "bash"),
      MultiEdit: cursorStub("MultiEdit", "多次 edit"),
      run_terminal_cmd: makeRunTerminalTool("run_terminal_cmd"),
      run_terminal_command: makeRunTerminalTool("run_terminal_command"),
      codebase_search: cursorStub("codebase_search", "grep"),
      file_search: cursorStub("file_search", "glob"),

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

      glob: tool({
        description: TOOL_DOC.glob,
        args: globArgSchema,
        async execute(args, ctx) {
          return runGlob(ctx.directory, args as ArgRecord)
        },
      }),

      grep: makeGrepTool("grep", TOOL_DOC.grep),
      Grep: makeGrepTool("Grep", "Cursor alias → same as grep（必须带 pattern）"),
    },
  }
}

export default OpencodeComposerBridgePlugin