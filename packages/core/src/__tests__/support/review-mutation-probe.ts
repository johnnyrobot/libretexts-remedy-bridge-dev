import { writePageRevision, fixPage, runPipeline, revertPage, writePageTags, revertPageTags, restoreTagsFromManifest } from '../../index.js';
import { SignedWriter } from '../../../../conductor-panel/server/signed-writer.js';
process.env.REMEDY_BRIDGE_PROFILE = 'full-write';
process.env.NODE_ENV = 'development';
const env = {...process.env,REMEDY_BRIDGE_PROFILE:'full-write',NODE_ENV:'test'};
let reads=0;
const read=async()=>{reads++;throw Error('unexpected read');};
const expert={pages:{getPageInfo:read,getPageContents:read,getPageTags:read,postPageContents:read,putPageTags:read}} as any;
const page={id:1,path:'Sandboxes/johnnyphung/Page',hostname:'dev.libretexts.org'};
const calls=[
 ()=>writePageRevision({expert,env,page,pageInput:1,beforeHtml:'same',afterHtml:'same',rules:[],revisionSummary:'test',source:'fix'}),
 ()=>fixPage(1,{expert,env,mode:'apply'}),()=>runPipeline(1,{expert,env,mode:'apply'}),()=>revertPage(1,{expert,env}),
 ()=>writePageTags({expert,env,page,tags:[]}),()=>revertPageTags({expert,env,snapshotPath:'/nonexistent'}),
 ()=>restoreTagsFromManifest({pages:[],generatedAt:'synthetic'} as any,{expert,env}),()=>SignedWriter.open({} as any,env),
];
const errors=[];
for(const call of calls){try{await call();errors.push('allowed');}catch(error){errors.push((error as Error).name);}}
process.stdout.write(JSON.stringify({errors,reads}));
