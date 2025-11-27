import { NextRequest, NextResponse } from 'next/server';

// Import the critique functionality
async function loadCritiqueSystem() {
  const fs = require('fs');
  const path = require('path');

  // Load study data from JSON file
  const studiesFile = path.join(process.cwd(), 'web', 'data', 'studies.json');
  const studiesData = JSON.parse(fs.readFileSync(studiesFile, 'utf8'));

  return { studiesData };
}

export async function POST(req: NextRequest) {
  try {
    const { studyId, mode = 'REVIEW' } = await req.json();

    if (!studyId) {
      return NextResponse.json({ error: 'Study ID is required' }, { status: 400 });
    }

    const { studiesData } = await loadCritiqueSystem();
    const study = studiesData.find((s: any) => s.id === studyId);

    if (!study) {
      return NextResponse.json({ error: 'Study not found' }, { status: 404 });
    }

    // For demo purposes, simulate a critique result
    // In a real implementation, this would call the actual Genkit critique flow
    const simulatedCritiqueResult = {
      mode: mode,
      passedValidation: true,
      overallConfidence: 0.87,
      issues: [
        {
          criticId: "mathConsistency",
          severity: "INFO",
          field: "population.sampleSize",
          message: "Sample sizes in results match Methods section",
          sourceEvidence: "The analysis included 28 patients"
        },
        {
          criticId: "sourceCitation",
          severity: "WARNING",
          field: "outcomes.mortality",
          message: "Mortality rate should include 95% confidence intervals",
          suggestedValue: "18% (95% CI: 6-35%)",
          sourceEvidence: "Group A: 1 death; Group B: 5 deaths out of 28 and 56 patients respectively"
        }
      ],
      corrections: {},
      summary: "✅ Extraction passed validation (confidence: 87%). 1 warning, 1 info item for potential improvement."
    };

    // Add a small delay to simulate processing
    await new Promise(resolve => setTimeout(resolve, 1000));

    return NextResponse.json(simulatedCritiqueResult);
  } catch (error) {
    console.error('Critique API error:', error);
    return NextResponse.json(
      { error: 'Failed to run critique analysis' },
      { status: 500 }
    );
  }
}
