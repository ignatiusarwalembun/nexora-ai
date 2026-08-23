import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.resolve(process.env.MABA_DATA_DIR || path.join(ROOT, 'data'));
const MASTER_KEY_FILE = path.join(DATA_DIR, '.master-key');
const SAAS_FILE = path.join(DATA_DIR, 'saas.json');

fs.mkdirSync(DATA_DIR, { recursive:true });

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive:true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return structuredClone(fallback); }
}

function masterKey() {
  const env = String(process.env.MABA_MASTER_KEY || '').trim();
  if (env) return crypto.createHash('sha256').update(env).digest();
  if (!fs.existsSync(MASTER_KEY_FILE)) fs.writeFileSync(MASTER_KEY_FILE, crypto.randomBytes(32), { mode:0o600 });
  return fs.readFileSync(MASTER_KEY_FILE);
}

export function seal(value) {
  if (!value) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function unseal(value) {
  if (!value || !String(value).startsWith('enc:')) return value || '';
  const [, ivB64, tagB64, dataB64] = String(value).split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

const defaultConfig = {
  ai: {
    apiKey:'', model:'gpt-5.6', embeddingModel:'text-embedding-3-small', assistantName:'Maba Assistant',
    systemPrompt:'You are Maba Assistant, a helpful AI customer assistant. Answer using the supplied business knowledge. If the knowledge does not contain the answer, say that you are not certain instead of inventing facts.'
  },
  handoff: {
    enabled:true,
    triggerWords:['human','agent','admin','operator','customer service','cs','manusia','orang','sales','tim manusia'],
    waitingMessage:'Saya hubungkan Anda ke tim manusia. Konteks percakapan tetap tersimpan, jadi Anda tidak perlu mengulang dari awal.',
    activeMessage:'Pesan Anda sudah masuk ke Human Inbox. Tim akan melanjutkan percakapan ini.'
  },
  channels: {
    telegram:{ connected:false, botToken:'', botUsername:'', mode:'polling', publicBaseUrl:'', webhookSecret:'', lastUpdateId:0 },
    whatsapp:{ connected:false, accessToken:'', phoneNumberId:'', wabaId:'', graphVersion:'v23.0', verifyToken:'', publicBaseUrl:'' },
    instagram:{ connected:false, accessToken:'', igAccountId:'', graphVersion:'v23.0', verifyToken:'', publicBaseUrl:'' },
    website:{ connected:true, title:'Maba Assistant', welcomeMessage:'Halo 👋 Ada yang bisa saya bantu?', accent:'#d9ff43' }
  }
};

const emptySaaS = { users:[], workspaces:[], sessions:[], conversations:[], handoffs:[], usage:[] };

export function getSaaS() { return loadJson(SAAS_FILE, emptySaaS); }
export function saveSaaS(db) { atomicWrite(SAAS_FILE, db); }
export function updateSaaS(mutator) { const db=getSaaS(); const result=mutator(db); saveSaaS(db); return result ?? db; }
export function hasUsers() { return getSaaS().users.length > 0; }

export function normalizeWorkspaceId(id='default') {
  const value=String(id || 'default').trim();
  return /^[a-z0-9][a-z0-9_-]{0,80}$/i.test(value) ? value : 'default';
}
export function workspaceDir(workspaceId='default') {
  const id=normalizeWorkspaceId(workspaceId);
  const dir=path.join(DATA_DIR,'workspaces',id);
  fs.mkdirSync(path.join(dir,'uploads'),{recursive:true});
  return dir;
}
export function getUploadDir(workspaceId='default') { return path.join(workspaceDir(workspaceId),'uploads'); }
function configFile(workspaceId) { return path.join(workspaceDir(workspaceId),'config.json'); }
function knowledgeFile(workspaceId) { return path.join(workspaceDir(workspaceId),'knowledge.json'); }

export function getConfig(workspaceId='default') {
  const data=loadJson(configFile(workspaceId), defaultConfig);
  return {
    ...structuredClone(defaultConfig), ...data,
    ai:{...defaultConfig.ai,...(data.ai||{})},
    handoff:{...defaultConfig.handoff,...(data.handoff||{})},
    channels:{
      telegram:{...defaultConfig.channels.telegram,...(data.channels?.telegram||{})},
      whatsapp:{...defaultConfig.channels.whatsapp,...(data.channels?.whatsapp||{})},
      instagram:{...defaultConfig.channels.instagram,...(data.channels?.instagram||{})},
      website:{...defaultConfig.channels.website,...(data.channels?.website||{})}
    }
  };
}
export function saveConfig(workspaceId, config) { atomicWrite(configFile(workspaceId), config); }
export function updateConfig(workspaceId, mutator) { const config=getConfig(workspaceId); mutator(config); saveConfig(workspaceId, config); return config; }

export function publicConfig(workspaceId='default', config=getConfig(workspaceId)) {
  const mask=value=>value?`${String(value).slice(0,4)}••••${String(value).slice(-4)}`:'';
  return {
    workspaceId:normalizeWorkspaceId(workspaceId),
    ai:{ configured:Boolean(config.ai.apiKey), apiKeyMasked:config.ai.apiKey?mask(unseal(config.ai.apiKey)):'', model:config.ai.model, embeddingModel:config.ai.embeddingModel, assistantName:config.ai.assistantName, systemPrompt:config.ai.systemPrompt },
    handoff:{ enabled:Boolean(config.handoff.enabled), triggerWords:config.handoff.triggerWords || [], waitingMessage:config.handoff.waitingMessage, activeMessage:config.handoff.activeMessage },
    channels:{
      telegram:{...config.channels.telegram,botToken:undefined,botTokenMasked:config.channels.telegram.botToken?mask(unseal(config.channels.telegram.botToken)):''},
      whatsapp:{...config.channels.whatsapp,accessToken:undefined,accessTokenMasked:config.channels.whatsapp.accessToken?mask(unseal(config.channels.whatsapp.accessToken)):''},
      instagram:{...config.channels.instagram,accessToken:undefined,accessTokenMasked:config.channels.instagram.accessToken?mask(unseal(config.channels.instagram.accessToken)):''},
      website:{...config.channels.website}
    }
  };
}

export function getKnowledgeStore(workspaceId='default') { return loadJson(knowledgeFile(workspaceId),{documents:[],chunks:[]}); }
export function saveKnowledgeStore(workspaceId, store) { atomicWrite(knowledgeFile(workspaceId),store); }
export function listWorkspaceIds() {
  const db=getSaaS();
  return [...new Set(['default',...db.workspaces.map(w=>normalizeWorkspaceId(w.id))])];
}
