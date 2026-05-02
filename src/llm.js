import OpenAI from 'openai';
import { config } from './config.js';

const client = new OpenAI({
  apiKey: config.openai.apiKey,
  ...(config.openai.baseURL ? { baseURL: config.openai.baseURL } : {}),
});

/** Create an embedding vector for a single string. */
export async function embedText(text) {
  const res = await client.embeddings.create({
    model: config.openai.embeddingModel,
    input: text,
  });
  return res.data[0].embedding;
}

/** Batched embedding (OpenAI allows array input). */
export async function embedBatch(texts) {
  if (texts.length === 0) return [];
  const res = await client.embeddings.create({
    model: config.openai.embeddingModel,
    input: texts,
  });
  return res.data.map((d) => d.embedding);
}

/** Chat completion. Returns the assistant string. */
export async function chat(messages, { temperature = 0.2, maxTokens = 1024 } = {}) {
  const res = await client.chat.completions.create({
    model: config.openai.chatModel,
    temperature,
    max_tokens: maxTokens,
    messages,
  });
  return res.choices[0]?.message?.content?.trim() || '';
}
