// Dependency-free render and interaction smoke test: node tests/smoke.test.js
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const actions={};
let markup='';
const root={
  get innerHTML(){return markup},
  set innerHTML(s){markup=s},
  addEventListener(type,handler){actions[type]=handler;}
};
const ctx={
  document:{getElementById:id=>id==='app'?root:null,querySelectorAll:()=>[]},
  location:{search:'',href:'http://localhost:8000/index.html',pathname:'/index.html'},
  history:{replaceState(){}},
  window:{scrollTo(){},addEventListener(){}},
  navigator:{},
  requestAnimationFrame:cb=>cb(),
  Intl,
  URLSearchParams,
  console
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../app.js'),'utf8'),ctx);
const click=async (action,data={})=>{
  const node={dataset:{action,...data}};
  await actions.click({target:{closest:()=>node},preventDefault(){}});
};
async function run(){
  assert.match(markup,/Good morning/);
  assert.match(markup,/€327\.40/);
  const screens=[['home','Good morning'],['chats','Search chats'],['group','Electricity'],['add','Split between'],['receipt','PIZZA E PASTA'],['request','Max owes you'],['payments','Choose payment method'],['activity','Yesterday'],['recurring','Spotify Family'],['invite','Invite via link']];
  for(const [id,expected] of screens){await click('go',{screen:id});assert.ok(markup.includes(expected),`${id} failed to render`)}
  await click('go',{screen:'add'});
  await click('saveexpense');
  assert.match(markup,/Expense added to Apartment/);
  assert.match(markup,/Dinner at L’Osteria/);
  await click('go',{screen:'payments'});
  await click('method',{method:'Apple Pay'});
  assert.match(markup,/Simulate payment/);
  await click('simulate');
  assert.match(markup,/All settled!/);
  await click('go',{screen:'activity'});
  assert.match(markup,/Demo settlement completed/);
  await click('gallery');
  for(const [id,expected] of screens) assert.ok(markup.includes(expected),`gallery missing ${id}`);
  console.log('PASS: all 10 screens, add expense, mock payment, activity, and gallery.');
}
run().catch(e=>{console.error(e);process.exitCode=1});
