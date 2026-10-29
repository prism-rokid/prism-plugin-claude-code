import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, delimiter } from "node:path";
import test from "node:test";
import { resolveClaudeCLI, runClaudeCLI } from "../claude-cli.js";

function cli(path: string): void { mkdirSync(dirname(path), {recursive:true}); writeFileSync(path,"fixture"); chmodSync(path,0o700); }

test("GUI system-only PATH discovers nvm Claude and supplies a Node executable path", () => {
 const home=mkdtempSync(join(tmpdir(),"prism-cli-gui-"));
 try {
  const expected=join(home,".nvm/versions/node/v24.20.0/bin/claude"); cli(expected);
  cli(join(home,".nvm/versions/node/v9.0.0/bin/claude"));
  const result=resolveClaudeCLI({PATH:join(home,"system-only"),HOME:home},home);
  assert.equal(result.command,expected);
  assert.ok(result.env.PATH?.split(delimiter).includes(dirname(process.execPath)));
  assert.ok(result.env.PATH?.split(delimiter).includes(dirname(expected)));
 } finally {rmSync(home,{recursive:true,force:true});}
});

test("an explicit Claude override remains authoritative even if missing", () => {
 const home=mkdtempSync(join(tmpdir(),"prism-cli-override-"));
 try {
  cli(join(home,".nvm/versions/node/v24.20.0/bin/claude"));
  const missing=join(home,"missing-claude");
  assert.equal(resolveClaudeCLI({PATH:"",PRISM_CLAUDE_CLI:missing},home).command,missing);
 } finally {rmSync(home,{recursive:true,force:true});}
});

test("mise discovers custom shim and executable without pinning an installed version", () => {
 const home=mkdtempSync(join(tmpdir(),"prism-mise-home-"));
 const custom=mkdtempSync(join(tmpdir(),"prism-mise-data-"));
 try {
  const suffix=process.platform === "win32" ? ".exe" : "";
  const mise=join(custom,"tools","mise"+suffix); cli(mise);
  const shim=join(custom,"custom shims",process.platform === "win32" ? "claude.cmd" : "claude"); cli(shim);
  const selection=join(custom,"selected-version.txt");
  writeFileSync(selection,"2.1.311\n");
  writeFileSync(shim, process.platform === "win32" ? `@echo off\r\ntype "${selection}"\r\n` : `#!/bin/sh\n/bin/cat '${selection.replace(/'/g, "'\\''")}'\n`);
  chmodSync(shim,0o700);
  const env={PATH:join(home,"empty"), MISE_DATA_DIR:join(custom,"data"), MISE_SHIMS_DIR:dirname(shim), MISE_BIN:mise};
  const first=resolveClaudeCLI(env,home);
  assert.equal(first.command,shim);
  assert.ok(first.env.PATH?.split(delimiter).includes(dirname(mise)));
  const before=runClaudeCLI(first.command,["--version"],{env:first.env,encoding:"utf8"});
  assert.match(before.stdout,/2\.1\.311/);
  writeFileSync(selection,"2.1.400\n");
  const next=resolveClaudeCLI(env,home);
  assert.equal(next.command,shim);
  const after=runClaudeCLI(next.command,["--version"],{env:next.env,encoding:"utf8"});
  assert.match(after.stdout,/2\.1\.400/);
 } finally {rmSync(home,{recursive:true,force:true});rmSync(custom,{recursive:true,force:true});}
});

test("mise default data directory follows platform and XDG overrides", () => {
 const home=mkdtempSync(join(tmpdir(),"prism-mise-default-"));
 try {
  const suffix=process.platform === "win32" ? ".exe" : "";
  const data=join(home,"redirected data");
  const mise=join(home,".local","bin","mise"+suffix); cli(mise);
  const shim=join(data,"mise","shims","claude"+suffix); cli(shim);
  const env={PATH:join(home,"empty"), ...(process.platform === "win32" ? {LOCALAPPDATA:data} : {XDG_DATA_HOME:data})};
  assert.equal(resolveClaudeCLI(env,home).command,shim);
 } finally {rmSync(home,{recursive:true,force:true});}
});

test("nvm default version takes precedence over other discovered versions", () => {
 const home=mkdtempSync(join(tmpdir(),"prism-cli-default-"));
 try {
  const nvm=join(home,"custom-nvm");
  const expected=join(nvm,"versions/node/v22.23.1/bin/claude"); cli(expected);
  cli(join(nvm,"versions/node/v24.20.0/bin/claude"));
  mkdirSync(join(nvm,"alias")); writeFileSync(join(nvm,"alias/default"),"v22.23.1\n");
  assert.equal(resolveClaudeCLI({PATH:"",NVM_DIR:nvm},home).command,expected);
 } finally {rmSync(home,{recursive:true,force:true});}
});

test("Windows 的 claude.cmd 可完成版本探测", { skip: process.platform !== "win32" }, () => {
 const home=mkdtempSync(join(tmpdir(),"prism cli windows & "));
 try {
  const command=join(home,"claude.cmd");
  writeFileSync(command,"@echo off\r\necho 2.1.289\r\n");
  const cli=resolveClaudeCLI({HOME:home,USERPROFILE:home,PATH:home,PRISM_CLAUDE_CLI:command},home);
  const result=runClaudeCLI(cli.command,["--version"],{env:cli.env,encoding:"utf8"});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/2\.1\.289/);
 } finally {rmSync(home,{recursive:true,force:true});}
});

test("Windows GUI discovers npm launcher and normalizes case-insensitive Path", { skip: process.platform !== "win32" }, () => {
 const home=mkdtempSync(join(tmpdir(),"prism npm gui "));
 try {
  const appData=join(home,"Roaming AppData");
  const expected=join(appData,"npm","claude.cmd"); cli(expected);
  const result=resolveClaudeCLI({Path:join(home,"system"),APPDATA:appData,USERPROFILE:home},home);
  assert.equal(result.command,expected);
  assert.equal(result.env.Path,undefined);
  assert.ok(result.env.PATH?.split(delimiter).includes(join(home,"system")));
 } finally {rmSync(home,{recursive:true,force:true});}
});

test("Windows GUI discovers NVM symlink launcher", { skip: process.platform !== "win32" }, () => {
 const home=mkdtempSync(join(tmpdir(),"prism nvm gui "));
 try {
  const nvm=join(home,"nvm node"); const expected=join(nvm,"claude.cmd"); cli(expected);
  assert.equal(resolveClaudeCLI({PATH:"",NVM_SYMLINK:nvm},home).command,expected);
 } finally {rmSync(home,{recursive:true,force:true});}
});
