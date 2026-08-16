/**
 * Download Handler
 *
 * Captures file downloads triggered by browser actions (e.g. Excel export).
 * Parses XLSX files into a text representation that the AI model can read
 * and extract structured data from.
 */

import type { Page, Download } from 'playwright';
import * as XLSX from 'xlsx';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionLogger } from '../utils/logger';

/**
 * Tracks downloads on a page. Attach to a page before triggering actions
 * that may initiate downloads. After an action, call `getDownload()` to
 * check if a file was downloaded.
 */
export class DownloadTracker {
  private downloads: Download[] = [];
  private page: Page;
  private listener: (download: Download) => void;
  private log: SessionLogger;

  constructor(page: Page, logger?: SessionLogger) {
    this.page = page;
    this.log = logger ?? { log: console.log, warn: console.warn, error: console.error, getLines: () => [] };
    this.listener = (download) => {
      this.log.log(`[Download] File download started: ${download.suggestedFilename()}`);
      this.downloads.push(download);
    };
    this.page.on('download', this.listener);
  }

  /**
   * Re-attach to a different page (e.g. when switching to a popup).
   * Removes the listener from the previous page first.
   */
  attachTo(page: Page): void {
    this.page.off('download', this.listener);
    this.page = page;
    this.page.on('download', this.listener);
  }

  /**
   * Check if any downloads were captured and return the most recent one.
   * Resets the download queue after retrieval.
   */
  async getDownload(): Promise<{ filename: string; filePath: string } | null> {
    if (this.downloads.length === 0) return null;

    const download = this.downloads[this.downloads.length - 1];
    this.downloads = [];

    // suggestedFilename() is derived from the visited (untrusted) site's
    // Content-Disposition / URL. Strip any directory components so a hostile
    // filename like "../../etc/foo" can't escape the tmp dir via path.join.
    const filename = path.basename(download.suggestedFilename());
    const tmpDir = os.tmpdir();
    const filePath = path.join(tmpDir, `crawl-download-${Date.now()}-${filename}`);

    try {
      await download.saveAs(filePath);
      // Verify file was actually saved
      if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
        this.log.warn(`[Download] Verification failed: file missing or empty (${filename})`);
        return null;
      }
      // Reject XLSX files over 50MB to prevent OOM
      const fileSize = fs.statSync(filePath).size;
      if (fileSize > 50_000_000 && /\.xlsx?$/i.test(filename)) {
        fs.unlinkSync(filePath);
        this.log.warn(`[Download] XLSX too large (${Math.round(fileSize / 1e6)}MB), skipping`);
        return null;
      }
      this.log.log(`[Download] Saved to ${filePath} (${filename}, ${Math.round(fileSize / 1024)}KB, magic=${readMagicHex(filePath)})`);
      return { filename, filePath };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`[Download] Failed to save: ${msg}`);
      return null;
    }
  }
}

/** Max bytes we will read and parse from a spreadsheet download. */
const MAX_SPREADSHEET_BYTES = 50_000_000;
const ZIP_LOCAL_FILE_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/**
 * Check ZIP local file headers for an exact archive-member name.
 *
 * This is structural rather than a byte-substring search: cell text or document
 * content that happens to contain the target string cannot pass the check.
 */
function zipHasEntry(buf: Buffer, entryName: string): boolean {
  const target = Buffer.from(entryName, 'utf8');
  let offset = 0;
  while ((offset = buf.indexOf(ZIP_LOCAL_FILE_HEADER, offset)) !== -1) {
    if (offset + 30 > buf.length) break;
    const nameLength = buf.readUInt16LE(offset + 26);
    const nameStart = offset + 30;
    if (
      nameStart + nameLength <= buf.length
      && buf.subarray(nameStart, nameStart + nameLength).equals(target)
    ) {
      return true;
    }
    offset += ZIP_LOCAL_FILE_HEADER.length;
  }
  return false;
}

function readMagicHex(filePath: string, bytes = 4): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(bytes);
    const bytesRead = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('hex');
  } catch {
    return '??';
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // A diagnostic read must not interfere with processing the download.
      }
    }
  }
}

/**
 * Recognize an Excel workbook by its container and decodability.
 *
 * This supplements filename detection for exports whose suggested filename has
 * no extension. ZIP-based files must contain the SpreadsheetML workbook member,
 * so unrelated ZIP/document formats are not accepted merely because SheetJS can
 * open them. Legacy OLE workbooks are accepted only if SheetJS decodes them.
 */
export function isDecodableExcelWorkbook(filePath: string, logger?: SessionLogger): boolean {
  const log = logger ?? console;
  let buf: Buffer;
  try {
    const size = fs.statSync(filePath).size;
    if (size < 8 || size > MAX_SPREADSHEET_BYTES) return false;
    buf = fs.readFileSync(filePath);
  } catch (err) {
    log.warn(`[Download] Could not read download for content detection: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  const isZip = buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
  const isOle = buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0;
  if (!isZip && !isOle) return false;
  if (isZip && !zipHasEntry(buf, 'xl/workbook.xml')) return false;

  try {
    const workbook = XLSX.read(buf, { type: 'buffer' });
    return Array.isArray(workbook.SheetNames)
      && workbook.SheetNames.length > 0
      && !!workbook.Sheets[workbook.SheetNames[0]];
  } catch (err) {
    log.warn(`[Download] File had an Excel signature but did not decode as a workbook: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Test whether a number format contains an actual calendar day/year token.
 * Time-only and elapsed-time formats must not turn numeric values into dates.
 */
function formatHasDateToken(format: string | number): boolean {
  const source = typeof format === 'string'
    ? format
    : (XLSX.SSF.get_table()[format] ?? '');
  const stripped = source
    .replace(/\[[^\]]*\]/g, '')
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/[_*]./g, '')
    .toLowerCase();
  return /[dy]/.test(stripped);
}

/**
 * Render one worksheet cell without locale or timezone ambiguity.
 *
 * Date-formatted serials become ISO dates; ordinary numeric cells retain their
 * raw values, and spreadsheet error cells are omitted rather than exposed as
 * misleading numeric error codes.
 */
export function formatSheetCell(cell: XLSX.CellObject | undefined, date1904 = false): string {
  if (!cell || cell.v === undefined || cell.v === null || cell.v === '') return '';
  if (cell.t === 'e') return '';

  if (
    cell.t === 'n'
    && typeof cell.v === 'number'
    && cell.z
    && XLSX.SSF.is_date(cell.z)
    && formatHasDateToken(cell.z)
  ) {
    const parsed = XLSX.SSF.parse_date_code(cell.v, { date1904 });
    if (
      parsed
      && parsed.y
      && parsed.m >= 1
      && parsed.m <= 12
      && parsed.d >= 1
      && parsed.d <= 31
    ) {
      const probe = new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d));
      if (
        probe.getUTCFullYear() === parsed.y
        && probe.getUTCMonth() === parsed.m - 1
        && probe.getUTCDate() === parsed.d
      ) {
        return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
      }
    }
  }

  return String(cell.v);
}

/**
 * Parse an XLSX file into a human-readable text table.
 * Returns a string with tab-separated values that the AI model can read.
 * Cleans up the temp file after reading.
 */
export function parseXlsxToText(filePath: string, logger?: SessionLogger): string {
  const log = logger ?? console;
  try {
    const workbook = XLSX.read(fs.readFileSync(filePath), { cellNF: true });
    const date1904 = workbook.Workbook?.WBProps?.date1904 === true;
    const parts: string[] = [];

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet || !sheet['!ref']) continue;

      const range = XLSX.utils.decode_range(sheet['!ref']);
      const rows: string[] = [];
      for (let row = range.s.r; row <= range.e.r; row++) {
        const cells: string[] = [];
        for (let column = range.s.c; column <= range.e.c; column++) {
          const address = XLSX.utils.encode_cell({ r: row, c: column });
          cells.push(formatSheetCell(sheet[address], date1904));
        }
        if (cells.every(c => c === '')) continue;
        rows.push(cells.join('\t'));
      }

      if (rows.length === 0) continue;
      parts.push(`=== Sheet: ${sheetName} ===`, ...rows, '');
    }

    const text = parts.join('\n');
    log.log(`[Download] Parsed XLSX: ${text.length} chars, ${workbook.SheetNames.length} sheets`);
    cleanupTempFile(filePath, log);
    return text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[Download] Failed to parse XLSX: ${msg}`);
    cleanupTempFile(filePath, log);
    return '';
  }
}

export function cleanupTempFile(filePath: string, log: SessionLogger | Console): void {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    log.warn(`[Download] Could not remove temp file ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
