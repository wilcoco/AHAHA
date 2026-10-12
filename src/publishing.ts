import { randomUUID } from 'node:crypto';
import { AppError } from './llm.js';

export const identified = (messages:any[]) => messages.map(m=>({...m,id:m.id||randomUUID()}));

/** Import is private and never treats a pasted system instruction as an actual system prompt. */
export function parseImport(value:unknown,platform:unknown){
  if(typeof value!=='string'||!value.trim()||value.length>56000)throw new AppError(400,'invalid_import','1~56,000자의 대화를 입력하세요.');
  if(typeof platform!=='string'||!platform.trim()||platform.length>80)throw new AppError(400,'invalid_import','원래 사용한 서비스 또는 출처 미상을 입력하세요.');
  const parts=value.split(/^\s*>>>>>\s*$/m).map(s=>s.trim());
  if(parts.length<2||parts.length>80||parts.length%2||parts.some(s=>!s||s.length>16000))throw new AppError(400,'invalid_import','질문과 답변을 번갈아 넣고 사이에 >>>>> 줄을 넣으세요. 최대 40문답, 메시지당 16,000자입니다.');
  return parts.map((content,i)=>({id:randomUUID(),role:i%2?'assistant':'user',content,source_platform:platform.trim()}));
}

/** Public copy contains only explicitly reviewed fields; summaries and private references never survive redaction. */
export function publicationProjection(e:any,messages:any[],data:Record<string,unknown>){
  const edits=data.messages;
  let selected=messages;
  if(edits!==undefined){
    if(!Array.isArray(edits)||edits.length>100)throw new AppError(400,'invalid_publication','발행할 문답을 확인하세요.');
    const byId=new Map(messages.map(m=>[m.id,m]));const seen=new Set();let last=-1;
    selected=edits.map((item:any)=>{
      if(!item||!byId.has(item.id)||seen.has(item.id)||typeof item.content!=='string'||!item.content.trim()||item.content.length>16000)throw new AppError(400,'invalid_publication','문답 선택과 가린 내용을 확인하세요.');
      const index=messages.findIndex(m=>m.id===item.id);if(index<=last)throw new AppError(400,'invalid_publication','문답 순서는 원문과 같아야 합니다.');last=index;seen.add(item.id);
      return {...byId.get(item.id),content:item.content.trim()};
    });
  }
  const clean=(v:unknown,max:number)=>{if(typeof v!=='string'||v.length>max)throw new AppError(400,'invalid_publication','발행 내용을 확인하세요.');return v.trim();};
  const title=clean(data.title??e.title,150);if(!title)throw new AppError(400,'invalid_publication','제목을 입력하세요.');
  // An edited selection defaults to no document: a document can contain excluded conversation details.
  const includeDocument=data.include_document===true||(edits===undefined&&data.include_document!==false);
  const document=includeDocument?clean(data.document_body??e.document_body??'',30000):'';
  if(!selected.length&&!document)throw new AppError(400,'empty_publication','대화나 문서 중 하나는 포함하세요.');
  return {title,system_prompt:data.include_setup===true?clean(e.system_prompt??'',6000):'',opening_question:selected.find(m=>m.role==='user')?.content||'',document_body:document,
    author_note:clean(data.author_note??'',3000),messages:selected.map(m=>({id:m.id,role:m.role,content:m.content,
      ...(m.model?{model:m.model}:{}),...(m.provider?{provider:m.provider}:{}),...(m.source_platform?{source_platform:m.source_platform}:{})}))};
}
