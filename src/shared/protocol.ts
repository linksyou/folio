/** Wire types shared by the extension and the local host. No credentials in replies. */
import type { TargetLanguage, DisplayMode } from "./languages.js";
export const HOST_NAME = "org.folio.host";
export const PROTOCOL_VERSION = 1;
/** Bump when translation instructions or placeholder semantics change. */
export const TRANSLATION_PROMPT_VERSION = "2";
export const MAX_BATCH_CHARACTERS = 4_000;
export const MAX_BATCH_BLOCKS = 5;

export interface TextBlock {
  id: string;
  text: string;
}

export interface Translation {
  id: string;
  text: string;
}

export type TranslationPriority = "visible" | "prefetch" | "background";

export interface Profile {
  id: string;
  label: string;
  email?: string;
}

export interface AuthStatus {
  state: "signed_out" | "signed_in" | "needs_login";
  profile?: Profile;
  profiles: Profile[];
  planEnabled: boolean;
}

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type ReasoningChoice = "auto" | ReasoningEffort;

export interface PublicSettings {
  targetLanguage?: TargetLanguage;
  displayMode?: DisplayMode;
  provider: "chatgpt" | "custom";
  chatgptModel: string;
  customBaseUrl: string;
  customModel: string;
  chatgptReasoningEffort?: ReasoningChoice;
  customReasoningEffort?: ReasoningChoice;
  hasApiKey: boolean;
}

export interface SaveSettings {
  targetLanguage?: TargetLanguage;
  displayMode?: DisplayMode;
  provider: "chatgpt" | "custom";
  chatgptModel: string;
  customBaseUrl: string;
  customModel: string;
  chatgptReasoningEffort?: ReasoningChoice;
  customReasoningEffort?: ReasoningChoice;
  /** Omitted means keep the saved key. An empty string explicitly removes it. */
  apiKey?: string;
}

export interface HostStatus {
  protocolVersion: number;
  settings: PublicSettings;
  settingsRevision: string;
  auth: AuthStatus;
}

/** Transport readiness only; does not validate credentials or call a model. */
export interface ConnectionPreparation {
  ready: boolean;
}

export interface Model {
  id: string;
  name: string;
  reasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
}

export type HostCommand =
  | { type: "status" }
  | { type: "diagnostics.get" }
  | { type: "settings.save"; settings: SaveSettings }
  | { type: "auth.login"; newAccount?: boolean }
  | { type: "auth.cancel" }
  | { type: "auth.logout" }
  | { type: "auth.select"; profileId: string }
  | { type: "models.list" }
  | { type: "connection.prepare" }
  | { type: "connection.test" }
  | { type: "translate"; jobId: string; batchId?: string; settingsRevision: string; blocks: TextBlock[]; priority?: TranslationPriority }
  | { type: "translate.cancel"; jobId: string }
  | { type: "translate.cancelBatch"; jobId: string; batchId: string };

export interface PublicError {
  code: string;
  message: string;
}

export type Result<T> = { ok: true; result: T } | { ok: false; error: PublicError };
export interface NativeRequest {
  id: string;
  command: HostCommand;
}
export type NativeReply = Result<unknown> & { id: string };
/** Cumulative provisional text; the final NativeReply still decides success. */
export interface NativeProgress {
  id: string;
  event: "translation.progress";
  translations: Translation[];
}
export type NativeMessage = NativeReply | NativeProgress;

export type PageAction = "start" | "retry" | "retranslate" | "stop" | "restore" | "status";
export interface PageState {
  /** Source already matches the target; no model output was generated. */
  skipped?: number;
  status: "idle" | "running" | "watching" | "paused" | "completed" | "stopped" | "error";
  total: number;
  completed: number;
  failed: number;
  message: string;
}

export interface PageCommand {
  displayMode?: DisplayMode;
  targetLanguage?: TargetLanguage;
  clickedAtEpochMs?: number;
  type: "page.command";
  action: PageAction;
  jobId?: string;
  settingsRevision?: string;
}

export interface PageProgress {
  type: "translate.progress";
  jobId: string;
  batchId: string;
  translations: Translation[];
}

export type ExtensionRequest =
  | { type: "cache.status" }
  | { type: "cache.set"; enabled: boolean }
  | { type: "cache.clear"; origin?: string }
  | { type: "site.status" }
  | { type: "site.set"; origin: string; enabled: boolean }
  | { type: "page.ready"; restored?: boolean }
  | { type: "page.navigate"; url: string; navigationId: number }
  | { type: "diagnostics.get" }
  | { type: "host.request"; command: HostCommand }
  | { type: "page.action"; action: PageAction; clickedAtEpochMs?: number }
  /** Content controls can only operate their own top-level document. */
  | { type: "page.control"; action: PageAction; clickedAtEpochMs?: number }
  | { type: "page.openSettings" }
  | { type: "translate.batch"; jobId: string; batchId?: string; settingsRevision: string; blocks: TextBlock[]; priority?: TranslationPriority; anchorFragment?: boolean }
  | { type: "translate.cancel"; jobId: string }
  | { type: "translate.cancelBatch"; jobId: string; batchId: string };
