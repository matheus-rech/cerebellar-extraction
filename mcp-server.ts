#!/usr/bin/env node

import { createMcpServer } from '@genkit-ai/mcp';
import { googleAI } from '@genkit-ai/googleai';
import { genkit, z } from 'genkit';

// Import the main AI instance and flows from your project
// We'll dynamically import the genkit.ts module
async function loadGenkitFlows() {
  // Dynamic import to avoid circular dependencies
  const genkitModule = await import('./src/genkit.js');

  return {
    extractStudyData: genkitModule.extractStudyData,
    checkAndSaveStudy: genkitModule.checkAndSaveStudy,
    listStudies: genkitModule.listStudies,
    searchSimilarStudies: genkitModule.searchSimilarStudies,
    evaluateExtraction: genkitModule.evaluateExtraction,
    CerebellarSDCSchema: genkitModule.CerebellarSDCSchema,
    formatVerificationReport: genkitModule.formatVerificationReport,
    ai: genkitModule.ai,
  };
}

// Create the MCP server
async function createServer() {
  const flows = await loadGenkitFlows();

  // Define additional tools for the MCP server using the shared AI instance
  const ai = flows.ai;

  // Add auxiliary tools beyond the flows
  ai.defineTool(
    {
      name: 'formatVerificationReport',
      description: 'Format extracted study data into a human-readable verification report with source citations',
      inputSchema: z.object({
        data: flows.CerebellarSDCSchema,
      }),
      outputSchema: z.object({
        report: z.string(),
      }),
    },
    async ({ data }) => {
      return { report: flows.formatVerificationReport(data) };
    }
  );

  ai.defineTool(
    {
      name: 'analyzePdfText',
      description: 'Analyze PDF text to identify study type, design, and key characteristics before full extraction',
      inputSchema: z.object({
        pdfText: z.string(),
      }),
      outputSchema: z.object({
        studyType: z.string(),
        isRelevant: z.boolean(),
        confidence: z.number(),
        keyCharacteristics: z.string(),
      }),
    },
    async ({ pdfText }) => {
      const { output } = await ai.generate({
        prompt: `Analyze this medical research paper text and determine:
1. What type of study is this? (RCT, retrospective cohort, case series, etc.)
2. Is this relevant to cerebellar stroke and Suboccipital Decompressive Craniectomy?
3. Key characteristics (sample size, outcomes measured, etc.)

Text:
${pdfText.slice(0, 2000)}`, // First 2k chars for analysis
        output: {
          schema: z.object({
            studyType: z.string(),
            isRelevant: z.boolean(),
            confidence: z.number(),
            keyCharacteristics: z.string(),
          }),
        },
      });
      return output!;
    }
  );

  // Create the MCP server using Genkit's MCP plugin
  const server = createMcpServer(ai, {
    name: 'firebase-genkit-cerebellar-mcp',
    version: '1.0.0',
  });

  return server;
}

// Setup and run the server
async function main() {
  try {
    const server = await createServer();

    // Setup and start the MCP server
    server.setup().then(async () => {
      await server.start();
      console.error('Firebase Genkit Cerebellar MCP Server started successfully');
    }).catch((error) => {
      console.error('Failed to start MCP server:', error);
      process.exit(1);
    });

  } catch (error) {
    console.error('Error creating MCP server:', error);
    process.exit(1);
  }
}

main();
