import test from 'node:test';
import assert from 'node:assert/strict';
import {composerState} from '../src/composer.js';
const initial={signedIn:true,selected:false,loading:false,busy:false,full:false,ready:false,settingsLoaded:false,settingsError:'',hasText:true};
test('writing is allowed before AI settings load, but sending waits for readiness',()=>{
 assert.equal(composerState(initial).inputDisabled,false);
 assert.equal(composerState(initial).sendDisabled,true);
 assert.equal(composerState({...initial,ready:true,settingsLoaded:true}).sendDisabled,false);
});
test('settings failure does not prevent editing a draft',()=>{
 const state=composerState({...initial,settingsError:'timeout'});assert.equal(state.inputDisabled,false);assert.equal(state.sendDisabled,true);assert.match(state.reason,/다시 연결/);
});
test('restoring an existing conversation and viewing published content remain protected',()=>{
 for(const change of [{loading:true},{selected:true},{signedIn:false},{busy:true},{full:true}])assert.equal(composerState({...initial,ready:true,...change}).inputDisabled,true);
});
