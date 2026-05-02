import jwt from 'jsonwebtoken';
import { config } from './config.js';

/**
 * In-memory session store.
 *   sessionId -> { email, name, picture, refreshToken, accessToken, expiryDate,
 *                  activeFolder: { id, name } | null }
 * Resets when the backend restarts (acceptable for this project).
 */
const sessions = new Map();

export function createSession(user, tokens) {
  const sessionId = cryptoRandom();
  sessions.set(sessionId, {
    email: user.email,
    name: user.name,
    picture: user.picture,
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    expiryDate: tokens.expiry_date,
    activeFolder: null,
  });
  return sessionId;
}

export function getSession(sessionId) {
  return sessions.get(sessionId);
}

export function updateSession(sessionId, patch) {
  const s = sessions.get(sessionId);
  if (!s) return null;
  Object.assign(s, patch);
  return s;
}

export function deleteSession(sessionId) {
  sessions.delete(sessionId);
}

export function signJwt(sessionId, email) {
  if (!config.jwtSecret) {
    throw new Error("JWT secret missing");
  }

  return jwt.sign(
    { sid: sessionId, email },
    config.jwtSecret,
    { expiresIn: "7d" }
  );
}

export function verifyJwt(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}

/** Express middleware: validates Authorization: Bearer <jwt> and attaches req.session. */
export function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }
  const payload = verifyJwt(token);
  if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });
  const session = sessions.get(payload.sid);
  if (!session) return res.status(401).json({ error: 'Session not found' });
  req.sessionId = payload.sid;
  req.session = session;
  next();
}

function cryptoRandom() {
  // 24-byte base64url id (no external deps)
  const bytes = new Uint8Array(24);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
