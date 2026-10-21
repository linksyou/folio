import assert from "node:assert/strict";
import test from "node:test";
import { isAlreadyTargetLanguage } from "../src/extension/page/language.js";
import { LANGUAGES } from "../src/shared/languages.js";
import type { TargetLanguage } from "../src/shared/languages.js";

const simplified = "这是一个用于测试的中文段落，当前页面已经是简体中文，不需要再次翻译。";
const traditional = "這是一個已經完成翻譯的中文段落，可以繼續閱讀原文。";
const english = "This is the article that we are reading, and the page will keep the original text for you.";
const french = "Cette page est déjà dans la langue que nous lisons et les paragraphes sont prêts pour vous.";
const german = "Diese Seite ist bereits in der Sprache, die wir lesen, und die Texte werden für alle angezeigt.";
const spanish = "Esta página es el texto que leemos, y los resultados son para las personas que usan esta aplicación.";

for (const target of Object.keys(LANGUAGES) as TargetLanguage[]) {
  test(`nonlinguistic text can remain unchanged for ${target}`, () => {
    for (const text of ["", "   ", "2026-10-21", "123 / 456 — 78.9%", "🙂 → ✓", "$39.99"]) {
      assert.equal(isAlreadyTargetLanguage(text, target), true, text);
    }
  });
}

test("substantial simplified and traditional Chinese are separated", () => {
  assert.equal(isAlreadyTargetLanguage(simplified, "zh-CN"), true);
  assert.equal(isAlreadyTargetLanguage(simplified, "zh-TW"), false);
  assert.equal(isAlreadyTargetLanguage(traditional, "zh-TW"), true);
  assert.equal(isAlreadyTargetLanguage(traditional, "zh-CN"), false);
  assert.equal(isAlreadyTargetLanguage("这个页面已经有翻譯结果，可以继续阅读。", "zh-CN"), false);
  assert.equal(isAlreadyTargetLanguage("這個段落已經有翻译結果，可以繼續閱讀。", "zh-TW"), false);
});

test("sufficient shared Chinese text can remain unchanged in both Chinese scripts", () => {
  const neutral = "今天是春天的第一天，我和你可以去山中看日出。";
  assert.equal(isAlreadyTargetLanguage(neutral, "zh-CN"), true);
  assert.equal(isAlreadyTargetLanguage(neutral, "zh-TW"), true);
});

test("Chinese unknown characters and ambiguous script conversion remain eligible", () => {
  assert.equal(isAlreadyTargetLanguage("这是一个含有罕见鬱字的中文段落，需要保留翻译。", "zh-CN", "zh-CN"), false);
  assert.equal(isAlreadyTargetLanguage("這是一個含有龘字的中文段落，可以繼續閱讀。", "zh-TW", "zh-TW"), false);
  // 面 can mean a face/surface in both scripts, but also needs 麵 in some words.
  assert.equal(isAlreadyTargetLanguage("今天的面包已经做好了，我们可以一起吃早餐。", "zh-TW"), false);
  assert.equal(isAlreadyTargetLanguage("这个段落已经完成了，我们可以到后面的房间阅读。", "zh-TW"), false);
});

test("Chinese titles and names are not guessed from a lang attribute", () => {
  for (const text of ["中文标题", "王小明", "OpenAI", "東京大学", "山川日月", "AAAAAAAAAAAAAA"]) {
    assert.equal(isAlreadyTargetLanguage(text, "zh-CN", "zh-CN"), false, text);
  }
});

test("mixed Chinese and foreign prose remains eligible even with a Chinese parent", () => {
  assert.equal(isAlreadyTargetLanguage(`${simplified} Read the next paragraph to learn more.`, "zh-CN", "zh-CN"), false);
  assert.equal(isAlreadyTargetLanguage(`Read the original article. ${simplified}`, "zh-CN", "zh-CN"), false);
  assert.equal(isAlreadyTargetLanguage(english, "zh-CN", "zh-CN"), false);
  assert.equal(isAlreadyTargetLanguage("这是一个使用 API 的中文段落，可以继续阅读。", "zh-CN", "zh-CN"), false);
});

test("Japanese kana and Korean Hangul cannot be classified as Chinese", () => {
  const japanese = "これはブラウザーで読むための文章です。すでに日本語になっています。";
  const korean = "이 문장은 한국어로 작성되어 있으며 번역하지 않고 그대로 읽을 수 있습니다.";
  assert.equal(isAlreadyTargetLanguage(japanese, "zh-CN", "zh-CN"), false);
  assert.equal(isAlreadyTargetLanguage(korean, "zh-CN", "zh-CN"), false);
  assert.equal(isAlreadyTargetLanguage(japanese, "ja"), true);
  assert.equal(isAlreadyTargetLanguage(korean, "ko"), true);
  assert.equal(isAlreadyTargetLanguage(`${japanese} 这是一个需要翻译的中文段落。`, "ja", "ja"), false);
  assert.equal(isAlreadyTargetLanguage(japanese, "ko"), false);
  assert.equal(isAlreadyTargetLanguage(korean, "ja"), false);
});

test("Japanese and Korean names, short snippets, and mixed foreign prose are retained", () => {
  assert.equal(isAlreadyTargetLanguage("こんにちは", "ja", "ja"), false);
  assert.equal(isAlreadyTargetLanguage("안녕하세요", "ko", "ko"), false);
  assert.equal(isAlreadyTargetLanguage("これは日本語の文章です。 Please translate this English sentence.", "ja", "ja"), false);
  assert.equal(isAlreadyTargetLanguage("이 문장은 한국어로 작성되어 있습니다. Translate the rest.", "ko", "ko"), false);
  assert.equal(isAlreadyTargetLanguage(simplified, "ja", "ja"), false);
  assert.equal(isAlreadyTargetLanguage("今天是春天的第一天，我和你可以去山中看日出。", "zh-CN", "ja"), false);
});

for (const [target, text] of [["en", english], ["fr", french], ["de", german], ["es", spanish]] as const) {
  test(`Latin ${target} needs both a matching hint and text evidence`, () => {
    assert.equal(isAlreadyTargetLanguage(text, target, target), true);
    assert.equal(isAlreadyTargetLanguage(text, target, ` ${target.toUpperCase()}-Latn `), true);
    assert.equal(isAlreadyTargetLanguage(text, target), false);
    assert.equal(isAlreadyTargetLanguage(text, target, "und"), false);
    assert.equal(isAlreadyTargetLanguage(text, target, "zh-CN"), false);
    assert.equal(isAlreadyTargetLanguage(text, target, `${target}_US`), false);
    assert.equal(isAlreadyTargetLanguage("Open Web Translator", target, target), false);
  });
}

test("a language hint alone cannot suppress another language", () => {
  assert.equal(isAlreadyTargetLanguage(english, "fr", "fr"), false);
  assert.equal(isAlreadyTargetLanguage(french, "en", "en-US"), false);
  assert.equal(isAlreadyTargetLanguage(german, "es", "es"), false);
  assert.equal(isAlreadyTargetLanguage(spanish, "de", "de"), false);
  assert.equal(isAlreadyTargetLanguage(`${english} ${french}`, "en", "en"), false);
  assert.equal(isAlreadyTargetLanguage(`${french} ${spanish}`, "fr", "fr"), false);
  assert.equal(isAlreadyTargetLanguage(`${english} ${simplified}`, "en", "en"), false);
});

test("Unicode normalization supports decomposed accents without guessing unknown scripts", () => {
  assert.equal(isAlreadyTargetLanguage(french.normalize("NFD"), "fr", "fr-CA"), true);
  assert.equal(isAlreadyTargetLanguage("هذا نص طويل بما يكفي للقراءة باللغة العربية على هذه الصفحة.", "en", "en"), false);
  assert.equal(isAlreadyTargetLanguage("Это предложение написано на русском языке и содержит достаточно слов.", "en", "en"), false);
  assert.equal(isAlreadyTargetLanguage("the and this the and this the and this", "en", "en"), false);
});
