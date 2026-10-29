process.once('disconnect',()=>process.exit(1));
import { scan } from './scan.mjs';
process.once('message', async ({url}) => {
 try {process.send?.({result:await scan(url)});} catch {process.send?.({error:true});}
});
