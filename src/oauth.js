

import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import { config } from "./config.js";
import {
  createSession,
  signJwt,
  getSession,
  updateSession,
} from "./sessions.js";

/** Create OAuth client */
export function newOAuthClient() {
  return new OAuth2Client(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );
}

/** Get Drive client for a session (auto refresh token) */
export async function driveClientForSession(sessionId) {
  const session = getSession(sessionId);
  if (!session) throw new Error("Session not found");

  // 🔍 DEBUG: Log token status
  console.log('🔍 Token Check:', {
    sessionId: sessionId.slice(0, 10) + '...',
    hasAccessToken: !!session.accessToken,
    hasRefreshToken: !!session.refreshToken,
    expiryDate: session.expiryDate,
    now: Date.now(),
    timeUntilExpiry: session.expiryDate ? (session.expiryDate - Date.now()) / 1000 + ' seconds' : 'no expiry'
  });

  const client = newOAuthClient();

  client.setCredentials({
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
    expiry_date: session.expiryDate,
  });

  // Auto refresh if expired or near expiry
  const now = Date.now();
  if (!session.expiryDate || session.expiryDate - now < 60_000) {
    console.log('🔄 Refreshing token...');
    try {
      const { credentials } = await client.refreshAccessToken();
      console.log('✅ Token refreshed successfully');
      
      updateSession(sessionId, {
        accessToken: credentials.access_token,
        expiryDate: credentials.expiry_date,
        refreshToken: credentials.refresh_token || session.refreshToken,
      });

      client.setCredentials(credentials);
    } catch (refreshError) {
      console.error('❌ Token refresh failed:', refreshError.message);
      throw new Error('Failed to refresh access token');
    }
  }

  return google.drive({ version: "v3", auth: client });
}

/** Generate Google OAuth URL */
export function buildAuthUrl() {
  const client = newOAuthClient();

  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // ensures refresh_token
    scope: config.google.scopes,
  });
}

/** Exchange auth code → session + JWT */
export async function exchangeCodeForSession(code) {
  console.log('\n📡 exchangeCodeForSession started');
  console.log('Code length:', code?.length);
  
  const client = newOAuthClient();
  
  console.log('OAuth Client Config:', {
    clientId: config.google.clientId?.substring(0, 20) + '...',
    redirectUri: config.google.redirectUri,
    hasSecret: !!config.google.clientSecret
  });
  
  try {
    console.log('Calling client.getToken()...');
    const { tokens } = await client.getToken(code);
    console.log('✅ getToken succeeded!');
    console.log('Tokens received:', {
      has_access_token: !!tokens.access_token,
      has_refresh_token: !!tokens.refresh_token,
      token_type: tokens.token_type,
      scope: tokens.scope,
      expiry_date: tokens.expiry_date
    });
    
    client.setCredentials(tokens);
    
    console.log('Fetching user info from Google...');
    const oauth2 = google.oauth2({ version: "v2", auth: client });
    const { data: user } = await oauth2.userinfo.get();
    console.log('✅ User info received:', { email: user.email, name: user.name });
    
    console.log('Creating session...');
    const sessionId = createSession(user, tokens);
    console.log('Session created:', sessionId.substring(0, 20) + '...');
    
    console.log('Signing JWT...');
    const jwtToken = signJwt(sessionId, user.email);
    console.log('✅ All done!');
    
    return { jwtToken, user };
  } catch (error) {
    console.error('🔴🔴🔴 exchangeCodeForSession ERROR 🔴🔴🔴');
    console.error('Error type:', error.constructor.name);
    console.error('Error message:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    if (error.stack) {
      console.error('Stack trace:', error.stack);
    }
    throw error;
  }
}