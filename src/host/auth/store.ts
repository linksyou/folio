import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { AppError } from "../../shared/errors.js";
import type { StoredAuthState } from "./types.js";

const FILE_NAME = "chatgpt-auth.json";
const MAX_FILE_BYTES = 2 * 1024 * 1024;

interface StoreQueue {
  tail: Promise<void>;
  read?: Promise<StoredAuthState>;
}

// Serialize operations before taking the cross-process lock. Otherwise reads in
// this same process collide on the lock and each loser sleeps for 100 ms.
const storeQueues = new Map<string, StoreQueue>();

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AppError("CANCELLED", "操作已停止。");
}

function validState(value: unknown): value is StoredAuthState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<StoredAuthState>;
  if (!(state.version === 1
    && typeof state.hostId === "string"
    && /^urn:uuid:[0-9a-f-]{36}$/.test(state.hostId)
    && Array.isArray(state.profiles)
    && Array.isArray(state.pendingRegistrations))) return false;
  const ids = new Set<string>();
  for (const entry of [...state.profiles, ...state.pendingRegistrations]) {
    if (!entry || typeof entry !== "object") return false;
    const record = entry as unknown as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id || ids.has(record.id)
        || typeof record.label !== "string" || !record.label
        || typeof record.clientId !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(record.clientId)
        || typeof record.savedAt !== "string") return false;
    ids.add(record.id);
  }
  if (state.activeProfileId !== undefined
      && (typeof state.activeProfileId !== "string" || !state.profiles.some((entry) => entry.id === state.activeProfileId))) return false;
  return state.profiles.every((profile) => Array.isArray(profile.scopes)
    && profile.scopes.every((scope) => typeof scope === "string")
    && ["signed_out", "signed_in", "needs_login"].includes(profile.state));
}

export class AuthStore {
  readonly #file: string;
  readonly #lockFile: string;

  constructor(readonly directory: string) {
    this.#file = resolve(directory, FILE_NAME);
    this.#lockFile = resolve(directory, ".chatgpt-auth.lock");
  }

  async #prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new AppError("STORAGE_UNSAFE", "认证数据目录不安全，请更换目录后重试。");
    }
    if (process.platform !== "win32") {
      if (process.getuid && info.uid !== process.getuid()) {
        throw new AppError("STORAGE_UNSAFE", "认证数据目录不属于当前用户。");
      }
      await chmod(this.directory, 0o700);
    }
  }

  private queue(): StoreQueue {
    let queue = storeQueues.get(this.#file);
    if (!queue) {
      queue = { tail: Promise.resolve() };
      storeQueues.set(this.#file, queue);
    }
    return queue;
  }

  private enqueue<T>(queue: StoreQueue, operation: (state: StoredAuthState) => Promise<T>, signal?: AbortSignal): Promise<T> {
    let started = false;
    const task = queue.tail.then(() => {
      started = true;
      cancelled(signal);
      return this.#withFileLock(operation, signal);
    });
    const tail = task.then(() => {}, () => {});
    queue.tail = tail;
    void tail.then(() => {
      if (queue.tail === tail && storeQueues.get(this.#file) === queue) storeQueues.delete(this.#file);
    });
    if (!signal) return task;
    // Reject a cancelled waiter promptly, but keep its queue position until the
    // preceding operation ends. Later writes must not overtake the lock owner.
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        // Once running, keep awaiting the owner: rotating credentials must finish
        // their atomic save even if the requesting page has gone away.
        if (!started) reject(new AppError("CANCELLED", "操作已停止。"));
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      task.then(
        (value) => { signal.removeEventListener("abort", abort); resolve(value); },
        (error) => { signal.removeEventListener("abort", abort); reject(error); },
      );
    });
  }

  /** Share only overlapping reads with no intervening potential writer. No TTL. */
  async read(): Promise<StoredAuthState> {
    const queue = this.queue();
    let task = queue.read;
    if (!task) {
      task = this.enqueue(queue, async (state) => state);
      queue.read = task;
      const clear = () => { if (queue.read === task) queue.read = undefined; };
      void task.then(clear, clear);
    }
    // Never let a reader mutate the shared snapshot of another reader.
    return structuredClone(await task);
  }

  async withLock<T>(operation: (state: StoredAuthState) => Promise<T>, signal?: AbortSignal): Promise<T> {
    cancelled(signal);
    const queue = this.queue();
    // Even accessToken may rotate credentials. A later status must queue behind
    // any such operation, rather than reuse the read that preceded it.
    queue.read = undefined;
    return this.enqueue(queue, operation, signal);
  }

  async #withFileLock<T>(operation: (state: StoredAuthState) => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.#prepare();
    const startedAt = Date.now();
    let release: (() => Promise<void>) | undefined;
    try {
      while (!release) {
        cancelled(signal);
        try {
          // proper-lockfile tracks ownership by target, not lockfilePath. Auth
          // and settings must use distinct targets even in the same directory.
          release = await lockfile.lock(this.#file, {
            realpath: false, // The data file may not exist before first sign-in.
            lockfilePath: this.#lockFile,
            stale: 120_000,
            update: 20_000,
            retries: 0,
          });
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ELOCKED") throw error;
          if (Date.now() - startedAt >= 45_000) {
            throw new AppError("STORAGE_BUSY", "另一个本地进程正在更新登录状态，请稍后重试。");
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
      }
      cancelled(signal);
      return await operation(await this.#readUnlocked());
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("STORAGE_ERROR", "无法安全读写本地登录状态。");
    } finally {
      if (release) {
        try { await release(); } catch { /* A later operation will detect a stale lock. */ }
      }
    }
  }

  async #readUnlocked(): Promise<StoredAuthState> {
    let handle;
    try {
      const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
      handle = await open(this.#file, constants.O_RDONLY | noFollow);
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_FILE_BYTES
          || (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())))) {
        throw new AppError("STORAGE_UNSAFE", "登录状态文件必须只允许当前用户访问。");
      }
      const parsed: unknown = JSON.parse(await handle.readFile("utf8"));
      if (!validState(parsed)) throw new AppError("STORAGE_INVALID", "本地登录状态已损坏，请从备份恢复或重新配置。");
      return parsed;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { version: 1, hostId: `urn:uuid:${randomUUID()}`, profiles: [], pendingRegistrations: [] };
      }
      if (error instanceof SyntaxError) throw new AppError("STORAGE_INVALID", "本地登录状态已损坏，请从备份恢复或重新配置。");
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async writeLocked(state: StoredAuthState): Promise<void> {
    const body = JSON.stringify(state);
    if (Buffer.byteLength(body) > MAX_FILE_BYTES) throw new AppError("STORAGE_TOO_LARGE", "本地登录状态超过大小限制。");
    const temporary = join(this.directory, `.chatgpt-auth.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(body, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.#file);
      if (process.platform !== "win32") {
        await chmod(this.#file, 0o600);
        const directory = await open(this.directory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("STORAGE_ERROR", "无法保存本地登录状态。");
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
