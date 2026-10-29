const {server}=await import('../../../../conductor-panel/server/server.js');
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
process.send?.({port:(server.address() as {port:number}).port});
process.on('message',message=>{if(message==='stop')server.close(()=>process.exit(0));});
