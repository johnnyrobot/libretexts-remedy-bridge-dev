import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { chromium } from 'playwright';
import axe from 'axe-core';
import { pageURL, allowedRequest, publicIPv4 } from './policy.mjs';
import { captureResourceResponse } from './resource-evidence.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const hosts = new Set((process.env.RENDER_ALLOWED_HOSTS || 'dev.libretexts.org,cdn.libretexts.net,cdn.jsdelivr.net,cdnjs.cloudflare.com,fonts.googleapis.com,fonts.gstatic.com,use.fontawesome.com,bio.libretexts.org,files.mtstatic.com,commons.libretexts.org,test.libretexts.org,www.myopenmath.com,hypothes.is,cdn.hypothes.is,static.cloudflareinsights.com,staging-chatbot.libretexts.org,staging.traffic.libretexts.org').split(',').map(s=>s.trim()));
export async function scan(raw) {
  const url = pageURL(raw);
  // Pin approved public DNS answers for the lifetime of this browser; no private-network access.
  const rules = [];
  if(hosts.size>64)throw Error('Resource host limit exceeded.');
  for (const host of hosts) {
    const addresses = await lookup(host, { all: true, family: 4 });
    if (!addresses.length || addresses.some(a => !publicIPv4(a.address))) throw Error('Non-public resource host.');
    rules.push(`MAP ${host} ${addresses[0].address}`);
  }
  const browser = await chromium.launch({ chromiumSandbox: true, args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp', `--host-resolver-rules=${rules.join(',')},MAP * ~NOTFOUND`] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent: 'LibreTexts-Remedy-Accessibility/1.0', serviceWorkers: 'block', acceptDownloads: false });
  const blocked = new Set(), blockedWrites = new Set(), blockedSockets = new Set(), failed = new Set(), assets = new Map(), pending = [];
  await context.routeWebSocket('**/*', socket => {blockedSockets.add(socket.url());socket.close();});
  await context.route('**/*', route => {
    const req = route.request();
    if(pending.length>=256){void context.close();return route.abort();}
    if (!['GET','HEAD'].includes(req.method())) { blockedWrites.add(req.url().split('?')[0]); return route.abort(); }
    if (!allowedRequest(req.url(), hosts, req.method())) { blocked.add(req.url().split('?')[0]); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  const deadline = setTimeout(()=>{void context.close().catch(()=>{});},110000);
  page.on('requestfailed', req => { if (['GET','HEAD'].includes(req.method()) && ['document','script','stylesheet','font','image','xhr','fetch'].includes(req.resourceType())) failed.add(req.url().split('?')[0]); });
  page.on('response', response => pending.push(captureResourceResponse(response, assets, failed)));
  try {
    const response = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    if (!response?.ok() || decodeURIComponent(new URL(pageURL(page.url())).pathname) !== decodeURIComponent(new URL(url).pathname)) throw Error(`Reader page unavailable or redirected (HTTP ${response?.status()}, path ${new URL(page.url()).pathname}; ${(await page.locator('body').innerText()).slice(0,600)}).`);
    if(Buffer.byteLength(await page.content())>8*1024*1024)throw Error('Reader page exceeds source limit.');
    const content = page.locator('section.mt-content-container');
    if (!await content.count() || (await content.innerText()).trim().length < 20) throw Error('Reader content not available without authentication.');
    // MathJax v2 queue and v3/v4 startup promise. Timeout is an incomplete scan, never a pass.
    const readinessErrors = [];
    const math = await Promise.race([page.evaluate(async () => {
      const m = window.MathJax;
      if (m?.Hub?.Queue) await new Promise(resolve => m.Hub.Queue(resolve));
      else if (m?.startup?.promise) await m.startup.promise;
      await document.fonts.ready;
      const raw = document.querySelectorAll('script[type^="math/tex"], .lt-math');
      const rendered = document.querySelectorAll('math, mjx-container, .MathJax');
      if (raw.length && !rendered.length) throw Error('MathJax did not render math.');
      if (document.querySelector('.MathJax_Error, mjx-merror, [data-mjx-error]')) throw Error('MathJax reported a rendering error.');
      return { ready:true, initializerCount:document.querySelectorAll('script#mathjax-script').length, version: m?.version || null, mathCount: rendered.length,
        mathSamples: [...document.querySelectorAll('math')].slice(0,10).map(x=>x.outerHTML.slice(0,3000)) };
    }), new Promise((_,reject)=>setTimeout(()=>reject(Error('MathJax readiness timeout.')),30000))]).catch(e=>{readinessErrors.push(e.message);return {ready:false};});
    // Exercise native lazy loading without changing authored attributes or styles.
    await page.evaluate(async()=>{
      const max=Math.min(document.documentElement.scrollHeight,100000);
      for(let y=0;y<max;y+=800){window.scrollTo(0,y);await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));}
      window.scrollTo(0,0);
      await Promise.all([...document.images].filter(i=>i.currentSrc || i.src).map(i=>i.decode().catch(()=>{})));
    });
    const brokenImages=await page.evaluate(()=>[...document.images].filter(i=>(i.currentSrc || i.src)&&(!i.complete || !i.naturalWidth)).map(i=>i.currentSrc || i.src));
    brokenImages.forEach(url=>failed.add(url));
    await page.addScriptTag({ content: axe.source });
    const results = await page.evaluate(async () => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21a','wcag21aa'] } }));
    const sourceCoverage = await page.evaluate(async () => window.axe.run(document, {runOnly:{type:'rule',values:['table-duplicate-name']}}));
    await Promise.allSettled(pending);
    const renderedHash = hash(await content.innerHTML());
    const shell = await page.evaluate(() => { const root = document.documentElement.cloneNode(true); root.querySelector('section.mt-content-container')?.replaceChildren(); return root.outerHTML; });
    const platformHash = hash(JSON.stringify([shell, [...assets.entries()].sort()]));
    const compact = r => ({ id:r.id, impact:r.impact, description:r.description, helpUrl:r.helpUrl, tags:r.tags,
      nodes:r.nodes.map(n=>({ target:n.target, html:n.html, failureSummary:n.failureSummary,
        checks:[...n.any,...n.all,...n.none].map(c=>({id:c.id,message:c.message})) })) });
    return { state: blocked.size || failed.size || readinessErrors.length ? 'incomplete' : 'complete', scannedAt:new Date().toISOString(),
      url, userAgent:'LibreTexts-Remedy-Accessibility/1.0', scope:'full-reader-page', viewport:{width:1280,height:900}, browser:browser.version(), axeVersion:axe.version,
      renderedHash, platformHash, math, readinessErrors, blockedWrites:[...blockedWrites], blockedSockets:[...blockedSockets], blockedResources:[...blocked], failedResources:[...failed],
      violations:results.violations.map(compact), incomplete:[...results.incomplete,...sourceCoverage.incomplete,...sourceCoverage.violations].map(compact),
      sourceRuleChecks:{rule:'table-duplicate-name',violations:sourceCoverage.violations.map(compact),incomplete:sourceCoverage.incomplete.map(compact)},
      passedRules:[...results.passes,...sourceCoverage.passes].map(r=>r.id), inapplicableRules:[...results.inapplicable,...sourceCoverage.inapplicable].map(r=>r.id),
      humanChecksRequired:['Mathematical meaning and navigation with screen reader','No duplicate math announcements','Keyboard and complete processes','Reflow, zoom and text spacing','Visual and linguistic review'] };
  } catch (e) { return {state:'error',scannedAt:new Date().toISOString(),url,error:e.message,mathDiagnostics:await page.evaluate(()=>({version:window.MathJax?.version,pending:window.MathJax?.Hub?.queue?.pending,running:window.MathJax?.Hub?.queue?.running,queueLength:window.MathJax?.Hub?.queue?.queue?.length,fonts:document.fonts.status,mathCount:document.querySelectorAll('math,mjx-container,.MathJax').length})).catch(()=>null),blockedResources:[...blocked],failedResources:[...failed]}; }
  finally { clearTimeout(deadline); await context.close(); await browser.close(); }
}
