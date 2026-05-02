import { embedBatch, embedText } from './llm.js';
import { LRUCache } from 'lru-cache'; // Install: npm install lru-cache

// Prevent memory leaks: automatically evict indices after 1 hour or when limit reached
const stores = new LRUCache({
  max: 100,
  ttl: 1000 * 60 * 60,
});

const getStoreKey = (sessionId, folderId) => `${sessionId}::${folderId}`;

export const getIndex = (sessionId, folderId) => stores.get(getStoreKey(sessionId, folderId)) || null;

export const clearIndex = (sessionId, folderId) => stores.delete(getStoreKey(sessionId, folderId));

/** Improved cleaning and chunking */
export function chunkText(text, size = 1200, overlap = 200) {
  const clean = (text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!clean) return [];
  
  const chunks = [];
  for (let i = 0; i < clean.length; i += (size - overlap)) {
    chunks.push(clean.slice(i, i + size));
  }
  return chunks;
}

/** Efficient indexing with progress monitoring */
export async function buildIndex(sessionId, folder, files, extractFn, onProgress = () => {}) {
  const store = {
    folderId: folder.id,
    folderName: folder.name,
    chunks: [],
    createdAt: new Date().toISOString(),
    files: [],
  };
  
  stores.set(getStoreKey(sessionId, folder.id), store);

  for (const [index, f] of files.entries()) {
    onProgress({ stage: 'extracting', file: f.name, processed: index, total: files.length });
    
    let text;
    try {
      text = await extractFn(f);
    } catch (err) {
      store.files.push({ fileId: f.id, fileName: f.name, error: err.message });
      continue;
    }

    const pieces = chunkText(text);
    if (pieces.length === 0) continue;

    onProgress({ stage: 'embedding', file: f.name, processed: index, total: files.length });

    // Embed in batches
    const vectors = [];
    for (let i = 0; i < pieces.length; i += 64) {
      const batch = await embedBatch(pieces.slice(i, i + 64));
      vectors.push(...batch);
    }

    store.chunks.push(...pieces.map((text, i) => ({
      id: `${f.id}:${i}`,
      fileId: f.id,
      fileName: f.name,
      webViewLink: f.webViewLink,
      text,
      vector: vectors[i]
    })));
    
    store.files.push({ fileId: f.id, fileName: f.name, chunks: pieces.length });
  }

  onProgress({ stage: 'done', processed: files.length, total: files.length });
  return store;
}

/** Cosine similarity with vector length validation */
function cosine(a, b) {
  if (a.length !== b.length) throw new Error('Vector dimension mismatch');
  
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return (normA === 0 || normB === 0) ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function retrieve(sessionId, folderId, query, topK = 5) {
  const store = getIndex(sessionId, folderId);
  if (!store?.chunks?.length) return { hits: [], store: null };

  const qVec = await embedText(query);
  
  const hits = store.chunks
    .map(c => ({ chunk: c, score: cosine(qVec, c.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return { hits, store };
}