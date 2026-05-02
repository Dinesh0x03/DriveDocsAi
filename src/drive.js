import mammoth from 'mammoth';
// pdf-parse is CommonJS; import its internal entry to avoid running its debug code on import.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { driveClientForSession } from './oauth.js';

/** Mime types we know how to handle. */
export const SUPPORTED_MIMES = new Set([
  'application/vnd.google-apps.document', // Google Doc
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'text/plain',
  'text/markdown',
]);

/** List folders that are direct children of `parentId` (use 'root' for My Drive root). */
export async function listFolders(sessionId, parentId = 'root') {
  const drive = await driveClientForSession(sessionId);
  const q = `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const { data } = await drive.files.list({
    q,
    fields: 'files(id, name, modifiedTime)',
    pageSize: 100,
    orderBy: 'name',
  });
  return data.files || [];
}

/** Search folders across the user's drive by name fragment. */
export async function searchFolders(sessionId, query) {
  const drive = await driveClientForSession(sessionId);
  const safe = (query || '').replace(/'/g, "\\'");
  const q = `mimeType = 'application/vnd.google-apps.folder' and trashed = false and name contains '${safe}'`;
  const { data } = await drive.files.list({
    q,
    fields: 'files(id, name, modifiedTime)',
    pageSize: 30,
    orderBy: 'modifiedTime desc',
  });
  return data.files || [];
}

/** List documents inside a folder. */
export async function listDocumentsInFolder(sessionId, folderId) {
  const drive = await driveClientForSession(sessionId);
  const q = `'${folderId}' in parents and trashed = false`;
  const { data } = await drive.files.list({
    q,
    fields:
      'files(id, name, mimeType, size, modifiedTime, webViewLink)',
    pageSize: 200,
    orderBy: 'name',
  });
  const all = data.files || [];
  return all.filter((f) => SUPPORTED_MIMES.has(f.mimeType));
}

/** Download a file's bytes from Drive. Returns Buffer. */
async function downloadFileBytes(drive, fileId) {
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(res.data);
}

/** Export a Google Doc as plain text. */
async function exportGoogleDocAsText(drive, fileId) {
  const res = await drive.files.export(
    { fileId, mimeType: 'text/plain' },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(res.data).toString('utf-8');
}

/** Extract plain text from a Drive file based on its mime type. */
export async function extractText(sessionId, file) {
  const drive = await driveClientForSession(sessionId);
  const { id, mimeType, name } = file;

  if (mimeType === 'application/vnd.google-apps.document') {
    return await exportGoogleDocAsText(drive, id);
  }

  const bytes = await downloadFileBytes(drive, id);

  if (mimeType === 'application/pdf') {
    const parsed = await pdfParse(bytes);
    return parsed.text || '';
  }

  if (
    mimeType ===
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    const { value } = await mammoth.extractRawText({ buffer: bytes });
    return value || '';
  }

  if (mimeType === 'text/plain' || mimeType === 'text/markdown') {
    return bytes.toString('utf-8');
  }

  throw new Error(`Unsupported mimeType ${mimeType} for ${name}`);
}
