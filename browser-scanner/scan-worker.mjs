process.once('disconnect',()=>process.exit(1));
import { scan } from './scan.mjs';
process.once('message', async ({url}) => {
 try {process.send?.({result:await scan(url,pid=>new Promise((resolve,reject)=>{
 const acknowledge=message=>{if(message?.ownership_ack===pid){process.off('message',acknowledge);resolve();}};
 process.on('message',acknowledge);
 process.send?.({browser_owned:pid},error=>{if(error){process.off('message',acknowledge);reject(error);}});
}))});} catch {process.send?.({error:true});}
});
