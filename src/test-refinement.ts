/**
 * Test citation refinement - finding specific text within broad citations
 */

import {extractTextWithPositions, refineCitationForText} from "./pdf-positions.js";

async function test() {
  console.log("📄 Loading PDF positions...\n");
  const pdfData = await extractTextWithPositions("./pdfs/Kim2016.pdf");

  // Claude's broad citation was chars 0-52628
  // Let's find specific text within it
  const searchTerms = [
    "log-rank",
    "P<0.05",
    "12-month",
    "mortality",
    "group A",
    "group B",
    "66.7%",
    "51.0%",
  ];

  console.log("=== Refining Broad Citation to Find Specific Text ===\n");

  for (const term of searchTerms) {
    const highlights = refineCitationForText(term, 0, 52628, pdfData.positions);
    if (highlights.length > 0) {
      console.log(`"${term}" found ${highlights.length} time(s):`);
      for (const h of highlights.slice(0, 3)) {
        console.log(`  📍 Page ${h.page} @ (${h.x.toFixed(1)}, ${h.y.toFixed(1)})`);
        console.log(`     Text: "${h.citedText}"`);
      }
      if (highlights.length > 3) {
        console.log(`  ... and ${highlights.length - 3} more`);
      }
      console.log();
    } else {
      console.log(`"${term}" - not found\n`);
    }
  }
}

test().catch(console.error);
