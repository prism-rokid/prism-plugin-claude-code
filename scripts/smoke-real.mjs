// Opt-in integration acceptance: real CLI, PTY, supervisor, Mod and provider.
// Supply an isolated CLAUDE_CONFIG_DIR and credentials through the environment.
import { ModClaudeAdapter } from "../dist/mod-adapter.js";
import { createConnection } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";

if (!process.env.CLAUDE_CONFIG_DIR || !process.env.PRISM_CLAUDE_SMOKE_CWD) throw new Error("isolated CLAUDE_CONFIG_DIR and PRISM_CLAUDE_SMOKE_CWD required");
const cwd = resolve(process.env.PRISM_CLAUDE_SMOKE_CWD);
await mkdir(cwd, {recursive:true});
const configPath = join(process.env.CLAUDE_CONFIG_DIR, ".claude.json");
let config = {};
try { config = JSON.parse(await readFile(configPath,"utf8")); } catch (error) { if(error.code!=="ENOENT") throw error; }
config.hasCompletedOnboarding = true;
config.theme = "dark";
config.projects ||= {};
for (const path of [cwd,cwd.replaceAll("\\","/")]) config.projects[path] = {...config.projects[path],hasTrustDialogAccepted:true,hasCompletedProjectOnboarding:true};
await writeFile(configPath,JSON.stringify(config,null,2));
const adapter = new ModClaudeAdapter();
const clients = [];
const terminals = [];
const nativeTerminal = process.argv.includes("--native-terminal");
for (const operation of ["create", "resume"]) {
const original = adapter.manager[operation].bind(adapter.manager);
adapter.manager[operation] = async (...args) => {
  const created = await original(...args);
  clients.push(created.client);
  if (nativeTerminal) return created;
  // Use the real authenticated local-terminal transport, without opening a UI.
  created.client.openTerminal = async id => {
    const handoff = await created.client.terminalHandoff(id);
    const socket = createConnection({host:handoff.host,port:handoff.port});
    terminals.push(socket);
    await new Promise((res,rej)=>{socket.once("connect",res);socket.once("error",rej);});
    let buffer="";
    socket.on("data",chunk=>{
      buffer+=chunk;let at;
      while((at=buffer.indexOf("\n"))>=0){const packet=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);
        // Reply to terminal capability queries just as a plain terminal does.
        if(packet.type==="output") { const data=Buffer.from(packet.data,"base64").toString();
          if(data.includes("\x1b[c"))socket.write(JSON.stringify({type:"input",data:Buffer.from("\x1b[?1;2c").toString("base64")})+"\n");
        }
      }
    });
    socket.write(JSON.stringify({type:"auth",token:handoff.token})+"\n");
  };
  return created;
};
}
let timeout;
try {
  const probe=await adapter.probe();
  if(!probe.Available)throw new Error(probe.UnavailableReason);
  const marker=process.env.PRISM_CLAUDE_SMOKE_RESUME ? "PRISM_CLAUDE_MOD_RESUME_MINIMAX_OK" : "PRISM_CLAUDE_MOD_MINIMAX_OK";
  const messageID=randomUUID();
  const run=async()=>{
    const message={PrismMessageID:messageID,Text:`Reply exactly ${marker}. Do not use tools.`};
    let started;
    if(process.env.PRISM_CLAUDE_SMOKE_RESUME){
      const session=await adapter.attachSession({PluginID:"claudecode",NativeSessionID:process.env.PRISM_CLAUDE_SMOKE_RESUME,NativeThreadID:process.env.PRISM_CLAUDE_SMOKE_RESUME,Cwd:cwd});
      started={Session:session,Receipt:await adapter.send(session,message)};
    }else started=await adapter.startSessionWithMessage({PluginID:"claudecode",Cwd:cwd,Message:message});
    const event=await adapter.waitForRun(started.Session,messageID);
    let history=[];
    for(let i=0;i<30;i++){history=await adapter.readHistory(started.Session,20);if(history.some(row=>JSON.stringify(row).includes(marker)&&JSON.stringify(row).toLowerCase().includes("assistant")))break;await new Promise(r=>setTimeout(r,200));}
    if(event.Type!=="run.completed"||!history.some(row=>JSON.stringify(row).includes(marker)&&JSON.stringify(row).toLowerCase().includes("assistant")))throw new Error(`unconfirmed completion: ${event.Type}`);
    console.log(JSON.stringify({available:true,native_terminal:nativeTerminal,resumed:Boolean(process.env.PRISM_CLAUDE_SMOKE_RESUME),accepted:started.Receipt.Accepted,visible:started.Receipt.Visible,event:event.Type,history_rows:history.length,assistant_marker:true,session_id:started.Session.NativeSessionID}));
  };
  await Promise.race([run(),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error("real Mod smoke timeout")),120000);})]);
} catch(error) {
  for(const client of clients){
    let output=(await client.recentOutput().catch(()=>"")).slice(-12000);
    for(const key of [process.env.ANTHROPIC_AUTH_TOKEN,process.env.ANTHROPIC_API_KEY])if(key)output=output.replaceAll(key,"[redacted]");
    console.error(JSON.stringify({terminal_output:output}));
  }
  throw error;
} finally {
  clearTimeout(timeout);
  for(const socket of terminals)socket.destroy();
  for(const client of clients)await client.shutdown().catch(()=>{});
  await adapter.close();
  for(const client of clients){
    const alive=()=>{try{process.kill(client.descriptor.pid,0);return true;}catch{return false;}};
    const deadline=Date.now()+8000;
    while(alive()&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));
    if(alive())throw new Error("supervisor did not exit after explicit shutdown");
  }
}
