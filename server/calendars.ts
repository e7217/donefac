import type { Express,Request } from 'express';
import type { Project,WorkCalendar } from '../shared/types.js';
import { CalendarError,defaultWorkCalendar,validateWorkCalendar } from '../shared/calendar.js';
import { Store } from './store.js';
export { CalendarError } from '../shared/calendar.js';

function fail(message:string,status=400):never{throw new CalendarError(status,message);}
export class CalendarService{
  constructor(private readonly store:Store){store.db.exec('CREATE TABLE IF NOT EXISTS project_calendars(id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,json TEXT NOT NULL)');}
  get(projectId:string):WorkCalendar{const project=this.store.get<Project>('projects',projectId);if(!project)fail('프로젝트를 찾을 수 없습니다.',404);return this.store.get<WorkCalendar>('project_calendars',projectId)||defaultWorkCalendar(projectId,project.createdAt);}
  snapshot():WorkCalendar[]{return this.store.all<Project>('projects').map(project=>this.get(project.id));}
  save(projectId:string,input:unknown,expectedVersion:unknown,afterSave?:(calendar:WorkCalendar)=>void):WorkCalendar{
    return this.store.transaction(()=>{const old=this.get(projectId);if(!Number.isSafeInteger(expectedVersion)||Number(expectedVersion)<1)fail('expectedVersion이 필요합니다.');if(old.version!==expectedVersion)fail('작업 달력이 변경되었습니다. 최신 내용을 불러와 주세요.',409);
      if(!input||typeof input!=='object'||Array.isArray(input))fail('작업 달력 설정이 필요합니다.');const value=input as Record<string,unknown>;
      if(('id'in value&&value.id!==projectId)||('projectId'in value&&value.projectId!==projectId))fail('달력의 프로젝트는 변경할 수 없습니다.');
      const updated=validateWorkCalendar({...old,...Object.fromEntries(['name','workingWeekdays','exceptions'].filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]])),version:old.version+1,updatedAt:new Date().toISOString()},projectId);this.store.put('project_calendars',updated);afterSave?.(updated);return updated;
    });
  }
  validateImport(raw:unknown,projects:Project[],options:{legacy?:boolean}={}):WorkCalendar[]{
    if(!Array.isArray(raw))fail('작업 달력 목록이 필요합니다.');if(options.legacy)return projects.map(project=>defaultWorkCalendar(project.id,project.createdAt));
    if(raw.length!==projects.length)fail('각 프로젝트의 작업 달력이 하나씩 필요합니다.');const seen=new Set<string>();
    return raw.map(value=>{const calendar=validateWorkCalendar(value);if(seen.has(calendar.projectId)||!projects.some(project=>project.id===calendar.projectId))fail('달력의 프로젝트가 중복되거나 올바르지 않습니다.');seen.add(calendar.projectId);return calendar;});
  }
  replaceImported(values:WorkCalendar[],previousVersions=new Map(this.snapshot().map(calendar=>[calendar.projectId,calendar.version]))){this.store.db.exec('DELETE FROM project_calendars');for(const value of values){const old=previousVersions.get(value.projectId);this.store.put('project_calendars',{...value,version:old===undefined?value.version:Math.max(old,value.version)+1});}}
  registerRoutes(app:Express,hooks:{actor:(req:Request)=>string;activity:(req:Request,type:string,id:string,action:string,detail?:string)=>unknown}){
    app.get('/api/projects/:projectId/calendar',(req,res)=>res.json(this.get(String(req.params.projectId))));
    app.patch('/api/projects/:projectId/calendar',(req,res)=>{hooks.actor(req);res.json(this.save(String(req.params.projectId),req.body,req.body.expectedVersion,value=>hooks.activity(req,'project',value.projectId,'작업 달력 변경',`버전 ${value.version}`)));});
  }
}
