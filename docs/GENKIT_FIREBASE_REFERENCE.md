# Genkit Complete Reference Guide

> Comprehensive documentation for Firebase Genkit framework.
> Saved for cerebellar-extraction project enhancement.

## Quick Links

- [Genkit Documentation](https://genkit.dev/docs)
- [Firebase Deployment](https://genkit.dev/docs/deployment/firebase/)
- [Cloud Run Deployment](https://genkit.dev/docs/deployment/cloud-run/)
- [Anthropic Plugin](https://github.com/BloomLabsInc/genkit-plugins/tree/main/plugins/anthropic)
- [MCP Integration](https://genkit.dev/docs/model-context-protocol/)

---

## Table of Contents

1. [Anthropic Plugin](#1-anthropic-plugin-genkitx-anthropic)
2. [Firebase Deployment with onCallGenkit](#2-firebase-deployment-with-oncallgenkit)
3. [Security Best Practices](#3-security-best-practices)
4. [Cloud Run Deployment](#4-cloud-run-deployment)
5. [Models](#5-models)
6. [Flows](#6-flows)
7. [Dotprompt](#7-dotprompt)
8. [Tool Calling](#8-tool-calling)
9. [RAG (Retrieval-Augmented Generation)](#9-rag-retrieval-augmented-generation)
10. [Chat & Sessions](#10-chat--sessions)
11. [Evaluation](#11-evaluation)
12. [MCP (Model Context Protocol)](#12-mcp-model-context-protocol)
13. [Multi-Agent Systems](#13-multi-agent-systems)
14. [Agentic Patterns](#14-agentic-patterns)
15. [Client Library](#15-client-library)
16. [Plugin Authoring](#16-plugin-authoring)
17. [AI-Assisted Development](#17-ai-assisted-development)
18. [Implementation TODO](#18-implementation-todo)

---

## 1. Anthropic Plugin (genkitx-anthropic)

### Installation
```bash
npm install genkitx-anthropic
```

### Usage
```typescript
import { genkit } from 'genkit';
import { anthropic, claude35Sonnet, claude3Haiku } from 'genkitx-anthropic';

const ai = genkit({
  plugins: [
    googleAI(),  // existing
    anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  ],
});

// Use Claude for extraction
const response = await ai.generate({
  model: claude35Sonnet,
  prompt: extractionPrompt,
});
```

### Available Models
| Model | Use Case |
|-------|----------|
| `claude37Sonnet` | Latest, best overall |
| `claude35Sonnet` | Fast + capable |
| `claude3Opus` | Most powerful |
| `claude3Haiku` | Fastest, cheapest |

---

## 2. Firebase Deployment with onCallGenkit

### Key Benefits
- Built-in streaming support
- Automatic auth handling
- Cleaner CORS management
- Proper secrets integration

### Migration Pattern

**Before (raw Cloud Functions):**
```typescript
export const extractPdf = https_fn.onRequest({
  cors: options.CorsOptions(cors_origins="*"),
}, async (req, res) => {...});
```

**After (onCallGenkit):**
```typescript
import { onCallGenkit } from 'firebase-functions/https';
import { defineSecret } from 'firebase-functions/params';

const geminiKey = defineSecret('GEMINI_API_KEY');
const anthropicKey = defineSecret('ANTHROPIC_API_KEY');

export const extractPdf = onCallGenkit(
  {
    secrets: [geminiKey, anthropicKey],
    cors: ['cerebellar-extraction.web.app', 'localhost'],
    authPolicy: (auth) => auth?.token?.email_verified === true,
    enforceAppCheck: true,
  },
  extractPdfFlow
);
```

### Secrets Management
```bash
# Set secrets securely (not in code!)
firebase functions:secrets:set GEMINI_API_KEY
firebase functions:secrets:set ANTHROPIC_API_KEY

# Deploy
firebase deploy --only functions
```

### Local Development
```bash
# With Genkit UI
genkit start -- npx tsx --watch src/index.ts

# With Firebase Emulators
genkit start -- firebase emulators:start --inspect-functions
```

---

## 3. Security Best Practices

### Authorization Policy (Required!)
```typescript
// Require email verification
authPolicy: (auth) => auth?.token?.email_verified === true

// Or custom claims
authPolicy: hasClaim('admin')
```

### App Check
```typescript
enforceAppCheck: true,
consumeAppCheckToken: true,
```

### CORS
```typescript
cors: ['cerebellar-extraction.web.app'],
```

---

## 4. Cloud Run Deployment

### Prerequisites
- Google Cloud CLI installed
- Active Google Cloud project linked to billing account

### Package.json Scripts
```json
{
  "scripts": {
    "start": "node lib/index.js",
    "build": "tsc"
  }
}
```

### Flow Server Configuration
```typescript
import { startFlowServer } from '@genkit-ai/flow';

startFlowServer({
  flows: [myFlow1, myFlow2],
  port: 3400,
  cors: { origin: true },
  pathPrefix: '/api'
});
```

### Authorization Approaches
1. **Cloud IAM-based**: Leverage Google Cloud's native access management
2. **Code-based**: Implement custom authorization via `authPolicy` parameter

### Deployment Commands

**For Google AI (Gemini):**
```bash
gcloud run deploy --update-secrets=GEMINI_API_KEY=<secret-name>:latest
```

**For Vertex AI:**
```bash
gcloud run deploy
```

### Testing Deployed Services
```bash
curl -X POST https://<url>/flowName \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  -H "Content-Type: application/json" \
  -d '{"data": {"input": "test"}}'
```

---

## 5. Models

### Using Models
```typescript
import { genkit } from 'genkit';
import { googleAI, gemini15Flash } from '@genkit-ai/googleai';

const ai = genkit({
  plugins: [googleAI()],
});

// Simple generation
const response = await ai.generate({
  model: gemini15Flash,
  prompt: 'What is the capital of France?',
});

// With config
const response = await ai.generate({
  model: gemini15Flash,
  prompt: 'Explain quantum computing',
  config: {
    temperature: 0.7,
    maxOutputTokens: 1000,
  },
});
```

### Streaming
```typescript
const { response, stream } = await ai.generateStream({
  model: gemini15Flash,
  prompt: 'Write a story about a robot',
});

for await (const chunk of stream) {
  process.stdout.write(chunk.text);
}

const finalResponse = await response;
```

### Model References
```typescript
// Use model references for flexibility
const myModel = ai.defineModel({
  name: 'my-model',
  // ... model config
});

// Reference in code
const response = await ai.generate({
  model: 'my-model',
  prompt: '...',
});
```

---

## 6. Flows

### Defining Flows
```typescript
import { genkit, z } from 'genkit';

const ai = genkit({ plugins: [googleAI()] });

// Simple flow
export const greetingFlow = ai.defineFlow(
  {
    name: 'greetingFlow',
    inputSchema: z.string(),
    outputSchema: z.string(),
  },
  async (name) => {
    const response = await ai.generate({
      model: gemini15Flash,
      prompt: `Say hello to ${name}`,
    });
    return response.text;
  }
);
```

### Flow with Streaming
```typescript
export const streamingFlow = ai.defineFlow(
  {
    name: 'streamingFlow',
    inputSchema: z.string(),
    outputSchema: z.string(),
    streamSchema: z.string(),
  },
  async (input, streamingCallback) => {
    const { response, stream } = await ai.generateStream({
      model: gemini15Flash,
      prompt: input,
    });

    for await (const chunk of stream) {
      streamingCallback(chunk.text);
    }

    return (await response).text;
  }
);
```

### Running Flows
```typescript
// Direct invocation
const result = await greetingFlow('World');

// Via CLI
// genkit flow:run greetingFlow '"World"'
```

---

## 7. Dotprompt

### Creating Prompts
```
---
model: googleai/gemini-1.5-flash
input:
  schema:
    topic: string
    style?: string
output:
  format: text
config:
  temperature: 0.8
---

Write a {{style}} article about {{topic}}.
```

### Using Prompts
```typescript
import { prompt } from '@genkit-ai/dotprompt';

const articlePrompt = await prompt('article');

const response = await articlePrompt.generate({
  input: {
    topic: 'AI in healthcare',
    style: 'technical',
  },
});
```

### Prompt Variants
```typescript
// Load specific variant
const formalPrompt = await prompt('greeting', { variant: 'formal' });
const casualPrompt = await prompt('greeting', { variant: 'casual' });
```

### Multi-Modal Prompts
```
---
model: googleai/gemini-1.5-flash
input:
  schema:
    image: string  # base64 or URL
    question: string
---

{{media url=image}}
{{question}}
```

---

## 8. Tool Calling

### Defining Tools
```typescript
const weatherTool = ai.defineTool(
  {
    name: 'getWeather',
    description: 'Gets the current weather for a location',
    inputSchema: z.object({
      location: z.string().describe('City name'),
    }),
    outputSchema: z.object({
      temperature: z.number(),
      conditions: z.string(),
    }),
  },
  async ({ location }) => {
    // Implement weather lookup
    return { temperature: 72, conditions: 'Sunny' };
  }
);
```

### Using Tools with Models
```typescript
const response = await ai.generate({
  model: gemini15Flash,
  prompt: 'What is the weather in Tokyo?',
  tools: [weatherTool],
});
```

### Tool Choice
```typescript
const response = await ai.generate({
  model: gemini15Flash,
  prompt: 'Get weather and news for NYC',
  tools: [weatherTool, newsTool],
  config: {
    toolChoice: 'auto',  // 'auto' | 'none' | 'required' | { name: 'toolName' }
  },
});
```

---

## 9. RAG (Retrieval-Augmented Generation)

### Indexers
```typescript
import { defineIndexer } from '@genkit-ai/ai/retriever';

const myIndexer = defineIndexer(
  {
    name: 'myIndexer',
    embedderRef: textEmbeddingGecko,
  },
  async (docs) => {
    // Index documents to your vector store
    for (const doc of docs) {
      const embedding = await embed(doc.content);
      await vectorStore.upsert(doc.id, embedding, doc.metadata);
    }
  }
);
```

### Retrievers
```typescript
import { defineRetriever } from '@genkit-ai/ai/retriever';

const myRetriever = defineRetriever(
  {
    name: 'myRetriever',
    configSchema: z.object({
      k: z.number().default(5),
    }),
  },
  async (query, options) => {
    const embedding = await embed(query);
    const results = await vectorStore.search(embedding, options.k);
    return results.map((r) => ({
      content: r.content,
      metadata: r.metadata,
    }));
  }
);
```

### Using RAG in Flows
```typescript
const ragFlow = ai.defineFlow(
  { name: 'ragFlow', inputSchema: z.string() },
  async (question) => {
    // Retrieve relevant documents
    const docs = await retrieve({
      retriever: myRetriever,
      query: question,
      options: { k: 5 },
    });

    // Generate answer with context
    const response = await ai.generate({
      model: gemini15Flash,
      prompt: `
        Answer based on these documents:
        ${docs.map((d) => d.content).join('\n')}

        Question: ${question}
      `,
    });

    return response.text;
  }
);
```

---

## 10. Chat & Sessions

### Basic Chat
```typescript
const chat = ai.chat({
  model: gemini15Flash,
  system: 'You are a helpful assistant',
});

const response1 = await chat.send('Hello!');
console.log(response1.text);

const response2 = await chat.send('What did I just say?');
console.log(response2.text);  // Remembers context
```

### Persistent Sessions
```typescript
import { defineSession } from '@genkit-ai/ai/session';

const session = await ai.createSession({
  store: firestoreSessionStore,  // or custom store
  initialState: { userName: 'Alice' },
});

const chat = session.chat({
  model: gemini15Flash,
  system: 'You are helping {{userName}}',
});

// Session persists across requests
await chat.send('Remember my favorite color is blue');

// Later, in a new request
const existingSession = await ai.loadSession(sessionId);
const chat2 = existingSession.chat();
await chat2.send('What is my favorite color?');  // Remembers!
```

### Multi-Turn with Tools
```typescript
const chat = ai.chat({
  model: gemini15Flash,
  tools: [weatherTool, calendarTool],
});

// Model can use tools across turns
await chat.send('What is the weather?');
await chat.send('Schedule a picnic if it is sunny');
```

---

## 11. Evaluation

### Built-in Evaluators
```typescript
import { faithfulness, relevance } from '@genkit-ai/evaluator';

const results = await evaluate({
  evaluators: [faithfulness, relevance],
  dataset: [
    {
      input: 'What is AI?',
      output: 'AI is artificial intelligence',
      reference: 'AI refers to artificial intelligence',
    },
  ],
});
```

### Custom Evaluators
```typescript
const myEvaluator = ai.defineEvaluator(
  {
    name: 'myEvaluator',
    displayName: 'Custom Metric',
    definition: 'Measures custom quality',
  },
  async (datapoint) => {
    const score = await computeScore(datapoint);
    return {
      score,
      details: { reason: 'Explanation' },
    };
  }
);
```

### NOS Consistency Evaluator (Project-Specific)
```typescript
// Already implemented in src/genkit.ts using shared utility
import { validateNosScores } from './utils/nos-validation.js';

const nosConsistencyEvaluator = ai.defineEvaluator(
  {
    name: 'nosConsistency',
    displayName: 'NOS Score Consistency',
    definition: 'Validates Newcastle-Ottawa Scale scores',
  },
  async (datapoint) => {
    const validation = validateNosScores(datapoint.output);
    return { score: validation.score };
  }
);
```

---

## 12. MCP (Model Context Protocol)

### Using MCP Tools
```typescript
import { mcp } from 'genkitx-mcp';

const ai = genkit({
  plugins: [
    mcp({
      servers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@anthropic/mcp-server-filesystem', '/path/to/files'],
        },
        docling: {
          command: 'uvx',
          args: ['docling-mcp-server'],
        },
      },
    }),
  ],
});

// Use MCP tools like regular tools
const response = await ai.generate({
  model: gemini15Flash,
  prompt: 'Analyze the document at /path/to/file.pdf',
  tools: ['mcp/filesystem', 'mcp/docling'],
});
```

### Creating MCP Servers
```typescript
// genkit mcp - exposes flows as MCP tools
// Run: genkit mcp

// Your flows become available as MCP tools:
// - get_usage_guide
// - lookup_genkit_docs
// - list_flows
// - run_flow
// - get_trace
```

### MCP in .mcp.json
```json
{
  "mcpServers": {
    "genkit-cerebellar": {
      "command": "node",
      "args": ["./node_modules/.bin/genkit", "mcp"],
      "timeout": 60000,
      "trust": true,
      "env": {
        "NODE_ENV": "production"
      }
    }
  }
}
```

---

## 13. Multi-Agent Systems

### Hierarchical Agent Architecture
```typescript
// Orchestrator agent
const orchestrator = ai.defineFlow(
  { name: 'orchestrator' },
  async (task) => {
    // Analyze task and delegate
    const plan = await ai.generate({
      model: gemini15Flash,
      prompt: `Plan subtasks for: ${task}`,
    });

    // Execute with specialist agents
    const results = await Promise.all([
      researchAgent(plan.research),
      analysisAgent(plan.analysis),
    ]);

    return synthesize(results);
  }
);

// Specialist agents
const researchAgent = ai.defineFlow(
  { name: 'researchAgent' },
  async (topic) => {
    return ai.generate({
      model: gemini15Flash,
      tools: [webSearchTool],
      prompt: `Research: ${topic}`,
    });
  }
);
```

### Agent Communication Patterns

**Tool-Based Delegation:**
```typescript
const delegateTool = ai.defineTool({
  name: 'delegateToSpecialist',
  inputSchema: z.object({
    specialist: z.enum(['research', 'analysis', 'writing']),
    task: z.string(),
  }),
  async execute({ specialist, task }) {
    return specialists[specialist](task);
  },
});
```

**Shared Context:**
```typescript
const sharedContext = {
  documents: [],
  findings: [],
  decisions: [],
};

// Agents read/write to shared context
```

---

## 14. Agentic Patterns

### Pattern Spectrum

| Pattern | Autonomy | Use Case |
|---------|----------|----------|
| Workflows | Low | Deterministic pipelines |
| Routing | Medium | Dynamic path selection |
| ReAct | High | Reasoning + Acting loops |
| Full Agents | Highest | Open-ended problem solving |

### Workflow Pattern
```typescript
const pipeline = ai.defineFlow(
  { name: 'pipeline' },
  async (input) => {
    const step1 = await extract(input);
    const step2 = await transform(step1);
    const step3 = await validate(step2);
    return step3;
  }
);
```

### Router Pattern
```typescript
const router = ai.defineFlow(
  { name: 'router' },
  async (input) => {
    const classification = await ai.generate({
      model: gemini15Flash,
      prompt: `Classify intent: ${input}`,
      output: { schema: z.enum(['question', 'command', 'chat']) },
    });

    switch (classification.output) {
      case 'question': return questionHandler(input);
      case 'command': return commandHandler(input);
      default: return chatHandler(input);
    }
  }
);
```

### ReAct Pattern
```typescript
const reactAgent = ai.defineFlow(
  { name: 'reactAgent' },
  async (goal) => {
    let state = { goal, observations: [], actions: [] };

    while (!isGoalMet(state)) {
      // Reason
      const thought = await ai.generate({
        model: gemini15Flash,
        prompt: `Given: ${JSON.stringify(state)}\nWhat should I do next?`,
      });

      // Act
      const action = parseAction(thought.text);
      const result = await executeAction(action);

      // Update state
      state.observations.push(result);
      state.actions.push(action);
    }

    return state;
  }
);
```

---

## 15. Client Library

### Non-Streaming Calls
```typescript
import { runFlow } from '@genkit-ai/client';

const result = await runFlow({
  url: 'http://127.0.0.1:3400/myFlow',
  input: { name: 'User' },
});
```

### Streaming Calls
```typescript
import { streamFlow } from '@genkit-ai/client';

const result = streamFlow({
  url: 'http://127.0.0.1:3400/myFlow',
  input: { query: 'Tell me a story' },
});

for await (const chunk of result.stream) {
  console.log('Chunk:', chunk);
}

const finalOutput = await result.output;
```

### With Authentication
```typescript
const result = await runFlow({
  url: 'http://127.0.0.1:3400/myFlow',
  headers: {
    Authorization: 'Bearer your-token-here',
  },
  input: { data: 'protected' },
});
```

### Firebase Callable Functions
```typescript
// Use Firebase client SDK instead
import { httpsCallable } from 'firebase/functions';

const myFlow = httpsCallable(functions, 'myFlow');
const result = await myFlow({ input: 'data' });
```

---

## 16. Plugin Authoring

### Plugin Structure
```typescript
import { genkitPlugin } from 'genkit';

export const myPlugin = genkitPlugin(
  'myPlugin',
  async (options) => {
    // Initialize plugin resources
    const client = new MyApiClient(options.apiKey);

    // Register models
    defineModel({
      name: 'myPlugin/my-model',
      // ... model config
    });

    // Register tools
    defineTool({
      name: 'myPlugin/my-tool',
      // ... tool config
    });
  }
);
```

### Model Plugin
```typescript
defineModel({
  name: 'myPlugin/custom-model',
  info: {
    label: 'Custom Model',
    supports: {
      multiturn: true,
      tools: true,
      media: false,
      systemRole: true,
    },
  },
  configSchema: z.object({
    temperature: z.number().optional(),
  }),
  async generate(request, options) {
    // Transform request to API format
    const apiRequest = transformRequest(request);

    // Call external API
    const apiResponse = await client.generate(apiRequest);

    // Transform response back
    return transformResponse(apiResponse);
  },
});
```

### Publishing
- Package name: `genkitx-{name}`
- Include keyword: `genkit-plugin`
- Additional keywords: `genkit-model`, `genkit-retriever`, `genkit-embedder`, etc.

---

## 17. AI-Assisted Development

### Setup
```bash
genkit init:ai-tools
```

### Supported Tools
- Gemini CLI
- Claude Code
- Cursor
- Firebase Studio
- VS Code (manual integration)

### What It Does
1. Detects existing AI assistant configurations
2. Installs Genkit MCP server
3. Creates/updates `GENKIT.md` with instructions

### MCP Tools Available
- `get_usage_guide` - Get Genkit usage guidance
- `lookup_genkit_docs` - Search documentation
- `list_flows` - List available flows
- `run_flow` - Execute a flow
- `get_trace` - Get execution traces

### Best Practices
1. Ask AI to consult the usage guide when generating code
2. Don't run `genkit start` in the assistant terminal
3. Use the generated GENKIT.md for context

---

## 18. Implementation TODO

### Immediate Actions
- [ ] Add `genkitx-anthropic` to package.json
- [ ] Update `.env.example` with ANTHROPIC_API_KEY
- [ ] Set up Firebase secrets for API keys
- [ ] Add auth policies to all flows
- [ ] Enable App Check for production

### Migration Tasks
- [ ] Migrate TypeScript functions to `onCallGenkit`
- [ ] Replace `cors: "*"` with allowlist (DONE ✅)
- [ ] Remove hardcoded API keys from frontend (DONE ✅)

### Future Enhancements
- [ ] Create dual-model extraction flow (Gemini vs Claude comparison)
- [ ] Add MCP tools for document processing
- [ ] Implement multi-agent extraction pipeline

### Dual-Model Extraction Example
```typescript
// Run both models and compare results
export const dualExtractFlow = ai.defineFlow(
  { name: 'dualExtract', inputSchema: z.string() },
  async (pdfText) => {
    const [geminiResult, claudeResult] = await Promise.all([
      ai.generate({ model: gemini25Pro, prompt: extractionPrompt }),
      ai.generate({ model: claude35Sonnet, prompt: extractionPrompt }),
    ]);

    return {
      gemini: geminiResult.output,
      claude: claudeResult.output,
      consensus: mergeResults(geminiResult, claudeResult),
    };
  }
);
```

---

*Last updated: 2024-11-28*
*Status: Reference complete - implementation pending*
