import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TableFigureExtractor } from '../src/modules/table-figure-extractor.js';

describe('TableFigureExtractor', () => {
  const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const originalDoclingEnabled = process.env.DOCLING_MCP_ENABLED;
  let tempDir: string;
  let pdfPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'table-fig-'));
    pdfPath = join(tempDir, 'dummy.pdf');
    writeFileSync(pdfPath, '%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');
    delete process.env.ANTHROPIC_API_KEY;
    process.env.DOCLING_MCP_ENABLED = 'false';
  });

  afterEach(() => {
    if (originalAnthropicApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
    }
    if (originalDoclingEnabled === undefined) {
      delete process.env.DOCLING_MCP_ENABLED;
    } else {
      process.env.DOCLING_MCP_ENABLED = originalDoclingEnabled;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns deterministic fallback tables and figures with valid highlights', async () => {
    const extractor = new TableFigureExtractor();
    const visionResult = await extractor.process(
      {
        pdfPath,
        extractFigures: true,
        imageOutputDir: tempDir,
      },
      { verbose: false }
    );

    expect(visionResult.extraction_method).toBe('vision');
    expect(visionResult.tables.length).toBeGreaterThan(0);
    expect(
      visionResult.tables.every(table => table.rows.length > 0 && table.rows[0].length > 0)
    ).toBe(true);
    expect(visionResult.figures?.length).toBeGreaterThan(0);
    expect(
      visionResult.figures?.every(fig => fig.highlights && fig.highlights.length > 0)
    ).toBe(true);

    const figures = await extractor.extractFigures({ pdfPath, imageOutputDir: tempDir });
    expect(figures.length).toBeGreaterThan(0);
    expect(
      figures.every(fig => ['kaplan-meier', 'forest-plot', 'bar-chart', 'scatter', 'other'].includes(fig.type))
    ).toBe(true);
    expect(
      figures.every(fig => fig.highlights && fig.highlights.length > 0)
    ).toBe(true);

    const firstHighlightBox = figures[0].highlights![0];
    expect(firstHighlightBox).toEqual(
      expect.objectContaining({
        left: expect.any(Number),
        right: expect.any(Number),
        top: expect.any(Number),
        bottom: expect.any(Number),
      })
    );
    expect(firstHighlightBox.left).toBeLessThan(firstHighlightBox.right);
    expect(firstHighlightBox.top).toBeLessThan(firstHighlightBox.bottom);
    expect(Number.isInteger(firstHighlightBox.page) && firstHighlightBox.page > 0).toBe(true);
  });

  it('normalizes named highlight boxes within the rendered page bounds', () => {
    const extractor = new TableFigureExtractor();
    const normalizeHighlights = (extractor as any).normalizeHighlights.bind(extractor);
    const parseJsonObject = (extractor as any).parseJsonObject.bind(extractor);

    expect(
      normalizeHighlights([{ left: 10, top: 20, right: 100, bottom: 200 }], 1, 595, 842)
    ).toEqual([{ left: 10, top: 20, right: 100, bottom: 200, page: 1 }]);
    expect(
      normalizeHighlights({ left: -10, top: 20, right: 700, bottom: 900 }, 2, 595, 842)
    ).toEqual([{ left: 0, top: 20, right: 595, bottom: 842, page: 2 }]);
    expect(parseJsonObject('```json\n{"tables":[]}\n```')).toEqual({ tables: [] });
  });
});
