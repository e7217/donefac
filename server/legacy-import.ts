import { randomUUID,createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { mkdirSync,chmodSync,lstatSync,readdirSync,writeFileSync,renameSync,rmSync,openSync,closeSync,fsyncSync } from 'node:fs';
import { join } from 'node:path';
import type { Express,Request } from 'express';
import type { LegacyDiagnostic,LegacyDiagnosticPage,LegacyPackageSummary,LegacyPackageDetail,LegacyRecord,LegacyRecordKind,LegacyRecordPage,LegacyRecordSummary } from '../shared/types.js';
import type { Store } from './store.js';
import { safeFilename } from './attachments.js';
import { LEGACY_MAX_RAW_BYTES } from './legacy-import-archive.js';
import { LegacyImportError } from './legacy-import-model.js';
import type { LegacyAnalysis } from './legacy-import-analysis.js';

const MAX_PACKAGES=20,MAX_STORED_BYTES=512*1024*1024;
type Hooks={actor:(req:Request)=>string;activity:(req:Request,type:string,id:string,action:string,detail?:string)=>unknown};
export type StoredLegacyPackageDetail = LegacyPackageDetail & {
  jiraBackupLayoutChecked?: true;
  sourceEvidenceChecked?: true;
  jiraServiceDeskOwnerEvidenceChecked?: true;
  jiraHistoricalWorkflowEvidenceChecked?: true;
  jiraAdminHistoryVisibilityChecked?: true;
};
const fail=(status:number,message:string):never=>{throw new LegacyImportError(status,message);};
const scalar=(value:unknown,label:string,max=500):string=>typeof value==='string'&&value.trim()&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value)?value.trim():fail(400,`${label}을(를) 확인해 주세요.`);
function pageOptions(query:Record<string,unknown>){const integer=(name:string,fallback:number,max:number)=>{const value=query[name];if(value===undefined)return fallback;if(typeof value!=='string'||!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)>max||name==='limit'&&Number(value)<1)fail(400,'페이지 범위를 확인해 주세요.');return Number(value);};return{offset:integer('offset',0,100000),limit:integer('limit',50,100)};}
const syncDirectory=(path:string)=>{const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}};

/** Read-only source analysis is deliberately separate from native replacement import. */
export class LegacyImportService{
  private readonly root:string;
  private closed=false;
  private current:{worker:Worker;reject:(error:Error)=>void}|null=null;
  private busy=false;
  constructor(private readonly store:Store,dataDir:string,{ preserveUnregisteredBundles = false } = {}){
    this.root=join(dataDir,'legacy-imports');
    const sourceDirectory = preserveUnregisteredBundles ? lstatSync(this.root, { throwIfNoEntry: false }) : undefined;
    if (sourceDirectory && !sourceDirectory.isDirectory()) throw new Error('리허설 원본 보관 디렉터리를 확인해 주세요.');
    mkdirSync(this.root,{recursive:true,mode:0o700});chmodSync(this.root,0o700);
    store.db.exec(`CREATE TABLE IF NOT EXISTS legacy_packages(id TEXT PRIMARY KEY,instance_key TEXT NOT NULL,sha256 TEXT NOT NULL,json TEXT NOT NULL,UNIQUE(instance_key,sha256));
      CREATE TABLE IF NOT EXISTS legacy_records(package_id TEXT NOT NULL REFERENCES legacy_packages(id) ON DELETE CASCADE,record_id TEXT NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,source_id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(package_id,record_id));
      CREATE TABLE IF NOT EXISTS legacy_diagnostics(package_id TEXT NOT NULL REFERENCES legacy_packages(id) ON DELETE CASCADE,id TEXT NOT NULL,severity TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(package_id,id));
      CREATE TABLE IF NOT EXISTS legacy_file_manifests(package_id TEXT PRIMARY KEY REFERENCES legacy_packages(id) ON DELETE CASCADE,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS legacy_record_kind ON legacy_records(package_id,kind);
      CREATE INDEX IF NOT EXISTS legacy_diagnostic_severity ON legacy_diagnostics(package_id,severity);`);
    // A rehearsal needs the original bytes even when the stored analysis row is missing.
    const known = preserveUnregisteredBundles ? null : new Set(this.list().map(value=>value.id));
    for (const filename of readdirSync(this.root)) {
      const match = /^([a-f\d-]{36})\.(pending|bundle)$/.exec(filename);
      if (match && (match[2] === 'pending' || (known && !known.has(match[1])))) rmSync(join(this.root,filename),{force:true});
    }
  }
  list():LegacyPackageSummary[]{return(this.store.db.prepare('SELECT json FROM legacy_packages ORDER BY rowid DESC').all() as {json:string}[]).map(row=>JSON.parse(row.json) as LegacyPackageSummary);}
  private get(id:string):LegacyPackageSummary{const row=this.store.db.prepare('SELECT json FROM legacy_packages WHERE id=?').get(id) as {json:string}|undefined;if(!row)return fail(404,'분석한 원본 패키지를 찾을 수 없습니다.');return JSON.parse(row.json) as LegacyPackageSummary;}
  detail(id:string):StoredLegacyPackageDetail{const summary=this.get(id),row=this.store.db.prepare('SELECT json FROM legacy_file_manifests WHERE package_id=?').get(id) as {json:string};return{summary,...JSON.parse(row.json)};}
  records(id:string,query:Record<string,unknown>):LegacyRecordPage{
    this.get(id);const {offset,limit}=pageOptions(query),params:(string|number)[]=[id];let where='package_id=?';
    if(query.kind!==undefined){where+=' AND kind=?';params.push(scalar(query.kind,'객체 종류',40));}
    if(query.q!==undefined){const q=scalar(query.q,'검색어',300);where+=" AND (instr(lower(title),lower(?))>0 OR instr(lower(source_id),lower(?))>0 OR instr(lower(coalesce(json_extract(json,'$.metadata.key'),'')),lower(?))>0)";params.push(q,q,q);}
    const total=Number((this.store.db.prepare(`SELECT COUNT(*) AS total FROM legacy_records WHERE ${where}`).get(...params) as {total:number}).total);
    const rows=this.store.db.prepare(`SELECT json_remove(json,'$.text','$.metadata','$.references') AS summary,substr(json_extract(json,'$.text'),1,600) AS preview,length(CAST(json_extract(json,'$.text') AS BLOB)) AS bytes,json_array_length(json_extract(json,'$.references')) AS refs FROM legacy_records WHERE ${where} ORDER BY rowid LIMIT ? OFFSET ?`).all(...params,limit,offset) as {summary:string;preview:string;bytes:number;refs:number}[];
    const records=rows.map(row=>({...JSON.parse(row.summary),textPreview:row.preview,textBytes:row.bytes,referenceCount:row.refs}) as LegacyRecordSummary);
    return{records,total,offset,limit};
  }
  record(id:string,recordId:string):LegacyRecord{this.get(id);const row=this.store.db.prepare('SELECT json FROM legacy_records WHERE package_id=? AND record_id=?').get(id,recordId) as {json:string}|undefined;return row?JSON.parse(row.json):fail(404,'원본 객체를 찾을 수 없습니다.');}
  diagnostics(id:string,query:Record<string,unknown>):LegacyDiagnosticPage{
    this.get(id);const {offset,limit}=pageOptions(query),severity=query.severity,params:(string|number)[]=[id];let where='package_id=?';if(severity!==undefined){if(typeof severity!=='string'||!['error','warning','info'].includes(severity))fail(400,'진단 분류를 확인해 주세요.');where+=' AND severity=?';params.push(severity as string);}
    const total=Number((this.store.db.prepare(`SELECT COUNT(*) AS total FROM legacy_diagnostics WHERE ${where}`).get(...params) as {total:number}).total);
    const rows=this.store.db.prepare(`SELECT json FROM legacy_diagnostics WHERE ${where} ORDER BY rowid LIMIT ? OFFSET ?`).all(...params,limit,offset) as {json:string}[];return{diagnostics:rows.map(row=>JSON.parse(row.json) as LegacyDiagnostic),total,offset,limit};
  }
  private analyze(input:{path:string;filename:string;instanceKey:string;product:'auto'|'jira'|'confluence'}):Promise<LegacyAnalysis>{
    return new Promise((resolve,reject)=>{let done=false;const worker=new Worker(new URL('./legacy-import-worker.mjs',import.meta.url),{workerData:input,execArgv:[],resourceLimits:{maxOldGenerationSizeMb:512,maxYoungGenerationSizeMb:64,stackSizeMb:4}});
      const finish=(error?:Error,result?:LegacyAnalysis)=>{if(done)return;done=true;clearTimeout(timer);this.current=null;if(error){void worker.terminate();reject(error);}else resolve(result!);};
      const timer=setTimeout(()=>finish(new LegacyImportError(408,'원본 분석이25초 한도를 초과했습니다. 패키지를 나누어 주세요.')),25000);timer.unref();this.current={worker,reject:error=>finish(error)};
      worker.once('message',(message:{ok:boolean;result?:LegacyAnalysis;status?:number;message?:string})=>{if(message.ok&&message.result)finish(undefined,message.result);else finish(new LegacyImportError(message.status||400,message.message||'원본 분석에 실패했습니다.'));});
      worker.once('error',()=>finish(new LegacyImportError(413,'원본 분석 작업이 중단되었습니다. 크기·형식 또는 메모리 한도를 확인해 주세요.')));
      worker.once('exit',()=>{if(!done)finish(new LegacyImportError(503,'원본 분석 작업이 종료되었습니다. 다시 시도해 주세요.'));});
    });
  }
  async upload(bytes:Buffer,input:{filename:unknown;instanceKey:unknown;product?:unknown},actorId:string,afterSave?:(summary:LegacyPackageSummary)=>void):Promise<{summary:LegacyPackageSummary;duplicate:boolean}>{
    if(this.closed)fail(503,'원본 분석 서비스가 종료되었습니다.');if(this.busy)fail(409,'다른 원본을 분석 중입니다. 완료 후 다시 시도해 주세요.');
    if(!Buffer.isBuffer(bytes)||!bytes.length)fail(400,'분석할 원본 파일이 필요합니다.');if(bytes.length>LEGACY_MAX_RAW_BYTES)fail(413,'원본 파일은64MiB 이하여야 합니다.');
    let filename:string;try{filename=safeFilename(input.filename);}catch{fail(400,'원본 파일명을 확인해 주세요.');}const instanceKey=scalar(input.instanceKey,'원본 인스턴스 식별값',200),product=input.product??'auto';if(!['auto','jira','confluence'].includes(product as string))fail(400,'원본 제품을 확인해 주세요.');
    const sha256=createHash('sha256').update(bytes).digest('hex'),existing=this.store.db.prepare('SELECT json FROM legacy_packages WHERE instance_key=? AND sha256=?').get(instanceKey,sha256) as {json:string}|undefined;
    const previous = existing ? JSON.parse(existing.json) as LegacyPackageSummary : undefined;
    if (previous) {
      if (product !== 'auto' && product !== previous.source.product) fail(400,'동일한 원본의 기존 분석 제품과 선택값이 다릅니다.');
      const detail = this.detail(previous.id);
      const nativeJiraCurrent = previous.source.format !== 'jira-backup-xml' ||
        detail.jiraServiceDeskOwnerEvidenceChecked === true && detail.jiraHistoricalWorkflowEvidenceChecked === true &&
        detail.jiraAdminHistoryVisibilityChecked === true;
      if (detail.sourceEvidenceChecked === true && nativeJiraCurrent) return { summary: previous, duplicate: true };
      filename = previous.filename;
    } else {
      const packages = this.list();
      if (packages.length >= MAX_PACKAGES || packages.reduce((sum, value) => sum + value.size, 0) + bytes.length > MAX_STORED_BYTES) {
        fail(409,'원본 분석 보관 한도(20개·512MiB)에 도달했습니다. 불필요한 패키지를 삭제해 주세요.');
      }
    }
    this.busy=true;const id=previous?.id ?? randomUUID(),pending=join(this.root,`${id}.pending`),bundle=join(this.root,`${id}.bundle`);let committed=false;
    try{
      writeFileSync(pending,bytes,{mode:0o600,flag:'wx',flush:true});syncDirectory(this.root);
      const analysis=await this.analyze({path:pending,filename:filename!,instanceKey,product:previous?.source.product ?? product as 'auto'|'jira'|'confluence'});if(this.closed)fail(503,'원본 분석 서비스가 종료되었습니다.');
      const counts:Partial<Record<LegacyRecordKind,number>>={};for(const value of analysis.dataset.records)counts[value.kind]=(counts[value.kind]||0)+1;
      const summary:LegacyPackageSummary={id,filename:filename!,sha256,size:bytes.length,version:(previous?.version ?? 0)+1,createdAt:previous?.createdAt ?? new Date().toISOString(),actorId,source:analysis.dataset.source,counts,errors:analysis.dataset.diagnostics.filter(value=>value.severity==='error').length,warnings:analysis.dataset.diagnostics.filter(value=>value.severity==='warning').length,fileCount:analysis.files.length,expandedBytes:analysis.expandedBytes,applySupported:false};
      this.store.transaction(()=>{
        if (previous) {
          if (this.get(id).version !== previous.version) fail(409, '원본 분석 버전이 변경되었습니다. 최신 목록을 불러와 주세요.');
          this.store.db.prepare('UPDATE legacy_packages SET json=? WHERE id=?').run(JSON.stringify(summary), id);
          this.store.db.prepare('DELETE FROM legacy_records WHERE package_id=?').run(id);
          this.store.db.prepare('DELETE FROM legacy_diagnostics WHERE package_id=?').run(id);
          this.store.db.prepare('DELETE FROM legacy_file_manifests WHERE package_id=?').run(id);
        } else this.store.db.prepare('INSERT INTO legacy_packages(id,instance_key,sha256,json) VALUES(?,?,?,?)').run(id,instanceKey,sha256,JSON.stringify(summary));
        const putRecord=this.store.db.prepare('INSERT INTO legacy_records(package_id,record_id,kind,title,source_id,json) VALUES(?,?,?,?,?,?)');for(const value of analysis.dataset.records)putRecord.run(id,value.id,value.kind,value.title,value.sourceId,JSON.stringify(value));
        const putDiagnostic=this.store.db.prepare('INSERT INTO legacy_diagnostics(package_id,id,severity,json) VALUES(?,?,?,?)');for(const value of analysis.dataset.diagnostics)putDiagnostic.run(id,value.id,value.severity,JSON.stringify(value));
        const manifest = { files: analysis.files, unsupported: analysis.dataset.unsupported, sourceEvidenceChecked: true,
          ...(summary.source.format === 'jira-backup-xml' ? { jiraBackupLayoutChecked: true, jiraServiceDeskOwnerEvidenceChecked: true,
            jiraHistoricalWorkflowEvidenceChecked: true, jiraAdminHistoryVisibilityChecked: true } : {}) };
        this.store.db.prepare('INSERT INTO legacy_file_manifests(package_id,json) VALUES(?,?)').run(id, JSON.stringify(manifest));afterSave?.(summary);renameSync(pending,bundle);syncDirectory(this.root);
      });committed=true;return{summary,duplicate:Boolean(previous)};
    }finally{this.busy=false;if(!committed){rmSync(pending,{force:true});if(!previous)rmSync(bundle,{force:true});}}
  }
  remove(id:string,expected:unknown,afterRemove?:(summary:LegacyPackageSummary)=>void):void{
    this.store.transaction(()=>{const summary=this.get(id);if(!Number.isSafeInteger(expected))fail(400,'expectedVersion이 필요합니다.');if(expected!==summary.version)fail(409,'원본 분석 버전이 다릅니다. 최신 목록을 불러와 주세요.');this.store.db.prepare('DELETE FROM legacy_packages WHERE id=?').run(id);afterRemove?.(summary);});
    try{rmSync(join(this.root,`${id}.bundle`),{force:true});syncDirectory(this.root);}catch{console.error('[teamspace legacy import] 삭제한 원본 파일 정리가 필요합니다.');}
  }
  close():void{this.closed=true;this.current?.reject(new LegacyImportError(503,'원본 분석 서비스가 종료되었습니다.'));}
  registerRoutes(app:Express,hooks:Hooks):void{
    const query=(req:Request,allowed:string[])=>{if(Object.keys(req.query).some(key=>!allowed.includes(key)))fail(400,'지원하지 않는 원본 분석 조회 조건입니다.');return req.query;};
    app.get('/api/legacy-import/packages',(req,res)=>{query(req,[]);res.json(this.list());});
    app.post('/api/legacy-import/packages',async(req,res)=>{const actorId=hooks.actor(req),input=query(req,['filename','instanceKey','product']);const result=await this.upload(req.body,{filename:input.filename,instanceKey:input.instanceKey,product:input.product},actorId,value=>hooks.activity(req,'legacy-package',value.id,'원본 패키지 분석',`${value.filename} · ${Object.values(value.counts).reduce((a,b)=>a+(b||0),0)}개 객체`));res.status(result.duplicate?200:201).json(result.summary);});
    app.get('/api/legacy-import/packages/:id',(req,res)=>{query(req,[]);const { summary, files, unsupported } = this.detail(String(req.params.id));res.json({ summary, files, unsupported });});
    app.get('/api/legacy-import/packages/:id/records',(req,res)=>res.json(this.records(String(req.params.id),query(req,['kind','q','offset','limit']))));
    app.get('/api/legacy-import/packages/:id/records/:recordId',(req,res)=>{query(req,[]);res.json(this.record(String(req.params.id),String(req.params.recordId)));});
    app.get('/api/legacy-import/packages/:id/diagnostics',(req,res)=>res.json(this.diagnostics(String(req.params.id),query(req,['severity','offset','limit']))));
    app.delete('/api/legacy-import/packages/:id',(req,res)=>{hooks.actor(req);query(req,['expectedVersion']);const expected=req.body?.expectedVersion??(req.query.expectedVersion===undefined?undefined:Number(req.query.expectedVersion));this.remove(String(req.params.id),expected,value=>hooks.activity(req,'legacy-package',value.id,'원본 패키지 분석 삭제',value.filename));res.json({ok:true});});
  }
}
