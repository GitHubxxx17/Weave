import {execFile}from'node:child_process';import{promisify}from'node:util';import{writeFile,readFile}from'node:fs/promises';import{createHash}from'node:crypto';import{pathToFileURL}from'node:url';import{resolve}from'node:path';
const root=process.cwd();
const moduleAt=path=>import(pathToFileURL(resolve(root,path)));
const{startPerformanceFixture}=await moduleAt('apps/server/test/performance/fixture.mjs');
const{probeViewer}=await moduleAt('apps/server/test/performance/viewer-probe.mjs');
const{validateViewerPayload,diffRowsReady}=await moduleAt('apps/server/test/performance/viewer-validation.mjs');
const execute=promisify(execFile),session=`weave-viewer-supplemental-${process.pid}`;
const cli=async(...args)=>{const{stdout}=await execute('playwright-cli',[`-s=${session}`,'--raw',...args],{timeout:240000,maxBuffer:16*1024*1024});if(/^### Error/m.test(stdout))throw Error(stdout);return stdout.trim();};
const scriptHash=createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
const report={schemaVersion:1,stage:'supplemental-same-command-three-phase',note:'Independent supplement; formal36raw remains unchanged. Every repeat freshfixture/browser. Allthreephases withinoneCLIcommand to diagnose page loss betweenCLIcommands.',scriptHash,cliTimeoutMs:240000,readinessWaitTimeoutMs:120000,samples:[]};
for(let repeat=0;repeat<3;repeat++){
const fixture=await startPerformanceFixture({count:100,variant:'markdown',tree:{fileCount:1000,shape:'wide-root',viewer:{bytes:1992294,encoding:'multibyte',lineShape:'single'}}});let opened=false;
try{
 await cli('open','about:blank','--browser=chrome');opened=true;
 const file='/tmp/weave-viewer-supplemental-probe.js';
 await writeFile(file,`async page => {const events=[];for(const type of ['pageerror','crash','close','framenavigated'])page.on(type,value=>events.push({type,message:type==='framenavigated'?value.url():value?.message??''}));const results=[];for(const phase of ['plain-content','typescript-content','typescript-diff']){const result=await (${probeViewer.toString()})(page,${JSON.stringify({url:fixture.url,viewer:fixture.tree.viewer})}&&{...${JSON.stringify({url:fixture.url,viewer:fixture.tree.viewer})},phase,initialize:phase==='plain-content'},(${validateViewerPayload.toString()}),(${diffRowsReady.toString()}));results.push(result);}return {results,events,url:page.url(),title:await page.title()};}`);
 console.log(`Supplemental near2MB/multibyte/single ${repeat+1}/3`);
 const result=JSON.parse(await cli('run-code',`--filename=${file}`));
 report.samples.push({repeat,fixtureHash:fixture.tree.hash,status:result.results.every(r=>r.failures.length===0)?'passed':'failed',...result});
}catch(error){report.samples.push({repeat,fixtureHash:fixture.tree.hash,status:'failed',failure:{message:error.message,stack:error.stack}});}
finally{if(opened)await cli('close');await fixture.close();await writeFile(resolve(root,'dist/performance/viewer-supplemental.json'),JSON.stringify(report,null,2)+'\n');}
}
