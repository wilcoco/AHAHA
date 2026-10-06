import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDocument, documentRendererScript } from '../src/document.js';
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
