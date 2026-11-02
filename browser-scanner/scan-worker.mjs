import {provisionPublicCA} from './public-ca.mjs';
process.once('disconnect',()=>process.exit(1));
import { scan } from './scan.mjs';
// Resolve installed Playwright browser provenance before isolating Chromium's HOME.
process.env.HOME=process.env.RENDER_JOB_HOME;
process.env.XDG_CACHE_HOME=process.env.RENDER_JOB_HOME+'/cache';
process.env.XDG_CONFIG_HOME=process.env.RENDER_JOB_HOME+'/config';
process.once('message', async ({url,publicCASha256}) => {
 try {await provisionPublicCA(publicCASha256,process.env.RENDER_JOB_HOME);process.send?.({result:await scan(url,pid=>new Promise((resolve,reject)=>{
 const acknowledge=message=>{if(message?.ownership_ack===pid){process.off('message',acknowledge);resolve();}};
 process.on('message',acknowledge);
 process.send?.({browser_owned:pid},error=>{if(error){process.off('message',acknowledge);reject(error);}});
}))});} catch {process.send?.({error:true});}
});
