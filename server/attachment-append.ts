import { randomUUID } from 'node:crypto';
import { mkdirSync,writeFileSync,readFileSync,renameSync,rmSync,existsSync,readdirSync,openSync,closeSync,fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { attachmentId,hash,MAX_FILE_BYTES } from './attachments.js';
import { LegacyImportError } from './legacy-import-model.js';

const sync=(path:string)=>{const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}};
export interface AppendedFile { id:string;bytes:Buffer;sha256:string;size:number }
export class AttachmentAppend {
  private readonly uploads:string;
  constructor(private readonly dataDir:string){this.uploads=join(dataDir,'uploads');mkdirSync(this.uploads,{recursive:true,mode:0o700});}
  /** Run after native replacement recovery. Only journal-owned generated IDs are touched. */
  recover(isCommitted:(id:string)=>boolean):void{
    for(const name of readdirSync(this.dataDir)){
      const match=/^\.append-([a-f\d-]{36})\.json$/.exec(name);if(!match)continue;
      const path=join(this.dataDir,name),entry=JSON.parse(readFileSync(path,'utf8')) as {id:string;stage:string;files:string[]};
      attachmentId(entry.id);if(entry.id!==match[1]||entry.stage!==`.append-stage-${entry.id}`||!Array.isArray(entry.files)||entry.files.length>100000||new Set(entry.files).size!==entry.files.length)throw new LegacyImportError(503,'첨부 추가 복구 기록을 확인해 주세요.');for(const id of entry.files)attachmentId(id);
      if(!isCommitted(entry.id))for(const id of entry.files)rmSync(join(this.uploads,id),{force:true});
      rmSync(join(this.dataDir,entry.stage),{recursive:true,force:true});rmSync(path,{force:true});sync(this.uploads);sync(this.dataDir);
    }
    for (const name of readdirSync(this.dataDir)) {
      if (/^\.append-stage-[a-f\d-]{36}$/.test(name)) rmSync(join(this.dataDir, name), {recursive:true,force:true});
      if (/^\.append-journal-[a-f\d-]{36}$/.test(name)) rmSync(join(this.dataDir, name), {force:true});
    }
  }
  stage(id:string,files:AppendedFile[]):{install:()=>void;commit:()=>void;rollback:()=>void}{
    attachmentId(id);if(files.length>100000||new Set(files.map(file=>file.id)).size!==files.length)throw new LegacyImportError(400,'추가할 첨부 ID를 확인해 주세요.');
    const directory=join(this.dataDir,`.append-stage-${id}`),journal=join(this.dataDir,`.append-${id}.json`),owned:string[]=[];let journalWritten=false,finished=false;
    if(existsSync(directory)||existsSync(journal))throw new LegacyImportError(409,'첨부 추가 작업이 이미 존재합니다.');mkdirSync(directory,{mode:0o700});
    try{for(const file of files){attachmentId(file.id);if(existsSync(join(this.uploads,file.id)))throw new LegacyImportError(409,'같은 첨부 파일 ID가 이미 존재합니다.');if(file.bytes.length!==file.size||file.size<1||file.size>MAX_FILE_BYTES||hash(file.bytes)!==file.sha256)throw new LegacyImportError(400,'추가할 첨부 내용·해시를 확인해 주세요.');writeFileSync(join(directory,file.id),file.bytes,{flag:'wx',mode:0o600,flush:true});}sync(directory);}catch(error){rmSync(directory,{recursive:true,force:true});throw error;}
    const cleanup=()=>{rmSync(directory,{recursive:true,force:true});rmSync(journal,{force:true});sync(this.dataDir);};
    return{
      install:()=>{
        if(finished||journalWritten)throw new LegacyImportError(409,'첨부 추가 작업 상태가 올바르지 않습니다.');
        // Check again before publishing the journal: rollback must never remove an existing file.
        for(const file of files)if(existsSync(join(this.uploads,file.id)))throw new LegacyImportError(409,'같은 첨부 파일 ID가 이미 존재합니다.');
        const temporary=join(this.dataDir,`.append-journal-${randomUUID()}`);writeFileSync(temporary,JSON.stringify({id,stage:`.append-stage-${id}`,files:files.map(file=>file.id)}),{flag:'wx',mode:0o600,flush:true});renameSync(temporary,journal);journalWritten=true;sync(this.dataDir);
        for(const file of files){renameSync(join(directory,file.id),join(this.uploads,file.id));owned.push(file.id);}sync(this.uploads);sync(this.dataDir);
      },
      commit:()=>{if(finished)return;if(!journalWritten)throw new LegacyImportError(409,'첨부를 설치한 뒤 완료해야 합니다.');cleanup();finished=true;},
      rollback:()=>{if(finished)return;for(const fileId of owned)rmSync(join(this.uploads,fileId),{force:true});sync(this.uploads);cleanup();finished=true;},
    };
  }
}
