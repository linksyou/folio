import { AppError } from "./errors.js";
import { MAX_BATCH_BLOCKS, MAX_BATCH_CHARACTERS, type HostCommand, type TextBlock } from "./protocol.js";
import { isReasoningChoice } from "./reasoning.js";
import { isTargetLanguage, isDisplayMode } from "./languages.js";

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum;
}

export function validateBlocks(value: unknown): asserts value is TextBlock[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BATCH_BLOCKS ||
      !value.every((block) => record(block) && boundedString(block.id, 160) && block.id.length > 0 &&
        boundedString(block.text, MAX_BATCH_CHARACTERS) && block.text.trim().length > 0) ||
      new Set(value.map((block) => block.id)).size !== value.length ||
      value.reduce((sum, block) => sum + block.text.length, 0) > MAX_BATCH_CHARACTERS) {
    throw new AppError("INVALID_REQUEST", "翻译段落格式或长度不符合要求。");
  }
}

export function validateCommand(value: unknown): asserts value is HostCommand {
  const invalid = () => { throw new AppError("INVALID_REQUEST", "无法识别此操作，请更新扩展和本地组件。"); };
  if (!record(value)) return invalid();
  switch (value.type) {
    case "status":
    case "diagnostics.get":
    case "auth.cancel":
    case "auth.logout":
    case "models.list":
    case "connection.prepare":
    case "connection.test":
      return;
    case "auth.login":
      if (value.newAccount !== undefined && typeof value.newAccount !== "boolean") return invalid();
      return;
    case "auth.select":
      if (!boundedString(value.profileId, 160)) return invalid();
      return;
    case "settings.save": {
      const s = value.settings;
      if (!record(s) || !["chatgpt", "custom"].includes(String(s.provider)) ||
          (s.targetLanguage !== undefined && !isTargetLanguage(s.targetLanguage)) ||
          (s.displayMode !== undefined && !isDisplayMode(s.displayMode)) ||
          !boundedString(s.chatgptModel, 200) || !boundedString(s.customModel, 200) ||
          !boundedString(s.customBaseUrl, 2_000) ||
          (s.chatgptReasoningEffort !== undefined && !isReasoningChoice(s.chatgptReasoningEffort)) ||
          (s.customReasoningEffort !== undefined && !isReasoningChoice(s.customReasoningEffort)) ||
          (s.apiKey !== undefined && !boundedString(s.apiKey, 8_000))) return invalid();
      return;
    }
    case "translate":
      if (value.priority !== undefined && !["visible", "prefetch", "background"].includes(String(value.priority))) return invalid();
      if (!boundedString(value.jobId, 160) || !boundedString(value.settingsRevision, 200)) return invalid();
      if (value.batchId !== undefined && (!boundedString(value.batchId, 160) || !value.batchId)) return invalid();
      validateBlocks(value.blocks);
      return;
    case "translate.cancelBatch":
      if (!boundedString(value.jobId, 160) || !value.jobId ||
          !boundedString(value.batchId, 160) || !value.batchId) return invalid();
      return;
    case "translate.cancel":
      if (!boundedString(value.jobId, 160)) return invalid();
      return;
    default:
      return invalid();
  }
}
