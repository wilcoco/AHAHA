import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDocument, documentRendererScript, groundDocumentLinks } from '../src/document.js';
import { workspacePage } from '../src/workspace-ui.js';
import { publishedArticle, blogHome } from '../src/blog-ui.js';

test('documents render readable Markdown without executable HTML or links',()=>{
 const bad='# Title\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[click](javascript:alert(1))\n\n```\n</code><img src=x>\n```';
 const html=renderDocument(bad);
 assert.match(html,/<h2>Title<\/h2>/);assert(!html.includes('<script'));assert(!html.includes('<img'));assert(!html.includes('href='));
 const e={id:'test',title:'<svg onload=alert(1)>',username:'writer',document_body:bad,topic:'x',relation_kind:'original',version_number:1};
 const article=publishedArticle(e,[{role:'user',content:bad}],[],{total:0,supporters:0});
 assert(!article.includes('<svg'));assert(!article.includes('<script'));assert(!article.includes('<img'));
 assert(!blogHome({...e,display_name:e.title},[e]).includes('<svg'));
});

test('workspace script embeds the shared renderer as self-contained valid JavaScript',()=>{
 assert.equal(new Function('return '+documentRendererScript())()('# Browser\n\n**Bold**'),renderDocument('# Browser\n\n**Bold**'));
 for(const signedIn of [false,true]){
  const scripts=[...workspacePage(signedIn).matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length,1);new Function(scripts[0][1]);
 }
});


test('generated citation destinations must be present in the supplied material',()=>{
 const path='/chat?exploration=12345678-1234-1234-1234-123456789abc';
 const input=JSON.stringify({references:[{url:path,body:'https://example.com/evidence?x=1&y=2'}]});
 const result=groundDocumentLinks('[Blog]('+path+') and [wrong](https://obsidian.md) and https://example.com/evidence?x=1&y=2. New https://invented.example/story.',input);
 assert(result.includes(path));assert(result.includes('https://example.com/evidence?x=1&y=2.'));
 assert(!result.includes('obsidian.md'));assert(!result.includes('invented.example'));assert.match(result,/wrong \[출처 링크 확인 필요\]/);
 assert.equal(groundDocumentLinks('No links; keep the author’s wording.',''),'No links; keep the author’s wording.');
 assert(!groundDocumentLinks('https://example.com/evidence/forged','https://example.com/evidence').includes('https://'));
});
