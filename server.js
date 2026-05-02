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

// Middleware
app.use(express.json({ limit: '2mb' }));

// Production-ready CORS configuration
const allowedOrigins = [
  'http://localhost:3000',           // Local development
  'http://localhost:3001',           // Local backend
  process.env.FRONTEND_URL,          // Production frontend URL
  config.frontendUrl,                // From config
].filter(Boolean); // Remove undefined values

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) === -1) {
      console.warn(`CORS blocked origin: ${origin}`);
      const msg = 'CORS policy does not allow access from this origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
}));

// Request logging (helpful for debugging)
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Per-session in-memory indexing status
const indexingStatus = new Map(); // sessionId -> { stage, file, processed, total, chunks, error, folderId }

// ---------- Health Check ----------
app.get('/api/health', (_req, res) => {
  res.json({ 
    ok: true, 
    service: 'drive-rag-node-backend',
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString()
  });
});

// ---------- Auth Routes ----------
app.get('/api/auth/google/url', (_req, res) => {
  try {
    const url = buildAuthUrl();
    res.json({ url });
  } catch (err) {
    console.error('Failed to build auth URL:', err);
    res.status(500).json({ error: 'Failed to initialize Google login' });
  }
});

app.get('/api/auth/google/callback', async (req, res) => {
  console.log('========== GOOGLE CALLBACK RECEIVED ==========');
  console.log('Query params:', req.query);
  
  const { code, error } = req.query;
  
  if (error) {
    console.error('❌ Google auth error:', error);
    return res.redirect(
      `${config.frontendUrl}/auth/error?reason=${encodeURIComponent(String(error))}`
    );
  }
  
  if (!code) {
    console.error('❌ No authorization code received');
    return res.status(400).send('Missing code');
  }
  
  try {
    console.log('🔄 Exchanging code for tokens...');
    const { jwtToken, user } = await exchangeCodeForSession(String(code));
    console.log('✅ Token exchange successful for:', user.email);
    
    const params = new URLSearchParams({
      token: jwtToken,
      email: user.email || '',
      name: user.name || '',
      picture: user.picture || '',
    });
    const redirectUrl = `${config.frontendUrl}/auth/success?${params.toString()}`;
    console.log('🔀 Redirecting to frontend:', redirectUrl);
    res.redirect(redirectUrl);
  } catch (err) {
    console.error('❌ OAuth exchange failed:', err);
    console.error('Error details:', err.message);
    if (err.response) {
      console.error('Google API response:', err.response.data);
    }
    res.redirect(
      `${config.frontendUrl}/auth/error?reason=${encodeURIComponent(err.message)}`
    );
  }
});

app.post('/api/auth/logout', authMiddleware, (req, res) => {
  deleteSession(req.sessionId);
  indexingStatus.delete(req.sessionId);
  console.log(`User logged out: ${req.session?.email}`);
  res.json({ ok: true });
});

app.get('/api/me', authMiddleware, (req, res) => {
  const { email, name, picture, activeFolder } = req.session;
  res.json({ email, name, picture, activeFolder });
});

// ---------- Drive Folders / Files ----------
app.get('/api/drive/folders', authMiddleware, async (req, res) => {
  try {
    const parent = req.query.parent ? String(req.query.parent) : 'root';
    const folders = await listFolders(req.sessionId, parent);
    res.json({ folders });
  } catch (err) {
    console.error('listFolders error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/drive/folders/search', authMiddleware, async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const folders = await searchFolders(req.sessionId, q);
    res.json({ folders });
  } catch (err) {
    console.error('searchFolders error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/drive/folders/:folderId/files', authMiddleware, async (req, res) => {
  try {
    const files = await listDocumentsInFolder(req.sessionId, req.params.folderId);
    res.json({ files });
  } catch (err) {
    console.error('listDocumentsInFolder error:', err);
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

    // Kick off async indexing and return immediately
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
        console.log(`✅ Indexing completed for folder: ${store.folderName}`);
      })
      .catch((err) => {
        console.error('❌ Indexing failed:', err);
        indexingStatus.set(req.sessionId, {
          stage: 'error',
          error: err.message,
          folderId,
        });
      });

    res.json({ ok: true, total: files.length });
  } catch (err) {
    console.error('Indexing start error:', err);
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
  console.log(`Index cleared for user: ${req.session?.email}`);
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
    console.log(`Chat question from ${req.session.email}: ${question.substring(0, 50)}...`);
    const { hits } = await retrieve(req.sessionId, active.id, question, 5);
    const result = await answerWithGuardrails(question, hits);
    res.json(result);
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Error Handling (must be last) ----------
// 404 handler for unmatched routes
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  
  // Don't expose internal errors in production
  const message = process.env.NODE_ENV === 'production' 
    ? 'Internal server error' 
    : err.message;
  
  res.status(500).json({ error: message });
});

// ---------- Start Server ----------
const PORT = config.port || process.env.PORT || 3001;

const server = app.listen(PORT, () => {
  console.log(`\n🚀 Server started successfully!`);
  console.log(`📡 Listening on: http://localhost:${PORT}`);
  console.log(`🌐 Frontend URL: ${config.frontendUrl}`);
  console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`✅ Health check: http://localhost:${PORT}/api/health\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});

// Add after all routes
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  
  // Don't expose internal errors in production
  const message = process.env.NODE_ENV === 'production' 
    ? 'Internal server error' 
    : err.message;
  
  res.status(500).json({ error: message });
});

// Handle 404
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});
export default app;