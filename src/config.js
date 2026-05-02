import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  google: {
    clientId: required('GOOGLE_CLIENT_ID'),
    clientSecret: required('GOOGLE_CLIENT_SECRET'),
    redirectUri:
      process.env.GOOGLE_REDIRECT_URI ||
      'http://localhost:3001/api/auth/google/callback',
    scopes: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
  },
  openai: {
    apiKey: required('OPENAI_API_KEY'),
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    chatModel: process.env.CHAT_MODEL || 'gpt-4o-mini',
    embeddingModel: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
  },
};
