import { spawn } from 'node:child_process';

const children = [
  spawn(process.execPath, ['--import', 'tsx', '--watch', 'server/index.ts'], { stdio: 'inherit', env: { ...process.env, PORT: process.env.API_PORT || '5181' } }),
  spawn(process.execPath, ['scripts/run-framework.mjs', 'dev', '--host', '127.0.0.1', '--port', process.env.WEB_PORT || '5173'], { stdio: 'inherit', env: process.env }),
];
let closing = false;
function close(code=0) { if(closing) return; closing=true; for(const child of children) child.kill('SIGTERM'); setTimeout(()=>process.exit(code),150).unref(); }
for(const child of children) child.on('exit',code=>{if(!closing)close(code ?? 1);});
process.on('SIGINT',()=>close());process.on('SIGTERM',()=>close());
