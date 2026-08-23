import crypto from 'node:crypto';
import { getSaaS, updateSaaS } from './storage.js';

const nowIso=()=>new Date().toISOString();
function displayCustomer(sessionId,channel){
  const tail=String(sessionId||'customer').split(':').slice(1).join(':');
  if(channel==='website') return tail?.startsWith('demo')?'Website Visitor':'Website Customer';
  return tail?`${channel[0]?.toUpperCase()+channel.slice(1)} • ${tail.slice(-8)}`:`${channel} customer`;
}
export function getConversation(workspaceId, sessionId){ return getSaaS().conversations.find(c=>c.workspaceId===workspaceId&&c.sessionId===sessionId)||null; }
export function ensureConversation(workspaceId, sessionId, channel='website') {
  let found=getConversation(workspaceId,sessionId); if(found) return found;
  const created={id:crypto.randomUUID(),workspaceId,sessionId,channel,customerName:displayCustomer(sessionId,channel),status:'ai',assignedTo:'',createdAt:nowIso(),updatedAt:nowIso(),lastMessage:'',unread:0,messages:[]};
  updateSaaS(db=>db.conversations.unshift(created)); return created;
}
export function addMessage(workspaceId,sessionId,{role,content,channel='website',meta={}}){
  ensureConversation(workspaceId,sessionId,channel); let result;
  updateSaaS(db=>{
    const c=db.conversations.find(x=>x.workspaceId===workspaceId&&x.sessionId===sessionId);
    const msg={id:crypto.randomUUID(),role,content:String(content||''),createdAt:nowIso(),meta}; c.messages.push(msg); c.lastMessage=msg.content; c.updatedAt=msg.createdAt; if(role==='user'&&c.status!=='ai') c.unread=(c.unread||0)+1; result={conversation:c,message:msg};
  }); return result;
}
export function shouldTriggerHandoff(message, config){
  if(!config?.enabled) return false; const hay=String(message||'').toLowerCase();
  return (config.triggerWords||[]).some(word=>word&&hay.includes(String(word).toLowerCase()));
}
export function openHandoff(workspaceId,sessionId,{reason='Customer requested human',channel='website'}={}){
  ensureConversation(workspaceId,sessionId,channel); let item;
  updateSaaS(db=>{
    const c=db.conversations.find(x=>x.workspaceId===workspaceId&&x.sessionId===sessionId); c.status='waiting'; c.updatedAt=nowIso();
    const existing=db.handoffs.find(h=>h.workspaceId===workspaceId&&h.conversationId===c.id&&['waiting','active'].includes(h.status));
    if(existing){item=existing;return;}
    item={id:crypto.randomUUID(),workspaceId,conversationId:c.id,status:'waiting',reason,assignedTo:'',createdAt:nowIso(),updatedAt:nowIso()}; db.handoffs.unshift(item);
  }); return item;
}
export function isHumanMode(workspaceId,sessionId){ const c=getConversation(workspaceId,sessionId); return Boolean(c&&['waiting','human'].includes(c.status)); }
export function listConversations(workspaceId,{limit=80}={}) { return getSaaS().conversations.filter(c=>c.workspaceId===workspaceId).sort((a,b)=>new Date(b.updatedAt)-new Date(a.updatedAt)).slice(0,limit); }
export function getConversationById(workspaceId,id){return getSaaS().conversations.find(c=>c.workspaceId===workspaceId&&c.id===id)||null;}
export function listHandoffs(workspaceId){
  const db=getSaaS(); const map=new Map(db.conversations.map(c=>[c.id,c]));
  return db.handoffs.filter(h=>h.workspaceId===workspaceId&&['waiting','active'].includes(h.status)).map(h=>({...h,conversation:map.get(h.conversationId)||null})).filter(h=>h.conversation).sort((a,b)=>new Date(b.updatedAt)-new Date(a.updatedAt));
}
export function assignHandoff(workspaceId,handoffId,user){let result; updateSaaS(db=>{const h=db.handoffs.find(x=>x.workspaceId===workspaceId&&x.id===handoffId);if(!h) return;h.status='active';h.assignedTo=user.name;h.updatedAt=nowIso();const c=db.conversations.find(x=>x.id===h.conversationId);if(c){c.status='human';c.assignedTo=user.name;c.unread=0;c.updatedAt=nowIso();}result={handoff:h,conversation:c};});return result;}
export function closeHandoff(workspaceId,conversationId){let result;updateSaaS(db=>{const c=db.conversations.find(x=>x.workspaceId===workspaceId&&x.id===conversationId);if(!c)return;c.status='ai';c.assignedTo='';c.unread=0;c.updatedAt=nowIso();for(const h of db.handoffs)if(h.workspaceId===workspaceId&&h.conversationId===conversationId&&['waiting','active'].includes(h.status)){h.status='resolved';h.updatedAt=nowIso();}result=c;});return result;}
export function addUsage(workspaceId,{model='unknown',inputChars=0,outputChars=0,credits=1}={}){updateSaaS(db=>{db.usage.unshift({id:crypto.randomUUID(),workspaceId,model,inputChars,outputChars,credits,createdAt:nowIso()});const w=db.workspaces.find(x=>x.id===workspaceId);if(w)w.credits=Math.max(0,Number(w.credits||0)-credits);});}
export function usageSummary(workspaceId){const db=getSaaS();const rows=db.usage.filter(x=>x.workspaceId===workspaceId);const workspace=db.workspaces.find(w=>w.id===workspaceId);return{creditsRemaining:Number(workspace?.credits||0),aiReplies:rows.length,creditsUsed:rows.reduce((n,x)=>n+Number(x.credits||0),0),inputChars:rows.reduce((n,x)=>n+Number(x.inputChars||0),0),outputChars:rows.reduce((n,x)=>n+Number(x.outputChars||0),0)};}
export function dashboardStats(workspaceId){const conv=listConversations(workspaceId,{limit:10000});return{conversations:conv.length,humanWaiting:conv.filter(c=>c.status==='waiting').length,humanActive:conv.filter(c=>c.status==='human').length,channels:[...new Set(conv.map(c=>c.channel))].length,usage:usageSummary(workspaceId)};}
