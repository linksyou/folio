import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AuthStatus, Profile } from "../../shared/protocol.js";
import { AppError } from "../../shared/errors.js";
import { verifyIdentity } from "./identity.js";
import {
  authorize,
  resolveEndpoints,
  SHARING_SCOPE,
  tokenFields,
  tokenRequest,
  TokenEndpointError,
} from "./oauth.js";
import { AuthStore } from "./store.js";
import type {
  AuthEndpoints,
  PendingRefresh,
  ResolvedEndpoints,
  StoredAuthState,
  StoredProfile,
} from "./types.js";

export type { AuthEndpoints } from "./types.js";

export interface ChatGPTAuthOptions {
  dataDir: string;
  fetch?: typeof fetch;
  openBrowser?: (url: string) => Promise<void>;
  endpoints?: AuthEndpoints;
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AppError("CANCELLED", "操作已停止。");
}

function activeProfile(state: StoredAuthState): StoredProfile | undefined {
  return state.profiles.find((profile) => profile.id === state.activeProfileId);
}

function publicProfile(profile: StoredProfile): Profile {
  return { id: profile.id, label: profile.label, ...(profile.email ? { email: profile.email } : {}) };
}

function publicStatus(state: StoredAuthState): AuthStatus {
  const selected = activeProfile(state);
  const profiles = state.profiles.map(publicProfile);
  if (!selected) return { state: "signed_out", profiles, planEnabled: false };
  return {
    state: selected.state,
    profile: publicProfile(selected),
    profiles,
    planEnabled: selected.state === "signed_in"
      && Boolean(selected.credentials)
      && selected.scopes.includes(SHARING_SCOPE),
  };
}

function clearCredentials(profile: StoredProfile, state: "signed_out" | "needs_login"): StoredProfile {
  const { credentials: _credentials, idToken: _idToken, pendingRefresh: _pending, ...metadata } = profile;
  return { ...metadata, state, scopes: [], savedAt: new Date().toISOString() };
}

function refreshTime(value: string | number | undefined): number {
  if (typeof value === "number") return value * 1_000;
  if (typeof value === "string") return Date.parse(value);
  return 0;
}

async function defaultOpenBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: "ignore" });
    child.once("error", () => reject(new AppError("BROWSER_UNAVAILABLE", "无法打开系统浏览器，请检查默认浏览器设置。")));
    child.once("exit", (code) => code === 0
      ? resolve()
      : reject(new AppError("BROWSER_UNAVAILABLE", "无法打开系统浏览器，请检查默认浏览器设置。")));
  });
}

export class ChatGPTAuth {
  readonly #store: AuthStore;
  readonly #fetcher: typeof fetch;
  readonly #openBrowser: (url: string) => Promise<void>;
  readonly #endpointOverrides: AuthEndpoints;
  #signInController?: AbortController;
  #epoch = 0;

  constructor(options: ChatGPTAuthOptions) {
    if (!options.dataDir) throw new AppError("AUTH_CONFIG_INVALID", "必须提供登录数据目录。");
    this.#store = new AuthStore(options.dataDir);
    this.#fetcher = options.fetch ?? globalThis.fetch;
    this.#openBrowser = options.openBrowser ?? defaultOpenBrowser;
    this.#endpointOverrides = options.endpoints ?? {};
  }

  async status(): Promise<AuthStatus> {
    return this.#store.withLock(async (state) => publicStatus(state));
  }

  async signIn(options: { newAccount?: boolean; signal?: AbortSignal } = {}): Promise<AuthStatus> {
    if (this.#signInController) throw new AppError("AUTH_BUSY", "已有登录操作正在进行，请先完成或取消。");
    const controller = new AbortController();
    this.#signInController = controller;
    this.#epoch += 1;
    const operation = this.#epoch;
    const signals: AbortSignal[] = [controller.signal, AbortSignal.timeout(10 * 60_000)];
    if (options.signal) signals.push(options.signal);
    const signal = AbortSignal.any(signals);
    try {
      const endpoints = await resolveEndpoints(this.#fetcher, this.#endpointOverrides, signal);
      const prepared = await this.#store.withLock(async (state) => {
        await this.#store.writeLocked(state); // Persist the host identity before opening a browser.
        const selected = options.newAccount ? undefined : activeProfile(state);
        // There is no public pending-profile selector. Reuse the last issued client
        // after an interrupted exchange instead of registering another client.
        const pending = !selected ? state.pendingRegistrations.at(-1) : undefined;
        const id = selected?.id ?? pending?.id ?? randomUUID();
        const label = selected?.label ?? pending?.label ?? `ChatGPT 账号 ${state.profiles.length + state.pendingRegistrations.length + 1}`;
        return {
          id,
          label,
          hostId: state.hostId,
          initialActiveProfileId: state.activeProfileId,
          previous: selected
            ? { clientId: selected.clientId, subject: selected.subject, email: selected.email, idToken: selected.idToken }
            : pending
              ? { clientId: pending.clientId }
              : undefined,
        };
      }, signal);

      const result = await authorize({
        endpoints,
        fetcher: this.#fetcher,
        openBrowser: this.#openBrowser,
        hostId: prepared.hostId,
        previous: prepared.previous,
        signal,
        onRegistration: async (clientId) => {
          await this.#store.withLock(async (state) => {
            assertActive(signal);
            const profile = state.profiles.find((entry) => entry.id === prepared.id);
            if (profile && profile.clientId !== clientId) {
              throw new AppError("AUTH_CHANGED", "所选账号在登录期间发生了变化，请重试。");
            }
            const pending = state.pendingRegistrations.find((entry) => entry.id === prepared.id);
            if (pending && pending.clientId !== clientId) {
              throw new AppError("AUTH_CHANGED", "待完成的登录注册发生了变化，请重试。");
            }
            if (!profile && !pending) {
              state.pendingRegistrations.push({
                id: prepared.id,
                label: prepared.label,
                clientId,
                savedAt: new Date().toISOString(),
              });
              await this.#store.writeLocked(state);
            }
          }, signal);
        },
      });
      assertActive(signal);
      return await this.#store.withLock(async (state) => {
        assertActive(signal);
        if (operation !== this.#epoch || state.activeProfileId !== prepared.initialActiveProfileId) {
          throw new AppError("AUTH_CHANGED", "当前账号在登录期间发生了变化，请重试。");
        }
        const current = state.profiles.find((entry) => entry.id === prepared.id);
        if (current?.subject && current.subject !== result.identity.subject) {
          throw new AppError("AUTH_ACCOUNT_MISMATCH", "本次登录的 ChatGPT 账号与所选账号不一致。");
        }
        const profile: StoredProfile = {
          id: prepared.id,
          label: result.identity.email ?? current?.label ?? prepared.label,
          clientId: result.clientId,
          subject: result.identity.subject,
          ...(result.identity.email ? { email: result.identity.email } : {}),
          scopes: result.scopes,
          state: "signed_in",
          credentials: result.credentials,
          idToken: result.idToken,
          savedAt: new Date().toISOString(),
        };
        state.profiles = [...state.profiles.filter((entry) => entry.id !== profile.id), profile];
        state.pendingRegistrations = state.pendingRegistrations.filter((entry) => entry.id !== profile.id);
        state.activeProfileId = profile.id;
        await this.#store.writeLocked(state);
        return publicStatus(state);
      }, signal);
    } catch (error) {
      if (signal.aborted && !(error instanceof AppError && error.code !== "CANCELLED")) {
        throw new AppError("CANCELLED", "操作已停止。");
      }
      if (error instanceof AppError) throw error;
      throw new AppError("AUTH_FAILED", "登录未完成，请重试。");
    } finally {
      if (this.#signInController === controller) this.#signInController = undefined;
    }
  }

  cancelSignIn(): void {
    this.#signInController?.abort();
  }

  async signOut(): Promise<{ revoked: boolean }> {
    this.#epoch += 1;
    this.cancelSignIn();
    const removed = await this.#store.withLock(async (state) => {
      const profile = activeProfile(state);
      if (!profile) return undefined;
      const token = profile.pendingRefresh?.credentials.refreshToken
        ?? profile.credentials?.refreshToken
        ?? profile.credentials?.accessToken;
      const tokenType = profile.pendingRefresh?.credentials.refreshToken || profile.credentials?.refreshToken
        ? "refresh_token"
        : "access_token";
      state.profiles = state.profiles.map((entry) => entry.id === profile.id ? clearCredentials(entry, "signed_out") : entry);
      await this.#store.writeLocked(state);
      return token ? { token, tokenType, clientId: profile.clientId } : undefined;
    });
    if (!removed) return { revoked: true };
    try {
      const signal = AbortSignal.timeout(10_000);
      const endpoints = await resolveEndpoints(this.#fetcher, this.#endpointOverrides, signal);
      if (!endpoints.revocation) return { revoked: false };
      const response = await this.#fetcher(endpoints.revocation, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: removed.token,
          token_type_hint: removed.tokenType,
          client_id: removed.clientId,
        }),
        signal,
      });
      await response.body?.cancel().catch(() => undefined);
      return { revoked: response.status === 200 };
    } catch {
      return { revoked: false };
    }
  }

  async selectProfile(id: string): Promise<AuthStatus> {
    if (this.#signInController) throw new AppError("AUTH_BUSY", "登录期间不能切换账号。");
    this.#epoch += 1;
    return this.#store.withLock(async (state) => {
      if (!state.profiles.some((profile) => profile.id === id)) {
        throw new AppError("PROFILE_NOT_FOUND", "找不到所选 ChatGPT 账号。");
      }
      state.activeProfileId = id;
      await this.#store.writeLocked(state);
      return publicStatus(state);
    });
  }

  async accessToken(signal?: AbortSignal): Promise<string> {
    if (this.#signInController) throw new AppError("AUTH_BUSY", "登录期间不能发起请求。");
    assertActive(signal);
    const operation = this.#epoch;
    const token = await this.#store.withLock(async (state) => {
      const profile = activeProfile(state);
      if (!profile || profile.state !== "signed_in" || !profile.credentials) {
        throw new AppError("AUTH_REQUIRED", "请先登录 ChatGPT。");
      }
      if (!profile.scopes.includes(SHARING_SCOPE)) {
        throw new AppError("PLAN_DISABLED", "当前账号未授权使用 ChatGPT 方案额度。");
      }

      // A valid credential needs no discovery/JWKS network round trip. Resolve
      // login endpoints only when we actually need to finish or refresh it.
      let endpoints: ResolvedEndpoints | undefined;
      if (profile.pendingRefresh) {
        endpoints = await resolveEndpoints(this.#fetcher, this.#endpointOverrides, signal);
        await this.#finishPendingRefresh(state, profile, endpoints);
      }
      const current = activeProfile(state);
      if (!current?.credentials || current.state !== "signed_in") {
        throw new AppError("AUTH_REQUIRED", "请重新登录 ChatGPT。");
      }
      if (current.credentials.expiresAt > Date.now() + 60_000) return current.credentials.accessToken;
      const earliest = refreshTime(current.credentials.earliestRefreshAt);
      if (Number.isFinite(earliest) && earliest > Date.now()) {
        if (current.credentials.expiresAt > Date.now()) return current.credentials.accessToken;
        throw new AppError("REFRESH_NOT_READY", "登录凭据暂时无法续期，请稍后重试。");
      }
      if (!current.credentials.refreshToken) {
        await this.#markNeedsLogin(state, current);
        throw new AppError("AUTH_REQUIRED", "登录已过期，请重新登录 ChatGPT。");
      }

      endpoints ??= await resolveEndpoints(this.#fetcher, this.#endpointOverrides, signal);
      const refreshSignal = AbortSignal.timeout(60_000);
      let data: Record<string, unknown>;
      try {
        data = await tokenRequest(endpoints.token, new URLSearchParams({
          grant_type: "refresh_token",
          client_id: current.clientId,
          refresh_token: current.credentials.refreshToken,
          resource: endpoints.resource,
        }), this.#fetcher, refreshSignal);
      } catch (error) {
        if (error instanceof TokenEndpointError || (error instanceof AppError && error.code === "AUTH_TOKEN_INVALID")) {
          await this.#markNeedsLogin(state, current);
          throw new AppError("AUTH_REQUIRED", "登录续期失败，请重新登录 ChatGPT。");
        }
        if (error instanceof AppError && error.code === "CANCELLED") {
          throw new AppError("AUTH_TEMPORARY", "登录续期超时，请稍后重试。");
        }
        throw error;
      }

      let fields: ReturnType<typeof tokenFields>;
      try { fields = tokenFields(data, current.scopes, true); }
      catch {
        await this.#markNeedsLogin(state, current);
        throw new AppError("AUTH_REQUIRED", "ChatGPT 返回的续期凭据无效，请重新登录。");
      }
      if (data.id_token !== undefined && (typeof data.id_token !== "string" || !data.id_token)) {
        await this.#markNeedsLogin(state, current);
        throw new AppError("AUTH_REQUIRED", "ChatGPT 返回的续期身份无效，请重新登录。");
      }
      if (typeof data.id_token === "string") {
        current.pendingRefresh = {
          credentials: fields.credentials,
          scopes: fields.scopes,
          idToken: data.id_token,
          receivedAt: Date.now(),
        };
        current.savedAt = new Date().toISOString();
        await this.#store.writeLocked(state);
        await this.#finishPendingRefresh(state, current, endpoints);
      } else {
        current.credentials = fields.credentials;
        current.scopes = fields.scopes;
        current.savedAt = new Date().toISOString();
        await this.#store.writeLocked(state);
      }
      const refreshed = activeProfile(state);
      if (!refreshed?.credentials || refreshed.credentials.expiresAt <= Date.now()) {
        throw new AppError("REFRESH_NOT_READY", "登录凭据已恢复，请重试当前操作。");
      }
      return refreshed.credentials.accessToken;
    }, signal);
    assertActive(signal);
    if (operation !== this.#epoch) throw new AppError("CANCELLED", "账号状态已变化，操作已停止。");
    return token;
  }

  async #finishPendingRefresh(
    state: StoredAuthState,
    profile: StoredProfile,
    endpoints: ResolvedEndpoints,
  ): Promise<void> {
    const pending: PendingRefresh | undefined = profile.pendingRefresh;
    if (!pending) return;
    let identity;
    try {
      identity = await verifyIdentity(pending.idToken, profile.clientId, endpoints, this.#fetcher, {
        receivedAt: pending.receivedAt,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (error instanceof AppError && error.code === "AUTH_TEMPORARY") throw error;
      if (error instanceof AppError && error.code === "CANCELLED") {
        throw new AppError("AUTH_TEMPORARY", "暂时无法验证续期身份，请稍后重试。");
      }
      await this.#markNeedsLogin(state, profile);
      throw new AppError("AUTH_REQUIRED", "续期身份验证失败，请重新登录 ChatGPT。");
    }
    if (!profile.subject || identity.subject !== profile.subject) {
      await this.#markNeedsLogin(state, profile);
      throw new AppError("AUTH_REQUIRED", "续期账号与当前账号不一致，请重新登录。");
    }
    profile.credentials = pending.credentials;
    profile.scopes = pending.scopes;
    profile.idToken = pending.idToken;
    if (identity.email) {
      profile.email = identity.email;
      profile.label = identity.email;
    }
    delete profile.pendingRefresh;
    profile.savedAt = new Date().toISOString();
    await this.#store.writeLocked(state);
  }

  async #markNeedsLogin(state: StoredAuthState, profile: StoredProfile): Promise<void> {
    state.profiles = state.profiles.map((entry) => entry.id === profile.id ? clearCredentials(entry, "needs_login") : entry);
    await this.#store.writeLocked(state);
  }
}
