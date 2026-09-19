const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const store=new Map();
const localStorage={getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)};
function boot(){
 const events={};let markup='';
 const root={get innerHTML(){return markup},set innerHTML(v){markup=v},addEventListener:(n,fn)=>events[n]=fn};
 const document={getElementById:()=>root,querySelectorAll:()=>[]};
 const ctx={document,localStorage,window:{scrollTo(){},addEventListener(){},matchMedia:()=>({matches:false})},location:{search:'',href:'http://localhost:8000/',pathname:'/'},history:{replaceState(){}},navigator:{},requestAnimationFrame:fn=>fn(),Intl,URLSearchParams,console};
 vm.runInNewContext(code,ctx);
 return {view:()=>markup,click:async(action,more={})=>events.click({target:{closest:()=>({dataset:{action,...more}})},preventDefault(){}}),type:async(field,value)=>events.input({target:{dataset:{field},value}})};
}
(async()=>{
 let x=boot();await x.click('go',{screen:'group'});
 assert.match(x.view(),/Needs your approval/);
 await x.click('billdetail');assert.match(x.view(),/Max requested from you/);
 await x.click('approveOwe');assert.match(x.view(),/Approved/);
 await x.click('go',{screen:'group'});assert.match(x.view(),/✓ Approved/);
 assert.match(store.get('payly-demo-v2'),/"approval":true/);
 x=boot();await x.click('go',{screen:'request'});await x.click('requestView',{view:'owe'});assert.match(x.view(),/Approved/);
 await x.click('disputeOwe');await x.type('disputeDraft','I was away this month');await x.click('submitDispute');assert.match(x.view(),/I was away this month/);
 await x.click('go',{screen:'add'});await x.click('saveexpense');assert.match(x.view(),/Awaiting approval/);
 const id=JSON.parse(store.get('payly-demo-v2')).expenses[0].id;
 await x.click('expenseDetail',{id});assert.match(x.view(),/Try a recipient/);
 await x.click('expenseViewer',{person:'max'});assert.match(x.view(),/Approve my share/);
 await x.click('expenseApprove');assert.match(x.view(),/Approved/);
 const saved=JSON.parse(store.get('payly-demo-v2'));
 assert.equal(saved.expenses[0].approvals.max,'approved');
 assert.equal(saved.expenses[0].approvals.sophie,'pending');
 x=boot();await x.click('go',{screen:'group'});assert.match(x.view(),/Max:/);assert.match(x.view(),/Approved/);
 await x.click('reset');assert.equal(store.has('payly-demo-v2'),false);
 console.log('PASS V2: self approval, dispute, recipient preview, per-person state, persistence, reset.');
})().catch(err=>{console.error(err);process.exitCode=1});
