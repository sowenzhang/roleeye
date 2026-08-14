import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MAX_FILE_BYTES, readDocument } from '../../src/resume/documents.js';

/**
 * Reading files a user hands us.
 *
 * A resume is a file of unknown provenance — templates are downloaded, and PDF
 * is a program format — so these tests are about refusing politely and reading
 * without evaluating anything (architecture.md §40).
 */

describe('document import readers', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'roleeye-docs-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function file(name: string, contents: string | Buffer): string {
    const target = path.join(root, name);
    writeFileSync(target, contents);
    return target;
  }

  it('reads plain text and markdown directly', async () => {
    const result = await readDocument(file('resume.md', '# Jane\n\n- Built things.\n'));

    assert.equal(result.format, 'markdown');
    assert.match(result.text, /Built things/);
    assert.equal(result.extractor, 'utf8');
  });

  it('refuses a file larger than the limit before parsing it', async () => {
    // The size check must happen on the file, not on what it decompresses to:
    // that ordering is the entire defence against a zip bomb.
    const oversized = Buffer.alloc(MAX_FILE_BYTES + 1024, 'a');

    await assert.rejects(() => readDocument(file('huge.txt', oversized)), /the limit is/);
  });

  it('refuses an empty file', async () => {
    await assert.rejects(() => readDocument(file('empty.txt', '')), /empty/);
  });

  it('names the fix for a legacy .doc', async () => {
    await assert.rejects(() => readDocument(file('old.doc', 'legacy')), /save as \.docx/);
  });

  it('refuses an unknown extension', async () => {
    await assert.rejects(() => readDocument(file('resume.rtf', 'x')), /unsupported file type/);
  });

  it('strips characters that would make stored text differ from what was read', async () => {
    // A right-to-left override can make a statement render as something other
    // than it reads. Approval means a human read the text, so the stored bytes
    // must be the ones they saw.
    const hostile = 'Reduced latency\u202E by 43%\u200B, using Go.\u0007';
    const result = await readDocument(file('resume.txt', hostile));

    assert.ok(!/[\u202E\u200B\u0007]/.test(result.text));
    assert.match(result.text, /Reduced latency by 43%, using Go\./);
  });

  it('hashes the bytes, so the same file is recognisable on re-import', async () => {
    const first = await readDocument(file('a.txt', 'Same content, different name.'));
    const second = await readDocument(file('b.txt', 'Same content, different name.'));

    assert.equal(first.sha256, second.sha256);
  });

  it('tells the user how to fix a missing PDF reader instead of failing obscurely', async () => {
    await assert.rejects(
      () =>
        readDocument(file('resume.pdf', '%PDF-1.4'), {
          loadPdfJs: () => Promise.reject(new Error('Cannot find module')),
        }),
      /npm install pdfjs-dist|export your resume as \.docx/,
    );
  });

  it('reads PDF text through the injected reader', async () => {
    const result = await readDocument(file('resume.pdf', '%PDF-1.4'), {
      loadPdfJs: () =>
        Promise.resolve({
          getDocument: (options: Record<string, unknown>) => {
            // The hardening flags are the point of this test: a PDF must never
            // be able to run code or fetch anything while we read its text.
            assert.equal(options['isEvalSupported'], false);
            assert.equal(options['useWorkerFetch'], false);
            assert.equal(options['disableAutoFetch'], true);

            return {
              promise: Promise.resolve({
                numPages: 1,
                getPage: () =>
                  Promise.resolve({
                    getTextContent: () =>
                      Promise.resolve({ items: [{ str: 'Rebuilt' }, { str: 'the' }, { str: 'ledger.' }] }),
                  }),
              }),
            };
          },
        }),
    });

    assert.match(result.text, /Rebuilt the ledger\./);
    assert.equal(result.extractor, 'pdfjs-dist');
  });

  it('says a scanned PDF is a scan rather than reporting no facts', async () => {
    const result = await readDocument(file('scan.pdf', '%PDF-1.4'), {
      loadPdfJs: () =>
        Promise.resolve({
          getDocument: () => ({
            promise: Promise.resolve({
              numPages: 1,
              getPage: () => Promise.resolve({ getTextContent: () => Promise.resolve({ items: [] }) }),
            }),
          }),
        }),
    });

    assert.ok(result.warnings.some((warning) => /scan/.test(warning)));
  });
});
