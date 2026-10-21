import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type RequestListener } from "node:http";
import { AppError } from "../../shared/errors.js";
import type { AuthEndpoints, ResolvedEndpoints, StoredCredentials, VerifiedIdentity } from "./types.js";
import { verifyIdentity } from "./identity.js";

export const SHARING_SCOPE = "chatgpt.tokens.use.direct";
const DEFAULT_ISSUER = "https://auth.openai.com";
const DEFAULT_RESOURCE = "https://api.openai.com/v1";
const AUTHORIZATION_PATH = "/api/accounts/authorize";
const TOKEN_PATH = "/api/accounts/oauth/token";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const CALLBACK_PATH = "/auth/callback";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AppError("CANCELLED", "操作已停止。");
}

async function json(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return undefined; }
}

export class TokenEndpointError extends AppError {
  constructor(readonly oauthCode: string, message: string, readonly status?: number) {
    super(oauthCode === "invalid_grant" ? "AUTH_GRANT_INVALID" : "AUTH_TOKEN_ERROR", message);
  }
}

export async function resolveEndpoints(
  fetcher: typeof fetch,
  overrides: AuthEndpoints = {},
  signal?: AbortSignal,
): Promise<ResolvedEndpoints> {
  const issuer = overrides.issuer ?? DEFAULT_ISSUER;
  const resource = overrides.resource ?? DEFAULT_RESOURCE;
  let issuerUrl: URL;
  try { issuerUrl = new URL(issuer); }
  catch { throw new AppError("AUTH_CONFIG_INVALID", "ChatGPT 登录服务地址无效。"); }
  const issuerOrigin = issuerUrl.origin;
  let discovered: Record<string, unknown> = {};
  if (!overrides.authorization || !overrides.token || !overrides.jwks) {
    assertActive(signal);
    let response: Response;
    try {
      response = await fetcher(overrides.discovery ?? `${issuer}/.well-known/openid-configuration`, {
        headers: { accept: "application/json" }, signal,
      });
    } catch {
      if (signal?.aborted) throw new AppError("CANCELLED", "操作已停止。");
      throw new AppError("AUTH_TEMPORARY", "暂时无法读取 ChatGPT 登录配置，请稍后重试。");
    }
    const body = await json(response);
    if (!response.ok || !isRecord(body) || body.issuer !== issuer) {
      throw new AppError("AUTH_CONFIG_INVALID", "ChatGPT 登录配置无法验证。");
    }
    discovered = body;
  }
  const endpoints: ResolvedEndpoints = {
    issuer,
    resource,
    // These protocol endpoints are explicit in the Sign in with ChatGPT contract.
    // Discovery remains the source of signing keys and optional revocation.
    authorization: overrides.authorization ?? new URL(AUTHORIZATION_PATH, issuerUrl).toString(),
    token: overrides.token ?? new URL(TOKEN_PATH, issuerUrl).toString(),
    jwks: overrides.jwks ?? String(discovered.jwks_uri ?? ""),
    ...((overrides.revocation ?? discovered.revocation_endpoint) ? { revocation: String(overrides.revocation ?? discovered.revocation_endpoint) } : {}),
  };
  for (const endpoint of [endpoints.authorization, endpoints.token, endpoints.jwks, ...(endpoints.revocation ? [endpoints.revocation] : [])]) {
    try {
      if (!endpoint || new URL(endpoint).origin !== issuerOrigin) throw new Error();
    } catch {
      throw new AppError("AUTH_CONFIG_INVALID", "ChatGPT 登录端点不可信。");
    }
  }
  return endpoints;
}

export async function tokenRequest(
  endpoint: string,
  body: URLSearchParams,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
      signal,
    });
  } catch {
    if (signal.aborted) throw new AppError("CANCELLED", "操作已停止。");
    throw new AppError("AUTH_TEMPORARY", "暂时无法连接 ChatGPT 登录服务，请稍后重试。");
  }
  const data = await json(response);
  if (!response.ok) {
    const code = isRecord(data) && typeof data.error === "string" ? data.error : "token_request_failed";
    const message = code === "invalid_grant"
      ? "登录授权已失效，请重新登录。"
      : response.status >= 500
        ? "ChatGPT 登录服务暂时不可用，请稍后重试。"
        : "ChatGPT 未接受登录请求，请重新登录。";
    if (response.status >= 500) throw new AppError("AUTH_TEMPORARY", message);
    throw new TokenEndpointError(code, message, response.status);
  }
  if (!isRecord(data)) throw new AppError("AUTH_TOKEN_INVALID", "ChatGPT 返回了无法识别的登录结果。");
  return data;
}

export function tokenFields(
  data: Record<string, unknown>,
  fallbackScopes: string[] = [],
  requireRefresh = false,
): { scopes: string[]; credentials: StoredCredentials } {
  const scopes = typeof data.scope === "string" ? data.scope.split(/\s+/).filter(Boolean) : fallbackScopes;
  if (!scopes.length || typeof data.access_token !== "string" || !data.access_token
      || typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer"
      || typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0
      || (requireRefresh && (typeof data.refresh_token !== "string" || !data.refresh_token))
      || (scopes.includes("offline_access") && (typeof data.refresh_token !== "string" || !data.refresh_token))) {
    throw new AppError("AUTH_TOKEN_INVALID", "ChatGPT 返回的登录凭据不完整，请重新登录。");
  }
  return {
    scopes,
    credentials: {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1_000,
      ...(typeof data.refresh_token === "string" && data.refresh_token ? { refreshToken: data.refresh_token } : {}),
      ...((typeof data.earliest_refresh_at === "string" || typeof data.earliest_refresh_at === "number")
        ? { earliestRefreshAt: data.earliest_refresh_at } : {}),
    },
  };
}

interface CallbackResult { code: string; clientId: string }

async function listenForCallback(state: string, savedClientId: string | undefined, signal: AbortSignal) {
  let resolveResult!: (value: CallbackResult) => void;
  let rejectResult!: (error: AppError) => void;
  let settled = false;
  let port = 0;
  const result = new Promise<CallbackResult>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  void result.catch(() => undefined);
  const finish = (value: CallbackResult | AppError) => {
    if (settled) return;
    settled = true;
    value instanceof AppError ? rejectResult(value) : resolveResult(value);
  };
  const handler: RequestListener = (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("referrer-policy", "no-referrer");
    let url: URL;
    try { url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`); }
    catch { response.writeHead(400).end("Invalid request"); return; }
    if (request.method !== "GET" || request.headers.host !== `127.0.0.1:${port}`
        || url.origin !== `http://127.0.0.1:${port}` || url.pathname !== CALLBACK_PATH || settled) {
      response.writeHead(404).end("Not found");
      return;
    }
    const actual = Buffer.from(url.searchParams.get("state") ?? "");
    const expected = Buffer.from(state);
    if (url.searchParams.getAll("state").length !== 1 || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      response.writeHead(400).end("Invalid sign-in state");
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<!doctype html><meta charset=utf-8><title>Folio 登录完成</title><p>登录检查即将完成，可以关闭此页面。</p>");
    if (url.searchParams.has("error")) {
      finish(new AppError("ACCESS_DENIED", "登录未获授权，请确认后重试。"));
      return;
    }
    const code = url.searchParams.get("code");
    const returnedClientId = url.searchParams.get("client_id");
    const clientId = returnedClientId ?? savedClientId;
    if (!code || url.searchParams.getAll("code").length !== 1 || url.searchParams.getAll("client_id").length > 1
        || !clientId || !/^[a-zA-Z0-9_-]{1,200}$/.test(clientId) || clientId === "dynamic_agent_client"
        || (savedClientId !== undefined && returnedClientId !== null && returnedClientId !== savedClientId)) {
      finish(new AppError("AUTH_CALLBACK_INVALID", "登录回调不完整，请重新登录。"));
      return;
    }
    finish({ code, clientId });
  };
  const server = createServer(handler);
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  const abort = () => finish(new AppError("CANCELLED", "操作已停止。"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ port: 0, host: "127.0.0.1" }, () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing port");
    port = address.port;
  } catch {
    signal.removeEventListener("abort", abort);
    server.close();
    throw new AppError("AUTH_CALLBACK_UNAVAILABLE", "无法启动本地登录回调，请重试。");
  }
  const close = () => {
    signal.removeEventListener("abort", abort);
    server.close();
    server.closeAllConnections();
  };
  return { result, close, redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}` };
}

export interface AuthorizationResult {
  clientId: string;
  identity: VerifiedIdentity;
  idToken: string;
  scopes: string[];
  credentials: StoredCredentials;
}

export async function authorize(options: {
  endpoints: ResolvedEndpoints;
  fetcher: typeof fetch;
  openBrowser: (url: string) => Promise<void>;
  hostId: string;
  previous?: { clientId: string; subject?: string; email?: string; idToken?: string };
  signal: AbortSignal;
  onRegistration: (clientId: string) => Promise<void>;
}): Promise<AuthorizationResult> {
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const listener = await listenForCallback(state, options.previous?.clientId, options.signal);
  try {
    const url = new URL(options.endpoints.authorization);
    url.search = new URLSearchParams({
      client_id: options.previous?.clientId ?? "dynamic_agent_client",
      response_type: "code",
      redirect_uri: listener.redirectUri,
      scope: SCOPES,
      resource: options.endpoints.resource,
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      ext_agent_host_id: options.hostId,
      ...(!options.previous ? { agent_name_hint: "Folio" } : {}),
      ...(options.previous?.idToken ? { id_token_hint: options.previous.idToken } : {}),
      ...(options.previous?.email ? { login_hint: options.previous.email } : {}),
    }).toString();
    await new Promise<void>((resolve, reject) => {
      const aborted = () => reject(new AppError("CANCELLED", "操作已停止。"));
      if (options.signal.aborted) { aborted(); return; }
      options.signal.addEventListener("abort", aborted, { once: true });
      Promise.resolve(options.openBrowser(url.toString())).then(resolve, reject).finally(() => {
        options.signal.removeEventListener("abort", aborted);
      });
    });
    const callback = await listener.result;
    await options.onRegistration(callback.clientId);
    const data = await tokenRequest(options.endpoints.token, new URLSearchParams({
      grant_type: "authorization_code",
      client_id: callback.clientId,
      code: callback.code,
      code_verifier: verifier,
      redirect_uri: listener.redirectUri,
      resource: options.endpoints.resource,
    }), options.fetcher, options.signal);
    if (typeof data.id_token !== "string" || !data.id_token) {
      throw new AppError("ID_TOKEN_INVALID", "ChatGPT 未返回可验证的身份，请重新登录。");
    }
    const identity = await verifyIdentity(data.id_token, callback.clientId, options.endpoints, options.fetcher, {
      nonce,
      signal: options.signal,
    });
    if (options.previous?.subject && identity.subject !== options.previous.subject) {
      throw new AppError("AUTH_ACCOUNT_MISMATCH", "本次登录的 ChatGPT 账号与所选账号不一致。");
    }
    const fields = tokenFields(data);
    return { clientId: callback.clientId, identity, idToken: data.id_token, ...fields };
  } finally {
    listener.close();
  }
}
