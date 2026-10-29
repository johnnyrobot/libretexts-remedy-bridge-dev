process.once('disconnect',()=>process.exit(1));
import { requestBudget } from '../../../tools/request-policy.cjs';
import sharp from 'sharp';
sharp.concurrency(1); sharp.cache(false);
process.once('message', async payload => {
  try {
    const { executeReadRoute } = await import('./server.js');
    const signal = AbortSignal.timeout(300000);
    const value = await requestBudget.run({signal,mutation:false},()=>executeReadRoute(payload as any));
    if (Buffer.byteLength(JSON.stringify(value)) > 32*1024*1024) throw new Error('response_too_large');
    process.send?.({ok:true,value});
  } catch(error) {
    const e = error as any;
    process.send?.({ok:false,status:e.name === 'ScanEngineError' ? 503 : e.status??503,
      body:e.name === 'ScanEngineError' ? {error:'scan_engine_failed',evidence_usable:false} : e.body??{error:'work_failed',evidence_usable:false}});
  }
});
