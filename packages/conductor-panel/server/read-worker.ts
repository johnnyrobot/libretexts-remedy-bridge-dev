process.once('disconnect',()=>process.exit(1));
import { requestBudget } from '../../../tools/request-policy.cjs';
import { isCxoneReadAuthFailure } from '@libretexts/remedy-core';
import { CapacityError } from './preview-cache.js';
import sharp from 'sharp';
sharp.concurrency(1); sharp.cache(false);
process.once('message', async payload => {
  const signal = AbortSignal.timeout(300000);
  try {
    const { executeReadRoute } = await import('./server.js');
    const value = await requestBudget.run({signal,mutation:false},()=>executeReadRoute(payload as any));
    if (Buffer.byteLength(JSON.stringify(value)) > 32*1024*1024) throw new Error('response_too_large');
    process.send?.({ok:true,value});
  } catch(error) {
    const e = error as any;
    process.send?.({ok:false,status:e.name === 'ScanEngineError' ? 503 : e.status??503,
      failureKind: signal.aborted ? 'cancelled' : error instanceof CapacityError ? 'capacity' : isCxoneReadAuthFailure(error) ? 'dependency_auth' : undefined,
      body:e.name === 'ScanEngineError' ? {error:'scan_engine_failed',evidence_usable:false} : e.body??{error:'work_failed',evidence_usable:false}});
  }
});
