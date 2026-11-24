import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import process from 'node:process';
import console from 'node:console';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { platform, arch, cpus } from 'node:os';
import { startPerformanceFixture } from './fixture.mjs';
import { probeTree } from './tree-probe.mjs';
const execute = promisify(execFile);
const { values } = parseArgs({ options: {
  'tree-counts': { type:'string', default:'1000,10000,50000' },
  'tree-shapes': { type:'string', default:'wide-root,wide-src' },
  repeats: { type:'string', default:'3' },
  output: { type:'string', default:'/tmp/explorer-draft.json' },
  dist: { type:'string', default: '/Users/mi/.codex/worktrees/agent-tasks/weave/apps/studio/dist' },
} });
const options = z.strictObject({
  counts:z.array(z.coerce.number().pipe(z.union([z.literal(1000),z.literal(10000),z.literal(50000)]))).min(1).max(3),
  shapes:z.array(z.enum(['wide-root','wide-src'])).min(1).max(2),
  repeats:z.coerce.number().int().min(1).max(5), output:z.string().min(1),dist:z.string().min(1),
}).parse({counts:values['tree-counts'].split(','),shapes:values['tree-shapes'].split(','),repeats:values.repeats,output:values.output,dist:values.dist});
const scratch = await mkdtemp(join(tmpdir(),'weave-explorer-probe-'));
const session = `weave-explorer-${process.pid}`;
const cli = async (...args) => {
  const {stdout}=await execute('playwright-cli',[`-s=${session}`,'--raw',...args],{timeout:240000,maxBuffer:8*1024*1024});
  if(/^### Error/m.test(stdout))throw Error(stdout);
  return stdout.trim();
};
const git=async(...args)=>(await execute('git',args,{cwd:'/Users/mi/.codex/worktrees/agent-tasks/weave'})).stdout.trim();
const distFiles=[];
async function scan(dir,prefix=''){for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const relative=prefix+entry.name;if(entry.isDirectory())await scan(join(dir,entry.name),relative+'/');else{const body=await readFile(join(dir,entry.name));distFiles.push({path:relative,bytes:body.length,sha256:createHash('sha256').update(body).digest('hex')});}}}
await scan(options.dist);
const distHash=createHash('sha256').update(JSON.stringify(distFiles)).digest('hex');
const harnessHash=createHash('sha256').update((await Promise.all(['tree-scenario.mjs','tree-probe.mjs','fixture.mjs','scenario.mjs','explorer-runner.mjs'].map(name=>readFile(new URL(name,import.meta.url))))).map(v=>v.toString()).join('\n')).digest('hex');
const report = { schemaVersion:1,commit:await git('rev-parse','HEAD'),dirty:Boolean(await git('status','--porcelain')),sourceNote:'Tree source unchanged from 7eb4c72; conversation PR1 dirty dist, no rebuild for Explorer baseline',harnessHash,distHash,distFiles,platform:platform(),arch:arch(),cpu:cpus()[0]?.model,node:process.version,browser:null, stage:'explorer-draft-unoptimized', recordedAt:new Date().toISOString(),synthetic:true,viewport:{width:1440,height:1000},browserIsolation:'fresh-browser-per-sample',assetCache:'no-store',options,samples:[] };
let opened=false;
try {
  for(const fileCount of options.counts)for(const shape of options.shapes)for(let repeat=0;repeat<options.repeats;repeat++){
    const fixture=await startPerformanceFixture({count:100,variant:'markdown',distDirectory:options.dist,tree:{fileCount,shape}});
    try{
      await cli('open','about:blank','--browser=chrome');opened=true;
      const browser=JSON.parse(await cli('run-code','async page => page.context().browser().version()'));
      if(report.browser!==null&&report.browser!==browser)throw Error('Browser changed');report.browser=browser;
      console.log(`Measuring Explorer ${fileCount}/${shape}, repeat ${repeat+1}/${options.repeats}`);
      const filename=join(scratch,'probe.js');
      await writeFile(filename,`async page => { const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.setViewportSize({width:1440,height:1000}); await page.goto(${JSON.stringify(fixture.url)},{waitUntil:'domcontentloaded'}); const value=await (${probeTree.toString()})(page,${JSON.stringify({tree:fixture.tree})});if(errors.length)throw Error(errors.join('; '));return value; }`);
      const sample=JSON.parse(await cli('run-code',`--filename=${filename}`));
      report.samples.push({fileCount,shape,repeat,fixtureHash:fixture.tree.hash,...sample});
      await cli('close');opened=false;
      await mkdir(resolve(options.output,'..'),{recursive:true});
      await writeFile(resolve(options.output),JSON.stringify(report,null,2)+'\n');
    }finally{await fixture.close();}
  }
}catch(error){report.failure={message:error.message};await writeFile(resolve(options.output),JSON.stringify(report,null,2)+'\n');throw error;
}finally{if(opened)await cli('close').catch(console.error);await rm(scratch,{recursive:true,force:true});}
