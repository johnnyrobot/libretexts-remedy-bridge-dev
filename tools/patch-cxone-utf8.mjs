import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// SDK 1.7.0 omits the charset on page-content POSTs. CXone's documented
// text/plain contract requires UTF-8 for non-ASCII descriptions and math.
// Mutation redirects can resend reviewed content; reject them and bound the single request.
// Keep this compatibility patch narrow and fail closed on SDK layout changes.
const require = createRequire(import.meta.url);
const dist = dirname(require.resolve('@libretexts/cxone-expert-node'));
const metadata = JSON.parse(await readFile(join(dist, '..', 'package.json'), 'utf8'));
if (metadata.version !== '1.7.0') throw new Error('Review the CXone UTF-8 compatibility patch before changing SDK versions.');
for (const file of ['index.mjs', 'index.cjs']) {
  const path = join(dist, file), source = await readFile(path, 'utf8');
  const start = source.indexOf('async postPageContents('), end = source.indexOf('async putPageUnorder(', start);
  if (start < 0 || end < start) throw new Error('Unexpected CXone page writer layout.');
  const method = source.slice(start, end);
  let patched = method;
  if (!patched.includes('text/plain; charset=utf-8')) {
    const matches = [...patched.matchAll(/(["`])text\/plain\1/g)];
    if (matches.length !== 1) throw new Error('Unexpected CXone page writer content type.');
    patched = patched.replace(/(["`])text\/plain\1/, '$1text/plain; charset=utf-8$1');
  }
  const policy = 'fetchOptions:{redirect:"error"},maxRedirects:0,timeout:30000,';
  if (!patched.includes(policy)) {
    if (patched.includes('fetchOptions') || [...patched.matchAll(/headers:\s*\{/g)].length !== 1) throw new Error('Unexpected CXone mutation transport layout.');
    patched = patched.replace(/headers:\s*\{/, policy + 'headers:{');
  }
  if (patched !== method) await writeFile(path, source.slice(0, start) + patched + source.slice(end));
}
