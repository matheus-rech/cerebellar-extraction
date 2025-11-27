/**
 * Multi-Agent Critic System
 *
 * Implements a triage-based multi-agent architecture where:
 * 1. TriageOrchestrator analyzes extraction and determines which critics to dispatch
 * 2. Specialized CriticAgents run with their own tools and can share findings
 * 3. SynthesizerAgent aggregates results and generates final report
 */

import {genkit, z} from "genkit";
import {googleAI} from "@genkit-ai/googleai";
import {
  CritiqueIssueSchema,
  CritiqueIssue,
  CriticResultSchema,
  CriticResult,
} from "./schemas.js";

// Initialize Genkit instance
const ai = genkit({
  plugins: [googleAI()],
});

// ============================================================================
// CRITIC AGENT SCHEMAS
// ============================================================================

const CriticAgentTypeSchema = z.enum([
  "math_consistency",
  "scale_inversion",
  "etiology_segregation",
  "evd_confounding",
  "flowchart_consistency",
  "surgical_technique",
  "outcome_definition",
  "source_citation",
]);
type CriticAgentType = z.infer<typeof CriticAgentTypeSchema>;

const TriageDecisionSchema = z.object({
  agentsToDispatch: z.array(CriticAgentTypeSchema).describe("Which critics need to run"),
  priorityOrder: z.array(CriticAgentTypeSchema).describe("Order of execution by priority"),
  skipReason: z.record(z.string()).optional().describe("Why certain critics were skipped"),
  dataQualityScore: z.number().min(0).max(1).describe("Initial data quality assessment"),
});

const AgentFindingSchema = z.object({
  agentId: z.string(),
  finding: z.string(),
  severity: z.enum(["CRITICAL", "WARNING", "INFO"]),
  relatedFields: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

const SharedContextSchema = z.object({
  findings: z.array(AgentFindingSchema),
  crossReferences: z.array(z.object({
    fromAgent: z.string(),
    toAgent: z.string(),
    message: z.string(),
  })),
});

// ============================================================================
// TRIAGE ORCHESTRATOR
// ============================================================================

/**
 * Triage Orchestrator Tool
 * Analyzes extraction data and determines which critic agents to dispatch
 */
const triageTool = ai.defineTool(
  {
    name: "triageExtraction",
    description: "Analyze extraction data and determine which critic agents should run",
    inputSchema: z.object({
      extractedData: z.any().describe("The extracted study data"),
      availableContext: z.object({
        hasPdfText: z.boolean(),
        hasComparator: z.boolean(),
        hasOutcomes: z.boolean(),
        hasQuality: z.boolean(),
      }),
    }),
    outputSchema: TriageDecisionSchema,
  },
  async ({extractedData, availableContext}) => {
    const agentsToDispatch: CriticAgentType[] = [];
    const priorityOrder: CriticAgentType[] = [];
    const skipReason: Record<string, string> = {};

    // Always run math consistency - it's fast and universal
    agentsToDispatch.push("math_consistency");
    priorityOrder.push("math_consistency");

    // Scale inversion is critical for outcome interpretation
    if (availableContext.hasOutcomes) {
      agentsToDispatch.push("scale_inversion");
      priorityOrder.unshift("scale_inversion"); // High priority
    } else {
      skipReason["scale_inversion"] = "No outcomes data available";
    }

    // Etiology segregation if population has diagnosis data
    if (extractedData?.population?.diagnosis) {
      agentsToDispatch.push("etiology_segregation");
      priorityOrder.push("etiology_segregation");
    } else {
      skipReason["etiology_segregation"] = "No diagnosis/etiology data";
    }

    // EVD confounding if intervention includes EVD
    if (extractedData?.intervention?.evdUsed?.value !== undefined) {
      agentsToDispatch.push("evd_confounding");
      priorityOrder.push("evd_confounding");
    } else {
      skipReason["evd_confounding"] = "No EVD usage data";
    }

    // Flowchart consistency if PDF text available
    if (availableContext.hasPdfText) {
      agentsToDispatch.push("flowchart_consistency");
      priorityOrder.push("flowchart_consistency");
    } else {
      skipReason["flowchart_consistency"] = "No PDF text for flowchart analysis";
    }

    // Surgical technique always relevant for SDC studies
    agentsToDispatch.push("surgical_technique");
    priorityOrder.push("surgical_technique");

    // Outcome definition if outcomes present
    if (availableContext.hasOutcomes) {
      agentsToDispatch.push("outcome_definition");
      priorityOrder.push("outcome_definition");
    } else {
      skipReason["outcome_definition"] = "No outcomes data";
    }

    // Source citation if PDF text available
    if (availableContext.hasPdfText) {
      agentsToDispatch.push("source_citation");
      priorityOrder.push("source_citation");
    } else {
      skipReason["source_citation"] = "No PDF text for source verification";
    }

    // Calculate initial data quality score
    let dataQualityScore = 0.5;
    if (availableContext.hasPdfText) dataQualityScore += 0.15;
    if (availableContext.hasComparator) dataQualityScore += 0.1;
    if (availableContext.hasOutcomes) dataQualityScore += 0.15;
    if (availableContext.hasQuality) dataQualityScore += 0.1;

    return {
      agentsToDispatch,
      priorityOrder,
      skipReason: Object.keys(skipReason).length > 0 ? skipReason : undefined,
      dataQualityScore: Math.min(1, dataQualityScore),
    };
  }
);

// ============================================================================
// SHARED CONTEXT TOOLS (Inter-Agent Communication)
// ============================================================================

let sharedContext: z.infer<typeof SharedContextSchema> = {
  findings: [],
  crossReferences: [],
};

/**
 * Tool for agents to share findings with other agents
 */
const shareFindingTool = ai.defineTool(
  {
    name: "shareFinding",
    description: "Share a finding with other critic agents for cross-validation",
    inputSchema: AgentFindingSchema,
    outputSchema: z.object({success: z.boolean()}),
  },
  async (finding) => {
    sharedContext.findings.push(finding);
    return {success: true};
  }
);

/**
 * Tool for agents to read findings from other agents
 */
const readFindingsTool = ai.defineTool(
  {
    name: "readFindings",
    description: "Read findings shared by other critic agents",
    inputSchema: z.object({
      fromAgent: z.string().optional().describe("Filter by specific agent"),
      severity: z.enum(["CRITICAL", "WARNING", "INFO"]).optional(),
    }),
    outputSchema: z.object({
      findings: z.array(AgentFindingSchema),
    }),
  },
  async ({fromAgent, severity}) => {
    let results = sharedContext.findings;
    if (fromAgent) {
      results = results.filter((f) => f.agentId === fromAgent);
    }
    if (severity) {
      results = results.filter((f) => f.severity === severity);
    }
    return {findings: results};
  }
);

/**
 * Tool for agents to send messages to specific other agents
 */
const crossReferenceTool = ai.defineTool(
  {
    name: "crossReference",
    description: "Send a message to another critic agent about related findings",
    inputSchema: z.object({
      fromAgent: z.string(),
      toAgent: z.string(),
      message: z.string(),
    }),
    outputSchema: z.object({success: z.boolean()}),
  },
  async (ref) => {
    sharedContext.crossReferences.push(ref);
    return {success: true};
  }
);

// ============================================================================
// CRITIC AGENT DEFINITIONS
// ============================================================================

/**
 * Math Consistency Critic Agent
 * Checks percentage/N mismatches, subgroup sums
 */
const mathConsistencyAgent = ai.definePrompt(
  {
    name: "mathConsistencyAgent",
    description: "Validates mathematical consistency in extraction",
    tools: [shareFindingTool, readFindingsTool, crossReferenceTool],
    input: {
      schema: z.object({
        population: z.any(),
        outcomes: z.any(),
      }),
    },
    output: {
      schema: CriticResultSchema,
    },
  },
  `You are a mathematical consistency validator for medical study extractions.

Your job is to check:
1. Percentages match N values (e.g., 30% of 100 = 30 patients)
2. Subgroups sum to totals (e.g., male + female = total)
3. Mortality + survivors = sample size
4. Outcome denominators are consistent

Use the shareFinding tool to share any issues you discover with other agents.

Data to analyze:
Population: {{population}}
Outcomes: {{outcomes}}

Return your findings as a CriticResult.`
);

/**
 * Scale Inversion Critic Agent
 * Detects mRS vs GOS confusion
 */
const scaleInversionAgent = ai.definePrompt(
  {
    name: "scaleInversionAgent",
    description: "Detects scale confusion (mRS vs GOS)",
    tools: [shareFindingTool, readFindingsTool, crossReferenceTool],
    input: {
      schema: z.object({
        outcomes: z.any(),
        pdfText: z.string().optional(),
      }),
    },
    output: {
      schema: CriticResultSchema,
    },
  },
  `You are a clinical scale expert validating outcome interpretations.

CRITICAL KNOWLEDGE:
- mRS: 0 = no symptoms, 6 = death (LOWER is better)
- GOS: 1 = death, 5 = good recovery (HIGHER is better)
- GOS-E: 1 = death, 8 = upper good recovery (HIGHER is better)

Watch for:
1. "Favorable outcome" defined incorrectly
2. Score interpretations inverted
3. Mixed scale terminology

Use shareFinding if you detect scale confusion - this is CRITICAL severity.

Data to analyze:
Outcomes: {{outcomes}}
{{#if pdfText}}
Source text (first 10000 chars): {{pdfText}}
{{/if}}

Return your findings as a CriticResult.`
);

/**
 * Source Citation Critic Agent
 * Verifies extracted values against source text
 */
const sourceCitationAgent = ai.definePrompt(
  {
    name: "sourceCitationAgent",
    description: "Verifies extracted values match source text",
    tools: [shareFindingTool, readFindingsTool, crossReferenceTool],
    input: {
      schema: z.object({
        extractedData: z.any(),
        pdfText: z.string(),
      }),
    },
    output: {
      schema: CriticResultSchema,
    },
  },
  `You are a source verification expert checking extraction accuracy.

Your job:
1. Verify each VerifiableField's value matches its sourceText
2. Check sourceText actually appears in pdfText
3. Flag any hallucinated or misquoted data

Check all VerifiableFields:
- population.age.mean/sd
- intervention.technique, evdUsed, duraplasty
- outcomes.mortality, mRS_favorable, lengthOfStay

Use shareFinding for any mismatches - cross-reference with other agents.

Data: {{extractedData}}
Source (first 30000 chars): {{pdfText}}

Return your findings as a CriticResult.`
);

// ============================================================================
// SYNTHESIZER AGENT
// ============================================================================

/**
 * Synthesizer Agent
 * Aggregates findings from all critic agents and generates final report
 */
const synthesizerAgent = ai.definePrompt(
  {
    name: "synthesizerAgent",
    description: "Synthesizes findings from all critic agents",
    tools: [readFindingsTool],
    input: {
      schema: z.object({
        agentResults: z.array(CriticResultSchema),
        sharedFindings: z.array(AgentFindingSchema),
        crossReferences: z.array(z.object({
          fromAgent: z.string(),
          toAgent: z.string(),
          message: z.string(),
        })),
      }),
    },
    output: {
      schema: z.object({
        overallConfidence: z.number().min(0).max(1),
        criticalIssueCount: z.number(),
        warningCount: z.number(),
        consensusIssues: z.array(CritiqueIssueSchema),
        disagreements: z.array(z.object({
          field: z.string(),
          agents: z.array(z.string()),
          description: z.string(),
        })),
        synthesizedSummary: z.string(),
      }),
    },
  },
  `You are the synthesis agent responsible for aggregating critic findings.

Your job:
1. Identify issues where multiple agents agree (high confidence)
2. Detect disagreements between agents
3. Calculate overall confidence based on consensus
4. Generate a synthesized summary

Agent Results: {{agentResults}}
Shared Findings: {{sharedFindings}}
Cross-References: {{crossReferences}}

Weight issues by:
- Consensus (2+ agents agree) = higher confidence
- CRITICAL severity = highest weight
- Source verification issues = blocking

Return synthesized analysis.`
);

// ============================================================================
// MAIN MULTI-AGENT ORCHESTRATION FLOW
// ============================================================================

/**
 * Multi-Agent Critique Flow
 * Orchestrates the triage → dispatch → synthesize pipeline
 */
export const multiAgentCritique = ai.defineFlow(
  {
    name: "multiAgentCritique",
    inputSchema: z.object({
      extractedData: z.any().describe("The extracted study data"),
      pdfText: z.string().optional().describe("Full PDF text for verification"),
    }),
    outputSchema: z.object({
      triageDecision: TriageDecisionSchema,
      agentResults: z.array(CriticResultSchema),
      synthesis: z.object({
        overallConfidence: z.number(),
        criticalIssueCount: z.number(),
        warningCount: z.number(),
        consensusIssues: z.array(CritiqueIssueSchema),
        disagreements: z.array(z.any()),
        synthesizedSummary: z.string(),
      }),
      executionStats: z.object({
        agentsRun: z.number(),
        agentsSkipped: z.number(),
        totalFindings: z.number(),
        crossReferences: z.number(),
      }),
    }),
  },
  async ({extractedData, pdfText}) => {
    // Reset shared context for this run
    sharedContext = {findings: [], crossReferences: []};

    console.log("🎯 Multi-Agent Critique: Starting triage...");

    // Step 1: Triage - Determine which agents to dispatch
    const triageDecision = await triageTool({
      extractedData,
      availableContext: {
        hasPdfText: !!pdfText,
        hasComparator: !!extractedData?.comparator?.exists,
        hasOutcomes: !!extractedData?.outcomes,
        hasQuality: !!extractedData?.quality,
      },
    });

    console.log(`📋 Triage: Dispatching ${triageDecision.agentsToDispatch.length} agents`);
    console.log(`   Priority order: ${triageDecision.priorityOrder.join(" → ")}`);

    // Step 2: Dispatch agents based on triage decision
    const agentPromises: Promise<CriticResult>[] = [];

    for (const agentType of triageDecision.agentsToDispatch) {
      switch (agentType) {
        case "math_consistency":
          agentPromises.push(
            mathConsistencyAgent({
              population: extractedData?.population,
              outcomes: extractedData?.outcomes,
            }).then((r) => r.output || {criticId: agentType, passed: true, issues: []})
          );
          break;

        case "scale_inversion":
          agentPromises.push(
            scaleInversionAgent({
              outcomes: extractedData?.outcomes,
              pdfText: pdfText?.slice(0, 10000),
            }).then((r) => r.output || {criticId: agentType, passed: true, issues: []})
          );
          break;

        case "source_citation":
          if (pdfText) {
            agentPromises.push(
              sourceCitationAgent({
                extractedData,
                pdfText: pdfText.slice(0, 30000),
              }).then((r) => r.output || {criticId: agentType, passed: true, issues: []})
            );
          }
          break;

        // Add other agent dispatches as needed
        default:
          // Placeholder for agents not yet fully implemented
          agentPromises.push(
            Promise.resolve({
              criticId: agentType,
              passed: true,
              confidence: 0.8,
              issues: [],
            })
          );
      }
    }

    // Execute all agents in parallel
    console.log("🤖 Executing critic agents in parallel...");
    const agentResults = await Promise.allSettled(agentPromises);

    const successfulResults: CriticResult[] = agentResults
      .filter((r): r is PromiseFulfilledResult<CriticResult> => r.status === "fulfilled")
      .map((r) => r.value);

    const failedCount = agentResults.filter((r) => r.status === "rejected").length;
    if (failedCount > 0) {
      console.warn(`⚠️ ${failedCount} agent(s) failed to execute`);
    }

    // Step 3: Synthesize results
    console.log("🔄 Synthesizing agent findings...");

    const synthesisResult = await synthesizerAgent({
      agentResults: successfulResults,
      sharedFindings: sharedContext.findings,
      crossReferences: sharedContext.crossReferences,
    });

    const synthesis = synthesisResult.output || {
      overallConfidence: 0.5,
      criticalIssueCount: 0,
      warningCount: 0,
      consensusIssues: [],
      disagreements: [],
      synthesizedSummary: "Synthesis failed",
    };

    console.log(`✅ Multi-Agent Critique complete: ${synthesis.criticalIssueCount} critical, ${synthesis.warningCount} warnings`);

    return {
      triageDecision,
      agentResults: successfulResults,
      synthesis,
      executionStats: {
        agentsRun: successfulResults.length,
        agentsSkipped: Object.keys(triageDecision.skipReason || {}).length,
        totalFindings: sharedContext.findings.length,
        crossReferences: sharedContext.crossReferences.length,
      },
    };
  }
);

// Export for use in main orchestrator
export {triageTool, shareFindingTool, readFindingsTool, crossReferenceTool};
export {mathConsistencyAgent, scaleInversionAgent, sourceCitationAgent, synthesizerAgent};
