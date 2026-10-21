import {
  DEFAULT_TRANSLATION_COLORS,
  DEFAULT_TRANSLATION_STYLE,
  FONT_SCALES,
  STYLE_PRESETS,
  STYLE_STORAGE_KEY,
  normalizeTranslationStyle,
  translationStyleCss,
  type TranslationStyle,
} from "./translation-style.js";

/** Appearance stays in the browser and never participates in a model request. */
export function initializeTranslationStyle(): void {
  const preset = document.getElementById("translation-style-preset") as HTMLSelectElement;
  const fontScale = document.getElementById("translation-font-scale") as HTMLSelectElement;
  const status = document.getElementById("translation-style-status") as HTMLParagraphElement;
  const reset = document.getElementById("translation-style-reset") as HTMLButtonElement;
  const colors = [
    { key: "textColor", id: "translation-text-color" },
    { key: "backgroundColor", id: "translation-background-color" },
  ] as const;
  const colorControls = colors.map(({ key, id }) => ({
    key,
    input: document.getElementById(id) as HTMLInputElement,
    value: document.getElementById(`${id}-value`) as HTMLSpanElement,
    reset: document.getElementById(`${id}-reset`) as HTMLButtonElement,
  }));
  const darkScheme = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : undefined;
  const previewStyle = document.createElement("style");
  previewStyle.id = "translation-style-preview-css";
  document.head.append(previewStyle);
  for (const [value, label] of Object.entries(STYLE_PRESETS)) preset.append(new Option(label, value));
  for (const scale of FONT_SCALES) fontScale.append(new Option(`${Math.round(scale * 100)}%${scale === DEFAULT_TRANSLATION_STYLE.fontScale ? " · 默认大小" : ""}`, String(scale)));

  let revision = 0;
  let currentStyle = normalizeTranslationStyle(DEFAULT_TRANSLATION_STYLE);
  let writing = false;
  let pending: { revision: number; style: TranslationStyle } | undefined;

  function render(style: TranslationStyle): void {
    currentStyle = style;
    preset.value = style.preset;
    fontScale.value = String(style.fontScale);
    previewStyle.textContent = translationStyleCss(style, "#translation-style-preview");
    const defaults = DEFAULT_TRANSLATION_COLORS[darkScheme?.matches ? "dark" : "light"];
    for (const control of colorControls) {
      const custom = style[control.key];
      const isDefault = custom === DEFAULT_TRANSLATION_STYLE[control.key];
      const prefix = isDefault ? "默认 · " : "";
      const fallback = control.key === "backgroundColor" && style.preset !== "background" ? `${prefix}透明`
        : control.key === "textColor" && style.preset === "plain" ? `${prefix}跟随网页`
        : `${prefix}跟随主题\n${defaults[control.key].toUpperCase()}`;
      control.input.value = custom ?? defaults[control.key];
      control.value.textContent = custom ? `${isDefault ? "默认" : "自定义"}\n${custom.toUpperCase()}` : fallback;
      control.reset.disabled = isDefault;
    }
  }

  function showStatus(message: string, failed = false): void {
    status.textContent = message;
    status.classList.toggle("danger-text", failed);
  }

  async function flush(): Promise<void> {
    if (writing) return;
    writing = true;
    // Keep only the newest pending selection while Chrome persists the active write.
    // A color picker can emit many inputs; none can overtake the final choice.
    while (pending) {
      const write = pending;
      pending = undefined;
      try {
        await chrome.storage.local.set({ [STYLE_STORAGE_KEY]: write.style });
        if (write.revision === revision) showStatus("样式已保存");
      } catch {
        if (write.revision === revision) showStatus("样式保存失败，当前仅预览。请重新选择或恢复默认后重试。", true);
      }
    }
    writing = false;
  }

  function save(style: TranslationStyle): void {
    const normalized = normalizeTranslationStyle(style);
    pending = { revision: ++revision, style: normalized };
    render(normalized);
    showStatus("正在保存样式…");
    void flush();
  }

  function changed(): void {
    save(normalizeTranslationStyle({ ...currentStyle, preset: preset.value, fontScale: Number(fontScale.value) }));
  }
  preset.addEventListener("change", changed);
  fontScale.addEventListener("change", changed);
  for (const control of colorControls) {
    const colorChanged = () => save({ ...currentStyle, [control.key]: control.input.value });
    control.input.addEventListener("input", colorChanged);
    control.input.addEventListener("change", colorChanged);
    control.reset.addEventListener("click", () => save({ ...currentStyle, [control.key]: DEFAULT_TRANSLATION_STYLE[control.key] }));
  }
  darkScheme?.addEventListener("change", () => render(currentStyle));
  reset.addEventListener("click", () => save(DEFAULT_TRANSLATION_STYLE));
  render(DEFAULT_TRANSLATION_STYLE);

  const initialRevision = revision;
  void chrome.storage.local.get(STYLE_STORAGE_KEY).then((stored) => {
    if (revision !== initialRevision) return;
    render(normalizeTranslationStyle(stored[STYLE_STORAGE_KEY]));
    showStatus("");
  }).catch(() => {
    if (revision === initialRevision) showStatus("暂时无法读取已保存样式。修改后将重新保存。", true);
  });
}
