import crypto from 'node:crypto';
import { getSaaS, updateSaaS, hasUsers, normalizeWorkspaceId, workspaceDir } from './storage.js';

const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const cleanEmail=v=>String(v||'').trim().toLowerCase();
const tokenHash=t=>crypto.createHash('sha256').update(String(t)).digest('hex');

function hashPassword(password, salt=crypto.randomBytes(16).toString('hex')) {
  const hash=crypto.scryptSync(String(password),salt,64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored='') {
  const [salt,expected]=String(stored).split(':');
  if (!salt || !expected) return false;
  const actual=crypto.scryptSync(String(password),salt,64);
  const exp=Buffer.from(expected,'hex');
  return actual.length===exp.length && crypto.timingSafeEqual(actual,exp);
}
function slugify(name='workspace') {
  const base=String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,38) || 'workspace';
  return normalizeWorkspaceId(`${base}-${crypto.randomBytes(3).toString('hex')}`);
}
function cookieToken(req) {
  const cookies=String(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(Boolean);
  for (const item of cookies) { const i=item.indexOf('='); if (item.slice(0,i)==='maba_session') return decodeURIComponent(item.slice(i+1)); }
  const auth=String(req.headers.authorization||'');
  return auth.startsWith('Bearer ')?auth.slice(7).trim():'';
}
function setCookie(res, token) {
  const secure=process.env.NODE_ENV==='production' ? '; Secure' : '';
  res.setHeader('Set-Cookie',`maba_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS/1000)}${secure}`);
}
export function clearSessionCookie(res) { res.setHeader('Set-Cookie','maba_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); }

function createSession(userId, workspaceId) {
  const token=crypto.randomBytes(32).toString('base64url');
  const now=Date.now();
  updateSaaS(db=>{
    db.sessions=db.sessions.filter(s=>Number(s.expiresAt)>now);
    db.sessions.push({id:crypto.randomUUID(),tokenHash:tokenHash(token),userId,workspaceId,createdAt:new Date(now).toISOString(),expiresAt:now+SESSION_MAX_AGE_MS});
  });
  return token;
}
export function resolveSession(req) {
  const token=cookieToken(req); if(!token) return null;
  const db=getSaaS(); const now=Date.now();
  const session=db.sessions.find(s=>s.tokenHash===tokenHash(token)&&Number(s.expiresAt)>now); if(!session) return null;
  const user=db.users.find(u=>u.id===session.userId); const workspace=db.workspaces.find(w=>w.id===session.workspaceId);
  return user&&workspace?{session,user,workspace}:null;
}
export function requireAuth(req,res,next) {
  const auth=resolveSession(req); if(!auth) return res.status(401).json({ok:false,error:'Login diperlukan untuk membuka Maba Studio.'});
  req.auth=auth; next();
}
export function publicUser(auth) { return auth?{id:auth.user.id,name:auth.user.name,email:auth.user.email,workspace:{id:auth.workspace.id,name:auth.workspace.name,role:auth.workspace.role||'owner'}}:null; }
export function authBootstrap(req) { return {hasUsers:hasUsers(),user:publicUser(resolveSession(req))}; }

export function register({name,email,password,workspaceName}) {
  const clean=cleanEmail(email); const pass=String(password||'');
  if (!name?.trim()) throw new Error('Nama wajib diisi.');
  if (!/^\S+@\S+\.\S+$/.test(clean)) throw new Error('Email tidak valid.');
  if (pass.length<8) throw new Error('Password minimal 8 karakter.');
  const db=getSaaS(); if(db.users.some(u=>u.email===clean)) throw new Error('Email sudah terdaftar.');
  const userId=crypto.randomUUID(); const workspaceId=slugify(workspaceName||`${name} Workspace`); const now=new Date().toISOString();
  updateSaaS(next=>{
    next.users.push({id:userId,name:String(name).trim(),email:clean,passwordHash:hashPassword(pass),createdAt:now});
    next.workspaces.push({id:workspaceId,name:String(workspaceName||'My Business').trim(),ownerId:userId,role:'owner',credits:1000,createdAt:now});
  });
  workspaceDir(workspaceId);
  return {token:createSession(userId,workspaceId),workspaceId};
}
export function login({email,password}) {
  const db=getSaaS(); const user=db.users.find(u=>u.email===cleanEmail(email));
  if(!user||!verifyPassword(password,user.passwordHash)) throw new Error('Email atau password salah.');
  const workspace=db.workspaces.find(w=>w.ownerId===user.id)||db.workspaces[0]; if(!workspace) throw new Error('Workspace tidak ditemukan.');
  return {token:createSession(user.id,workspace.id),workspaceId:workspace.id};
}
export function logout(req) {
  const token=cookieToken(req); if(!token) return;
  updateSaaS(db=>{db.sessions=db.sessions.filter(s=>s.tokenHash!==tokenHash(token));});
}
export function attachSessionCookie(res, token){setCookie(res,token);}
