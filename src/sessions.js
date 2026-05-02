import jwt from 'jsonwebtoken';
import { config } from './config.js';

/**
 * In-memory session store.
 *   sessionId -> { email, name, picture, refreshToken, accessToken, expiryDate,
 *                  activeFolder: { id, name } | null }
 * 
 * Note: In-memory sessions reset when backend restarts.
 * For production with multiple instances, consider using Redis.
 */
const sessions = new Map();

// Session cleanup interval (clean expired sessions every hour)
const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour

// Start session cleanup in production
if (config.nodeEnv === 'production') {
  setInterval(() => {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [sessionId, session] of sessions.entries()) {
      // Clean if token expired (with 1 hour grace period)
      if (session.expiryDate && session.expiryDate + 3600000 < now) {
        sessions.delete(sessionId);
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      console.log(`🧹 Session cleanup: removed ${cleanedCount} expired sessions. Active: ${sessions.size}`);
    }
  }, CLEANUP_INTERVAL);
}

/**
 * Create a new session for authenticated user
 */
export function createSession(user, tokens) {
  const sessionId = cryptoRandom();
  
  // Validate required token data
  if (!tokens.access_token) {
    throw new Error('Missing access_token when creating session');
  }
  
  if (!tokens.refresh_token) {
    console.warn(`Warning: No refresh_token received for user ${user.email}. Token will not auto-refresh.`);
  }
  
  const session = {
    email: user.email,
    name: user.name,
    picture: user.picture,
    refreshToken: tokens.refresh_token || null,
    accessToken: tokens.access_token,
    expiryDate: tokens.expiry_date || Date.now() + 3600000, // Default 1 hour if missing
    activeFolder: null,
    createdAt: Date.now(),
    lastAccessed: Date.now(),
  };
  
  sessions.set(sessionId, session);
  console.log(`✅ Session created for ${user.email} (${sessionId.substring(0, 8)}...)`);
  
  return sessionId;
}

/**
 * Get session by ID
 */
export function getSession(sessionId) {
  const session = sessions.get(sessionId);
  
  if (session) {
    // Update last accessed time
    session.lastAccessed = Date.now();
  }
  
  return session;
}

/**
 * Update session with new data
 */
export function updateSession(sessionId, patch) {
  const s = sessions.get(sessionId);
  if (!s) {
    console.warn(`Attempted to update non-existent session: ${sessionId?.substring(0, 8)}...`);
    return null;
  }
  
  Object.assign(s, patch);
  s.lastAccessed = Date.now();
  
  return s;
}

/**
 * Delete session (logout)
 */
export function deleteSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    console.log(`🗑️ Session deleted for ${session.email} (${sessionId.substring(0, 8)}...)`);
    sessions.delete(sessionId);
  }
  return true;
}

/**
 * Get all active sessions (for debugging/admin)
 */
export function getActiveSessions() {
  const activeSessions = [];
  for (const [id, session] of sessions.entries()) {
    activeSessions.push({
      sessionId: id.substring(0, 8) + '...',
      email: session.email,
      name: session.name,
      activeFolder: session.activeFolder?.name || null,
      lastAccessed: new Date(session.lastAccessed).toISOString(),
      expiresAt: new Date(session.expiryDate).toISOString(),
    });
  }
  return activeSessions;
}

/**
 * Get session statistics
 */
export function getSessionStats() {
  const now = Date.now();
  let expiredCount = 0;
  let expiringSoon = 0;
  
  for (const session of sessions.values()) {
    if (session.expiryDate && session.expiryDate < now) {
      expiredCount++;
    } else if (session.expiryDate && session.expiryDate - now < 300000) { // 5 minutes
      expiringSoon++;
    }
  }
  
  return {
    totalSessions: sessions.size,
    expiredSessions: expiredCount,
    expiringSoon: expiringSoon,
  };
}

/**
 * Sign JWT token for session
 */
export function signJwt(sessionId, email) {
  if (!config.jwtSecret) {
    throw new Error("JWT secret missing - check environment configuration");
  }
  
  // Ensure JWT secret is strong enough in production
  if (config.nodeEnv === 'production' && config.jwtSecret.length < 32) {
    console.warn('⚠️ Warning: JWT secret is weak. Use a 32+ character secret in production.');
  }

  const token = jwt.sign(
    { 
      sid: sessionId, 
      email,
      iat: Math.floor(Date.now() / 1000),
    },
    config.jwtSecret,
    { expiresIn: "7d" }
  );
  
  return token;
}

/**
 * Verify and decode JWT token
 */
export function verifyJwt(token) {
  if (!token) {
    return null;
  }
  
  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    return decoded;
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      console.debug('JWT token expired');
    } else if (error.name === 'JsonWebTokenError') {
      console.debug('Invalid JWT token:', error.message);
    }
    return null;
  }
}

/**
 * Express middleware: validates Authorization: Bearer <jwt> and attaches req.session
 */
export function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ 
      error: 'Missing bearer token',
      code: 'MISSING_TOKEN'
    });
  }
  
  const payload = verifyJwt(token);
  if (!payload) {
    return res.status(401).json({ 
      error: 'Invalid or expired token',
      code: 'INVALID_TOKEN'
    });
  }
  
  const session = sessions.get(payload.sid);
  if (!session) {
    console.debug(`Session not found for token: ${payload.sid?.substring(0, 8)}...`);
    return res.status(401).json({ 
      error: 'Session not found. Please login again.',
      code: 'SESSION_NOT_FOUND'
    });
  }
  
  // Check if session access token is expired (needs refresh)
  const now = Date.now();
  if (session.expiryDate && session.expiryDate < now) {
    console.log(`Session token expired for ${session.email}, requires refresh`);
    // Don't reject here - let driveClientForSession handle refresh
  }
  
  // Attach session data to request
  req.sessionId = payload.sid;
  req.session = session;
  
  next();
}

/**
 * Generate cryptographically random session ID
 */
/**
 * Generate cryptographically random session ID
 */
function cryptoRandom() {
  // Try to use Node.js crypto module first
  try {
    // Dynamic import for Node.js crypto (works in ES modules)
    const crypto = require('crypto');
    const randomBytes = crypto.randomBytes(24);
    return randomBytes.toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  } catch (err) {
    // Fallback for browser or if crypto is not available
    const bytes = new Uint8Array(24);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
    return Buffer.from(bytes)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }
}

// Admin endpoint helper (optional - for debugging)
export function getSessionInfo(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  
  return {
    email: session.email,
    name: session.name,
    hasRefreshToken: !!session.refreshToken,
    expiryDate: session.expiryDate,
    expiresIn: session.expiryDate ? Math.floor((session.expiryDate - Date.now()) / 1000) : null,
    activeFolder: session.activeFolder,
    lastAccessed: new Date(session.lastAccessed).toISOString(),
  };
}

// Periodic stats logging in production (every hour)
if (config.nodeEnv === 'production') {
  setInterval(() => {
    const stats = getSessionStats();
    if (stats.totalSessions > 0) {
      console.log(`📊 Session stats: ${stats.totalSessions} active, ${stats.expiringSoon} expiring soon`);
    }
  }, 3600000); // Every hour
}