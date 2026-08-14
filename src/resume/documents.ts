import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { sha256 } from '../util/hash.js';
import { RoleEyeError, ExitCode } from '../util/errors.js';

/**
 * Reading a resume the user hands us.
 *
 * A resume is a file of unknown provenance: templates get downloaded, and PDF
 * is a program format. Import therefore obeys the untrusted-content rules
 * (architecture.md §40) even though the file is nominally the user's own —
 * bounded before parsing, capped after, and parsed by readers that cannot
 * evaluate code or reach the network.
 */

export type DocumentFormat = 'docx' | 'pdf' | 'markdown' | 'text' | 'yaml';

/** Larger than any real resume, small enough that a zip bomb cannot land. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Roughly 100 pages of text. Beyond this the file is not a resume. */
export const MAX_TEXT_CHARS = 400_000;

export const EXTRACTOR_VERSION = 'v1';

export interface ExtractedDocument {
  text: string;
  format: DocumentFormat;
  bytes: number;
  sha256: string;
  extractor: string;
  warnings: string[];
}

export function formatOf(file: string): DocumentFormat {
  const extension = path.extname(file).toLowerCase();

  switch (extension) {
    case '.docx':
      return 'docx';
    case '.pdf':
      return 'pdf';
    case '.md':
    case '.markdown':
      return 'markdown';
    case '.yaml':
    case '.yml':
      return 'yaml';
    case '.txt':
      return 'text';
    case '.doc':
      throw new RoleEyeError(
        'the legacy .doc format is not supported. Open it and save as .docx, or export to PDF.',
        ExitCode.UsageError,
      );
    default:
      throw new RoleEyeError(
        `unsupported file type "${extension || '(none)'}". Supported: .docx, .pdf, .md, .txt, .yaml`,
        ExitCode.UsageError,
      );
  }
}

/** Reads the file with its size checked *before* anything decompresses it. */
function readBounded(file: string): Buffer {
  let size: number;

  try {
    size = statSync(file).size;
  } catch {
    throw new RoleEyeError(`cannot read ${file}`, ExitCode.NotFound);
  }

  if (size > MAX_FILE_BYTES) {
    throw new RoleEyeError(
      `${path.basename(file)} is ${(size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_FILE_BYTES / 1024 / 1024} MB`,
      ExitCode.UsageError,
    );
  }

  if (size === 0) {
    throw new RoleEyeError(`${path.basename(file)} is empty`, ExitCode.UsageError);
  }

  return readFileSync(file);
}

/**
 * Control characters, zero-width joiners, and bidi overrides.
 *
 * A PDF or DOCX can carry text that renders as one thing and reads as another.
 * Statements become facts a human approves by reading them, so what is stored
 * must be what was shown.
 */
function stripInvisible(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '')
    .replace(/\r\n?/g, '\n');
}

function capText(text: string, warnings: string[]): string {
  const cleaned = stripInvisible(text).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  if (cleaned.length <= MAX_TEXT_CHARS) return cleaned;

  warnings.push(`text truncated at ${MAX_TEXT_CHARS} characters`);
  return cleaned.slice(0, MAX_TEXT_CHARS);
}

interface MammothModule {
  extractRawText(input: { buffer: Buffer }): Promise<{ value: string; messages: { message: string }[] }>;
}

interface PdfTextItem {
  str?: string;
}

interface PdfPage {
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
}

interface PdfDocument {
  numPages: number;
  getPage(index: number): Promise<PdfPage>;
  destroy?(): Promise<void>;
}

interface PdfJsModule {
  getDocument(options: Record<string, unknown>): { promise: Promise<PdfDocument> };
}

async function importPdfJs(): Promise<PdfJsModule> {
  // Not a static import: pdfjs-dist is 33 MB, eight times the rest of this
  // feature, and is only needed by users whose resume is a PDF.
  const moduleName = 'pdfjs-dist/legacy/build/pdf.mjs';
  return (await import(moduleName)) as unknown as PdfJsModule;
}

export interface ReadOptions {
  /** Injectable so tests do not depend on an optional 33 MB install. */
  loadPdfJs?: () => Promise<PdfJsModule>;
  loadMammoth?: () => Promise<MammothModule>;
}

async function readDocx(buffer: Buffer, warnings: string[], options: ReadOptions): Promise<string> {
  const load = options.loadMammoth ?? (async (): Promise<MammothModule> => (await import('mammoth')) as unknown as MammothModule);
  const mammoth = await load();
  const result = await mammoth.extractRawText({ buffer });

  for (const message of result.messages.slice(0, 5)) warnings.push(`docx: ${message.message}`);

  return result.value;
}

async function readPdf(buffer: Buffer, warnings: string[], options: ReadOptions): Promise<string> {
  let pdfjs: PdfJsModule;

  try {
    pdfjs = await (options.loadPdfJs ?? importPdfJs)();
  } catch {
    throw new RoleEyeError(
      'reading PDF resumes needs pdfjs-dist, which is not installed. Run `npm install pdfjs-dist`, or export your resume as .docx and import that.',
      ExitCode.ConfigError,
    );
  }

  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    // A PDF may contain JavaScript, external references, and font programs.
    // None of that is needed to read text, and all of it is attack surface.
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    disableAutoFetch: true,
    disableStream: true,
    stopAtErrors: false,
  });

  const document = await task.promise;
  const pages: string[] = [];

  for (let index = 1; index <= document.numPages; index += 1) {
    const page = await document.getPage(index);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => item.str ?? '').join(' '));
  }

  await document.destroy?.();

  const text = pages.join('\n\n');

  // A scanned resume is an image: pdfjs returns almost nothing and the user
  // deserves to be told why, rather than seeing "0 facts found".
  if (text.replace(/\s/g, '').length < 200) {
    warnings.push(
      'this PDF contains almost no extractable text, which usually means it is a scan. Import the .docx original instead.',
    );
  }

  return text;
}

export async function readDocument(file: string, options: ReadOptions = {}): Promise<ExtractedDocument> {
  const format = formatOf(file);
  const buffer = readBounded(file);
  const warnings: string[] = [];

  let raw: string;
  let extractor: string;

  switch (format) {
    case 'docx':
      raw = await readDocx(buffer, warnings, options);
      extractor = 'mammoth';
      break;
    case 'pdf':
      raw = await readPdf(buffer, warnings, options);
      extractor = 'pdfjs-dist';
      break;
    default:
      raw = buffer.toString('utf8');
      extractor = 'utf8';
      break;
  }

  return {
    text: capText(raw, warnings),
    format,
    bytes: buffer.byteLength,
    sha256: sha256(buffer.toString('base64')),
    extractor,
    warnings,
  };
}
