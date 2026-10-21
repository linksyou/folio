/** Local presentation preferences. They never enter prompts or translation cache keys. */
export const STYLE_STORAGE_KEY = "translationAppearance";
export const STYLE_PRESETS = {
  border: "侧边线",
  background: "淡色背景",
  underline: "下划线",
  plain: "纯文本",
} as const;
export const FONT_SCALES = [0.9, 1, 1.1, 1.25] as const;
export const DEFAULT_TRANSLATION_COLORS = {
  light: { textColor: "#315f49", backgroundColor: "#eef7f1" },
  dark: { textColor: "#a6d8bb", backgroundColor: "#243b30" },
} as const;

export interface TranslationStyle {
  preset: keyof typeof STYLE_PRESETS;
  fontScale: typeof FONT_SCALES[number];
  /** Omitted colors follow the preset and the light/dark theme. */
  textColor?: string;
  backgroundColor?: string;
}

export const DEFAULT_TRANSLATION_STYLE: Readonly<TranslationStyle> = {
  preset: "plain", fontScale: 1, textColor: "#4a9834",
};

export function normalizeHexColor(value: unknown): string | undefined {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : undefined;
}

/** Storage may contain old or malformed values; only enumerated CSS choices survive. */
export function normalizeTranslationStyle(value: unknown): TranslationStyle {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_TRANSLATION_STYLE };
  const input = value as Record<string, unknown>;
  const textColor = normalizeHexColor(input.textColor);
  const backgroundColor = normalizeHexColor(input.backgroundColor);
  return {
    preset: typeof input.preset === "string" && Object.hasOwn(STYLE_PRESETS, input.preset)
      ? input.preset as TranslationStyle["preset"] : DEFAULT_TRANSLATION_STYLE.preset,
    fontScale: FONT_SCALES.includes(input.fontScale as TranslationStyle["fontScale"])
      ? input.fontScale as TranslationStyle["fontScale"] : DEFAULT_TRANSLATION_STYLE.fontScale,
    ...(textColor ? { textColor } : {}),
    ...(backgroundColor ? { backgroundColor } : {}),
  };
}

/** Selector is a fixed application-owned selector, never a value read from storage. */
export function translationStyleCss(
  value: TranslationStyle,
  selector = '.open-web-translator-translation[data-open-web-translator="translation"]',
): string {
  const style = normalizeTranslationStyle(value);
  const decoration: Record<TranslationStyle["preset"], string> = {
    border: "padding-inline-start: .7em; border-inline-start: 2px solid var(--owt-accent);",
    background: "padding: .55em .75em; border-radius: .4em; background-color: var(--owt-background);",
    underline: "text-decoration: underline; text-decoration-color: var(--owt-accent); text-decoration-thickness: 1px; text-underline-offset: .22em;",
    plain: "color: inherit;",
  };
  return `
    ${selector} {
      --owt-accent: #5e9b7b;
      --owt-text: ${style.textColor ?? DEFAULT_TRANSLATION_COLORS.light.textColor};
      --owt-background: ${style.backgroundColor ?? DEFAULT_TRANSLATION_COLORS.light.backgroundColor};
      box-sizing: border-box;
      display: block;
      margin-block: .35em .8em;
      padding: 0;
      border: 0;
      border-radius: 0;
      background: transparent;
      color: var(--owt-text);
      font: inherit;
      font-size: ${Math.round(style.fontScale * 100)}%;
      line-height: inherit;
      text-decoration: none;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      ${decoration[style.preset]}
      ${style.backgroundColor ? "background-color: var(--owt-background); padding: .55em .75em; border-radius: .4em;" : ""}
      ${style.textColor ? "color: var(--owt-text);" : ""}
    }
    ${selector}[aria-busy="true"] { opacity: .8; }
    @media (prefers-color-scheme: dark) {
      ${selector} {
        --owt-accent: #64a982;
        --owt-text: ${style.textColor ?? DEFAULT_TRANSLATION_COLORS.dark.textColor};
        --owt-background: ${style.backgroundColor ?? DEFAULT_TRANSLATION_COLORS.dark.backgroundColor};
      }
    }
  `;
}
