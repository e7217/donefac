import type { WorkCalendar } from './types.js';

export class CalendarError extends Error {constructor(public status:number,message:string,public details?:unknown){super(message);}}
function invalid(message:string,status=400):never{throw new CalendarError(status,message);}
export const MIN_CALENDAR_DATE='0000-01-01',MAX_CALENDAR_DATE='9999-12-31';
const DAY=86400000,MIN_DAY=Math.floor(Date.parse(MIN_CALENDAR_DATE+'T00:00:00Z')/DAY),MAX_DAY=Math.floor(Date.parse(MAX_CALENDAR_DATE+'T00:00:00Z')/DAY);
export function isCalendarDate(value:unknown):value is string{return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;}
export function calendarDay(value:unknown):number{if(!isCalendarDate(value))invalid('날짜는 유효한 YYYY-MM-DD 형식이어야 합니다.');return Math.floor(Date.parse(value+'T00:00:00Z')/DAY);}
export function calendarDate(day:number):string{if(!Number.isSafeInteger(day)||day<MIN_DAY||day>MAX_DAY)invalid('작업일 계산이 0000~9999년 날짜 범위를 벗어났습니다.');return new Date(day*DAY).toISOString().slice(0,10);}
export function defaultWorkCalendar(projectId:string,updatedAt='1970-01-01T00:00:00.000Z'):WorkCalendar{return{id:projectId,projectId,name:'기본 작업 달력',workingWeekdays:[1,2,3,4,5],exceptions:[],version:1,updatedAt};}
export const defaultCalendar=defaultWorkCalendar;
export function validateWorkCalendar(value:unknown,projectId?:string):WorkCalendar{
  if(!value||typeof value!=='object'||Array.isArray(value))invalid('작업 달력 객체가 필요합니다.');const v=value as Record<string,any>;
  if(typeof v.projectId!=='string'||!v.projectId||v.id!==v.projectId||(projectId!==undefined&&v.projectId!==projectId))invalid('작업 달력의 프로젝트 ID가 올바르지 않습니다.');
  if(typeof v.name!=='string'||!v.name.trim()||v.name.length>120)invalid('달력 이름은 1~120자여야 합니다.');
  if(!Array.isArray(v.workingWeekdays)||!v.workingWeekdays.length||v.workingWeekdays.length>7||v.workingWeekdays.some((day:unknown)=>!Number.isInteger(day)||Number(day)<0||Number(day)>6)||new Set(v.workingWeekdays).size!==v.workingWeekdays.length)invalid('일주일에 최소 하루 이상, 중복되지 않은 작업 요일을 선택해 주세요.');
  if(!Array.isArray(v.exceptions)||v.exceptions.length>10000)invalid('날짜별 예외는 10,000개 이하여야 합니다.');const dates=new Set<string>();
  const exceptions=v.exceptions.map((entry:any)=>{if(!entry||!isCalendarDate(entry.date)||dates.has(entry.date)||typeof entry.isWorking!=='boolean'||typeof entry.label!=='string'||entry.label.length>120)invalid('날짜별 예외의 날짜·작업 여부·이름을 확인해 주세요.');dates.add(entry.date);return{date:entry.date,isWorking:entry.isWorking,label:entry.label};});
  if(!Number.isSafeInteger(v.version)||v.version<1||typeof v.updatedAt!=='string'||!Number.isFinite(Date.parse(v.updatedAt)))invalid('작업 달력 버전과 수정 시간을 확인해 주세요.');
  return{id:v.projectId,projectId:v.projectId,name:v.name,workingWeekdays:[...v.workingWeekdays].sort((a,b)=>a-b),exceptions:exceptions.sort((a:any,b:any)=>a.date.localeCompare(b.date)),version:v.version,updatedAt:v.updatedAt};
}
const weekday=(day:number)=>((day+4)%7+7)%7;
function lowerBound(values:number[],value:number){let lo=0,hi=values.length;while(lo<hi){const mid=Math.floor((lo+hi)/2);if(values[mid]<value)lo=mid+1;else hi=mid;}return lo;}

/** Full weeks + exception prefix sums keep even 0000..9999 range counts bounded. */
export function createCalendarMath(calendar:WorkCalendar){
  const checked=validateWorkCalendar(calendar),week=new Set(checked.workingWeekdays);
  const exceptions=checked.exceptions.map(e=>({day:calendarDay(e.date),working:e.isWorking}));
  const days=exceptions.map(e=>e.day),prefix=[0];
  for(const exception of exceptions)prefix.push(prefix.at(-1)!+Number(exception.working)-Number(week.has(weekday(exception.day))));
  const overrides=new Map(exceptions.map(e=>[e.day,e.working]));
  const working=(day:number)=>overrides.get(day)??week.has(weekday(day));
  const count=(start:number,end:number)=>{
    if(start>end)return 0;const span=end-start+1,full=Math.floor(span/7);let total=full*week.size;
    for(let i=0;i<span%7;i++)if(week.has(weekday(start+i)))total++;
    return total+prefix[lowerBound(days,end+1)]-prefix[lowerBound(days,start)];
  };
  const shift=(date:string,amount:number)=>{
    const start=calendarDay(date);if(!Number.isSafeInteger(amount))invalid('작업일 이동 일수는 정수여야 합니다.');if(amount===0)return date;
    if(amount>0){if(count(start+1,MAX_DAY)<amount)invalid('이후에 필요한 작업일이 없거나 날짜 범위를 벗어났습니다.');let lo=start+1,hi=MAX_DAY;while(lo<hi){const mid=Math.floor((lo+hi)/2);if(count(start+1,mid)>=amount)hi=mid;else lo=mid+1;}return calendarDate(lo);}
    const needed=-amount;if(count(MIN_DAY,start-1)<needed)invalid('이전에 필요한 작업일이 없거나 날짜 범위를 벗어났습니다.');let lo=MIN_DAY,hi=start-1;while(lo<hi){const mid=Math.floor((lo+hi+1)/2);if(count(mid,start-1)>=needed)lo=mid;else hi=mid-1;}return calendarDate(lo);
  };
  return{
    isWorking:(date:string)=>working(calendarDay(date)),
    count:(start:string,end:string)=>{const a=calendarDay(start),b=calendarDay(end);if(a>b)invalid('종료일은 시작일보다 빠를 수 없습니다.');return count(a,b);},
    shift,
    onOrAfter:(date:string)=>working(calendarDay(date))?date:shift(date,1),
  };
}
export function isWorkingDate(calendar:WorkCalendar,date:string):boolean;
export function isWorkingDate(date:string,calendar:WorkCalendar):boolean;
export function isWorkingDate(a:WorkCalendar|string,b:string|WorkCalendar){return typeof a==='string'?createCalendarMath(b as WorkCalendar).isWorking(a):createCalendarMath(a).isWorking(b as string);}
export function shiftWorkingDate(date:string,amount:number,calendar:WorkCalendar):string;
export function shiftWorkingDate(calendar:WorkCalendar,date:string,amount:number):string;
export function shiftWorkingDate(a:WorkCalendar|string,b:string|number,c:WorkCalendar|number){return typeof a==='string'?createCalendarMath(c as WorkCalendar).shift(a,b as number):createCalendarMath(a).shift(b as string,c as number);}
export function countWorkingDays(start:string,end:string,calendar:WorkCalendar):number;
export function countWorkingDays(calendar:WorkCalendar,start:string,end:string):number;
export function countWorkingDays(a:WorkCalendar|string,b:string,c:WorkCalendar|string){return typeof a==='string'?createCalendarMath(c as WorkCalendar).count(a,b):createCalendarMath(a).count(b,c as string);}
export const workingDuration=countWorkingDays;
export function workingDateOnOrAfter(date:string,calendar:WorkCalendar){return createCalendarMath(calendar).onOrAfter(date);}
