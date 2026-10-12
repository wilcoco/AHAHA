import { AppError } from './llm.js';

export function branchPoint(messages:any[], data:Record<string,unknown>){
  const mode=String(data.mode);
  const index=data.message_id!==undefined?messages.findIndex(m=>m.id===data.message_id):data.message_index;
  if(!Number.isInteger(index)||Number(index)<0||Number(index)>=messages.length||!['rewrite','continue','quote','regenerate'].includes(mode))throw new AppError(400,'invalid_branch_point','분기할 질문이나 답변을 선택하세요.');
  if(data.message_id!==undefined&&data.message_index!==undefined&&data.message_index!==index)throw new AppError(409,'branch_changed','선택한 문답이 변경됐습니다. 다시 열어 주세요.');
  const message=messages[Number(index)];
  if(mode==='rewrite'&&message.role!=='user'||mode!=='rewrite'&&message.role!=='assistant')throw new AppError(400,'invalid_branch_point','질문이나 답변에 맞는 작업을 선택하세요.');
  let count=Number(index)+(mode==='continue'?1:0),input=mode==='rewrite'?message.content:'';
  if(mode==='regenerate'){
    if(Number(index)<1||messages[Number(index)-1].role!=='user')throw new AppError(400,'invalid_branch_point','이 답변 앞의 질문을 찾을 수 없습니다.');
    count=Number(index)-1;input=messages[count].content;
  }
  return {messages:mode==='quote'?[]:messages.slice(0,count),input,anchor:{message_id:message.id,message_index:Number(index),mode,inherited_count:mode==='quote'?0:count,excerpt:message.content.slice(0,240),...(mode==='quote'?{quote:message.content}:{})}};
}

export type DiffRow={kind:'same'|'add'|'remove';text:string;before:number|null;after:number|null};
/** Exact line comparison with bounded memory. Large inputs fall back to an exact prefix/suffix replacement. */
export function documentDiff(before:string,after:string){
  const a=before?before.split('\n'):[],b=after?after.split('\n'):[];const rows:DiffRow[]=[];
  let i=0,j=0;const emit=(kind:DiffRow['kind'])=>{rows.push({kind,text:kind==='add'?b[j]:a[i],before:kind==='add'?null:i+1,after:kind==='remove'?null:j+1});if(kind!=='add')i++;if(kind!=='remove')j++;};
  const simplified=a.length*b.length>600000;
  if(simplified){
    while(i<a.length&&j<b.length&&a[i]===b[j])emit('same');
    let tail=0;while(a.length-tail>i&&b.length-tail>j&&a[a.length-1-tail]===b[b.length-1-tail])tail++;
    while(i<a.length-tail)emit('remove');while(j<b.length-tail)emit('add');while(i<a.length)emit('same');
  }else{
    const width=b.length+1,dp=new Uint16Array((a.length+1)*width);
    for(let x=a.length-1;x>=0;x--)for(let y=b.length-1;y>=0;y--)dp[x*width+y]=a[x]===b[y]?dp[(x+1)*width+y+1]+1:Math.max(dp[(x+1)*width+y],dp[x*width+y+1]);
    while(i<a.length||j<b.length){if(i<a.length&&j<b.length&&a[i]===b[j])emit('same');else if(i<a.length&&(j===b.length||dp[(i+1)*width+j]>=dp[i*width+j+1]))emit('remove');else emit('add');}
  }
  return {rows,added:rows.filter(r=>r.kind==='add').length,removed:rows.filter(r=>r.kind==='remove').length,simplified};
}

export function transcriptDiff(before:any[],after:any[]){
  let common=0;while(common<before.length&&common<after.length&&before[common].role===after[common].role&&before[common].content===after[common].content)common++;
  return {common,removed:before.slice(common),added:after.slice(common)};
}
