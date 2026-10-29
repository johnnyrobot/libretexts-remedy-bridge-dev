import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';

// SDK 1.7.0 omits the charset on page-content POSTs. CXone's documented
// text/plain contract requires UTF-8 for non-ASCII descriptions and math.
// Mutation redirects can resend reviewed content; reject them and bound the single request.
// Keep this compatibility patch narrow and fail closed on SDK layout changes.
const require = createRequire(import.meta.url);
const dist = dirname(require.resolve('@libretexts/cxone-expert-node'));
const axiosMetadata = JSON.parse(await readFile(require.resolve('axios/package.json'), 'utf8'));
if (axiosMetadata.version !== '1.21.0') throw new Error('Review the pinned CXone Axios transport before changing versions.');
const axiosEntry = './' + relative(dist, require.resolve('axios')).replaceAll('\\', '/');
const metadata = JSON.parse(await readFile(join(dist, '..', 'package.json'), 'utf8'));
if (metadata.version !== '1.7.0') throw new Error('Review the CXone UTF-8 compatibility patch before changing SDK versions.');
for (const file of ['index.mjs', 'index.cjs']) {
  const path = join(dist, file);
  let source = await readFile(path, 'utf8');
  // SDK1.7 bundles Axios1.18 even when npm's external dependency is overridden.
  // Route BOTH request-instance creation sites to the supported external build.
  // Preserve its original fetch-adapter behavior and all SDK error translation.
  const transportImport = file.endsWith('.mjs') ? `import remedyPatchedAxios from ${JSON.stringify(axiosEntry)};\n` : `var remedyPatchedAxios=require(${JSON.stringify(axiosEntry)});\n`;
  if (source.includes('remedyPatchedAxios') && !source.startsWith(transportImport)) {
    const old = /^(?:import remedyPatchedAxios from [^;]+;|var remedyPatchedAxios=require\([^;]+\);)\n/;
    if (!old.test(source)) throw new Error('Unexpected patched Axios import layout.');
    source = source.replace(old, transportImport);
    await writeFile(path, source);
  }
  if (!source.includes('remedyPatchedAxios')) {
    const sites = [...source.matchAll(/axiosInstance\s*=\s*([A-Za-z_$]\w*)\.create\(/g)];
    if (sites.length !== 2 || sites[0][1] !== sites[1][1]) throw new Error('Unexpected CXone bundled Axios request layout.');
    source = source.replace(/axiosInstance\s*=\s*[A-Za-z_$]\w*\.create\(\)/g, 'axiosInstance=remedyPatchedAxios.create({adapter:"fetch"})');
    source = source.replace(/axiosInstance\s*=\s*[A-Za-z_$]\w*\.create\(\{/g, 'axiosInstance=remedyPatchedAxios.create({adapter:"fetch",');
    source = transportImport + source;
    if ([...source.matchAll(/axiosInstance=remedyPatchedAxios\.create/g)].length !== 2) throw new Error('Failed to replace CXone Axios request sites.');
    await writeFile(path, source);
  }
  if ([...source.matchAll(/axiosInstance=remedyPatchedAxios\.create/g)].length !== 2 || /axiosInstance\s*=\s*Q\.create/.test(source)) throw new Error('Unexpected patched Axios request sites.');
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
