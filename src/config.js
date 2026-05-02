import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables based on NODE_ENV
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env';
dotenv.config({ path: path.resolve(__dirname, '..', envFile) });
dotenv.config({ path: path.resolve(__dirname, '../.env') }); // Fallback

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name, defaultValue) {
  return process.env[name] || defaultValue;
}

export const config = {
  // Server configuration
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  
  // Frontend URL (critical for CORS and OAuth redirects)
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  
  // JWT Secret (use strong secret in production)
  jwtSecret: process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' 
    ? (() => { throw new Error('JWT_SECRET must be set in production'); })()
    : 'dev-secret-change-me'),
  
  // Google OAuth configuration
  google: {
    clientId: required('GOOGLE_CLIENT_ID'),
    clientSecret: required('GOOGLE_CLIENT_SECRET'),
    redirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/api/auth/google/callback',
    scopes: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
  },
  
  // OpenAI configuration
  openai: {
    apiKey: required('OPENAI_API_KEY'),
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    chatModel: process.env.CHAT_MODEL || 'gpt-4o-mini',
    embeddingModel: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
    maxTokens: parseInt(process.env.OPENAI_MAX_TOKENS || '1024', 10),
    temperature: parseFloat(process.env.OPENAI_TEMPERATURE || '0.2'),
  },
  
  // Optional: Rate limiting (for production)
  rateLimit: {
    enabled: process.env.RATE_LIMIT_ENABLED === 'true',
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10), // 15 minutes
    max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10), // limit each IP to 100 requests per windowMs
  },
  
  // Optional: Logging
  logging: {
    level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
    requests: process.env.LOG_REQUESTS !== 'false', // Log all requests by default
  },
};

// Validate critical configuration in production
if (config.nodeEnv === 'production') {
  console.log('🔐 Running in PRODUCTION mode');
  
  // Ensure frontendUrl is not localhost in production
  if (config.frontendUrl.includes('localhost')) {
    console.warn('⚠️  Warning: FRONTEND_URL is set to localhost in production!');
  }
  
  // Ensure redirectUri matches production domain
  if (config.google.redirectUri.includes('localhost') && !process.env.GOOGLE_REDIRECT_URI) {
    console.warn('⚠️  Warning: Using localhost redirect URI in production. Set GOOGLE_REDIRECT_URI environment variable.');
  }
  
  // Check for strong JWT secret
  if (config.jwtSecret === 'dev-secret-change-me' || config.jwtSecret.length < 32) {
    console.error('❌ ERROR: JWT_SECRET must be a strong, random string in production!');
    console.error('   Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    process.exit(1);
  }
} else {
  console.log('🔧 Running in DEVELOPMENT mode');
}

// Log configuration summary (without sensitive data)
console.log('📋 Configuration loaded:');
console.log(`   Environment: ${config.nodeEnv}`);
console.log(`   Port: ${config.port}`);
console.log(`   Frontend URL: ${config.frontendUrl}`);
console.log(`   Google Redirect URI: ${config.google.redirectUri}`);
console.log(`   OpenAI Model: ${config.openai.chatModel}`);
console.log(`   Log Level: ${config.logging.level}`);

export default config;