/**
 * Stateless PDF renderer for report-kit.
 * Uses local headless Chromium / chrome-headless-shell when available,
 * with deterministic standard conforming %PDF-1.4 fallback engine.
 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface RenderPdfOptions {
  timeoutMs?: number;
  preferChromium?: boolean;
  /** Retained, reviewed artifacts must never silently use the text-only fallback. */
  requireChromium?: boolean;
  /** Immutable review time used as the PDF metadata date for reproducible retries. */
  documentDate?: string;
}

export interface RenderPdfResult {
  pdfBuffer: Buffer;
  sha256: string;
  byteLength: number;
  renderer: 'chromium' | 'deterministic-fallback';
}

/** Chromium embeds wall-clock creation dates. Replace only fixed-width metadata
 * values so a founder retry can reproduce the reviewed PDF byte-for-byte. */
function normalizeChromiumPdfMetadata(bytes: Buffer, documentDate: string): Buffer {
  const instant = new Date(documentDate);
  if (!Number.isFinite(instant.getTime())) throw new Error('Invalid immutable PDF document date');
  const canonical = `D:${instant.toISOString().slice(0, 19).replace(/[-:T]/g, '')}+00'00'`;
  const raw = bytes.toString('latin1');
  let dates = 0;
  const normalized = raw.replace(
    /\/(CreationDate|ModDate) \(D:\d{14}[+-]\d{2}'\d{2}'\)/g,
    (_match, field: string) => {
      dates++;
      return `/${field} (${canonical})`;
    },
  );
  if (dates !== 2 || normalized.length !== raw.length) {
    throw new Error('Chromium PDF metadata format is unsupported');
  }
  return Buffer.from(normalized, 'latin1');
}

/** Known locations for headless chromium / chrome-headless-shell */
function findChromiumExecutable(): string | null {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  if (
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH &&
    existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)
  ) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }

  const home = process.env.HOME || '';
  const candidates = [
    // Playwright standard cache paths
    join(
      home,
      'Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell',
    ),
    join(
      home,
      'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell',
    ),
    join(
      home,
      '.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux/chrome-headless-shell',
    ),
    join(home, '.cache/ms-playwright/chromium-1243/chrome-linux/chrome'),
    // System installations
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];

  for (const c of candidates) {
    if (c && existsSync(c)) {
      return c;
    }
  }
  return null;
}

/**
 * Safely extracts visible text from HTML using a linear character scanner without
 * regular expressions, preventing polynomial backtracking (ReDoS) and sanitization bypasses.
 */
function extractVisibleText(htmlContent: string): string {
  let inTag = false;
  let inScript = false;
  let inStyle = false;
  let currentTag = '';
  let result = '';

  for (let i = 0; i < htmlContent.length; i++) {
    const char = htmlContent[i];
    if (char === '<') {
      inTag = true;
      currentTag = '';
    } else if (char === '>') {
      inTag = false;
      const tagLower = currentTag.trim().toLowerCase();
      if (tagLower.startsWith('script')) {
        inScript = true;
      } else if (tagLower.startsWith('/script')) {
        inScript = false;
      } else if (tagLower.startsWith('style')) {
        inStyle = true;
      } else if (tagLower.startsWith('/style')) {
        inStyle = false;
      }
      result += ' ';
    } else if (inTag) {
      currentTag += char;
    } else if (!inScript && !inStyle) {
      result += char;
    }
  }

  // Collapse whitespaces linearly without regex
  let collapsed = '';
  let prevSpace = false;
  for (let i = 0; i < result.length; i++) {
    const c = result[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      if (!prevSpace) {
        collapsed += ' ';
        prevSpace = true;
      }
    } else {
      collapsed += c;
      prevSpace = false;
    }
  }
  return collapsed.trim();
}

/**
 * Safely extracts document title without regular expressions.
 */
function extractTitle(htmlContent: string): string {
  const startIdx = htmlContent.toLowerCase().indexOf('<title>');
  if (startIdx === -1) return 'Axiom Proof Board Report';
  const afterStart = startIdx + 7;
  const endIdx = htmlContent.toLowerCase().indexOf('</title>', afterStart);
  if (endIdx === -1) return 'Axiom Proof Board Report';
  const title = htmlContent.slice(afterStart, endIdx).trim();
  return title || 'Axiom Proof Board Report';
}

/**
 * Safely sanitizes text for PDF Type 1 standard font literals.
 * Converts unicode quotes, dashes, checkmarks, bullets to ASCII,
 * removes non-printable characters, and escapes literal parentheses and backslashes.
 */
function sanitizePdfText(str: string): string {
  return str
    .replace(/[\u2014\u2013]/g, '-')
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[✓✔]/g, '[OK]')
    .replace(/[✗✘]/g, '[X]')
    .replace(/[\u2022\u00B7]/g, '|')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/[()\\]/g, '\\$&');
}

/**
 * Wraps text into lines with at most maxCharsPerLine without cutting words.
 */
function wrapTextToLines(text: string, maxCharsPerLine = 72): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (const w of words) {
    if (!current) {
      current = w;
    } else if (current.length + 1 + w.length <= maxCharsPerLine) {
      current += ' ' + w;
    } else {
      lines.push(current);
      current = w;
    }
  }
  if (current) {
    lines.push(current);
  }
  return lines;
}

/**
 * Deterministically generates a compliant, beautifully formatted %PDF-1.4 document buffer from HTML text.
 * Uses Indigo and Teal for unsealed report presentation.
 * and guarantees text never overflows printable page margins.
 */
function generateDeterministicPdf(htmlContent: string): Buffer {
  const title = extractTitle(htmlContent);
  const cleanText = extractVisibleText(htmlContent);
  const allLines = wrapTextToLines(cleanText, 72);

  const page1Max = 40;
  const subsequentMax = 48;
  const pagesLines: string[][] = [];

  if (allLines.length <= page1Max) {
    pagesLines.push(allLines.length > 0 ? allLines : ['(No report content recorded)']);
  } else {
    pagesLines.push(allLines.slice(0, page1Max));
    let remaining = allLines.slice(page1Max);
    while (remaining.length > 0) {
      pagesLines.push(remaining.slice(0, subsequentMax));
      remaining = remaining.slice(subsequentMax);
    }
  }

  const totalPages = pagesLines.length;
  const streams: string[] = [];

  for (let p = 0; p < totalPages; p++) {
    const pageNum = p + 1;
    const lines = pagesLines[p]!;
    let stream = '';

    if (pageNum === 1) {
      // Page 1 Header Banner (Indigo with Teal accent; Gold is for sealed proof).
      stream += `0.118 0.165 0.290 rg\n40 758 515.28 48 re f\n`;
      stream += `0.059 0.710 0.647 rg\n40 754 515.28 4 re f\n`;
      // White banner text
      stream += `BT\n1 1 1 rg\n/F2 13 Tf\n52 786 Td\n(Axiom Proof | Recorded Report) Tj\n`;
      stream += `/F1 8.5 Tf\n0 -18 Td\n(Axiom Minds Private Limited | https://axiomminds.ai | https://axiomproof.ai) Tj\nET\n`;

      // Subheader Document Title & Axiom Proof Metadata
      stream += `BT\n0.118 0.165 0.290 rg\n/F2 11 Tf\n40 730 Td\n(${sanitizePdfText(title.slice(0, 75))}) Tj\n`;
      stream += `/F1 8.5 Tf\n0 -14 Td\n(Platform: Axiom Proof (https://axiomproof.ai) | Fiduciary Compliance Infrastructure) Tj\n`;
      stream += `/F1 8 Tf\n0 -12 Td\n(Tagline: "Agents do the work. You approve. The proof is automatic.") Tj\nET\n`;

      // Separator line
      stream += `0.85 0.85 0.85 RG 1 w\n40 694 m 555 694 l S\n`;

      // Body text lines
      if (lines.length > 0) {
        stream += `BT\n0.12 0.15 0.20 rg\n/F1 9 Tf\n40 676 Td\n(${sanitizePdfText(lines[0]!)}) Tj\n`;
        for (let i = 1; i < lines.length; i++) {
          stream += `0 -13.5 Td\n(${sanitizePdfText(lines[i]!)}) Tj\n`;
        }
        stream += `ET\n`;
      }
    } else {
      // Subsequent Pages Mini Banner
      stream += `0.118 0.165 0.290 rg\n40 788 515.28 24 re f\n`;
      stream += `0.059 0.710 0.647 rg\n40 785 515.28 3 re f\n`;
      stream += `BT\n1 1 1 rg\n/F2 9.5 Tf\n52 795 Td\n(Axiom Proof - Recorded Report (Continued)) Tj\nET\n`;

      // Body text lines
      if (lines.length > 0) {
        stream += `BT\n0.12 0.15 0.20 rg\n/F1 9 Tf\n40 762 Td\n(${sanitizePdfText(lines[0]!)}) Tj\n`;
        for (let i = 1; i < lines.length; i++) {
          stream += `0 -13.5 Td\n(${sanitizePdfText(lines[i]!)}) Tj\n`;
        }
        stream += `ET\n`;
      }
    }

    // Page Footer (Applicable to all pages)
    stream += `0.85 0.85 0.85 RG 0.5 w\n40 50 m 555 50 l S\n`;
    stream += `BT\n0.45 0.45 0.50 rg\n/F1 7.5 Tf\n40 38 Td\n(Axiom Proof | Axiom Minds Private Limited (https://axiomminds.ai) | https://axiomproof.ai | Page ${pageNum} of ${totalPages}) Tj\n`;
    stream += `/F1 7 Tf\n0 -11 Td\n(Rendered from supplied report data. Storage retention is not verified by this renderer.) Tj\nET\n`;

    streams.push(stream);
  }

  const pageObjectIds: number[] = [];
  const contentObjectIds: number[] = [];
  for (let p = 0; p < totalPages; p++) {
    pageObjectIds.push(3 + p);
  }
  for (let p = 0; p < totalPages; p++) {
    contentObjectIds.push(3 + totalPages + p);
  }
  const fontF1Id = 3 + 2 * totalPages;
  const fontF2Id = 3 + 2 * totalPages + 1;
  const totalObjects = 2 + 2 * totalPages + 2;

  const objects: string[] = [];

  // Object 1: Catalog
  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj`);

  // Object 2: Pages
  const kidsStr = pageObjectIds.map((id) => `${id} 0 R`).join(' ');
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${kidsStr}] /Count ${totalPages} >>\nendobj`);

  // Objects for each Page
  for (let p = 0; p < totalPages; p++) {
    const pageId = pageObjectIds[p]!;
    const contentId = contentObjectIds[p]!;
    objects.push(
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontF1Id} 0 R /F2 ${fontF2Id} 0 R >> >> >>\nendobj`,
    );
  }

  // Objects for each Content stream
  for (let p = 0; p < totalPages; p++) {
    const contentId = contentObjectIds[p]!;
    const streamContent = streams[p]!;
    const streamLen = Buffer.byteLength(streamContent, 'utf-8');
    objects.push(
      `${contentId} 0 obj\n<< /Length ${streamLen} >>\nstream\n${streamContent}\nendstream\nendobj`,
    );
  }

  // Font F1 (Helvetica)
  objects.push(`${fontF1Id} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj`);
  // Font F2 (Helvetica-Bold)
  objects.push(
    `${fontF2Id} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj`,
  );

  let pdfStr = '%PDF-1.4\n';
  const offsets: number[] = [0];

  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdfStr, 'utf-8'));
    pdfStr += obj + '\n';
  }

  const xrefOffset = Buffer.byteLength(pdfStr, 'utf-8');
  pdfStr += `xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`;

  for (let i = 1; i <= totalObjects; i++) {
    pdfStr += `${offsets[i]!.toString().padStart(10, '0')} 00000 n \n`;
  }

  pdfStr += `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdfStr, 'utf-8');
}

/**
 * A short, log-safe reason for a failed Chromium run. The child's stderr holds
 * only browser diagnostics and local temp paths, never report content.
 */
export function describeChromiumFailure(label: string, error: unknown): string {
  if (!(error instanceof Error)) return `${label}: unknown failure`;
  const failure = error as Error & {
    killed?: boolean;
    signal?: string | null;
    code?: string | number | null;
    stderr?: unknown;
  };
  const parts = [label];
  if (failure.killed) parts.push('killed (timeout)');
  if (failure.signal) parts.push(`signal=${failure.signal}`);
  if (failure.code !== undefined && failure.code !== null) parts.push(`code=${failure.code}`);
  const stderr = typeof failure.stderr === 'string' ? failure.stderr.trim() : '';
  if (stderr) parts.push(`stderr=${stderr.replace(/\s+/g, ' ').slice(-300)}`);
  if (parts.length === 1) parts.push(failure.message.slice(0, 200));
  return parts.join(' ');
}

/**
 * Render HTML to deterministic PDF buffer.
 */
export async function renderHtmlToPdf(
  htmlContent: string,
  options: RenderPdfOptions = {},
): Promise<RenderPdfResult> {
  const timeoutMs = options.timeoutMs ?? 10000;
  const preferChromium = options.preferChromium ?? true;
  if (options.requireChromium && !preferChromium) {
    throw new Error('Chromium is required for this PDF');
  }
  if (options.requireChromium && !options.documentDate) {
    throw new Error('Immutable document date is required for this PDF');
  }

  const chromiumPath = preferChromium ? findChromiumExecutable() : null;
  if (options.requireChromium && !chromiumPath) {
    throw new Error('Chromium is unavailable for this PDF');
  }

  if (chromiumPath) {
    const tempPrefix = join(tmpdir(), `axiom-report-${Date.now()}-${randomUUID()}`);
    const inHtmlPath = `${tempPrefix}.html`;
    const outPdfPath = `${tempPrefix}.pdf`;
    const profilePath = `${tempPrefix}-profile`;
    let firstFailure = '';

    try {
      await fs.writeFile(inHtmlPath, htmlContent, { encoding: 'utf-8', mode: 0o600 });

      const baseArgs = [
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-software-rasterizer',
        '--disable-background-networking',
        '--disable-extensions',
        '--disable-javascript',
        '--no-first-run',
        `--user-data-dir=${profilePath}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--no-pdf-header-footer',
        `--print-to-pdf=${outPdfPath}`,
        inHtmlPath,
      ];
      const childOptions = {
        timeout: timeoutMs,
        killSignal: 'SIGKILL' as const,
        env: { ...process.env, HOME: tmpdir(), XDG_CACHE_HOME: join(tmpdir(), 'chrome-cache') },
      };

      try {
        await execFileAsync(chromiumPath, ['--headless=new', ...baseArgs], childOptions);
      } catch (first) {
        firstFailure = describeChromiumFailure('headless=new', first);
        // Fallback to classic '--headless' if '--headless=new' is not accepted by older Chromium
        try {
          await execFileAsync(chromiumPath, ['--headless', ...baseArgs], childOptions);
        } catch (second) {
          throw new Error(`${firstFailure}; ${describeChromiumFailure('headless', second)}`);
        }
      }

      const rawPdf = await fs.readFile(outPdfPath);
      const pdfBuffer = options.documentDate
        ? normalizeChromiumPdfMetadata(rawPdf, options.documentDate)
        : rawPdf;
      if (pdfBuffer.length < 500 || pdfBuffer.toString('ascii', 0, 5) !== '%PDF-') {
        throw new Error('Chromium produced invalid PDF bytes');
      }
      const sha256 = createHash('sha256').update(pdfBuffer).digest('hex');

      return {
        pdfBuffer,
        sha256,
        byteLength: pdfBuffer.length,
        renderer: 'chromium',
      };
    } catch (cause) {
      if (options.requireChromium) {
        const reason = cause instanceof Error ? cause.message.slice(0, 600) : 'unknown';
        throw new Error(`Chromium PDF rendering failed: ${reason}`);
      }
      // Other callers may use the text-only fallback when Chromium fails.
    } finally {
      await fs.unlink(inHtmlPath).catch(() => {});
      await fs.unlink(outPdfPath).catch(() => {});
      await fs.rm(profilePath, { recursive: true, force: true }).catch(() => {});
    }
  }

  const pdfBuffer = generateDeterministicPdf(htmlContent);
  const sha256 = createHash('sha256').update(pdfBuffer).digest('hex');

  return {
    pdfBuffer,
    sha256,
    byteLength: pdfBuffer.length,
    renderer: 'deterministic-fallback',
  };
}
