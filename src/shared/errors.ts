import type { PublicError } from "./protocol.js";

/** Expected failures may cross the process boundary; arbitrary exception text may not. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function publicError(error: unknown): PublicError {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  if (error instanceof Error && error.name === "AbortError") {
    return { code: "CANCELLED", message: "操作已停止。" };
  }
  return { code: "INTERNAL_ERROR", message: "操作未完成，请重试。详情可在本地诊断中查看。" };
}
