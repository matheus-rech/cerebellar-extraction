import assert from 'assert';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TableFigureExtractor } from '../src/modules/table-figure-extractor.js';

async function runTests() {
  const tempDir = mkdtempSync(join(tmpdir(), 'table-fig-'));
  const pdfPath = join(tempDir, 'dummy.pdf');

  // Minimal PDF-like content for pdf-parse to consume safely
  writeFileSync(pdfPath, '%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');

  const extractor = new TableFigureExtractor();
  process.env.DOCLING_MCP_ENABLED = 'false';

  const visionResult = await extractor.process(
    {
      pdfPath,
      extractFigures: true,
      imageOutputDir: tempDir,
    },
    { verbose: false }
  );

  assert.strictEqual(visionResult.extraction_method, 'vision');
  assert.ok(visionResult.tables.length > 0, 'Expected fallback vision tables');
  assert.ok(
    visionResult.tables.every(table => table.rows.length > 0 && table.rows[0].length > 0),
    'Tables should include extracted rows with citation hints'
  );
  assert.ok(visionResult.figures && visionResult.figures.length > 0, 'Expected figure extraction');

  const figures = await extractor.extractFigures({ pdfPath, imageOutputDir: tempDir });
  assert.ok(figures.length > 0, 'Standalone figure extraction should return data');
  assert.ok(
    figures.every(fig => ['kaplan-meier', 'forest-plot', 'bar-chart', 'scatter', 'other'].includes(fig.type)),
    'Figures should map to known types'
  );
  assert.ok(
    figures.every(fig => fig.highlights && fig.highlights.length > 0),
    'Figures should include highlight regions'
  );
}

runTests().catch(error => {
  console.error(error);
  process.exit(1);
});
