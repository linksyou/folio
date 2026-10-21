import type { Model, ReasoningChoice, ReasoningEffort } from "./protocol.js";

/** `ultra` is retained for forward-compatible UI/catalog data, but is not in current API docs. */
export const REASONING_EFFORTS = [
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
] as const satisfies readonly ReasoningEffort[];
export const REASONING_CHOICES = ["auto", ...REASONING_EFFORTS] as const satisfies readonly ReasoningChoice[];

export const REASONING_LABELS: Readonly<Record<ReasoningChoice, string>> = {
  auto: "自动（速度优先）",
  none: "无推理（最快）",
  minimal: "极少",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
  ultra: "超高",
};

const choiceSet = new Set<string>(REASONING_CHOICES);
const speedOrder = new Map<ReasoningEffort, number>(REASONING_EFFORTS.map((effort, index) => [effort, index]));

export function isReasoningChoice(value: unknown): value is ReasoningChoice {
  return typeof value === "string" && choiceSet.has(value);
}

export function normalizeReasoningChoice(value: unknown): ReasoningChoice {
  return isReasoningChoice(value) ? value : "auto";
}

export function reasoningChoicesForModel(model?: Model): ReasoningChoice[] {
  if (!model?.reasoningEfforts?.length) return ["auto"];
  return ["auto", ...[...new Set(model.reasoningEfforts)].sort(
    (left, right) => speedOrder.get(left)! - speedOrder.get(right)!,
  )];
}

export function resolveReasoningEffort(
  choice: ReasoningChoice | undefined,
  model?: Model,
): ReasoningEffort | undefined {
  const normalized = normalizeReasoningChoice(choice);
  if (normalized !== "auto") return normalized;
  return reasoningChoicesForModel(model).find((item): item is ReasoningEffort => item !== "auto");
}

const GPT_6_FULL: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
const GPT_6_FAST: ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];

/**
 * Finite, exact-slug fallbacks; unknown slugs stay unknown.
 * Source: https://developers.openai.com/api/docs/guides/deployment-checklist
 * Recheck model support before adding a slug; do not infer it from name prefixes.
 */
export function reasoningMetadataForModel(
  modelId: string,
): Pick<Model, "reasoningEfforts" | "defaultReasoningEffort"> {
  if (modelId === "gpt-6-astra" || modelId === "gpt-6.1-sol") {
    return { reasoningEfforts: [...GPT_6_FULL], defaultReasoningEffort: "medium" };
  }
  if (modelId === "gpt-6-sol" || modelId === "gpt-6-luna") {
    return { reasoningEfforts: [...GPT_6_FAST], defaultReasoningEffort: "medium" };
  }
  return {};
}
