/**
 * Built-in example skills and workflows, using only the registered tools. They go through the same validation as
 * imported definitions (skillStore seeds them only if valid), can be switched off or duplicated, not edited or deleted.
 * Names have Telugu and Hindi versions to show localized texts; ids, tool names and parameters stay English.
 */
const tv = (tools: Record<string, number>) => ({ tools });

export const BUILTIN_SKILLS = [
  {
    format: 'localai.skill', formatVersion: 1, id: 'doc-summary', version: 1,
    name: { en: 'Summarize documents on a topic', te: 'అంశంపై పత్రాల సారాంశం', hi: 'विषय पर दस्तावेज़ों का सारांश' },
    description: { en: 'Finds the most relevant passages in your documents and summarizes them with source numbers.' },
    instructions: { en: 'Give a topic. The skill searches your documents (keywords, plus meaning search when it is on) and summarizes the best passages, citing them.' },
    inputs: [{ name: 'topic', label: { en: 'Topic', te: 'అంశం', hi: 'विषय' }, type: 'text', required: true, maxLength: 300 }],
    output: 'text', tools: ['docs.search', 'text.summarize'], permissions: ['documents.read', 'model.generate'],
    limits: { maxSteps: 2, maxRetries: 1, stepTimeoutSec: 120 },
    compatibility: tv({ 'docs.search': 1, 'text.summarize': 2 }),
    steps: [
      { tool: 'docs.search', input: { query: '{{topic}}', limit: 6 }, purpose: { en: 'Find relevant passages' } },
      { tool: 'text.summarize', input: { maxWords: 120 }, fromStep: 1, purpose: { en: 'Summarize them with sources' } },
    ],
  },
  {
    format: 'localai.skill', formatVersion: 1, id: 'doc-compare', version: 1,
    name: { en: 'Compare documents on a topic', te: 'అంశంపై పత్రాల పోలిక', hi: 'विषय पर दस्तावेज़ों की तुलना' },
    description: { en: 'Collects passages from several documents and says where they agree and differ, with sources.' },
    instructions: { en: 'Give a topic. Passages from up to four documents are compared; every claim should cite its source.' },
    inputs: [{ name: 'topic', label: { en: 'Topic', te: 'అంశం', hi: 'विषय' }, type: 'text', required: true, maxLength: 300 }],
    output: 'text', tools: ['docs.search', 'docs.answer'], permissions: ['documents.read', 'model.generate'],
    limits: { maxSteps: 2, maxRetries: 1, stepTimeoutSec: 120 },
    compatibility: tv({ 'docs.search': 1, 'docs.answer': 1 }),
    steps: [
      { tool: 'docs.search', input: { query: '{{topic}}', limit: 8 }, purpose: { en: 'Find passages in several documents' } },
      { tool: 'docs.answer', input: { question: 'Compare what the different documents say about {{topic}}. Say where they agree and where they differ, citing each source.' },
        fromStep: 1, purpose: { en: 'Compare them with sources' } },
    ],
  },
  {
    format: 'localai.skill', formatVersion: 1, id: 'text-summary', version: 1,
    name: { en: 'Summarize a text', te: 'పాఠ్యం సారాంశం', hi: 'पाठ का सारांश' },
    description: { en: 'Summarizes text you paste, without using your documents.' },
    instructions: { en: 'Paste the text. The summary uses only what the text says.' },
    inputs: [{ name: 'text', label: { en: 'Text', te: 'పాఠ్యం', hi: 'पाठ' }, type: 'text', required: true, maxLength: 20000 }],
    output: 'text', tools: ['text.summarize'], permissions: ['model.generate'],
    limits: { maxSteps: 1, maxRetries: 1, stepTimeoutSec: 120 },
    compatibility: tv({ 'text.summarize': 2 }),
    steps: [{ tool: 'text.summarize', input: { text: '{{text}}', maxWords: 100 }, purpose: { en: 'Summarize the text' } }],
  },
  {
    format: 'localai.skill', formatVersion: 1, id: 'calc-explain', version: 1,
    name: { en: 'Calculate and explain', te: 'లెక్కించి వివరించు', hi: 'गणना और व्याख्या' },
    description: { en: 'Computes an expression exactly (no guessing), then explains the result in simple words.' },
    instructions: { en: 'Give an expression such as 12.5% of 80 or (3 + 4) * 2. The number comes from the calculator, the explanation from the model.' },
    inputs: [{ name: 'expression', label: { en: 'Expression', te: 'సమీకరణం', hi: 'व्यंजक' }, type: 'text', required: true, maxLength: 200 }],
    output: 'text', tools: ['calculator', 'text.compose'], permissions: ['model.generate'],
    limits: { maxSteps: 2, maxRetries: 1, stepTimeoutSec: 90 },
    compatibility: tv({ calculator: 1, 'text.compose': 1 }),
    steps: [
      { tool: 'calculator', input: { expression: '{{expression}}' }, purpose: { en: 'Calculate exactly' } },
      { tool: 'text.compose', input: { instruction: 'Explain this calculation and its result step by step in simple words.' }, fromStep: 1, purpose: { en: 'Explain the result' } },
    ],
  },
];

export const BUILTIN_WORKFLOWS = [
  {
    format: 'localai.workflow', formatVersion: 1, id: 'research-report', version: 1,
    name: { en: 'Research report to a file', te: 'పరిశోధన నివేదిక ఫైల్‌గా', hi: 'शोध रिपोर्ट फ़ाइल में' },
    purpose: { en: 'Compares your documents on a topic and saves the comparison, with its sources, as a text file you place.' },
    inputs: [{ name: 'topic', label: { en: 'Topic' }, type: 'text', required: true, maxLength: 300 }],
    limits: { maxSteps: 3, maxRetries: 1, stepTimeoutSec: 120 },
    compatibility: { tools: { 'file.export': 2 }, skills: { 'doc-compare': 1 } },
    steps: [
      { skill: 'doc-compare', skillVersion: 1, inputs: { topic: '{{topic}}' }, purpose: { en: 'Compare the documents' } },
      { tool: 'file.export', input: { fileName: 'research-report.txt' }, fromStep: 1, purpose: { en: 'Save the report (asks first)' } },
    ],
  },
  {
    format: 'localai.workflow', formatVersion: 1, id: 'study-notes', version: 1,
    name: { en: 'Study notes from documents', te: 'పత్రాల నుండి అధ్యయన గమనికలు', hi: 'दस्तावेज़ों से अध्ययन नोट्स' },
    purpose: { en: 'Summarizes your documents on a topic, then turns the summary into study questions with answers.' },
    inputs: [{ name: 'topic', label: { en: 'Topic' }, type: 'text', required: true, maxLength: 300 }],
    limits: { maxSteps: 3, maxRetries: 1, stepTimeoutSec: 120 },
    compatibility: { tools: { 'text.compose': 1 }, skills: { 'doc-summary': 1 } },
    steps: [
      { skill: 'doc-summary', skillVersion: 1, inputs: { topic: '{{topic}}' }, purpose: { en: 'Summarize the documents' } },
      { tool: 'text.compose', input: { instruction: 'Turn this summary into five short study questions with answers. Keep the source numbers like [1].' },
        fromStep: 1, purpose: { en: 'Write study questions' } },
    ],
  },
  {
    format: 'localai.workflow', formatVersion: 1, id: 'calc-and-explain', version: 1,
    name: { en: 'Calculation with explanation', te: 'వివరణతో లెక్క', hi: 'व्याख्या सहित गणना' },
    purpose: { en: 'An exact calculation and a plain-language explanation of it.' },
    inputs: [{ name: 'expression', label: { en: 'Expression' }, type: 'text', required: true, maxLength: 200 }],
    limits: { maxSteps: 2, maxRetries: 1, stepTimeoutSec: 90 },
    compatibility: { tools: {}, skills: { 'calc-explain': 1 } },
    steps: [{ skill: 'calc-explain', skillVersion: 1, inputs: { expression: '{{expression}}' } }],
  },
];
