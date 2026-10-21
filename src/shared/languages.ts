export const LANGUAGES = {
  "zh-CN": { label: "简体中文", prompt: "Simplified Chinese" },
  "zh-TW": { label: "繁體中文", prompt: "Traditional Chinese" },
  en: { label: "English", prompt: "English" },
  ja: { label: "日本語", prompt: "Japanese" },
  ko: { label: "한국어", prompt: "Korean" },
  fr: { label: "Français", prompt: "French" },
  de: { label: "Deutsch", prompt: "German" },
  es: { label: "Español", prompt: "Spanish" },
} as const;
export type TargetLanguage = keyof typeof LANGUAGES;
export type DisplayMode = "bilingual" | "translation-only";
export const isTargetLanguage = (value: unknown): value is TargetLanguage => typeof value === "string" && Object.hasOwn(LANGUAGES, value);
export const isDisplayMode = (value: unknown): value is DisplayMode => value === "bilingual" || value === "translation-only";
