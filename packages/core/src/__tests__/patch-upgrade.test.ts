import {expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,copyFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
it('upgrades an already-routed SDK in both formats and is idempotent',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sdk-upgrade-')),sdk=join(root,'node_modules/@libretexts/cxone-expert-node');
 await mkdir(join(root,'tools'),{recursive:true});await mkdir(join(sdk,'dist'),{recursive:true});
 const require=createRequire(import.meta.url);await symlink(dirname(require.resolve('axios/package.json')),join(root,'node_modules/axios'),'dir');
 await writeFile(join(sdk,'package.json'),JSON.stringify({name:'@libretexts/cxone-expert-node',version:'1.7.0',main:'dist/index.cjs'}));
 const factory='class Example {axiosInstance=remedyPatchedAxios.create({adapter:"fetch",adapter:"fetch"}); constructor(){this.axiosInstance=remedyPatchedAxios.create({adapter:"fetch",baseURL:"synthetic"});} async postPageContents(){return {fetchOptions:{redirect:"error"},maxRedirects:0,timeout:30000,headers:{type:"text/plain; charset=utf-8"}};} async putPageUnorder(){}}';
 for(const ext of ['mjs','cjs'])await writeFile(join(sdk,'dist/index.'+ext),(ext==='mjs'?'import remedyPatchedAxios from "./old.js";\n':'var remedyPatchedAxios=require("./old.js");\n')+factory);
 const script=join(root,'tools/patch-cxone-utf8.mjs');await copyFile(new URL('../../../../tools/patch-cxone-utf8.mjs',import.meta.url),script);
 const run=promisify(execFile);await run(process.execPath,[script]);const before=await Promise.all(['mjs','cjs'].map(ext=>readFile(join(sdk,'dist/index.'+ext),'utf8')));
 expect(before.every(source=>(source.match(/env:\{fetch:remedyBoundedFetch\}/g)||[]).length===2)).toBe(true);
 await run(process.execPath,[script]);expect(await Promise.all(['mjs','cjs'].map(ext=>readFile(join(sdk,'dist/index.'+ext),'utf8')))).toEqual(before);
});
