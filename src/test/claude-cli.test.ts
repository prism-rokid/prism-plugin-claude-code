import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, delimiter } from "node:path";
import test from "node:test";
import { resolveClaudeCLI } from "../claude-cli.js";

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
