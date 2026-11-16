import { createApp } from './app.js';
const {app,close}=createApp();
const port=Number(process.env.PORT||5181);
const server=app.listen(port,'127.0.0.1',()=>console.log(`Teamspace API listening on http://127.0.0.1:${port}`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>{close();process.exit(0);}));
