import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Attachment } from '../shared/types.js';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
export const MAX_EXPORT_BYTES = MAX_PACKAGE_BYTES - 1024;
export const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export function safeFilename(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value,'utf8') > 255 || /[\\/\x00-\x1f\x7f]/.test(value) || ['.','..'].includes(value.trim())) throw new Error('파일명에 경로·제어 문자를 사용할 수 없습니다.');
  return value.trim();
}
export function attachmentId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value)) throw new Error('첨부파일 ID가 올바르지 않습니다.');
  return value;
}
export function sniffMime(bytes: Buffer): string {
  if (bytes.length >= 24 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii',12,16)==='IHDR' && bytes.readUInt32BE(16)>0 && bytes.readUInt32BE(20)>0) return 'image/png';
  if (bytes.length >= 4 && bytes[0]===0xff && bytes[1]===0xd8 && bytes[2]===0xff && bytes.at(-2)===0xff && bytes.at(-1)===0xd9) return 'image/jpeg';
  if (bytes.length >= 13 && ['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6)) && bytes.readUInt16LE(6)>0 && bytes.readUInt16LE(8)>0) return 'image/gif';
  if (bytes.length >= 20 && bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP' && ['VP8 ','VP8L','VP8X'].includes(bytes.toString('ascii',12,16)) && bytes.readUInt32LE(4)===bytes.length-8) return 'image/webp';
  if (bytes.toString('ascii',0,5)==='%PDF-') return 'application/pdf';
  return 'application/octet-stream';
}
export class AttachmentFiles {
  readonly root: string;
  readonly journal: string;
  constructor(readonly dataDir: string) { this.dataDir=resolve(dataDir);this.root=join(this.dataDir,'uploads');this.journal=join(this.dataDir,'.attachments-import.json');mkdirSync(this.root,{recursive:true,mode:0o700}); }
  private syncDirectory(directory=this.dataDir) { const fd=openSync(directory,'r');try{fsyncSync(fd);}finally{closeSync(fd);} }
  recover(committedGeneration:string|null) {
    if(!existsSync(this.journal))return;
    const record=JSON.parse(readFileSync(this.journal,'utf8'));
    attachmentId(record.generation);
    if(typeof record.backup!=='string'||!/^\.uploads-previous-[a-f\d-]{36}$/.test(record.backup)||typeof record.stage!=='string'||!/^\.uploads-import-[a-f\d-]{36}$/.test(record.stage))throw new Error('첨부파일 복구 기록이 올바르지 않습니다.');
    const backup=join(this.dataDir,record.backup),stage=join(this.dataDir,record.stage);
    if(committedGeneration!==record.generation&&existsSync(backup)){rmSync(this.root,{recursive:true,force:true});renameSync(backup,this.root);}
    else if(committedGeneration===record.generation){rmSync(backup,{recursive:true,force:true});}
    rmSync(stage,{recursive:true,force:true});rmSync(this.journal,{force:true});this.syncDirectory();
  }
  path(id: string, dir=this.root) { return join(dir,attachmentId(id)); }
  read(a: Attachment) {
    const bytes=readFileSync(this.path(a.id));
    if(bytes.length!==a.size||hash(bytes)!==a.sha256)throw new Error('첨부파일 무결성 검사에 실패했습니다.');
    return bytes;
  }
  write(id:string,bytes:Buffer) {
    const stage=join(this.root,`.upload-${randomUUID()}`),dest=this.path(id);
    try{writeFileSync(stage,bytes,{mode:0o600,flag:'wx',flush:true});renameSync(stage,dest);this.syncDirectory(this.root);}finally{rmSync(stage,{force:true});}
  }
  remove(id:string) { rmSync(this.path(id),{force:true}); }
  stageImport(attachments: Attachment[], contents: {id:string;data:string}[]) {
    const stage=join(this.dataDir,`.uploads-import-${randomUUID()}`);
    mkdirSync(stage,{mode:0o700});
    try{
      const ids=new Set(attachments.map(a=>a.id));
      if(contents.length!==attachments.length||new Set(contents.map(c=>c.id)).size!==contents.length||contents.some(c=>!ids.has(c.id)))throw new Error('첨부파일 메타데이터와 내용 목록이 일치하지 않습니다.');
      const contentMap=new Map(contents.map(c=>[c.id,c.data]));
      for(const a of attachments){
        attachmentId(a.id);safeFilename(a.filename);
        if(!Number.isInteger(a.size)||a.size<=0||a.size>MAX_FILE_BYTES||!/^[a-f\d]{64}$/.test(a.sha256))throw new Error('첨부파일 크기·체크섬을 확인해 주세요.');
        const encoded=contentMap.get(a.id);if(typeof encoded!=='string'||encoded.length>Math.ceil(MAX_FILE_BYTES/3)*4)throw new Error('첨부파일 내용이 올바르지 않습니다.');
        const bytes=Buffer.from(encoded,'base64');if(bytes.toString('base64')!==encoded||bytes.length!==a.size||hash(bytes)!==a.sha256)throw new Error('첨부파일 내용과 체크섬이 일치하지 않습니다.');
        if(sniffMime(bytes)!==a.mimeType)throw new Error('첨부파일 MIME 형식이 일치하지 않습니다.');
        writeFileSync(this.path(a.id,stage),bytes,{mode:0o600,flag:'wx',flush:true});
      }
      this.syncDirectory(stage);return stage;
    }catch(error){rmSync(stage,{recursive:true,force:true});throw error;}
  }
  swapImport(stage:string,generation:string) {
    attachmentId(generation);
    const backupName=`.uploads-previous-${randomUUID()}`,backup=join(this.dataDir,backupName);let movedOld=false,movedNew=false;
    const stageName=stage.slice(this.dataDir.length+1);
    if(!/^\.uploads-import-[a-f\d-]{36}$/.test(stageName))throw new Error('첨부파일 임시 경로가 올바르지 않습니다.');
    const journalTemp=join(this.dataDir,`.attachments-journal-${randomUUID()}`);
    writeFileSync(journalTemp,JSON.stringify({generation,stage:stageName,backup:backupName}),{mode:0o600,flag:'wx',flush:true});renameSync(journalTemp,this.journal);this.syncDirectory();
    try{if(existsSync(this.root)){renameSync(this.root,backup);movedOld=true;}renameSync(stage,this.root);movedNew=true;this.syncDirectory();}
    catch(error){if(movedNew)rmSync(this.root,{recursive:true,force:true});if(movedOld)renameSync(backup,this.root);rmSync(this.journal,{force:true});this.syncDirectory();throw error;}
    return{
      commit:()=>{rmSync(backup,{recursive:true,force:true});rmSync(this.journal,{force:true});this.syncDirectory();},
      rollback:()=>{if(movedNew)rmSync(this.root,{recursive:true,force:true});if(movedOld)renameSync(backup,this.root);rmSync(this.journal,{force:true});this.syncDirectory();},
    };
  }
  cleanupStage(stage:string) { rmSync(stage,{recursive:true,force:true}); }
}
