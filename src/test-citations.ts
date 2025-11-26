/**
 * Test Claude Native Citations with PDF Position Mapping
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import {extractTextWithPositions, mapCitationToHighlights} from "./pdf-positions.js";

const client = new Anthropic();

async function testCitations() {
  const pdfPath = process.argv[2] || "./pdfs/Kim2016.pdf";

  console.log("📄 Loading PDF with positions...");
  const pdfData = await extractTextWithPositions(pdfPath);
  console.log(`   Text length: ${pdfData.text.length} chars`);
  console.log(`   Positions: ${pdfData.positions.length} items`);

  // Use FULL document to test multi-page citations
  const docText = pdfData.text;
  console.log(`   Using full document (${docText.length} chars across ${pdfData.pageCount} pages)`);

  console.log("\n🤖 Asking Claude for mortality data (typically on later pages)...\n");

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "text",
              media_type: "text/plain",
              data: Buffer.from(docText).toString("base64"),
            },
            citations: {enabled: true},
          },
          {
            type: "text",
            text: "What were the mortality outcomes at 12-month follow-up for both groups? Include the statistical significance.",
          },
        ],
      },
    ],
  });

  console.log("=== RESPONSE WITH NATIVE CITATIONS ===\n");

  for (const block of response.content) {
    if (block.type === "text") {
      console.log(`Claude: ${block.text}`);

      const citations = (block as {citations?: Array<{
        type: string;
        cited_text: string;
        start_char_index: number;
        end_char_index: number;
      }>}).citations;

      if (citations && citations.length > 0) {
        console.log("\n📎 Native Citations:");
        for (const cit of citations) {
          const decoded = Buffer.from(cit.cited_text, "base64").toString("utf-8");
          console.log(`\n   Char range: ${cit.start_char_index} - ${cit.end_char_index}`);
          console.log(`   Cited text: "${decoded.substring(0, 150)}${decoded.length > 150 ? "..." : ""}"`);

          // Map to PDF coordinates
          const highlights = mapCitationToHighlights(
            cit.start_char_index,
            cit.end_char_index,
            pdfData.positions
          );

          if (highlights.length > 0) {
            // Group highlights by page
            const byPage = new Map<number, typeof highlights>();
            for (const h of highlights) {
              if (!byPage.has(h.page)) byPage.set(h.page, []);
              byPage.get(h.page)!.push(h);
            }

            console.log(`\n   📍 PDF Highlights across ${byPage.size} page(s):`);
            for (const [page, pageHighlights] of byPage) {
              console.log(`\n   === PAGE ${page} (${pageHighlights.length} highlights) ===`);
              for (const h of pageHighlights.slice(0, 3)) {
                console.log(`      @ (${h.x.toFixed(1)}, ${h.y.toFixed(1)}) w:${h.width.toFixed(1)}`);
                console.log(`      "${h.citedText.substring(0, 60)}"`);
              }
              if (pageHighlights.length > 3) {
                console.log(`      ... and ${pageHighlights.length - 3} more`);
              }
            }
          }
        }
      } else {
        console.log("\n⚠️  No native citations in response");
      }
    }
  }
}

testCitations().catch(err => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
