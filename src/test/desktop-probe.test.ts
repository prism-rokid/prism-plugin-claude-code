import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("desktop probe discovers nvm CLI, installs the user Mod, and recovers after an install failure", {skip:process.platform === "win32" ? "POSIX CLI fixture" : false}, () => {
 const home=mkdtempSync(join(tmpdir(),"prism-desktop-probe-"));
 try {
  const path=join(home,".nvm/versions/node/v24.20.0/bin/claude");
  mkdirSync(dirname(path),{recursive:true});
  writeFileSync(path,`#!${process.execPath}\nconst fs=require('node:fs');const p=require('node:path');const args=process.argv.slice(2);fs.appendFileSync(p.join(process.env.HOME,'calls.jsonl'),JSON.stringify(args)+'\\n');if(args[0]==='--version'){console.log('2.1.289 (Claude Code)');}else if(fs.existsSync(p.join(process.env.HOME,'fail'))){process.exit(1);}\n`);
  chmodSync(path,0o700); writeFileSync(join(home,"fail"),"one failure");
  const script=`import {ModClaudeAdapter} from './dist/mod-adapter.js';import {rmSync} from 'node:fs';const a=new ModClaudeAdapter();try{const first=await a.probe();rmSync(process.env.HOME+'/fail');const second=await a.probe();console.log(JSON.stringify({first:first.Available,second:second.Available}));}finally{await a.close();}`;
  const env={...process.env,HOME:home,USERPROFILE:home,PATH:"/usr/bin:/bin:/usr/sbin:/sbin",CLAUDE_CONFIG_DIR:join(home,".claude"),PRISM_CLAUDE_MOD_STATE_DIR:join(home,".prism/claudecode"),PRISM_CLAUDE_MANAGED_DIR:join(home,".prism/terminal")};
  delete (env as NodeJS.ProcessEnv).PRISM_CLAUDE_CLI; delete (env as NodeJS.ProcessEnv).NVM_DIR;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),env,encoding:'utf8',timeout:15_000});
  assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout.trim()),{first:false,second:true});
  const calls=readFileSync(join(home,"calls.jsonl"),'utf8').trim().split('\n').map(line=>JSON.parse(line) as string[]);
  assert.ok(calls.some(args=>args[0]==='plugin' && args[1]==='enable'));
 }finally{rmSync(home,{recursive:true,force:true});}
});
