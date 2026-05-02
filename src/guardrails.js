import { chat } from './llm.js';

export const OUT_OF_CONTEXT_THRESHOLD = 0.22;

const SYSTEM_PROMPT = `You are a strict document-grounded assistant.

Absolute rules:
1. Answer using ONLY the information in the provided "CONTEXT" section.
2. If the answer is not contained in the context, you MUST respond with exactly: OUT_OF_CONTEXT
3. Do not use outside knowledge, assumptions, or web information.
4. Cite the source filenames you used in square brackets after each claim, e.g., [report.pdf].
5. Keep answers concise. If asked for an opinion or general knowledge, respond OUT_OF_CONTEXT.

Output format:
- Plain prose with inline [filename] citations.
- No conversational filler like "According to the documents".`;

function buildUserMessage(question, hits) {
  const contextBlocks = hits
    .map((h, idx) => `--- SOURCE ${idx + 1} | file: ${h.chunk.fileName} | chunk: ${h.chunk.chunkIndex} ---\n${h.chunk.text}`)
    .join('\n\n');

  return `CONTEXT:\n${contextBlocks || '(no context available)'}\n\nQUESTION: ${question}\n\nAnswer using ONLY the CONTEXT above. If the CONTEXT does not contain the answer, reply with exactly: OUT_OF_CONTEXT`;
}

/** 
 * Runs guarded RAG chat.
 */
export async function answerWithGuardrails(question, hits) {
  const bestScore = hits.length > 0 ? hits[0].score : 0;
  
  // Pre-filter: if similarity is too low, reject immediately
  if (hits.length === 0 || bestScore < OUT_OF_CONTEXT_THRESHOLD) {
    return {
      answer: null,
      outOfContext: true,
      reason: 'No relevant documents found. Try rephrasing.',
      citations: [],
      bestScore,
    };
  }

  const raw = await chat(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserMessage(question, hits) },
    ],
    { temperature: 0.1, maxTokens: 700 }
  );

  // Parse result
  if (!raw || /^\s*OUT_OF_CONTEXT\s*$/i.test(raw)) {
    return {
      answer: null,
      outOfContext: true,
      reason: 'The documents do not contain sufficient information to answer.',
      citations: citationsFromHits(hits),
      bestScore,
    };
  }

  return {
    answer: raw,
    outOfContext: false,
    citations: citationsFromHits(hits),
    bestScore,
  };
}

/** 
 * De-duplicates citations by fileId, keeping the most relevant hit per file.
 */
function citationsFromHits(hits) {
  const seen = new Map();
  for (const h of hits) {
    const { fileId, fileName, webViewLink, chunkIndex, text } = h.chunk;
    if (!seen.has(fileId)) {
      seen.set(fileId, {
        fileId,
        fileName,
        webViewLink,
        chunkIndex,
        snippet: text.slice(0, 200),
        score: Number(h.score.toFixed(3)),
      });
    }
  }
  return Array.from(seen.values());
}