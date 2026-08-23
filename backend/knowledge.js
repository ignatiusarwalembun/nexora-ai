import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import pdf from 'pdf-parse';
import { getKnowledgeStore, saveKnowledgeStore, getUploadDir } from './storage.js';

const supported = new Set(['.pdf','.docx','.pptx','.json','.txt','.md','.csv']);

function cleanText(text='') {
  return String(text)
    .replace(/\u0000/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function decodeXml(text='') {
  return text.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'");
}

async function pptxText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const slideNames = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a,b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]));
  const slides = [];
  for (const name of slideNames) {
    const xml = await zip.file(name).async('text');
    const parts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(m => decodeXml(m[1]));
    slides.push(parts.join(' '));
  }
  return slides.join('\n\n');
}

export async function extractText(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!supported.has(ext)) throw new Error(`Format ${ext || 'file'} belum didukung.`);
  if (ext === '.pdf') return cleanText((await pdf(file.buffer)).text);
  if (ext === '.docx') return cleanText((await mammoth.extractRawText({ buffer: file.buffer })).value);
  if (ext === '.pptx') return cleanText(await pptxText(file.buffer));
  if (ext === '.json') {
    const obj = JSON.parse(file.buffer.toString('utf8'));
    return cleanText(JSON.stringify(obj, null, 2));
  }
  return cleanText(file.buffer.toString('utf8'));
}

export function chunkText(text, maxChars=1400, overlap=180) {
  const clean = cleanText(text);
  if (!clean) return [];
  const paragraphs = clean.split(/\n{2,}/).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if ((current + '\n\n' + paragraph).length <= maxChars) {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
      continue;
    }
    if (current) chunks.push(current);
    if (paragraph.length <= maxChars) current = paragraph;
    else {
      let start = 0;
      while (start < paragraph.length) {
        chunks.push(paragraph.slice(start, start + maxChars));
        start += Math.max(1, maxChars - overlap);
      }
      current = '';
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function addFileKnowledge(workspaceId, file, embedder) {
  const text = await extractText(file);
  if (text.length < 2) throw new Error('Dokumen tidak memiliki teks yang dapat dibaca.');
  const id = crypto.randomUUID();
  const ext = path.extname(file.originalname).toLowerCase();
  const storedName = `${id}${ext}`;
  fs.writeFileSync(path.join(getUploadDir(workspaceId), storedName), file.buffer);
  return addDocument(workspaceId, { id, name: file.originalname, type: ext.slice(1).toUpperCase(), source: 'file', text, storedName }, embedder);
}

export async function addTextKnowledge(workspaceId, { title, text }, embedder) {
  const cleaned = cleanText(text);
  if (!cleaned) throw new Error('Isi knowledge tidak boleh kosong.');
  return addDocument(workspaceId, { id: crypto.randomUUID(), name: title || 'Manual knowledge', type: 'TEXT', source: 'text', text: cleaned, storedName: '' }, embedder);
}

async function addDocument(workspaceId, doc, embedder) {
  const store = getKnowledgeStore(workspaceId);
  const pieces = chunkText(doc.text);
  const chunks = [];
  for (let i = 0; i < pieces.length; i++) {
    const embedding = embedder ? await embedder(pieces[i]).catch(() => null) : null;
    chunks.push({ id: crypto.randomUUID(), documentId: doc.id, index: i, text: pieces[i], embedding });
  }
  const meta = { id: doc.id, name: doc.name, type: doc.type, source: doc.source, storedName: doc.storedName, chars: doc.text.length, chunks: chunks.length, createdAt: new Date().toISOString(), indexed: chunks.some(c => Array.isArray(c.embedding)) };
  store.documents.unshift(meta);
  store.chunks.push(...chunks);
  saveKnowledgeStore(workspaceId, store);
  return meta;
}

export function listKnowledge(workspaceId) {
  const store = getKnowledgeStore(workspaceId);
  return { documents: store.documents, totals: { documents: store.documents.length, chunks: store.chunks.length, indexedChunks: store.chunks.filter(c => Array.isArray(c.embedding)).length } };
}

export function removeKnowledge(workspaceId, id) {
  const store = getKnowledgeStore(workspaceId);
  const doc = store.documents.find(d => d.id === id);
  if (!doc) return false;
  store.documents = store.documents.filter(d => d.id !== id);
  store.chunks = store.chunks.filter(c => c.documentId !== id);
  if (doc.storedName) { try { fs.unlinkSync(path.join(getUploadDir(workspaceId), doc.storedName)); } catch {} }
  saveKnowledgeStore(workspaceId, store);
  return true;
}

export async function reindexKnowledge(workspaceId, embedder) {
  const store = getKnowledgeStore(workspaceId);
  if (!store.chunks.length) return { updated: 0 };
  let updated = 0;
  for (const chunk of store.chunks) {
    if (Array.isArray(chunk.embedding) && chunk.embedding.length) continue;
    chunk.embedding = await embedder(chunk.text);
    updated++;
  }
  store.documents = store.documents.map(doc => ({ ...doc, indexed: store.chunks.filter(c => c.documentId === doc.id).every(c => Array.isArray(c.embedding) && c.embedding.length) }));
  saveKnowledgeStore(workspaceId, store);
  return { updated };
}

function cosine(a,b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return -1;
  let dot=0, aa=0, bb=0;
  for (let i=0;i<a.length;i++){ dot += a[i]*b[i]; aa += a[i]*a[i]; bb += b[i]*b[i]; }
  return dot / ((Math.sqrt(aa)*Math.sqrt(bb)) || 1);
}

function lexicalScore(query, text) {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])];
  const hay = text.toLowerCase();
  return words.reduce((score,w) => score + (hay.includes(w) ? 1 : 0), 0);
}

export async function retrieveKnowledge(workspaceId, query, queryEmbedding, limit=6) {
  const store = getKnowledgeStore(workspaceId);
  const docs = new Map(store.documents.map(d => [d.id,d]));
  const scored = store.chunks.map(chunk => ({
    ...chunk,
    score: queryEmbedding && chunk.embedding ? cosine(queryEmbedding, chunk.embedding) : lexicalScore(query, chunk.text)
  })).sort((a,b)=>b.score-a.score).slice(0,limit);
  return scored.filter(x => x.score > (queryEmbedding ? 0.15 : 0)).map(x => ({ text:x.text, score:x.score, source:docs.get(x.documentId)?.name || 'Knowledge' }));
}
