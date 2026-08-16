/**
 * Tests for XLSX download parsing.
 * Creates real XLSX files and verifies parseXlsxToText produces readable output.
 */

import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  formatSheetCell,
  isDecodableExcelWorkbook,
  parseXlsxToText,
} from './download-handler';

/** Helper: create a temp XLSX file from an array of arrays */
function createTempXlsx(data: (string | number | null)[][], sheetName = 'Sheet1'): string {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const filePath = path.join(os.tmpdir(), `test-${Date.now()}-${Math.random().toString(36).slice(2)}.xlsx`);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  fs.writeFileSync(filePath, buf);
  return filePath;
}

/** Helper: create a multi-sheet XLSX */
function createMultiSheetXlsx(sheets: { name: string; data: (string | number | null)[][] }[]): string {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(s.data);
    XLSX.utils.book_append_sheet(wb, ws, s.name);
  }
  const filePath = path.join(os.tmpdir(), `test-multi-${Date.now()}.xlsx`);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  fs.writeFileSync(filePath, buf);
  return filePath;
}

describe('parseXlsxToText', () => {
  it('parses a simple spreadsheet with headers and data rows', () => {
    const data = [
      ['銘柄名', 'シンボル', '保有数量', '評価額', '取得価額'],
      ['APPLE COM(AAPL)', 'AAPL', 410.13, 76116.01, 38962.01],
      ['WALMART (WMT)', 'WMT', 203.3, 68640.82, 37812.99],
      ['MICROSOFT(MSFT)', 'MSFT', 839.61, 66387.08, 37782.61],
    ];
    const filePath = createTempXlsx(data);
    const text = parseXlsxToText(filePath);

    // Should contain all column headers
    expect(text).toContain('銘柄名');
    expect(text).toContain('シンボル');
    expect(text).toContain('保有数量');
    expect(text).toContain('評価額');

    // Should contain all tickers
    expect(text).toContain('AAPL');
    expect(text).toContain('WMT');
    expect(text).toContain('MSFT');

    // Should contain numeric values
    expect(text).toContain('410.13');
    expect(text).toContain('76116.01');

    // Should contain sheet name header
    expect(text).toContain('=== Sheet: Sheet1 ===');

    // Temp file should be cleaned up
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('handles multiple sheets', () => {
    const filePath = createMultiSheetXlsx([
      { name: 'Positions', data: [['A', 'B'], [1, 2]] },
      { name: 'Summary', data: [['C', 'D'], [3, 4]] },
    ]);

    const text = parseXlsxToText(filePath);
    expect(text).toContain('=== Sheet: Positions ===');
    expect(text).toContain('=== Sheet: Summary ===');
    expect(text).toContain('A\tB');
    expect(text).toContain('C\tD');
  });

  it('skips completely empty rows', () => {
    const data = [
      ['Header1', 'Header2'],
      [null, null],
      ['Value1', 'Value2'],
    ];
    const filePath = createTempXlsx(data);
    const text = parseXlsxToText(filePath);

    const lines = text.split('\n').filter(l => l.trim() !== '' && !l.startsWith('==='));
    expect(lines).toHaveLength(2); // header + data row, empty row skipped
  });

  it('handles an empty spreadsheet gracefully', () => {
    const filePath = createTempXlsx([]);

    const text = parseXlsxToText(filePath);
    // Should not crash, may be empty or just have sheet header
    expect(typeof text).toBe('string');
  });

  it('returns empty string for nonexistent file', () => {
    const text = parseXlsxToText('/tmp/nonexistent-file-12345.xlsx');
    expect(text).toBe('');
  });

  it('handles a non-xlsx file without crashing', () => {
    // SheetJS may parse plain text as CSV — that's OK, the key thing is no crash
    const filePath = path.join(os.tmpdir(), `test-invalid-${Date.now()}.xlsx`);
    fs.writeFileSync(filePath, 'this is not an xlsx file');
    const text = parseXlsxToText(filePath);
    expect(typeof text).toBe('string');
    // Should still clean up
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('preserves non-Latin text correctly', () => {
    const data = [
      ['銘柄名', '種別', '通貨'],
      ['サンプル連動投信', '投資信託', '日本円'],
      ['サンプル工業', '株式', '米ドル'],
    ];
    const filePath = createTempXlsx(data);
    const text = parseXlsxToText(filePath);

    expect(text).toContain('サンプル連動投信');
    expect(text).toContain('サンプル工業');
    expect(text).toContain('米ドル');
  });

  it('formats output as tab-separated values', () => {
    const data = [
      ['Col1', 'Col2', 'Col3'],
      ['A', 'B', 'C'],
    ];
    const filePath = createTempXlsx(data);
    const text = parseXlsxToText(filePath);

    // Find the header line and check tab separation
    const lines = text.split('\n').filter(l => !l.startsWith('===') && l.trim() !== '');
    expect(lines[0]).toBe('Col1\tCol2\tCol3');
    expect(lines[1]).toBe('A\tB\tC');
  });

  it('renders date-formatted serials as timezone-independent ISO dates', () => {
    const filePath = createTempXlsx([['Date', 46211]]);
    const workbook = XLSX.read(fs.readFileSync(filePath), { cellNF: true });
    workbook.Sheets.Sheet1.B1.z = 'dd/mm/yyyy';
    fs.writeFileSync(filePath, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));

    expect(parseXlsxToText(filePath)).toContain('2026-07-08');
  });
});

describe('formatSheetCell', () => {
  it('does not turn time-only values into early-1900 dates', () => {
    expect(formatSheetCell({ t: 'n', v: 0.5, z: 'h:mm' })).toBe('0.5');
  });

  it('honours the workbook 1904 date epoch', () => {
    expect(formatSheetCell({ t: 'n', v: 1, z: 'yyyy-mm-dd' }, true)).toBe('1904-01-02');
  });

  it('omits spreadsheet error codes', () => {
    expect(formatSheetCell({ t: 'e', v: 7 })).toBe('');
  });

  it('does not emit Excel’s fictional 1900 leap day as an ISO date', () => {
    expect(formatSheetCell({ t: 'n', v: 60, z: 'yyyy-mm-dd' })).toBe('60');
  });
});

describe('isDecodableExcelWorkbook', () => {
  it('recognizes a genuine workbook even when the filename has no extension', () => {
    const workbookPath = createTempXlsx([['Amount'], [12.34]]);
    const extensionlessPath = workbookPath.replace(/\.xlsx$/, '');
    fs.renameSync(workbookPath, extensionlessPath);
    try {
      expect(isDecodableExcelWorkbook(extensionlessPath)).toBe(true);
    } finally {
      if (fs.existsSync(extensionlessPath)) fs.unlinkSync(extensionlessPath);
    }
  });

  it('rejects text and unrelated ZIP-shaped data', () => {
    const textPath = path.join(os.tmpdir(), `test-text-${Date.now()}`);
    const zipPath = path.join(os.tmpdir(), `test-zip-${Date.now()}`);
    fs.writeFileSync(textPath, 'plain text export');
    fs.writeFileSync(zipPath, Buffer.from([
      0x50, 0x4b, 0x03, 0x04,
      ...new Array(40).fill(0),
    ]));
    try {
      expect(isDecodableExcelWorkbook(textPath)).toBe(false);
      expect(isDecodableExcelWorkbook(zipPath)).toBe(false);
    } finally {
      fs.unlinkSync(textPath);
      fs.unlinkSync(zipPath);
    }
  });
});
