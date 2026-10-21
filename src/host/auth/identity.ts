import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { AppError } from "../../shared/errors.js";
import type { ResolvedEndpoints, VerifiedIdentity } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function verifyIdentity(
  idToken: string,
  clientId: string,
  endpoints: ResolvedEndpoints,
  fetcher: typeof fetch,
  options: { nonce?: string; receivedAt?: number; signal?: AbortSignal } = {},
): Promise<VerifiedIdentity> {
  let response: Response;
  try {
    response = await fetcher(endpoints.jwks, { headers: { accept: "application/json" }, signal: options.signal });
  } catch {
    if (options.signal?.aborted) throw new AppError("CANCELLED", "操作已停止。");
    throw new AppError("AUTH_TEMPORARY", "暂时无法验证 ChatGPT 身份，请稍后重试。");
  }
  let keys: unknown;
  try { keys = await response.json(); } catch { keys = undefined; }
  if (!response.ok || !isRecord(keys) || !Array.isArray(keys.keys)) {
    throw new AppError("AUTH_TEMPORARY", "暂时无法验证 ChatGPT 身份，请稍后重试。");
  }

  try {
    const result = await jwtVerify(idToken, createLocalJWKSet(keys as unknown as JSONWebKeySet), {
      issuer: endpoints.issuer,
      audience: clientId,
      algorithms: ["RS256"],
      clockTolerance: 5,
      requiredClaims: ["iss", "aud", "exp", "iat", "sub"],
      ...(options.receivedAt === undefined ? {} : { currentDate: new Date(options.receivedAt) }),
    });
    const payload = result.payload;
    if (typeof payload.sub !== "string" || !payload.sub
        || (options.nonce !== undefined && payload.nonce !== options.nonce)
        || (payload.azp !== undefined && payload.azp !== clientId)
        || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)) {
      throw new Error("invalid identity claims");
    }
    return {
      subject: payload.sub,
      ...(typeof payload.email === "string" && payload.email ? { email: payload.email } : {}),
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("ID_TOKEN_INVALID", "ChatGPT 返回的身份凭据无效，请重新登录。");
  }
}
