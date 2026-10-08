import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("real loopback Mod bridge delivers every delta through the adapter history stream and reconciles disk history", () => {
  const home = mkdtempSync(join(tmpdir(), "prism-stream-integration-"));
  const script = `
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {ModClaudeAdapter} from './dist/mod-adapter.js';
import {register} from './mod/hooks/register.js';
const id='native-stream-session';
const directory=join(process.env.CLAUDE_CONFIG_DIR,'projects','isolated');
await mkdir(directory,{recursive:true});
const file=join(directory,id+'.jsonl');
const user={type:'user',uuid:'user',timestamp:new Date().toISOString(),message:{content:'test'},cwd:'/isolated'};
await writeFile(file,JSON.stringify(user)+'\\n');
const adapter=new ModClaudeAdapter();
const hooks=new Map(); register((name,hook)=>hooks.set(name,hook));
const api={env:{get:async()=>process.env.HOME},fs:{read:async(path)=>readFile(path,'utf8')},
http:{fetch:async(url,options)=>{const r=await fetch(url,options);return {ok:r.ok,status:r.status,text:await r.text()};}},
session:{id:async()=>id,cwd:async()=>'/isolated',version:async()=>({version:'2.1.289'}),surfaces:async()=>['terminal']},
clock:{every:()=>{}},ui:{status:()=>{}}};
const abort=new AbortController();
const history=adapter.readHistoryStream({PluginID:'claudecode',NativeSessionID:id,Cwd:'/isolated'}, {stream_id:'test',limit:20,live:true},abort.signal);
try {
 await history.next(); await history.next();
 await hooks.get('session.start')(api,{},e=>e);
 await hooks.get('turn.start')(api,{turnId:'turn'},e=>e);
 const work=(await history.next()).value;
 assert.equal(work.turn.messages.find(message=>message.Type==='progress').Progress.Status,'running');
 const result={turnId:'turn',index:0,answer:'你好',toolUses:[],stopReason:'end_turn',usage:null};
 const native=Object.assign((async function*(){yield {kind:'text',index:0,text:'你'};yield {kind:'text',index:0,text:'好'};return result;})(),{result:Promise.resolve(result)});
 const stream=hooks.get('turn.step')(api,{turnId:'turn',index:0},()=>native);
 assert.equal((await stream.next()).value.text,'你');
 assert.equal((await stream.next()).value.text,'好');
 const first=(await history.next()).value;
 assert.equal(first.turn.messages.filter(message=>message.Type!=='progress').at(-1).Content,'你');
 const reconnected=adapter.readHistoryStream({PluginID:'claudecode',NativeSessionID:id,Cwd:'/isolated'}, {stream_id:'reconnected',limit:20,live:true},abort.signal);
 assert.equal((await reconnected.next()).value.turn.messages.filter(message=>message.Type!=='progress').at(-1).Content,'你');
 await reconnected.return();
 const finish=stream.next();
 const second=(await history.next()).value;
 assert.equal(second.turn.messages.filter(message=>message.Type!=='progress').at(-1).Content,'你好');
 assert.ok(second.turn.revision>first.turn.revision);
 assert.equal((await finish).value,result);
 const completed=(await history.next()).value;
 assert.equal(completed.turn.messages.filter(message=>message.Type!=='progress').at(-1).Status,'completed');
 await writeFile(file,JSON.stringify(user)+'\\n'+JSON.stringify({type:'assistant',uuid:'answer',parentUuid:'user',timestamp:new Date().toISOString(),message:{content:[{type:'text',text:'你好'}]}})+'\\n');
 const workingDurable=(await history.next()).value;
 assert.equal(workingDurable.turn.messages.find(message=>message.Type==='progress').Progress.Status,'running');
 await hooks.get('turn.complete')(api,{turnId:'turn',reason:'complete'},e=>e);
 const durable=(await history.next()).value;
 assert.deepEqual(durable.turn.messages.map(message=>message.ID),['user','answer']);
 abort.abort(); await history.return();
 const shutdown=adapter.readHistoryStream({PluginID:'claudecode',NativeSessionID:id,Cwd:'/isolated'}, {stream_id:'shutdown',limit:20,live:true});
 await shutdown.next(); await shutdown.next();
 const waiting=shutdown.next();
 await adapter.close();
 assert.equal((await waiting).done,true);
 console.log(JSON.stringify({frames:[first.turn.messages.filter(message=>message.Type!=='progress').at(-1).Content,second.turn.messages.filter(message=>message.Type!=='progress').at(-1).Content],finalIDs:durable.turn.messages.map(message=>message.ID)}));
} finally {abort.abort();await adapter.close();}
`;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: process.cwd(), encoding: "utf8", timeout: 10_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), PRISM_CLAUDE_MOD_STATE_DIR: join(home, ".prism", "claudecode"), PRISM_CLAUDE_MANAGED_DIR: join(home, ".prism", "terminal") },
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.deepEqual(JSON.parse(result.stdout), { frames: ["你", "你好"], finalIDs: ["user", "answer"] });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
