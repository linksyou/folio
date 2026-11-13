import type { PageAction, PageState, PublicError } from "./protocol.js";

// Display only our own copy, even if an upstream error contains a URL or token.
const reasons: Record<string, [string, string?]> = {
  NETWORK_ERROR: ["网络连接失败"],
  TIMEOUT: ["翻译请求超时"],
  INVALID_RESPONSE: ["返回的译文不完整或格式无效"],
  INCOMPLETE_RESPONSE: ["译文传输中断"],
  PROVIDER_ERROR: ["翻译服务暂时不可用"],
  AUTH_REQUIRED: ["需要登录或检查认证配置", "去登录 / 检查认证"],
  AUTH_EXPIRED: ["登录已失效", "去登录"],
  NEEDS_LOGIN: ["登录已失效", "去登录"],
  UNAUTHORIZED: ["认证未通过", "检查认证"],
  ACCESS_DENIED: ["账号或模型访问受限", "检查连接"],
  PLAN_DISABLED: ["当前账号未启用方案额度", "检查账号"],
  LIMIT_REACHED: ["达到用量或请求频率限制", "检查用量 / 连接"],
  INVALID_CONFIG: ["翻译配置不可用", "检查配置"],
  CONFIG_REQUIRED: ["需要配置翻译服务", "检查配置"],
  HOST_UNAVAILABLE: ["本地程序未连接", "检查连接"],
  NATIVE_DISCONNECTED: ["本地程序连接中断", "检查连接"],
  EXTENSION_ERROR: ["扩展连接中断，请刷新页面", "检查连接"],
  PAGE_UNAVAILABLE: ["当前页面暂不支持翻译"],
  PERMISSION_REQUIRED: ["需要网站访问权限", "检查设置"],
  CANCELLED: ["操作已停止"],
  INTERNAL_ERROR: ["操作未完成，请重试"],
};

export function pageError(error: Pick<PublicError, "code">): PublicError {
  const code = Object.hasOwn(reasons, error.code) ? error.code : "INTERNAL_ERROR";
  return { code, message: reasons[code][0] };
}

export function settingsAction(error?: PublicError): string | undefined {
  return error ? reasons[pageError(error).code][1] : undefined;
}

export function pageFeedback(state: PageState) {
  const skipped = state.skipped ?? 0;
  const remaining = Math.max(0, state.total - state.completed - skipped);
  const pending = Math.max(0, remaining - state.failed);
  const error = state.error ? pageError(state.error) : undefined;
  const settings = settingsAction(error);
  const working = state.status === "running";
  const stoppable = state.continuing ?? ["running", "watching", "completed", "partial", "failed"].includes(state.status);
  const problem = !!error || state.failed > 0 || state.status === "paused" || state.status === "error";
  const progress = `已翻译 ${state.completed} / ${state.total} 段${skipped ? ` · ${skipped} 段无需翻译` : ""}${state.failed ? ` · ${state.failed} 段失败` : ""}${pending && !working ? ` · ${pending} 段未完成` : ""}`;
  let message = state.message;
  if (!working && problem) message = `${state.completed ? progress : "尚未译出内容"}${error ? ` · ${error.message}` : ""}`;
  const retryLabel = state.failed && remaining === state.failed
    ? state.completed ? `重试失败的 ${state.failed} 段` : `重试 ${state.failed} 段`
    : remaining ? `继续未完成的 ${remaining} 段` : "重试翻译";
  let primary: PageAction | "settings" = "start";
  let label = "翻译正文";
  if (working) { primary = "stop"; label = "停止翻译"; }
  else if (settings) { primary = "settings"; label = settings; }
  else if (problem || state.status === "stopped" && remaining > 0) { primary = "retry"; label = retryLabel; }
  else if (state.completed > 0) { primary = "restore"; label = "恢复原文"; }
  else if (stoppable) { primary = "stop"; label = "停止持续翻译"; }
  return { message, progress, remaining, problem, primary, label, retryLabel, settings, working, stoppable };
}
