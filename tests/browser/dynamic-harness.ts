import { PageTranslator } from '../../src/extension/page/PageTranslator.js';

export async function measureDynamic(): Promise<Record<string, number | boolean>> {
  // Already-target-language text isolates discovery from provider/render work.
  const prose = '这是一个中文文章的正文，我们已经可以在网页上阅读这些内容。'.repeat(4);
  document.documentElement.lang = 'zh-CN';
  document.body.innerHTML = `<main>${Array.from({ length: 1000 }, () => `<p>${prose}</p>`).join('')}</main>`;
  let calls = 0;
  const engine = new PageTranslator(document, {
    async translate() { calls++; throw new Error('This fixture should not call a provider'); },
    async cancel() {},
  });
  try {
    engine.handle('start', 'dynamic-benchmark', 'r1');
    await engine.whenIdle();
    document.querySelector('p')!.firstChild!.textContent = `更新后的段落。${prose}`;
    await engine.whenIdle();
    const event = engine.getDiagnostics().filter(event => event.stage === 'extraction.dynamic').at(-1);
    if (!event || engine.getState().total !== 1000 || calls) throw new Error('Dynamic benchmark lost scope or dispatched a provider');
    return { ...event.values, providerCalls: calls };
  } finally { engine.dispose(); }
}

declare global { interface Window { measureDynamic: typeof measureDynamic } }
window.measureDynamic = measureDynamic;
