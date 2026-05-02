import express from 'express';
import cors from 'cors';
import { config } from './src/config.js';
import {
  buildAuthUrl,
  exchangeCodeForSession,
} from './src/oauth.js';
import { authMiddleware, deleteSession, updateSession } from './src/sessions.js';
import {
  listFolders,
  searchFolders,
  listDocumentsInFolder,
  extractText,
} from './src/drive.js';
import {
  buildIndex,
  getIndex,
  clearIndex,
  retrieve,
} from './src/rag.js';
import { answerWithGuardrails } from './src/guardrails.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(
  cors({
    origin: config.frontendUrl,
    credentials: false,
  })
);

// Per-session in-memory indexing status.
const indexingStatus = new Map(); // sessionId -> { stage, file, processed, total, chunks, error, folderId }

// ---------- Health ----------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'drive-rag-node-backend' });
});

// ---------- Auth ----------
app.get('/api/auth/google/url', (_req, res) => {
  res.json({ url: buildAuthUrl() });
});

app.get('/api/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) {
    return res.redirect(
      `${config.frontendUrl}/auth/error?reason=${encodeURIComponent(String(error))}`
    );
  }
  if (!code) return res.status(400).send('Missing code');
  try {
    const { jwtToken, user } = await exchangeCodeForSession(String(code));
    const params = new URLSearchParams({
      token: jwtToken,
      email: user.email || '',
      name: user.name || '',
      picture: user.picture || '',
    });
    res.redirect(`${config.frontendUrl}/auth/success?${params.toString()}`);
  } catch (err) {
    console.error('OAuth exchange failed:', err);
    res.redirect(
      `${config.frontendUrl}/auth/error?reason=${encodeURIComponent(err.message)}`
    );
  }
});

app.post('/api/auth/logout', authMiddleware, (req, res) => {
  deleteSession(req.sessionId);
  indexingStatus.delete(req.sessionId);
  res.json({ ok: true });
});

app.get('/api/me', authMiddleware, (req, res) => {
  const { email, name, picture, activeFolder } = req.session;
  res.json({ email, name, picture, activeFolder });
});

// ---------- Drive folders / files ----------
app.get('/api/drive/folders', authMiddleware, async (req, res) => {
  try {
    const parent = req.query.parent ? String(req.query.parent) : 'root';
    const folders = await listFolders(req.sessionId, parent);
    res.json({ folders });
  } catch (err) {
    console.error('listFolders error', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/drive/folders/search', authMiddleware, async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const folders = await searchFolders(req.sessionId, q);
    res.json({ folders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/drive/folders/:folderId/files', authMiddleware, async (req, res) => {
  try {
    const files = await listDocumentsInFolder(req.sessionId, req.params.folderId);
    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Indexing ----------
app.post('/api/index/:folderId', authMiddleware, async (req, res) => {
  const { folderId } = req.params;
  const { folderName } = req.body || {};
  try {
    const files = await listDocumentsInFolder(req.sessionId, folderId);
    if (files.length === 0) {
      return res
        .status(400)
        .json({ error: 'No supported documents found in this folder.' });
    }

    indexingStatus.set(req.sessionId, {
      stage: 'starting',
      processed: 0,
      total: files.length,
      folderId,
    });

    // Kick off async indexing and return immediately.
    buildIndex(
      req.sessionId,
      { id: folderId, name: folderName || 'Folder' },
      files,
      (file) => extractText(req.sessionId, file),
      (progress) => {
        indexingStatus.set(req.sessionId, { ...progress, folderId });
      }
    )
      .then((store) => {
        updateSession(req.sessionId, {
          activeFolder: { id: folderId, name: store.folderName },
        });
      })
      .catch((err) => {
        console.error('indexing failed', err);
        indexingStatus.set(req.sessionId, {
          stage: 'error',
          error: err.message,
          folderId,
        });
      });

    res.json({ ok: true, total: files.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/index/status', authMiddleware, (req, res) => {
  const status = indexingStatus.get(req.sessionId) || { stage: 'idle' };
  const active = req.session.activeFolder;
  const index = active ? getIndex(req.sessionId, active.id) : null;
  res.json({
    status,
    activeFolder: active,
    summary: index
      ? {
          folderId: index.folderId,
          folderName: index.folderName,
          totalChunks: index.chunks.length,
          files: index.files,
          createdAt: index.createdAt,
        }
      : null,
  });
});

app.delete('/api/index', authMiddleware, (req, res) => {
  const active = req.session.activeFolder;
  if (active) clearIndex(req.sessionId, active.id);
  updateSession(req.sessionId, { activeFolder: null });
  indexingStatus.delete(req.sessionId);
  res.json({ ok: true });
});

// ---------- Chat ----------
app.post('/api/chat', authMiddleware, async (req, res) => {
  const { question } = req.body || {};
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'Missing question' });
  }
  const active = req.session.activeFolder;
  if (!active) {
    return res.status(400).json({
      error: 'No folder indexed yet. Select a folder and index it first.',
    });
  }
  try {
    const { hits } = await retrieve(req.sessionId, active.id, question, 5);
    const result = await answerWithGuardrails(question, hits);
    res.json(result);
  } catch (err) {
    console.error('chat error', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Start ----------
app.listen(config.port, () => {
  console.log(
    `[drive-rag] listening on http://localhost:${config.port} (frontend: ${config.frontendUrl})`
  );
});
