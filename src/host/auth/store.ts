import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { AppError } from "../../shared/errors.js";
import type { StoredAuthState } from "./types.js";

const FILE_NAME = "chatgpt-auth.json";
const MAX_FILE_BYTES = 2 * 1024 * 1024;

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
    this.#file = join(directory, FILE_NAME);
    this.#lockFile = join(directory, ".chatgpt-auth.lock");
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

  async withLock<T>(operation: (state: StoredAuthState) => Promise<T>, signal?: AbortSignal): Promise<T> {
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
