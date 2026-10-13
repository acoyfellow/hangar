import type { Context } from '@earendil-works/chord'
import {
  type BinaryReader,
  type DirReader,
  type ExecutionEnv,
  ExecutionError,
  FileError,
  type FileErrorCode,
  type FileInfo,
  type FileWatcher,
  LineScanner,
  type LineScan,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  StreamDecoder,
  type TextLine,
  type TextLineReader,
  type WatchChange,
  type WatchTarget,
  err,
  ok,
} from '@earendil-works/pi-durable/env'
import { Bash, InMemoryFs } from 'just-bash/browser'

import type { FileStore, StoreChange, StoredEntry } from './file-store'
import { baseName, isWithin, joinPaths, parentOf, resolveAgainst } from './paths'

type FsStat = Awaited<ReturnType<InMemoryFs['lstat']>>

const SHELL_PROGRAMS = new Set(['sh', 'bash'])
const SHELL_COMMAND_FLAG = '-c'
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000
const TIMEOUT_EXIT_CODE = 124
const TEMP_ROOT = '/tmp'
const WATCH_POLL_MS = 50

const ERROR_CODES: Record<string, FileErrorCode> = {
  ENOENT: 'not_found',
  EACCES: 'permission_denied',
  EPERM: 'permission_denied',
  ENOTDIR: 'not_directory',
  EISDIR: 'is_directory',
  EINVAL: 'invalid',
  EEXIST: 'invalid',
  ENOTEMPTY: 'invalid',
}

const toFileError = (error: unknown, path?: string): FileError => {
  if (error instanceof FileError) return error
  const cause = error instanceof Error ? error : new Error(String(error))
  const code = Object.keys(ERROR_CODES).find(name => cause.message.startsWith(`${name}:`))
  return new FileError(code === undefined ? 'unknown' : ERROR_CODES[code]!, cause.message, path, cause)
}

const abortedFile = (context: Context, path?: string): Result<never, FileError> | undefined =>
  context.abortSignal?.aborted ? err(new FileError('aborted', 'aborted', path)) : undefined

const closedResult = (what: string, path: string): Result<never, FileError> =>
  err(new FileError('invalid', `${what} is closed`, path))

const kindOf = (stat: FsStat): FileInfo['kind'] =>
  stat.isSymbolicLink ? 'symlink' : stat.isDirectory ? 'directory' : 'file'

const infoFrom = (path: string, stat: FsStat): FileInfo => ({
  name: baseName(path),
  path,
  kind: kindOf(stat),
  size: stat.size,
  mtimeMs: stat.mtime.getTime(),
})

const toBytes = (content: string | Uint8Array): Uint8Array =>
  typeof content === 'string' ? new TextEncoder().encode(content) : content

const shellQuote = (argument: string): string => `'${argument.replaceAll("'", `'\\''`)}'`

class SnapshotBinaryReader implements BinaryReader {
  private closed = false

  constructor(
    private readonly path: string,
    private readonly bytes: Uint8Array,
    private readonly mtimeMs: number,
  ) {}

  async info(context: Context): Promise<Result<FileInfo, FileError>> {
    const aborted = abortedFile(context, this.path)
    if (aborted) return aborted
    if (this.closed) return closedResult('Binary reader', this.path)
    return ok({ name: baseName(this.path), path: this.path, kind: 'file', size: this.bytes.length, mtimeMs: this.mtimeMs })
  }

  async read(offset: number, length: number, context: Context): Promise<Result<Uint8Array, FileError>> {
    const aborted = abortedFile(context, this.path)
    if (aborted) return aborted
    if (this.closed) return closedResult('Binary reader', this.path)
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
      return err(new FileError('invalid', 'Offset and length must be non-negative safe integers', this.path))
    }
    return ok(this.bytes.slice(offset, offset + length))
  }

  async scanLines(
    options: { startLine: number; endLine?: number },
    context: Context,
  ): Promise<Result<LineScan, FileError>> {
    const aborted = abortedFile(context, this.path)
    if (aborted) return aborted
    if (this.closed) return closedResult('Binary reader', this.path)
    let scanner: LineScanner
    try {
      scanner = new LineScanner(options.startLine, options.endLine)
    } catch {
      return err(new FileError('invalid', 'Invalid line range', this.path))
    }
    scanner.push(this.bytes)
    return ok(scanner.finish())
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

class SnapshotTextLineReader implements TextLineReader {
  private closed = false
  private remaining: string

  constructor(
    private readonly path: string,
    bytes: Uint8Array,
  ) {
    const decoder = new StreamDecoder()
    this.remaining = decoder.decode(bytes) + decoder.decode()
  }

  async readLine(context: Context): Promise<Result<TextLine | undefined, FileError>> {
    const aborted = abortedFile(context, this.path)
    if (aborted) return aborted
    if (this.closed) return closedResult('Text line reader', this.path)
    if (this.remaining.length === 0) return ok(undefined)
    const newline = this.remaining.indexOf('\n')
    if (newline === -1) {
      const text = this.remaining
      this.remaining = ''
      return ok({ text, terminated: false })
    }
    const text = this.remaining.slice(0, newline)
    this.remaining = this.remaining.slice(newline + 1)
    return ok({ text, terminated: true })
  }

  async close(): Promise<void> {
    this.closed = true
    this.remaining = ''
  }
}

class LiveDirReader implements DirReader {
  private closed = false
  private cursor = 0

  constructor(
    private readonly path: string,
    private readonly names: ReadonlyArray<string>,
    private readonly describe: (path: string) => Promise<FileInfo | undefined>,
  ) {}

  async next(
    maxEntries: number,
    context: Context,
  ): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>> {
    const aborted = abortedFile(context, this.path)
    if (aborted) return aborted
    if (this.closed) return closedResult('Directory reader', this.path)
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      return err(new FileError('invalid', 'maxEntries must be a positive safe integer', this.path))
    }
    const entries: Array<FileInfo> = []
    while (this.cursor < this.names.length && entries.length < maxEntries) {
      const info = await this.describe(joinPaths([this.path, this.names[this.cursor]!]))
      this.cursor += 1
      if (info !== undefined) entries.push(info)
    }
    return ok({ entries, done: this.cursor >= this.names.length })
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

interface ResolvedWatchTarget {
  readonly path: string
  readonly reportAs: string
  readonly recursive: boolean
  readonly target: WatchTarget
}

interface WatchRegistration {
  readonly targets: ReadonlyArray<ResolvedWatchTarget>
  readonly onChange: (change: WatchChange) => void
  readonly pending: Set<string>
  timer: ReturnType<typeof setTimeout> | undefined
}

const excluded = (target: WatchTarget, root: string, path: string): boolean => {
  const relative = path.slice(root.length + 1).split('/')
  return relative.some(
    segment => (target.exclude?.hidden === true && segment.startsWith('.')) || target.exclude?.names?.includes(segment) === true,
  )
}

const covers = (registration: ResolvedWatchTarget, path: string): boolean => {
  if (path === registration.path || isWithin(registration.path, path)) return true
  if (!isWithin(path, registration.path)) return false
  if (excluded(registration.target, registration.path, path)) return false
  return registration.recursive || parentOf(path) === registration.path
}

export interface BrowserEnvOptions {
  readonly id: string
  readonly cwd: string
  readonly fs: InMemoryFs
  readonly persist: (changes: ReadonlyArray<StoreChange>) => Promise<void>
}

export class BrowserExecutionEnv implements ExecutionEnv {
  readonly id: string
  cwd: string
  private readonly fs: InMemoryFs
  private readonly persist: (changes: ReadonlyArray<StoreChange>) => Promise<void>
  private readonly watchers = new Set<WatchRegistration>()
  private readonly running = new Set<AbortController>()

  constructor(options: BrowserEnvOptions) {
    this.id = options.id
    this.cwd = options.cwd
    this.fs = options.fs
    this.persist = options.persist
  }

  static async open(options: {
    readonly id: string
    readonly cwd: string
    readonly store: FileStore
  }): Promise<BrowserExecutionEnv> {
    const fs = new InMemoryFs()
    const entries = [...(await options.store.load())].sort((a, b) => a.path.length - b.path.length)
    for (const entry of entries) await restoreEntry(fs, entry)
    await fs.mkdir(options.cwd, { recursive: true })
    await fs.mkdir(TEMP_ROOT, { recursive: true })
    return new BrowserExecutionEnv({
      id: options.id,
      cwd: options.cwd,
      fs,
      persist: changes => options.store.apply(changes),
    })
  }

  private resolve(path: string): string {
    return resolveAgainst(this.cwd, path)
  }

  private async snapshot(path: string): Promise<StoredEntry | undefined> {
    try {
      const stat = await this.fs.lstat(path)
      if (stat.isSymbolicLink) return { path, type: 'symlink', target: await this.fs.readlink(path) }
      if (stat.isDirectory) return { path, type: 'directory', mode: stat.mode }
      return { path, type: 'file', content: await this.fs.readFileBuffer(path), mode: stat.mode }
    } catch {
      return undefined
    }
  }

  private async commitPaths(before: ReadonlySet<string>, touched: ReadonlyArray<string>): Promise<void> {
    const after = new Set(this.fs.getAllPaths())
    const changes: Array<StoreChange> = []
    const changed = new Set<string>()
    for (const path of before) {
      if (!after.has(path)) {
        changes.push({ kind: 'delete', path })
        changed.add(path)
      }
    }
    const candidates = new Set<string>([...touched, ...[...after].filter(path => !before.has(path))])
    for (const path of after) {
      if (touched.some(root => isWithin(path, root))) candidates.add(path)
    }
    for (const path of candidates) {
      const entry = await this.snapshot(path)
      if (entry !== undefined) {
        changes.push({ kind: 'put', entry })
        changed.add(path)
      }
    }
    await this.persist(changes)
    this.notify([...changed])
  }

  private async mutate<T>(touched: ReadonlyArray<string>, change: () => Promise<T>): Promise<T> {
    const before = new Set(this.fs.getAllPaths())
    try {
      return await change()
    } finally {
      await this.commitPaths(before, touched)
    }
  }

  private notify(paths: ReadonlyArray<string>): void {
    for (const registration of this.watchers) {
      for (const path of paths) {
        for (const target of registration.targets) {
          if (covers(target, path)) registration.pending.add(target.path === target.reportAs ? path : target.reportAs)
        }
      }
      if (registration.pending.size > 0 && registration.timer === undefined) {
        registration.timer = setTimeout(() => {
          registration.timer = undefined
          const reported = [...registration.pending]
          registration.pending.clear()
          if (this.watchers.has(registration)) registration.onChange({ paths: reported })
        }, WATCH_POLL_MS)
      }
    }
  }

  private async describe(path: string): Promise<FileInfo | undefined> {
    try {
      return infoFrom(path, await this.fs.lstat(path))
    } catch {
      return undefined
    }
  }

  private async readSnapshot(
    path: string,
    noFollow: boolean,
  ): Promise<Result<{ bytes: Uint8Array; mtimeMs: number }, FileError>> {
    try {
      const link = await this.fs.lstat(path)
      if (noFollow && link.isSymbolicLink) {
        return err(new FileError('invalid', 'Refusing to follow a symbolic link', path))
      }
      const stat = await this.fs.stat(path)
      if (stat.isDirectory) return err(new FileError('is_directory', `EISDIR: illegal operation on a directory, read '${path}'`, path))
      return ok({ bytes: await this.fs.readFileBuffer(path), mtimeMs: stat.mtime.getTime() })
    } catch (error) {
      return err(toFileError(error, path))
    }
  }

  async absolutePath(path: string): Promise<Result<string, FileError>> {
    return ok(this.resolve(path))
  }

  async joinPath(parts: string[]): Promise<Result<string, FileError>> {
    return ok(joinPaths(parts))
  }

  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    const resolved = this.resolve(path)
    const aborted = abortedFile(context, resolved)
    if (aborted) return aborted
    const read = await this.readSnapshot(resolved, false)
    return read.ok ? ok(new TextDecoder().decode(read.value.bytes)) : read
  }

  async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    const resolved = this.resolve(path)
    const aborted = abortedFile(context, resolved)
    if (aborted) return aborted
    const read = await this.readSnapshot(resolved, false)
    return read.ok ? ok(new SnapshotTextLineReader(resolved, read.value.bytes)) : read
  }

  async readTextLines(
    path: string,
    options: { maxLines?: number } | undefined,
    context: Context,
  ): Promise<Result<string[], FileError>> {
    if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([])
    const opened = await this.openTextLineReader(path, context)
    if (!opened.ok) return opened
    const lines: Array<string> = []
    while (options?.maxLines === undefined || lines.length < options.maxLines) {
      const line = await opened.value.readLine(context)
      if (!line.ok) return line
      if (line.value === undefined) break
      lines.push(line.value.text)
    }
    await opened.value.close(context)
    return ok(lines)
  }

  async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    const resolved = this.resolve(path)
    const aborted = abortedFile(context, resolved)
    if (aborted) return aborted
    const read = await this.readSnapshot(resolved, false)
    return read.ok ? ok(read.value.bytes) : read
  }

  async openBinaryReader(
    path: string,
    options: { noFollow?: boolean } | undefined,
    context: Context,
  ): Promise<Result<BinaryReader, FileError>> {
    const resolved = this.resolve(path)
    const aborted = abortedFile(context, resolved)
    if (aborted) return aborted
    const read = await this.readSnapshot(resolved, options?.noFollow === true)
    return read.ok ? ok(new SnapshotBinaryReader(resolved, read.value.bytes, read.value.mtimeMs)) : read
  }

  async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const resolved = this.resolve(path)
    const aborted = abortedFile(context, resolved)
    if (aborted) return aborted
    try {
      await this.mutate([resolved], async () => {
        await this.fs.mkdir(parentOf(resolved), { recursive: true })
        await this.fs.writeFile(resolved, toBytes(content))
      })
      return ok(undefined)
    } catch (error) {
      return err(toFileError(error, resolved))
    }
  }

  async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const resolved = this.resolve(path)
    const aborted = abortedFile(context, resolved)
    if (aborted) return aborted
    try {
      await this.mutate([resolved], async () => {
        await this.fs.mkdir(parentOf(resolved), { recursive: true })
        await this.fs.appendFile(resolved, toBytes(content))
      })
      return abortedFile(context, resolved) ?? ok(undefined)
    } catch (error) {
      return err(toFileError(error, resolved))
    }
  }

  async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    const resolved = this.resolve(path)
    const aborted = abortedFile(context, resolved)
    if (aborted) return aborted
    if (!Number.isSafeInteger(size) || size < 0) {
      return err(new FileError('invalid', 'File size must be a non-negative safe integer', resolved))
    }
    try {
      const current = await this.fs.readFileBuffer(resolved)
      const next = new Uint8Array(size)
      next.set(current.subarray(0, size))
      await this.mutate([resolved], () => this.fs.writeFile(resolved, next))
      return ok(undefined)
    } catch (error) {
      return err(toFileError(error, resolved))
    }
  }

  async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    const resolved = this.resolve(path)
    const aborted = abortedFile(context, resolved)
    if (aborted) return aborted
    try {
      const stat = await this.fs.stat(resolved)
      if (stat.isDirectory) return err(new FileError('is_directory', 'Is a directory', resolved))
      return ok(undefined)
    } catch (error) {
      return err(toFileError(error, resolved))
    }
  }

  async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    const source = this.resolve(sourcePath)
    const destination = this.resolve(destinationPath)
    const aborted = abortedFile(context, destination)
    if (aborted) return aborted
    try {
      await this.mutate([source, destination], () => this.fs.mv(source, destination))
      return ok(undefined)
    } catch (error) {
      return err(toFileError(error, source))
    }
  }

  async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    const resolved = this.resolve(path)
    const aborted = abortedFile(context, resolved)
    if (aborted) return aborted
    try {
      return ok(infoFrom(resolved, await this.fs.lstat(resolved)))
    } catch (error) {
      return err(toFileError(error, resolved))
    }
  }

  async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    const resolved = this.resolve(path)
    const aborted = abortedFile(context, resolved)
    if (aborted) return aborted
    try {
      const names = await this.fs.readdir(resolved)
      const infos: Array<FileInfo> = []
      for (const name of names) {
        const info = await this.describe(joinPaths([resolved, name]))
        if (info !== undefined) infos.push(info)
      }
      return ok(infos)
    } catch (error) {
      return err(toFileError(error, resolved))
    }
  }

  async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    const resolved = this.resolve(path)
    const aborted = abortedFile(context, resolved)
    if (aborted) return aborted
    try {
      const names = await this.fs.readdir(resolved)
      return ok(new LiveDirReader(resolved, names, entryPath => this.describe(entryPath)))
    } catch (error) {
      return err(toFileError(error, resolved))
    }
  }

  async watch(
    targets: readonly WatchTarget[],
    onChange: (change: WatchChange) => void,
    context: Context,
  ): Promise<Result<FileWatcher, FileError>> {
    const aborted = abortedFile(context)
    if (aborted) return aborted
    const resolvedTargets: Array<ResolvedWatchTarget> = []
    for (const target of targets) {
      const reportAs = this.resolve(target.path)
      const recursive = target.recursive === true
      resolvedTargets.push({ path: reportAs, reportAs, recursive, target })
      const real = await this.fs.realpath(reportAs).catch(() => reportAs)
      if (real !== reportAs) resolvedTargets.push({ path: real, reportAs, recursive, target })
    }
    const registration: WatchRegistration = {
      targets: resolvedTargets,
      onChange,
      pending: new Set(),
      timer: undefined,
    }
    this.watchers.add(registration)
    return ok({
      mode: 'native',
      close: async () => {
        this.watchers.delete(registration)
        if (registration.timer !== undefined) clearTimeout(registration.timer)
      },
    })
  }

  async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    const resolved = this.resolve(path)
    const aborted = abortedFile(context, resolved)
    if (aborted) return aborted
    try {
      return ok(await this.fs.realpath(resolved))
    } catch (error) {
      return err(toFileError(error, resolved))
    }
  }

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    const info = await this.fileInfo(path, context)
    if (info.ok) return ok(true)
    return info.error.code === 'not_found' ? ok(false) : err(info.error)
  }

  async createDir(
    path: string,
    options: { recursive?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const resolved = this.resolve(path)
    const aborted = abortedFile(context, resolved)
    if (aborted) return aborted
    try {
      await this.mutate([resolved], () => this.fs.mkdir(resolved, { recursive: options?.recursive ?? true }))
      return ok(undefined)
    } catch (error) {
      return err(toFileError(error, resolved))
    }
  }

  async remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const resolved = this.resolve(path)
    const aborted = abortedFile(context, resolved)
    if (aborted) return aborted
    try {
      await this.mutate([resolved], () =>
        this.fs.rm(resolved, { recursive: options?.recursive ?? false, force: options?.force ?? false }),
      )
      return ok(undefined)
    } catch (error) {
      return err(toFileError(error, resolved))
    }
  }

  async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    const aborted = abortedFile(context)
    if (aborted) return aborted
    const path = `${TEMP_ROOT}/${prefix ?? 'tmp-'}${crypto.randomUUID()}`
    const created = await this.createDir(path, { recursive: true }, context)
    return created.ok ? ok(path) : created
  }

  async createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    const dir = await this.createTempDir('tmp-', context)
    if (!dir.ok) return dir
    const path = `${dir.value}/${options?.prefix ?? ''}${crypto.randomUUID()}${options?.suffix ?? ''}`
    const written = await this.writeFile(path, '', context)
    return written.ok ? ok(path) : written
  }

  async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    if (context.abortSignal?.aborted) return err(new ExecutionError('aborted', 'aborted'))
    const timeout = options?.timeout
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_SECONDS)) {
      return err(new ExecutionError('timeout', 'Invalid timeout: must be a finite number of seconds'))
    }
    const script = this.scriptFor(command)
    if (!script.ok) return script
    const cwd = options?.cwd === undefined ? this.cwd : this.resolve(options.cwd)
    if (!(await this.fs.exists(cwd))) {
      return err(new ExecutionError('spawn_error', `Working directory does not exist: ${cwd}\nCannot execute bash commands.`))
    }
    const controller = new AbortController()
    let timedOut = false
    const onAbort = () => controller.abort()
    context.abortSignal?.addEventListener('abort', onAbort, { once: true })
    const timer =
      timeout === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            controller.abort()
          }, timeout * 1000)
    this.running.add(controller)
    const bash = new Bash({ fs: this.fs, cwd })
    try {
      const result = await this.mutate([cwd], () =>
        bash.exec(script.value, {
          cwd,
          signal: controller.signal,
          rawScript: true,
          ...(options?.env === undefined ? {} : { env: options.env }),
          ...(options?.inheritEnv === false ? { replaceEnv: true } : {}),
        }),
      )
      if (timedOut) return err(new ExecutionError('timeout', `Command timed out after ${timeout} seconds`))
      if (context.abortSignal?.aborted) return err(new ExecutionError('aborted', 'aborted'))
      if (Array.isArray(command) && result.exitCode === 127 && result.stdout === '') {
        return err(new ExecutionError('spawn_error', result.stderr.trim() || `${command[0]}: command not found`))
      }
      try {
        if (result.stdout !== '') options?.onOutput?.(result.stdout, context, { stream: 'stdout' })
        if (result.stderr !== '') options?.onOutput?.(result.stderr, context, { stream: 'stderr' })
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error))
        return err(new ExecutionError('callback_error', cause.message, cause))
      }
      return ok({ exitCode: timedOut ? TIMEOUT_EXIT_CODE : result.exitCode })
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error))
      return err(new ExecutionError('unknown', cause.message, cause))
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      context.abortSignal?.removeEventListener('abort', onAbort)
      this.running.delete(controller)
    }
  }

  private scriptFor(command: string | readonly string[]): Result<string, ExecutionError> {
    if (typeof command === 'string') return ok(command)
    const [program, ...args] = command
    if (program === undefined) return err(new ExecutionError('spawn_error', 'Empty argv: no program to run'))
    if (SHELL_PROGRAMS.has(program) && args[0] === SHELL_COMMAND_FLAG && args[1] !== undefined) {
      const positional = args.slice(3).map(shellQuote).join(' ')
      const prelude = positional === '' ? '' : `set -- ${positional}\n`
      return ok(`${prelude}${args[1]}`)
    }
    return ok([program, ...args].map(shellQuote).join(' '))
  }

  async cleanup(_context?: Context): Promise<void> {
    for (const controller of this.running) controller.abort()
    this.running.clear()
    for (const registration of this.watchers) {
      if (registration.timer !== undefined) clearTimeout(registration.timer)
    }
    this.watchers.clear()
  }
}

const restoreEntry = async (fs: InMemoryFs, entry: StoredEntry): Promise<void> => {
  await fs.mkdir(parentOf(entry.path), { recursive: true })
  if (entry.type === 'directory') await fs.mkdir(entry.path, { recursive: true })
  else if (entry.type === 'symlink') await fs.symlink(entry.target, entry.path)
  else await fs.writeFile(entry.path, entry.content)
}
