import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { AppError } from "../shared/errors.js";
import type { PublicSettings, SaveSettings } from "../shared/protocol.js";
import { normalizeReasoningChoice } from "../shared/reasoning.js";
import { isDisplayMode, isTargetLanguage } from "../shared/languages.js";
import { writePrivateJson } from "./files.js";

export interface Settings extends Omit<PublicSettings, "hasApiKey"> {
  apiKey: string;
  revision: string;
}

export function normalizeBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new AppError("INVALID_CONFIG", "请输入完整的 API 基础地址，例如 https://example.com/v1。");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username || url.password || url.search || url.hash) {
    throw new AppError("INVALID_CONFIG", "API 地址须为 HTTPS；本机服务可用 HTTP，地址中不能包含凭证、查询参数或片段。");
  }
  if (/\/(?:chat\/completions|responses)\/?$/.test(url.pathname)) {
    throw new AppError("INVALID_CONFIG", "请填写 API 基础地址（通常以 /v1 结尾），不要包含 /chat/completions。");
  }
  return url.href.replace(/\/+$/, "");
}

export function publicSettings(settings: Settings): PublicSettings {
  const { apiKey, revision: _revision, ...safe } = settings;
  return { ...safe, hasApiKey: apiKey.length > 0 };
}

/** Presentation preferences are readable for migration, but do not identify model work. */
export function sameGenerationSettings(left: Settings, right: Settings): boolean {
  const baseUrl = (value: string) => {
    try { return value.trim() ? normalizeBaseUrl(value.trim()) : ""; }
    catch { return value.trim(); } // A repaired legacy URL still changes identity.
  };
  const values = (settings: Settings) => [
    settings.provider, settings.targetLanguage ?? "zh-CN",
    ...(settings.provider === "chatgpt"
      ? [settings.chatgptModel.trim(), normalizeReasoningChoice(settings.chatgptReasoningEffort)]
      : [baseUrl(settings.customBaseUrl), settings.customModel.trim(), settings.apiKey.trim(), normalizeReasoningChoice(settings.customReasoningEffort)]),
  ];
  return JSON.stringify(values(left)) === JSON.stringify(values(right));
}

export class SettingsStore {
  private readonly file: string;
  constructor(private readonly directory: string) {
    this.file = join(directory, "settings.json");
  }

  async read(): Promise<Settings> {
    try {
      const settings = JSON.parse(await readFile(this.file, "utf8")) as Settings;
      if (!["chatgpt", "custom"].includes(settings.provider) ||
          !["revision", "chatgptModel", "customBaseUrl", "customModel", "apiKey"]
            .every((key) => typeof settings[key as keyof Settings] === "string")) {
        throw new Error("Invalid settings");
      }
      return {
        ...settings,
        targetLanguage: isTargetLanguage(settings.targetLanguage) ? settings.targetLanguage : "zh-CN",
        displayMode: isDisplayMode(settings.displayMode) ? settings.displayMode : "bilingual",
        chatgptReasoningEffort: normalizeReasoningChoice(settings.chatgptReasoningEffort),
        customReasoningEffort: normalizeReasoningChoice(settings.customReasoningEffort),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new AppError("STORAGE_ERROR", "本地配置无法读取，请检查配置文件；原文件已保留。");
      }
      return {
        provider: "chatgpt", chatgptModel: "", customBaseUrl: "https://api.openai.com/v1",
        customModel: "", chatgptReasoningEffort: "auto", customReasoningEffort: "auto",
        targetLanguage: "zh-CN", displayMode: "bilingual",
        apiKey: "", revision: "initial",
      };
    }
  }

  async save(input: SaveSettings): Promise<Settings> {
    if ((input.targetLanguage !== undefined && !isTargetLanguage(input.targetLanguage)) ||
        (input.displayMode !== undefined && !isDisplayMode(input.displayMode))) {
      throw new AppError("INVALID_CONFIG", "请选择支持的目标语言和显示方式。");
    }
    const baseUrl = input.customBaseUrl.trim() ? normalizeBaseUrl(input.customBaseUrl.trim()) : "";
    if (input.provider === "custom" && (!baseUrl || !input.customModel.trim())) {
      throw new AppError("INVALID_CONFIG", "请填写 API 基础地址和模型 ID。");
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.file, {
      realpath: false, // The first save creates the target after acquiring its lock.
      lockfilePath: join(this.directory, ".settings.lock"),
      retries: { retries: 20, minTimeout: 50, maxTimeout: 200 },
    });
    try {
      const previous = await this.read();
      const settings: Settings = {
        provider: input.provider,
        chatgptModel: input.chatgptModel.trim(),
        customBaseUrl: baseUrl,
        customModel: input.customModel.trim(),
        targetLanguage: input.targetLanguage ?? previous.targetLanguage ?? "zh-CN",
        displayMode: input.displayMode ?? previous.displayMode ?? "bilingual",
        chatgptReasoningEffort: normalizeReasoningChoice(
          input.chatgptReasoningEffort ?? previous.chatgptReasoningEffort,
        ),
        customReasoningEffort: normalizeReasoningChoice(
          input.customReasoningEffort ?? previous.customReasoningEffort,
        ),
        apiKey: input.apiKey === undefined ? previous.apiKey : input.apiKey.trim(),
        revision: previous.revision,
      };
      if (!sameGenerationSettings(previous, settings)) settings.revision = randomUUID();
      await writePrivateJson(this.file, settings);
      return settings;
    } finally {
      await release();
    }
  }
}
