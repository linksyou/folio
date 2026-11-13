import assert from "node:assert/strict";
import { test } from "node:test";
import { sameGenerationSettings, type Settings } from "../src/host/settings.js";

const settings: Settings = {
  provider: "custom", revision: "initial", apiKey: "fixture", customModel: "local",
  customBaseUrl: "http://localhost:1234/v1", chatgptModel: "other", targetLanguage: "zh-CN",
};

test("only active generation settings invalidate translation identity", () => {
  for (const change of [{ chatgptModel: "unused" }, { chatgptReasoningEffort: "high" as const },
    { displayMode: "translation-only" as const }, { customBaseUrl: "http://localhost:1234/v1/" }]) {
    assert.equal(sameGenerationSettings(settings, { ...settings, ...change }), true);
  }
  for (const change of [{ apiKey: "next" }, { customModel: "next" }, { targetLanguage: "en" as const },
    { provider: "chatgpt" as const }, { customReasoningEffort: "high" as const }]) {
    assert.equal(sameGenerationSettings(settings, { ...settings, ...change }), false);
  }
  const chatgpt = { ...settings, provider: "chatgpt" as const };
  assert.equal(sameGenerationSettings(chatgpt, { ...chatgpt, apiKey: "unused", customModel: "unused" }), true);
  assert.equal(sameGenerationSettings(chatgpt, { ...chatgpt, chatgptModel: "next" }), false);
});
