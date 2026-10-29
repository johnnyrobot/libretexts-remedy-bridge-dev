import { expect, it } from 'vitest';
import { scanHtmlFull } from '../scan.js';

it('concurrent full scans preserve the same actual axe evidence as serial scans', async () => {
  const html = '<button></button>';
  const baseline = await scanHtmlFull(html);
  expect(baseline.some(f => f.ruleId === 'axe/button-name')).toBe(true);
  const parallel = await Promise.all(Array.from({ length: 6 }, () => scanHtmlFull(html)));
  for (const findings of parallel) expect(findings).toEqual(baseline);
});

it('isolates different documents and preserves pre-existing host globals', async () => {
  const names = ['window', 'document', 'Node', 'Element', 'HTMLElement', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const before = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const inputs = ['<button></button>', '<button>Named</button>', '<input>'];
  const serial = [];
  for (const html of inputs) serial.push(await scanHtmlFull(html));
  expect(await Promise.all(inputs.map(html => scanHtmlFull(html)))).toEqual(serial);
  expect(names.map(name => Object.getOwnPropertyDescriptor(globalThis, name))).toEqual(before);
});
