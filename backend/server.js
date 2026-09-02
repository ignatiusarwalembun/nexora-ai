import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, publicConfig, updateConfig, seal, ROOT, normalizeWorkspaceId } from './storage.js';
import { addFileKnowledge, addTextKnowledge, listKnowledge, removeKnowledge, reindexKnowledge } from './knowledge.js';
import { answerMessage, embedText, testAI } from './ai.js';
import { connectTelegram, disconnectTelegram, connectWhatsApp, connectInstagram, disconnectChannel, saveWebsite, verifyMetaWebhook, handleTelegramUpdate, handleWhatsAppWebhook, handleInstagramWebhook, startAllTelegramPolling, sendHumanReply } from './channels.js';
import { authBootstrap, register, login, logout, attachSessionCookie, clearSessionCookie, requireAuth, resolveSession, publicUser } from './auth.js';
import { addMessage, assignHandoff, closeHandoff, dashboardStats, getConversation, getConversationById, listConversations, listHandoffs } from './conversations.js';

const app=express();
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:25*1024*1024,files:8}});
const PORT=Number(process.env.PORT||5500);
const __dirname=path.dirname(fileURLToPath(import.meta.url));
const FRONTEND=path.join(ROOT,'frontend');

app.disable('x-powered-by');
app.use(express.json({limit:'2mb'}));
app.use(express.urlencoded({extended:true}));

const workspaceOf=req=>req.auth?.workspace?.id||normalizeWorkspaceId(req.body?.workspaceId||req.query?.workspaceId||'default');

app.get('/api/health',(_req,res)=>res.json({ok:true,phase:4,service:'maba-business',time:new Date().toISOString()}));

// Authentication / workspace bootstrap
app.get('/api/auth/bootstrap',(req,res)=>res.json({ok:true,...authBootstrap(req)}));
app.post('/api/auth/register',(req,res)=>{try{const result=register(req.body||{});attachSessionCookie(res,result.token);const auth=resolveSession({...req,headers:{...req.headers,cookie:`maba_session=${encodeURIComponent(result.token)}`}});res.json({ok:true,user:publicUser(auth)});}catch(err){res.status(400).json({ok:false,error:err.message});}});
app.post('/api/auth/login',(req,res)=>{try{const result=login(req.body||{});attachSessionCookie(res,result.token);const auth=resolveSession({...req,headers:{...req.headers,cookie:`maba_session=${encodeURIComponent(result.token)}`}});res.json({ok:true,user:publicUser(auth)});}catch(err){res.status(400).json({ok:false,error:err.message});}});
app.post('/api/auth/logout',(req,res)=>{logout(req);clearSessionCookie(res);res.json({ok:true});});
app.get('/api/auth/me',(req,res)=>res.json({ok:true,user:publicUser(resolveSession(req))}));

// Protected Studio APIs
app.get('/api/status',requireAuth,(req,res)=>{const ws=workspaceOf(req);const cfg=publicConfig(ws);const knowledge=listKnowledge(ws);const connectedChannels=Object.values(cfg.channels).filter(c=>c.connected).length;res.json({ok:true,aiConfigured:cfg.ai.configured,model:cfg.ai.model,knowledge:knowledge.totals,connectedChannels,stats:dashboardStats(ws)});});
app.get('/api/config',requireAuth,(req,res)=>res.json({ok:true,config:publicConfig(workspaceOf(req))}));
app.post('/api/config/ai',requireAuth,(req,res)=>{try{const ws=workspaceOf(req);const{apiKey,model,embeddingModel,assistantName,systemPrompt}=req.body||{};if(!model?.trim())throw new Error('Model wajib diisi.');updateConfig(ws,config=>{if(String(apiKey||'').trim())config.ai.apiKey=seal(String(apiKey).trim());config.ai.model=String(model).trim();config.ai.embeddingModel=String(embeddingModel||'text-embedding-3-small').trim();config.ai.assistantName=String(assistantName||'Nexora Assistant').trim();config.ai.systemPrompt=String(systemPrompt||config.ai.systemPrompt).trim();});res.json({ok:true,config:publicConfig(ws).ai});}catch(err){res.status(400).json({ok:false,error:err.message});}});
app.post('/api/config/ai/test',requireAuth,async(req,res)=>{try{res.json({ok:true,message:await testAI(workspaceOf(req))});}catch(err){res.status(400).json({ok:false,error:err.message});}});
app.post('/api/config/handoff',requireAuth,(req,res)=>{try{const ws=workspaceOf(req);const{enabled,triggerWords,waitingMessage,activeMessage}=req.body||{};updateConfig(ws,c=>{c.handoff.enabled=Boolean(enabled);if(Array.isArray(triggerWords))c.handoff.triggerWords=triggerWords.map(x=>String(x).trim()).filter(Boolean).slice(0,30);if(String(waitingMessage||'').trim())c.handoff.waitingMessage=String(waitingMessage).trim();if(String(activeMessage||'').trim())c.handoff.activeMessage=String(activeMessage).trim();});res.json({ok:true,handoff:publicConfig(ws).handoff});}catch(err){res.status(400).json({ok:false,error:err.message});}});

app.get('/api/knowledge',requireAuth,(req,res)=>res.json({ok:true,...listKnowledge(workspaceOf(req))}));
app.post('/api/knowledge/upload',requireAuth,upload.array('files',8),async(req,res)=>{try{if(!req.files?.length)throw new Error('Pilih minimal satu file.');const ws=workspaceOf(req);const canEmbed=publicConfig(ws).ai.configured;const documents=[];for(const file of req.files)documents.push(await addFileKnowledge(ws,file,canEmbed?(text)=>embedText(ws,text):null));res.json({ok:true,uploaded:documents,...listKnowledge(ws)});}catch(err){res.status(400).json({ok:false,error:err.message});}});
app.post('/api/knowledge/text',requireAuth,async(req,res)=>{try{const ws=workspaceOf(req);const canEmbed=publicConfig(ws).ai.configured;const document=await addTextKnowledge(ws,req.body||{},canEmbed?(text)=>embedText(ws,text):null);res.json({ok:true,document,...listKnowledge(ws)});}catch(err){res.status(400).json({ok:false,error:err.message});}});
app.delete('/api/knowledge/:id',requireAuth,(req,res)=>{const ws=workspaceOf(req);res.json({ok:removeKnowledge(ws,req.params.id),...listKnowledge(ws)});});
app.post('/api/knowledge/reindex',requireAuth,async(req,res)=>{try{const ws=workspaceOf(req);if(!publicConfig(ws).ai.configured)throw new Error('Simpan OpenAI API key terlebih dahulu.');const result=await reindexKnowledge(ws,(text)=>embedText(ws,text));res.json({ok:true,...result,...listKnowledge(ws)});}catch(err){res.status(400).json({ok:false,error:err.message});}});

// Public customer chat. workspaceId is embedded by the website widget.
app.post('/api/chat',async(req,res)=>{try{const message=String(req.body?.message||'').trim();if(!message)throw new Error('Pesan kosong.');const workspaceId=normalizeWorkspaceId(req.body?.workspaceId||'default');const result=await answerMessage({workspaceId,message,sessionId:String(req.body?.sessionId||'website:demo'),channel:String(req.body?.channel||'website')});res.json({ok:true,...result});}catch(err){res.status(400).json({ok:false,error:err.message});}});
app.get('/api/chat/history',(req,res)=>{const workspaceId=normalizeWorkspaceId(req.query.workspaceId||'default');const sessionId=String(req.query.sessionId||'');if(!sessionId)return res.status(400).json({ok:false,error:'sessionId wajib diisi.'});const conversation=getConversation(workspaceId,sessionId);res.json({ok:true,status:conversation?.status||'ai',assignedTo:conversation?.assignedTo||'',messages:(conversation?.messages||[]).slice(-80)});});

// Human Inbox / conversation operations
app.get('/api/dashboard/stats',requireAuth,(req,res)=>res.json({ok:true,stats:dashboardStats(workspaceOf(req))}));
app.get('/api/inbox',requireAuth,(req,res)=>{const ws=workspaceOf(req);res.json({ok:true,handoffs:listHandoffs(ws),conversations:listConversations(ws,{limit:100})});});
app.get('/api/conversations/:id',requireAuth,(req,res)=>{const conversation=getConversationById(workspaceOf(req),req.params.id);if(!conversation)return res.status(404).json({ok:false,error:'Conversation tidak ditemukan.'});res.json({ok:true,conversation});});
app.post('/api/handoffs/:id/assign',requireAuth,(req,res)=>{const result=assignHandoff(workspaceOf(req),req.params.id,req.auth.user);if(!result)return res.status(404).json({ok:false,error:'Handoff tidak ditemukan.'});res.json({ok:true,...result});});
app.post('/api/conversations/:id/reply',requireAuth,async(req,res)=>{try{const ws=workspaceOf(req);const text=String(req.body?.text||'').trim();if(!text)throw new Error('Balasan kosong.');const conversation=getConversationById(ws,req.params.id);if(!conversation)throw new Error('Conversation tidak ditemukan.');const result=addMessage(ws,conversation.sessionId,{role:'human',content:text,channel:conversation.channel,meta:{agent:req.auth.user.name}});await sendHumanReply(ws,result.conversation,text);res.json({ok:true,conversation:result.conversation});}catch(err){res.status(400).json({ok:false,error:err.message});}});
app.post('/api/conversations/:id/return-ai',requireAuth,(req,res)=>{const conversation=closeHandoff(workspaceOf(req),req.params.id);if(!conversation)return res.status(404).json({ok:false,error:'Conversation tidak ditemukan.'});res.json({ok:true,conversation});});

// Channel settings
app.post('/api/channels/telegram/connect',requireAuth,async(req,res)=>{try{const ws=workspaceOf(req);res.json({ok:true,result:await connectTelegram(ws,req.body||{}),config:publicConfig(ws).channels.telegram});}catch(err){res.status(400).json({ok:false,error:err.message});}});
app.post('/api/channels/telegram/disconnect',requireAuth,async(req,res)=>{try{const ws=workspaceOf(req);await disconnectTelegram(ws);res.json({ok:true,config:publicConfig(ws).channels.telegram});}catch(err){res.status(400).json({ok:false,error:err.message});}});
app.post('/api/channels/whatsapp/connect',requireAuth,async(req,res)=>{try{const ws=workspaceOf(req);res.json({ok:true,result:await connectWhatsApp(ws,req.body||{}),config:publicConfig(ws).channels.whatsapp});}catch(err){res.status(400).json({ok:false,error:err.message});}});
app.post('/api/channels/instagram/connect',requireAuth,async(req,res)=>{try{const ws=workspaceOf(req);res.json({ok:true,result:await connectInstagram(ws,req.body||{}),config:publicConfig(ws).channels.instagram});}catch(err){res.status(400).json({ok:false,error:err.message});}});
app.post('/api/channels/:type/disconnect',requireAuth,(req,res)=>{try{const ws=workspaceOf(req);disconnectChannel(ws,req.params.type);res.json({ok:true,config:publicConfig(ws).channels[req.params.type]});}catch(err){res.status(400).json({ok:false,error:err.message});}});
app.post('/api/channels/website/save',requireAuth,(req,res)=>{try{const ws=workspaceOf(req);saveWebsite(ws,req.body||{});res.json({ok:true,config:publicConfig(ws).channels.website});}catch(err){res.status(400).json({ok:false,error:err.message});}});

// Workspace-aware webhooks
app.post('/webhooks/telegram/:workspaceId/:secret',async(req,res)=>{const ws=normalizeWorkspaceId(req.params.workspaceId);const cfg=getConfig(ws).channels.telegram;if(!cfg.connected||req.params.secret!==cfg.webhookSecret)return res.sendStatus(403);res.sendStatus(200);handleTelegramUpdate(ws,req.body).catch(err=>console.error('[telegram webhook]',ws,err.message));});
app.get('/webhooks/whatsapp/:workspaceId',(req,res)=>{const ws=normalizeWorkspaceId(req.params.workspaceId);const challenge=verifyMetaWebhook(ws,'whatsapp',req.query);if(!challenge)return res.sendStatus(403);res.send(String(challenge));});
app.post('/webhooks/whatsapp/:workspaceId',(req,res)=>{const ws=normalizeWorkspaceId(req.params.workspaceId);res.sendStatus(200);handleWhatsAppWebhook(ws,req.body).catch(err=>console.error('[whatsapp webhook]',ws,err.message));});
app.get('/webhooks/instagram/:workspaceId',(req,res)=>{const ws=normalizeWorkspaceId(req.params.workspaceId);const challenge=verifyMetaWebhook(ws,'instagram',req.query);if(!challenge)return res.sendStatus(403);res.send(String(challenge));});
app.post('/webhooks/instagram/:workspaceId',(req,res)=>{const ws=normalizeWorkspaceId(req.params.workspaceId);res.sendStatus(200);handleInstagramWebhook(ws,req.body).catch(err=>console.error('[instagram webhook]',ws,err.message));});

// Website widget
app.get('/api/widget/config',(req,res)=>{const ws=normalizeWorkspaceId(req.query.workspaceId||'default');const cfg=getConfig(ws);res.json({ok:true,workspaceId:ws,widget:cfg.channels.website,assistantName:cfg.ai.assistantName});});
app.get('/widget.js',(req,res)=>{const origin=`${req.protocol}://${req.get('host')}`;res.type('application/javascript').send(`(()=>{const BASE=${JSON.stringify(origin)};const s=document.currentScript;const W=(s&&s.dataset.workspace)||'default';const f=document.createElement('iframe');f.src=BASE+'/widget.html?workspace='+encodeURIComponent(W);f.title='Nexora AI Chat';Object.assign(f.style,{position:'fixed',right:'20px',bottom:'20px',width:'370px',height:'580px',maxWidth:'calc(100vw - 24px)',maxHeight:'calc(100vh - 24px)',border:'0',zIndex:'2147483000',borderRadius:'22px',boxShadow:'0 24px 80px rgba(0,0,0,.24)'});document.body.appendChild(f)})();`);});
app.get('/widget.html',(_req,res)=>res.sendFile(path.join(FRONTEND,'widget.html')));

app.use(express.static(FRONTEND));
app.use((_req,res)=>res.sendFile(path.join(FRONTEND,'index.html')));

app.listen(PORT,()=>{console.log(`\n[NEXORA AI] Phase 4 running → http://localhost:${PORT}\n`);startAllTelegramPolling();});
