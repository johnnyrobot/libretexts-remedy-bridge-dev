import sharp from 'sharp';
sharp.concurrency(1);sharp.cache(false);
process.once('message',async(payload:{url:string})=>{
 const encoded=await sharp({create:{width:6000,height:6000,channels:3,background:'green'}}).png().toBuffer();
 // Start real native decode/transform work before notifying the external observer.
 const decoding=sharp(encoded,{limitInputPixels:40000000}).rotate(90).blur(20).png().toBuffer();
 await fetch(payload.url,{method:'POST',body:JSON.stringify({pid:process.pid})});
 await decoding;
 await fetch(payload.url+'/late',{method:'POST',body:'completed'});
 process.send?.({ok:true,value:'completed'});
});
