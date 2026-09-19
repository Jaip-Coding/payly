/* Payly Cloud: Supabase-backed authenticated chats & expenses. No payment processing.
   Never put a service_role/secret key here. The database enforces membership and ownership. */
(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const eur = cents => new Intl.NumberFormat('en-IE',{style:'currency',currency:'EUR'}).format((Number(cents)||0)/100);
  const clock = iso => new Date(iso).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  const icons = {
    home:'<path d="m3 10 9-7 9 7v10H4zM9 21v-8h6v8"/>',chats:'<path d="M21 11.5A8.5 8.5 0 0 1 9 19.5L3 21l2-5A8.5 8.5 0 1 1 21 11.5z"/>',
    plus:'<path d="M12 4v16M4 12h16"/>',activity:'<path d="M4 19v-5m6 5V8m6 11V6m5 13V3"/>',user:'<circle cx="12" cy="7" r="4"/><path d="M4 21v-1a8 8 0 0 1 16 0v1"/>',
    left:'<path d="m15 18-6-6 6-6"/>',chevron:'<path d="m9 18 6-6-6-6"/>',check:'<path d="m4 12 5 5L20 6"/>',share:'<path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/>',
    send:'<path d="m22 2-7 20-4-9-9-4zM22 2 11 13"/>',bell:'<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
    search:'<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',copy:'<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    users:'<circle cx="9" cy="8" r="4"/><path d="M2 21v-2a7 7 0 0 1 14 0v2M16 4a4 4 0 0 1 0 8M17 16a6 6 0 0 1 5 5"/>'
  };
  const icon = (name,size=20) => `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]||icons.check}</svg>`;
  const btn = (label,act,variant='',other='') => `<button class="green-button ${variant}" type="button" data-act="${act}" ${other}>${label}</button>`;
  const state = {
    client:null, user:null, profile:null, screen:'home', authMode:'signup', authNotice:'', recovery:false, error:'', busy:false,
    chats:[], members:[], profiles:[], messages:[], expenses:[], shares:[], allExpenses:[], allShares:[], chatId:null,
    inviteToken:'', inviteLink:'', openedExpense:null, splitIds:[], splitMode:'Equally',
    inputTitle:'', inputAmount:'', custom:{}, notice:'', search:'', loading:false, lastSync:0
  };
  const $app = document.getElementById('app');
  let generation = 0;
  let realtimeChannel = null;
  const findChat = id => state.chats.find(c=>c.id===id);
  const myName = () => state.profile?.display_name || state.user?.email?.split('@')[0] || 'Friend';
  const getName = id => id===state.user?.id ? 'You' : (state.profiles.find(p=>p.id===id)?.display_name || 'Member');
  const memberIds = id => state.members.filter(m=>m.chat_id===id).map(m=>m.user_id);
  const initials = name => String(name||'?').trim().split(/\s+/).slice(0,2).map(x=>x[0]).join('').toUpperCase();
  const avatar = (name,shade='') => `<span class="cloud-avatar ${shade}" aria-hidden="true">${esc(initials(name))}</span>`;
  const title = chat => !chat ? 'Chats' : chat.kind==='direct' ?
    (memberIds(chat.id).filter(id=>id!==state.user?.id).map(getName)[0] || 'Invite a friend') : chat.name;
  const selectChat = () => findChat(state.chatId);
  const getInviteFromURL = () => {
    // Invite secrets use a query parameter so they survive Supabase email confirmation redirects.
    // We immediately remove the token from the visible URL after reading it and keep it only
    // in local browser storage until it is redeemed or dismissed.
    const params = new URLSearchParams(location.search);
    let token = params.get('invite') || '';
    if(!token && location.hash.startsWith('#')) token = new URLSearchParams(location.hash.slice(1)).get('invite') || ''; // V2/V3-alpha links
    if(token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
      state.inviteToken=token;
      try{localStorage.setItem('payly-invite',token);}catch(_){}
      params.delete('invite');
      const cleaned = location.pathname + (params.toString()?('?'+params.toString()):'');
      history.replaceState(null,'',cleaned);
    } else {try{state.inviteToken=localStorage.getItem('payly-invite')||'';}catch(_){}}
  };
  const throwErr = ({error}) => {if(error) throw error;};
  async function rpc(name,params){const result=await state.client.rpc(name,params);throwErr(result);return result.data;}
  function setError(err){state.error=err?.message || String(err);state.busy=false;render();}
  function notice(message){state.notice=message;state.error='';render();}
  function clearInvite(){state.inviteToken='';try{localStorage.removeItem('payly-invite');}catch(_){}history.replaceState(null,'',location.pathname+location.search);}
  async function refresh(silent=false){
    if(!state.user || state.loading) return;
    state.loading=true;const me=state.user.id, seq=generation;
    try{
      const c=await state.client.from('chats').select('id,name,kind,created_by,created_at').order('created_at',{ascending:false});throwErr(c);
      if(seq!==generation)return;
      const chats=c.data||[], ids=chats.map(x=>x.id);
      let members=[],profiles=[],messages=[],expenses=[],shares=[],allExpenses=[],allShares=[];
      if(ids.length){
        const m=await state.client.from('chat_members').select('chat_id,user_id,role,joined_at').in('chat_id',ids);throwErr(m);members=m.data||[];
        const userIDs=[...new Set([...members.map(x=>x.user_id),me])];
        const p=await state.client.from('profiles').select('id,display_name').in('id',userIDs);throwErr(p);profiles=p.data||[];
        const ae=await state.client.from('expenses').select('id,chat_id,paid_by,title,amount_cents').in('chat_id',ids).order('created_at',{ascending:false}).limit(300);throwErr(ae);allExpenses=ae.data||[];
        if(allExpenses.length){const ash=await state.client.from('expense_shares').select('expense_id,user_id,amount_cents,status').in('expense_id',allExpenses.map(x=>x.id));throwErr(ash);allShares=ash.data||[];}
      } else {
        const p=await state.client.from('profiles').select('id,display_name').eq('id',me);throwErr(p);profiles=p.data||[];
      }
      if(state.chatId && ids.includes(state.chatId)){
        const msg=await state.client.from('messages').select('id,chat_id,sender_id,body,created_at').eq('chat_id',state.chatId).order('created_at',{ascending:false}).limit(150);throwErr(msg);messages=(msg.data||[]).reverse();
        const ex=await state.client.from('expenses').select('id,chat_id,title,amount_cents,paid_by,created_at').eq('chat_id',state.chatId).order('created_at',{ascending:false}).limit(80);throwErr(ex);expenses=ex.data||[];
        if(expenses.length){const sh=await state.client.from('expense_shares').select('expense_id,user_id,amount_cents,status,question,responded_at').in('expense_id',expenses.map(x=>x.id));throwErr(sh);shares=sh.data||[];}
      }
      if(seq!==generation)return;
      Object.assign(state,{chats,members,profiles,messages,expenses,shares,allExpenses,allShares,profile:profiles.find(p=>p.id===me)||null,lastSync:Date.now()});
      if(state.chatId&&!ids.includes(state.chatId)){state.chatId=null;state.screen='chats';}
      if(['home','chats','chat','expense'].includes(state.screen)||!silent)render();
    }catch(err){if(!silent)setError(err);}
    finally{state.loading=false;}
  }
  function subscribeRealtime(){
    if(!state.client || !state.user || typeof state.client.channel!=='function') return;
    if(realtimeChannel){try{state.client.removeChannel(realtimeChannel);}catch(_){ } realtimeChannel=null;}
    let pending=false;
    const changed=()=>{
      if(pending || document.hidden) return;
      pending=true;
      setTimeout(()=>{pending=false;if(state.user)refresh(true);},180);
    };
    realtimeChannel=state.client.channel('payly-live-'+state.user.id)
      .on('postgres_changes',{event:'*',schema:'public',table:'messages'},changed)
      .on('postgres_changes',{event:'*',schema:'public',table:'chat_members'},changed)
      .on('postgres_changes',{event:'*',schema:'public',table:'expenses'},changed)
      .on('postgres_changes',{event:'*',schema:'public',table:'expense_shares'},changed)
      .subscribe();
  }
  function go(screen){state.error='';state.notice='';state.screen=screen;render();}
  function head(label,back=false,right=''){
    return `<div class="app-head">${back?`<button class="icon-button back" data-act="back" aria-label="Back">${icon('left')}</button>`:''}<div class="head-content"><div class="head-title">${esc(label)}</div></div>${right}</div>`;
  }
  function nav(active){return `<div class="bottom-nav">${[['home','Home','home'],['chats','Chats','chats']].map(([id,label,ico])=>`<button class="nav-item ${active===id?'active':''}" data-act="go" data-to="${id}">${icon(ico)}${label}</button>`).join('')}<button class="nav-plus" data-act="add" aria-label="Add expense">${icon('plus',24)}</button><button class="nav-item ${active==='activity'?'active':''}" data-act="go" data-to="activity">${icon('activity')}Activity</button><button class="nav-item ${active==='profile'?'active':''}" data-act="go" data-to="profile">${icon('user')}Profile</button></div>`;}
  function status(){return `<div class="statusbar"><span>9:41</span><div class="status-icons">● ᴡɪғɪ ▰</div></div><div class="island"></div>`;}
  function outer(content,active='home',authed=true){
    $app.innerHTML=`<div class="app-shell"><header class="topbar"><div class="brand-wrap"><div class="brand">Payly</div><div class="tagline">Money between people, simplified.</div></div><div class="top-actions"><span class="cloud-tag">${authed?'CONNECTED • LIVE ACCOUNTS':'SECURE SIGN-IN'}</span>${authed?`<button class="top-action" data-act="logout">Sign out</button>`:''}</div></header><main class="workspace"><section class="intro"><div class="eyebrow">${icon('check',15)} Shared money, simplified</div><h1>Share more.<br>Worry less.</h1><p>Your personal home for expenses, one-to-one conversations and shared group balances.</p><div class="feature-pills"><span>Private chats</span><span>Approve requests</span><span>Invite friends</span><span>Free to use</span></div><p class="soft-note">Real accounts and messages. Payment processing is not enabled.</p></section><section class="device-column"><div class="phone"><div class="phone-inner">${status()}<div class="screen-main">${content}${authed&&state.screen!=='chat'&&state.screen!=='invite'&&state.screen!=='expense'&&state.screen!=='create'&&state.screen!=='add'&&state.screen!=='newchat'?nav(active):''}</div><div class="home-indicator"></div></div></div><div class="bottom-device-caption">Payly · ${authed?'Your private account':'Get started securely'}</div></section><aside class="screen-list"><div class="panel-overline">THE PAYLY EXPERIENCE</div><h2>Your money chats.</h2><p>Messages, bills and approvals are shared between signed-in members of each conversation.</p><div class="screens-box">${[['home','Home','home'],['chats','Chats','chats'],['newchat','New chat','users'],['activity','Activity','activity'],['profile','Profile','user']].map(([id,label,ico])=>`<button class="screen-selector ${state.screen===id?'active':''}" data-act="go" data-to="${id}"><span class="selector-icon">${icon(ico,18)}</span><span class="selector-label"><strong>${label}</strong><small>${id==='newchat'?'Create group or 1:1 invitation':'Go to '+label}</small></span>${icon('chevron',14)}</button>`).join('')}</div><div class="below-note"><b>Private by design.</b><br>Only chat members can view its messages, balances and expenses. No real money moves through Payly yet.</div></aside></main></div>`;
  }
  function alertBox(){return `${state.error?`<div class="cloud-alert" role="alert">${esc(state.error)}</div>`:''}${state.notice?`<div class="cloud-success" role="status">${esc(state.notice)}</div>`:''}`;}
  function authScreen(){
    const signup=state.authMode==='signup';
    if(state.recovery){outer(`<div class="cloud-auth"><div class="cloud-mark">P</div><h1>Set new password</h1><p>Use a fresh password for your Payly account.</p>${alertBox()}<form id="recoveryForm" class="cloud-form"><label>New password<input type="password" name="password" minlength="8" required autocomplete="new-password"></label><button class="green-button" type="submit">Save password</button></form></div>`,'home',false);return;}
    outer(`<div class="cloud-auth"><div class="cloud-mark">P</div><h1>${signup?'Join Payly':'Welcome back'}</h1><p>Money between people, simplified.</p>${state.inviteToken?`<div class="cloud-success">You have a private chat invitation. Sign in to join.</div>`:''}${alertBox()}${state.authNotice?`<div class="cloud-success">${esc(state.authNotice)}</div>`:''}<form id="authForm" class="cloud-form">${signup?`<label>Your name<input name="name" maxlength="80" required autocomplete="name" placeholder="Your name"></label>`:''}<label>Email<input type="email" name="email" required autocomplete="email" placeholder="you@example.com"></label><label>Password<input type="password" name="password" minlength="8" required autocomplete="${signup?'new-password':'current-password'}" placeholder="At least 8 characters"></label><button class="green-button" ${state.busy?'disabled':''} type="submit">${state.busy?'Please wait…':signup?'Create account':'Log in'}</button></form><button class="cloud-text-button" data-act="switch-auth">${signup?'Already have an account? Log in':'New to Payly? Create account'}</button><button class="cloud-text-button" data-act="reset-password">Forgot password?</button><p class="cloud-disclaimer">We never store your password in Payly. Email verification may be required before your first sign-in.</p></div>`, 'home',false);
  }
  function home(){
    const owed=state.allExpenses.filter(x=>x.paid_by===state.user.id).reduce((a,x)=>a+state.allShares.filter(y=>y.expense_id===x.id&&y.user_id!==state.user.id).reduce((z,s)=>z+s.amount_cents,0),0);
    const owe=state.allShares.filter(s=>s.user_id===state.user.id && state.allExpenses.some(x=>x.id===s.expense_id&&x.paid_by!==state.user.id)).reduce((a,s)=>a+s.amount_cents,0);
    return `${head('Home',false,`<button class="icon-button" data-act="go" data-to="profile" aria-label="Profile">${icon('user')}</button>`)}<div class="scroll-content"><div class="cloud-hello">${avatar(myName())}<div>Good to see you,<strong>${esc(myName())}!</strong></div></div><div class="balance-card"><div class="balance-pair"><div><div class="balance-label">You are owed*</div><div class="balance-number">${eur(owed)}</div></div><div><div class="balance-label">You owe*</div><div class="balance-number">${eur(owe)}</div></div></div><div class="balance-net">Recorded net balance<strong>${eur(owed-owe)}</strong></div><div class="spark"><span style="height:15px"></span><span style="height:27px"></span><span style="height:43px"></span></div></div><p class="cloud-balance-note">*Recorded shares only; no payments verified yet. Latest 300 expenses.</p>${alertBox()}<div class="section-heading"><h3>Your conversations</h3><button class="text-link" data-act="go" data-to="chats">See all</button></div><div class="stack-card">${state.chats.length?state.chats.slice(0,4).map(c=>chatRow(c)).join(''):`<div class="cloud-empty">You haven't joined any chats yet. Start a group or a one-to-one conversation.</div>`}</div><div class="cloud-padded">${btn('Create your first chat','newchat')}</div></div>`;
  }
  function chatRow(chat){const n=title(chat),count=memberIds(chat.id).length;return `<button class="chat-row" data-act="open-chat" data-id="${chat.id}">${chat.kind==='group'?`<span class="group-icon">🏠</span>`:avatar(n,'blue')}<div class="row-body"><div class="row-title">${esc(n)}</div><div class="row-sub">${chat.kind==='group'?'Group':'Private chat'} · ${count} ${count===1?'member':'members'}</div></div>${icon('chevron',15)}</button>`;}
  function chats(){let items=state.chats.filter(x=>title(x).toLowerCase().includes(state.search.toLowerCase()));return `${head('Chats',false,`<button class="icon-button" data-act="newchat" aria-label="New chat">${icon('plus')}</button>`)}<div class="search-box">${icon('search',18)}<input name="search" id="chatSearch" placeholder="Search chats…" value="${esc(state.search)}"></div>${alertBox()}<div class="scroll-content">${items.length?items.map(chatRow).join(''):`<div class="cloud-empty">No conversations yet. Invite someone to start one.</div>`}<div class="cloud-padded">${btn('New group or chat','newchat')}</div></div>`;}
  function newChat(){return `${head('New conversation',true)}<div class="scroll-content form-scroll">${alertBox()}<div class="cloud-padded"><h3>Start something together</h3><p class="cloud-muted">Invite people securely through a private link. Only authenticated invitees become members.</p><form id="createChatForm" class="cloud-form"><label>Conversation type<select name="kind"><option value="group">Group (roommates, holidays…)</option><option value="direct">1:1 chat</option></select></label><label>Name<input name="name" maxlength="100" required placeholder="e.g. Apartment or Dinner with Sam"></label><button class="green-button" type="submit" ${state.busy?'disabled':''}>Create and invite</button></form></div></div>`;}
  function chat(){
    const c=selectChat();if(!c)return `${head('Chats',true)}<div class="cloud-empty">Select a chat to continue.</div>`;
    const events=[...state.messages.map(m=>({...m,type:'message',date:m.created_at})),...state.expenses.map(x=>({...x,type:'expense',date:x.created_at}))].sort((a,b)=>a.date.localeCompare(b.date));
    return `<div class="app-head cloud-chat-header"><button class="icon-button back" data-act="back" aria-label="Back">${icon('left')}</button>${c.kind==='group'?`<span class="group-icon">🏠</span>`:avatar(title(c))}<div class="head-content"><div class="cloud-chat-title">${esc(title(c))}</div><div class="head-subtitle">${memberIds(c.id).length} member(s) · ${c.kind==='group'?'Group':'Private chat'}</div></div><button class="icon-button" data-act="invite" aria-label="Invite" title="Invite">${icon('share',19)}</button></div>${alertBox()}<div class="chat-thread"><div class="thread-scroll" id="cloudThread">${events.length?events.map(item=>item.type==='expense'?expenseBubble(item):messageBubble(item)).join(''):`<div class="cloud-chat-placeholder">Say hello or add your first shared expense.</div>`}</div><div class="cloud-thread-actions"><button class="cloud-soft-button" data-act="add">${icon('plus',16)} Add expense</button><button class="cloud-soft-button" data-act="invite">${icon('share',16)} Invite</button></div><form id="messageForm" class="thread-compose"><input name="body" maxlength="2000" required autocomplete="off" placeholder="Write a message…"><button type="submit" aria-label="Send message" ${state.busy?'disabled':''}>${icon('send',20)}</button></form></div>`;
  }
  function messageBubble(m){const mine=m.sender_id===state.user.id;return `<div class="message-line ${mine?'mine':''}">${avatar(getName(m.sender_id))}<div class="message-body"><div class="msg-author">${esc(getName(m.sender_id))}</div><div class="chat-bubble">${esc(m.body)}</div><div class="msg-time">${clock(m.created_at)}</div></div></div>`;}
  function expenseBubble(x){const mine=x.paid_by===state.user.id;const my=state.shares.find(s=>s.expense_id===x.id&&s.user_id===state.user.id);return `<div class="message-line ${mine?'mine':''}">${avatar(getName(x.paid_by))}<div class="message-body"><div class="msg-author">${esc(getName(x.paid_by))} added an expense</div><div class="expense-bubble"><div class="expense-row-head"><span class="expense-icon">🧾</span><div><strong>${esc(x.title)}</strong><div class="expense-amount">${eur(x.amount_cents)}</div><div class="subdued">Your share: ${eur(my?.amount_cents||0)}</div></div></div><div class="cloud-status ${my?.status||'pending'}">${esc(my?.status||'pending')}</div>${btn('Review shares','view-expense','','data-id="'+x.id+'"')}</div><div class="msg-time">${clock(x.created_at)}</div></div></div>`;}
  function add(){const members=state.members.filter(m=>m.chat_id===state.chatId);return `${head('Add expense',true)}<div class="scroll-content form-scroll">${alertBox()}${!selectChat()?`<div class="cloud-empty">First open a chat, then add an expense.</div>`:`<form id="expenseForm" class="cloud-padded cloud-form"><label>Title<input name="title" value="${esc(state.inputTitle)}" maxlength="200" required placeholder="Dinner at L’Osteria"></label><label>Amount in EUR<input name="amount" value="${esc(state.inputAmount)}" type="number" min="0.01" step="0.01" required placeholder="86.40"></label><label>Split type<select name="split" id="splitMode"><option value="Equally" ${state.splitMode==='Equally'?'selected':''}>Equally</option><option value="Custom" ${state.splitMode==='Custom'?'selected':''}>Custom amounts</option></select></label><h3>Split between</h3><p class="cloud-muted">Include yourself as the payer. Each other member must approve their own share.</p>${members.map(m=>`<div class="cloud-member-row"><label><input type="checkbox" name="participant" value="${m.user_id}" ${state.splitIds.includes(m.user_id)?'checked':''}>${avatar(getName(m.user_id))}<span>${esc(getName(m.user_id))}</span></label><input class="cloud-custom ${state.splitMode==='Custom'?'':'cloud-hidden'}" name="share_${m.user_id}" aria-label="${esc(getName(m.user_id))} share in EUR" type="number" min="0" step="0.01" value="${esc(state.custom[m.user_id]??'')}" placeholder="€"></div>`).join('')}<button class="green-button" type="submit" ${state.busy?'disabled':''}>Add expense for approval</button></form>`}</div>`;}
  function expense(){const x=state.expenses.find(v=>v.id===state.openedExpense);if(!x)return `${head('Expense',true)}<div class="cloud-empty">Expense not found.</div>`;
    const shares=state.shares.filter(s=>s.expense_id===x.id), my=shares.find(s=>s.user_id===state.user.id);
    return `${head('Review expense',true)}<div class="scroll-content form-scroll">${alertBox()}<div class="cloud-padded"><div class="detail-card"><div class="request-icon">🧾</div><div class="request-lead">${esc(x.title)} · Paid by ${esc(getName(x.paid_by))}</div><div class="big-money">${eur(x.amount_cents)}</div><p class="cloud-muted">Everyone sees the same split. You can respond only for your own share.</p></div><h3>Individual shares</h3>${shares.map(s=>`<div class="cloud-share">${avatar(getName(s.user_id))}<div class="row-body"><strong>${esc(getName(s.user_id))}</strong><div class="cloud-status ${s.status}">${esc(s.status)}</div>${s.question?`<p class="cloud-muted">${esc(s.question)}</p>`:''}</div><strong>${eur(s.amount_cents)}</strong></div>`).join('')}${my&&my.user_id!==x.paid_by?`<div class="cloud-response"><h3>Your share: ${eur(my.amount_cents)}</h3>${btn('Approve my share','approve')}${btn('Question this amount','question','outline')}</div>`:`<div class="cloud-success">Your share is automatically approved as the payer.</div>`}<p class="cloud-disclaimer">Approval is not a payment. Payment integrations are not enabled.</p></div></div>`;}
  function invite(){const c=selectChat();if(!c)return `${head('Invitation',true)}<div class="cloud-empty">Open a chat first.</div>`;
    const owner=c.created_by===state.user.id;
    return `${head('Invite people',true)}<div class="scroll-content form-scroll">${alertBox()}<div class="cloud-padded"><h3>${esc(title(c))}</h3><p class="cloud-muted">Share a private, expiring link. Invitees must sign up or log in before joining.</p>${owner?`${btn('Create invite link','generate-invite')}${state.inviteLink?`<div class="cloud-link">${esc(state.inviteLink)}</div>${btn('Copy invite link','copy-invite','outline')}${btn('Share invite','share-invite','outline')}<p class="cloud-muted">Expires in 7 days. ${c.kind==='direct'?'One person can join.':'Up to 25 redemptions (max 25 members).'}</p>`:''}`:`<div class="cloud-alert">Only the chat creator can generate invitation links.</div>`}<div class="cloud-disclaimer">Treat this link like a password. Anyone with it can join before it expires; send it privately.</div></div></div>`;}
  function join(){return `<div class="cloud-auth"><div class="cloud-mark">↗</div><h1>Your invitation</h1><p>You're signed in as ${esc(state.user.email)}.</p>${alertBox()}<p class="cloud-muted">This private link lets you join a Payly money conversation. The chat contents will become visible only after you join.</p>${btn('Join conversation','join-invite')}${btn('Not now','dismiss-invite','outline')}</div>`;}
  function activity(){return `${head('Activity',false)}<div class="scroll-content">${alertBox()}<div class="cloud-empty">Your newest shared expenses appear within each chat. Open a conversation to review amounts and approval status.</div><div class="cloud-padded">${btn('View conversations','go','','data-to="chats"')}</div></div>`;}
  function profile(){return `${head('Profile',false)}<div class="scroll-content"><div class="cloud-padded">${avatar(myName())}<h2>${esc(myName())}</h2><p class="cloud-muted">${esc(state.user.email)}</p>${alertBox()}<form id="profileForm" class="cloud-form"><label>Display name<input name="name" value="${esc(myName())}" maxlength="80" required></label><button class="green-button" type="submit">Save name</button></form><p class="cloud-disclaimer">Your name is visible only to people in the same conversations.</p>${btn('Sign out','logout','outline')}</div></div>`;}
  function render(){
    if(!state.user){authScreen();return;}
    if(state.inviteToken){outer(join(),'home');return;}
    let view;
    switch(state.screen){case 'chats':view=chats();break;case 'newchat':view=newChat();break;
      case 'chat':view=chat();break;case 'add':view=add();break;case 'expense':view=expense();break;
      case 'invite':view=invite();break;case 'activity':view=activity();break;case 'profile':view=profile();break;
      default:view=home();}
    outer(view,state.screen);
    if(state.screen==='chat'){const el=document.getElementById('cloudThread');if(el)el.scrollTop=el.scrollHeight;}
  }
  async function action(act,button){
    if(state.busy)return;
    const id=button.dataset.id;
    if(act==='switch-auth'){state.authMode=state.authMode==='signup'?'login':'signup';state.error='';state.authNotice='';render();return;}
    if(act==='go'){go(button.dataset.to||'home');return;}
    if(act==='back'){go(['invite','add','expense'].includes(state.screen)?'chat':'chats');return;}
    if(act==='newchat'){go('newchat');return;}
    if(act==='add'){if(!selectChat()){go('chats');state.error='Open a chat before adding an expense.';render();return;}state.splitIds=memberIds(state.chatId);state.custom={};state.splitMode='Equally';go('add');return;}
    if(act==='open-chat'){state.chatId=id;state.openedExpense=null;go('chat');await refresh();return;}
    if(act==='view-expense'){state.openedExpense=id;go('expense');return;}
    if(act==='invite'){state.inviteLink='';go('invite');return;}
    if(act==='dismiss-invite'){clearInvite();go('chats');return;}
    if(act==='question'){
      const question=window.prompt('What should the payer review? (1–1500 characters)');
      if(question===null)return;
      if(!question.trim()||question.trim().length>1500){notice('Enter a question up to 1500 characters.');return;}
      await mutate(async()=>{await rpc('respond_to_share',{p_expense_id:state.openedExpense,p_status:'disputed',p_question:question.trim()});await refresh();notice('Your question is visible to the group.');});return;
    }
    if(act==='approve'){await mutate(async()=>{await rpc('respond_to_share',{p_expense_id:state.openedExpense,p_status:'approved',p_question:null});await refresh();notice('Your share is approved.');});return;}
    if(act==='join-invite'){await mutate(async()=>{const chatId=await rpc('accept_chat_invite',{p_token:state.inviteToken});clearInvite();state.chatId=chatId;state.screen='chat';await refresh();notice('You joined the conversation.');});return;}
    if(act==='generate-invite'){await mutate(async()=>{const token=await rpc('create_chat_invite',{p_chat_id:state.chatId});state.inviteLink=location.origin+location.pathname+'?invite='+encodeURIComponent(token);notice('Private invitation created. Share only with people you trust.');});return;}
    if(act==='copy-invite'){try{await navigator.clipboard.writeText(state.inviteLink);notice('Link copied.');}catch(_){notice('Select the link above and copy it.');}return;}
    if(act==='share-invite'){if(navigator.share){try{await navigator.share({title:'Join my Payly chat',url:state.inviteLink});}catch(_){}}else await action('copy-invite',button);return;}
    if(act==='logout'){await mutate(async()=>{throwErr(await state.client.auth.signOut());state.user=null;state.profile=null;state.chats=[];state.members=[];state.chatId=null;generation++;state.screen='home';state.notice='';render();});return;}
    if(act==='reset-password'){
      const email=window.prompt('Enter your Payly account email address:');if(!email)return;
      await mutate(async()=>{throwErr(await state.client.auth.resetPasswordForEmail(email.trim(),{redirectTo:location.origin+location.pathname}));state.authNotice='If an account exists, a password reset email has been requested.';render();});return;
    }
  }
  async function mutate(task){state.busy=true;state.error='';try{await task();}catch(err){setError(err);}finally{state.busy=false;}}
  $app.addEventListener('click',event=>{const el=event.target.closest('[data-act]');if(!el)return;event.preventDefault();action(el.dataset.act,el);});
  $app.addEventListener('change',event=>{
    if(event.target.id==='splitMode'){
      state.splitMode=event.target.value;
      const inputs=[...document.querySelectorAll('.cloud-custom')];
      for(const el of inputs)el.classList.toggle('cloud-hidden',state.splitMode!=='Custom');
    }
  });
  $app.addEventListener('input',event=>{if(event.target.id==='chatSearch'){
    const cursor=event.target.selectionStart;state.search=event.target.value;render();
    const input=document.getElementById('chatSearch');if(input){input.focus();input.setSelectionRange(cursor,cursor);}
  }});
  $app.addEventListener('submit',async event=>{
    const form=event.target;if(!['authForm','recoveryForm','createChatForm','messageForm','expenseForm','profileForm'].includes(form.id))return;
    event.preventDefault();if(state.busy)return;const data=new FormData(form);
    await mutate(async()=>{
      if(form.id==='recoveryForm'){const password=String(data.get('password')||'');if(password.length<8)throw Error('Use at least 8 characters.');throwErr(await state.client.auth.updateUser({password}));state.recovery=false;state.authNotice='Password changed.';state.screen='home';await refresh();render();return;}
      if(form.id==='authForm'){
        const email=String(data.get('email')||'').trim(),password=String(data.get('password')||'');
        if(state.authMode==='signup'){
          const name=String(data.get('name')||'').trim();if(!name||password.length<8)throw Error('Enter a name and a password of at least 8 characters.');
          const res=await state.client.auth.signUp({email,password,options:{data:{display_name:name},emailRedirectTo:location.origin+location.pathname+(state.inviteToken?('?invite='+encodeURIComponent(state.inviteToken)):'')}});throwErr(res);
          state.authNotice=res.data.session?'Account created.':'Check your email to confirm your account, then return to your invitation.';
          if(res.data.session)state.user=res.data.session.user;
        }else{
          const res=await state.client.auth.signInWithPassword({email,password});throwErr(res);state.user=res.data.user;state.authNotice='';
        }
        if(state.user){generation++;await refresh();state.screen='home';}
        render();return;
      }
      if(!state.user)throw Error('Sign in first.');
      if(form.id==='createChatForm'){
        const name=String(data.get('name')||'').trim(),kind=String(data.get('kind')||'');
        const chatId=await rpc('create_chat',{p_name:name,p_kind:kind});state.chatId=chatId;state.screen='invite';state.inviteLink='';await refresh();notice('Conversation created. Invite somebody to get started.');return;
      }
      if(form.id==='messageForm'){
        const body=String(data.get('body')||'').trim();if(!body)throw Error('Write a message.');
        await rpc('send_message',{p_chat_id:state.chatId,p_body:body});form.reset();await refresh();return;
      }
      if(form.id==='profileForm'){
        const name=String(data.get('name')||'').trim();if(!name||name.length>80)throw Error('Enter a valid name.');
        throwErr(await state.client.from('profiles').update({display_name:name}).eq('id',state.user.id));
        state.profile={id:state.user.id,display_name:name};notice('Display name saved.');return;
      }
      if(form.id==='expenseForm'){
        const title=String(data.get('title')||'').trim(),amountRaw=Number(data.get('amount'));
        if(!Number.isFinite(amountRaw)||amountRaw<=0||Math.round(amountRaw*100)>100000000)throw Error('Enter a valid amount.');
        const amount=Math.round(amountRaw*100),ids=[...new Set(data.getAll('participant').map(String))];
        if(!ids.includes(state.user.id))throw Error('Include yourself as the payer.');
        if(!ids.length)throw Error('Select at least one person.');
        let allocations=[];
        if(String(data.get('split'))==='Custom'){
          allocations=ids.map(id=>({user_id:id,amount_cents:Math.round(Number(data.get('share_'+id))*100)}));
          if(allocations.some(s=>!Number.isSafeInteger(s.amount_cents)||s.amount_cents<0)||allocations.reduce((a,s)=>a+s.amount_cents,0)!==amount)throw Error('Custom shares must add up exactly to the total.');
        }else{
          const base=Math.floor(amount/ids.length),rem=amount%ids.length;
          allocations=ids.map((id,i)=>({user_id:id,amount_cents:base+(i<rem?1:0)}));
        }
        await rpc('create_expense',{p_chat_id:state.chatId,p_title:title,p_amount_cents:amount,p_shares:allocations});
        state.screen='chat';await refresh();notice('Expense added. Members can now approve their own shares.');return;
      }
    });
  });
  async function start(){
    getInviteFromURL();
    if(!window.supabase?.createClient){state.error='Unable to load the Supabase SDK. Check your internet connection and reload.';authScreen();return;}
    state.client=window.supabase.createClient(window.PAYLY_CONFIG.supabaseUrl,window.PAYLY_CONFIG.supabasePublishableKey,{
      auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}
    });
    const initial=await state.client.auth.getSession();
    if(initial.error)state.error=initial.error.message;
    if(initial.data?.session?.user){state.user=initial.data.session.user;generation++;await refresh();subscribeRealtime();}
    render();
    state.client.auth.onAuthStateChange((event,session)=>{
      if(event==='PASSWORD_RECOVERY'){state.recovery=true;render();}
      else if(event==='SIGNED_OUT'){generation++;if(realtimeChannel){try{state.client.removeChannel(realtimeChannel);}catch(_){}realtimeChannel=null;}state.user=null;state.profile=null;state.chats=[];state.chatId=null;render();}
      else if(session?.user && session.user.id!==state.user?.id){state.user=session.user;generation++;setTimeout(async()=>{await refresh();subscribeRealtime();},0);render();}
    });
    setInterval(()=>{if(state.user && !document.hidden && Date.now()-state.lastSync>=4500)refresh(true);},6500);
    window.addEventListener('focus',()=>{if(state.user)refresh(true);});
  }
  window.PaylyCloud={start};
})();
