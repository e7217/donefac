import { parentPort,workerData } from 'node:worker_threads';
import { tsImport } from 'tsx/esm/api';

try{
  const {analyzeLegacyPackage}=await tsImport('./legacy-import-analysis.ts',import.meta.url);
  parentPort.postMessage({ok:true,result:await analyzeLegacyPackage(workerData)});
}catch(error){
  const status=Number.isInteger(error?.status)&&error.status>=400&&error.status<=599?error.status:400;
  parentPort.postMessage({ok:false,status,message:status===500?'원본 분석을 완료하지 못했습니다.':String(error?.message||'원본 파일을 확인해 주세요.').slice(0,2000)});
}finally{parentPort.close();}
