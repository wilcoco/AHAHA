import test from 'node:test';
import assert from 'node:assert/strict';
import { documentDiff,transcriptDiff } from '../src/versioning.js';

test('line comparison reconstructs both versions, including empty and repeated lines',()=>{
 for(const [before,after] of [['',''],['','새 문서'],['삭제',''],['a\nb\na','a\nc\na'],['# 제목\n\n한글','새 제목\n\n한글'],['x\n','x']]){
  const d=documentDiff(before,after);
  assert.equal(d.rows.filter(r=>r.kind!=='add').map(r=>r.text).join('\n'),before);
  assert.equal(d.rows.filter(r=>r.kind!=='remove').map(r=>r.text).join('\n'),after);
 }
 const d=documentDiff('first\nold\nlast','first\nnew\nlast');assert.equal(d.added,1);assert.equal(d.removed,1);
});
test('large diff remains bounded and retains exact text, without treating markup as HTML',()=>{
 const before='prefix\n'+'old\n'.repeat(1000)+'suffix',after='prefix\n'+'<img onerror=x>\n'.repeat(1000)+'suffix';
 const d=documentDiff(before,after);assert.equal(d.simplified,true);
 assert.equal(d.rows.filter(r=>r.kind!=='add').map(r=>r.text).join('\n'),before);
 assert.equal(d.rows.filter(r=>r.kind!=='remove').map(r=>r.text).join('\n'),after);
});
test('transcript comparison identifies the common prefix rather than matching later duplicate answers',()=>{
 const msg=(content:string)=>({role:'user',content});
 const d=transcriptDiff([msg('a'),msg('b'),msg('a')],[msg('a'),msg('c'),msg('a')]);
 assert.equal(d.common,1);assert.equal(d.removed.length,2);assert.equal(d.added.length,2);
});
