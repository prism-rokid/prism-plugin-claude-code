import pty from "node-pty";

const marker = `PRISM_PTY_${process.pid}`;
const child = pty.spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(marker)})`], {
  name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env: process.env,
});
let output = "";
child.onData((chunk) => { output += chunk; });
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { child.kill(); reject(new Error("native PTY did not exit within 5 seconds")); }, 5000);
  child.onExit(({ exitCode }) => {
    clearTimeout(timer);
    if (exitCode === 0) resolve();
    else reject(new Error(`native PTY exited ${exitCode}`));
  });
});
if (!output.includes(marker)) throw new Error("native PTY did not forward process output");
console.log("native PTY probe passed");
