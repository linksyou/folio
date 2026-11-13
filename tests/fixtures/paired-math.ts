// Authored from the sibling structure observed on Wikipedia's Transformer page,
// 2026-11-13. No Wikipedia prose, SVG paths or third-party implementation copied.
export const mathValue = (value: string) => `<math class="mwe-math-element-inline"><msub><mi>d</mi><mtext>${value}</mtext></msub></math>`;
export const renderedMath = '<mjx-container class="MathJax" jax="SVG"><svg aria-hidden="true"><text>RENDER_ONLY_CANARY</text></svg></mjx-container>';
export const lazyMath = '<mjx-container><mjx-lazy data-mjx-lazy="1"></mjx-lazy></mjx-container>';
export const pairedMath = (value: string, style = 'display:none') =>
  `<span class="mwe-math-mathml-a11y" style="${style}">${mathValue(value)}</span>${renderedMath}`;
export const formulaParagraph = (formula = pairedMath) =>
  `The embedding dimension is ${formula('emb')}. The model dimension is ${formula('model')} in this example.`;
export const formulaSource = 'The embedding dimension is demb. The model dimension is dmodel in this example.';
export const formulaMasked = 'The embedding dimension is ⟪FOLIO:0⟫. The model dimension is ⟪FOLIO:1⟫ in this example.';
