import { buildPrompt, previousLanguage } from './prompt';

const YEAR = 2026;
/** Everything before the user's text (the guidance block), or '' when there is none. */
const guidanceOf = (prompt: string, text: string) => (prompt === text ? '' : prompt.slice(0, -(text.length + 2)));

test("the user's text is always the end of the prompt, unchanged", () => {
  const texts = ['Hi', 'Explain Kafka simply.', 'Translate "good morning" to Telugu. Keep it formal!',
    'Write a Python function. Use type hints, no recursion.', "What's the weather today?",
    'Kafka గురించి చెప్పండి', 'What is Kafka? Why is it fast? Where is it used?'];
  for (const text of texts) {
    const { prompt } = buildPrompt(text, null, YEAR);
    expect(prompt.endsWith(text)).toBe(true);
    if (prompt !== text) expect(prompt.endsWith(`\n\n${text}`)).toBe(true); // guidance is a separate block
  }
});

test('a plain English question or greeting gets no guidance at all', () => {
  for (const text of ['Hi', 'Explain Kafka simply.', 'Who wrote Gitanjali?', 'I feel tired']) {
    expect(buildPrompt(text, null, YEAR).prompt).toBe(text);
  }
});

test('language selection is unchanged from M2.1', () => {
  const te = buildPrompt('Kafka గురించి చెప్పండి', null, YEAR);
  expect(te.lang).toBe('te');
  expect(te.prompt).toMatch(/^Language: Respond in Telugu written in Telugu script\./);
  expect(buildPrompt('ok', 'te', YEAR)).toMatchObject({ lang: 'te' }); // short reply keeps the chat's language
  expect(buildPrompt('ok', 'te', YEAR).prompt).toMatch(/^Language: Respond in Telugu/);
  expect(buildPrompt('Explain this in English', 'te', YEAR).prompt).toBe('Respond in English.\n\nExplain this in English');
  expect(buildPrompt('Kafka എന്താണ്?', null, YEAR).lang).toBe('ml');
});

test('task guidance only where it helps, one line each, at most two guidance lines', () => {
  const tr = buildPrompt('Translate "good morning" to Telugu', null, YEAR);
  expect(tr.intent).toBe('translation');
  expect(guidanceOf(tr.prompt, 'Translate "good morning" to Telugu').split('\n')).toEqual([
    expect.stringMatching(/^Language: Respond in Telugu/), // the target language, from language.ts
    expect.stringMatching(/^Task: Translate faithfully\. Reply with the translation only/),
  ]);
  expect(buildPrompt('Summarize: Kafka is a log.', null, YEAR).prompt).toMatch(/^Task: Summarize only what the given text says/);
  expect(buildPrompt('Write a Python function', null, YEAR).prompt).toMatch(/^Task: Put any code in a fenced code block\.\n\n/);
  expect(buildPrompt("Today's gold price?", null, YEAR).prompt).toMatch(/^Task: You have no internet access/);
  expect(buildPrompt('What is Kafka? Why is it fast? Where is it used?', null, YEAR).prompt)
    .toMatch(/^Task: Answer every part of the request/);
  expect(buildPrompt('Explain Kafka in detail', null, YEAR).prompt).toBe('Explain Kafka in detail'); // medium: no line
});

test('guidance lines never repeat the system message or each other', () => {
  for (const text of ['Translate "hi" to Hindi', 'ఈరోజు వార్తలు ఏమిటి?', 'Build a complete Kotlin app, step by step']) {
    const lines = buildPrompt(text, null, YEAR).prompt.split('\n\n')[0].split('\n');
    expect(new Set(lines).size).toBe(lines.length);
    expect(lines.some(l => /concise|helpful assistant/i.test(l))).toBe(false);
  }
});

test('result carries intent, complexity and the deciding signals', () => {
  expect(buildPrompt('Bitcoin price', null, YEAR)).toMatchObject({
    intent: 'current_info', complexity: 'simple', signals: ['current:bitcoin price'],
  });
});

test('previousLanguage reads the last user message only', () => {
  expect(previousLanguage([{ role: 'user', lang: 'ml' }, { role: 'assistant' }])).toBe('ml');
  expect(previousLanguage([{ role: 'user', lang: 'te' }, { role: 'user' }])).toBeNull();
  expect(previousLanguage([])).toBeNull();
});
