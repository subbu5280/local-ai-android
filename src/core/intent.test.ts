// Intent and complexity rules. Several cases come from the reference POC's backend/tests/test_context.py and
// test_web.py phrasing; the false-positive cases guard the tightened coding/explain patterns.
import { analyze, type Complexity, type Intent } from './intent';

const YEAR = 2026;
const cases: [string, Intent, Complexity][] = [
  // greetings: whole message only
  ['Hi', 'greeting', 'simple'],
  ['hello there!', 'greeting', 'simple'],
  ['Thank you so much 🙏', 'greeting', 'simple'],
  ['నమస్కారం', 'greeting', 'simple'],
  ['नमस्ते!', 'greeting', 'simple'],
  ['Hi, can you explain Kafka?', 'explain', 'simple'],
  // translation
  ['Translate "good morning" to Telugu', 'translation', 'simple'],
  ['How do you say thank you in Hindi?', 'translation', 'simple'],
  ["What is 'thank you' in Malayalam?", 'translation', 'simple'],
  ['ఈ వాక్యాన్ని ఇంగ్లీష్‌లోకి అనువదించండి: నేను బాగున్నాను', 'translation', 'simple'],
  // summarize
  ['Summarize this: Kafka is a distributed log. Producers write records and consumers read them.', 'summarize', 'simple'],
  ['tl;dr of the above please', 'summarize', 'simple'],
  // coding
  ['Write a Python function to reverse a string', 'coding', 'simple'],
  ['Why do I get NullPointerException in my Kotlin app?', 'coding', 'simple'],
  ['```js\nconst x = 1\n``` why does this fail', 'coding', 'simple'],
  ['Build a complete React Native app with login and profile, step by step', 'coding', 'medium'],
  // current information
  ["What's the weather in Hyderabad today?", 'current_info', 'simple'],
  ['Bitcoin price', 'current_info', 'simple'],
  ['Latest news about ISRO', 'current_info', 'simple'],
  ['When is Diwali 2026?', 'current_info', 'simple'],
  ['ఈరోజు వార్తలు ఏమిటి?', 'current_info', 'simple'],
  ['ഇന്ന് കാലാവസ്ഥ എങ്ങനെ?', 'current_info', 'simple'],
  // explanations
  ['Explain Kafka simply.', 'explain', 'simple'],
  ['How does weather forecasting work?', 'explain', 'simple'],
  ['What is a hash map?', 'explain', 'simple'],
  ['Kafka గురించి వివరించండి', 'explain', 'simple'],
  ['Kafka को आसान भाषा में समझाइए', 'explain', 'simple'],
  ['Explain Kafka in detail', 'explain', 'medium'],
  // other questions and fallback
  ['Who wrote Gitanjali?', 'question', 'simple'],
  ['What is 2 + 2?', 'question', 'simple'],
  ['Kafka ಎಂದರೆ ಏನು?', 'question', 'simple'],
  ['I feel tired after work', 'general', 'simple'],
  ['blue', 'general', 'simple'],
  // false positives the rules must avoid
  ['What is the function of the liver?', 'question', 'simple'], // not coding
  ['Let me know a good book', 'general', 'simple'],
  ['How should I react to criticism?', 'question', 'simple'],
  ['Write a movie script about a cat', 'general', 'simple'],
  ['Weather app ideas', 'general', 'simple'],
];

for (const [text, intent, complexity] of cases) {
  test(`${intent}/${complexity}: ${text.replace(/\n/g, ' ')}`, () => {
    const a = analyze(text, YEAR);
    expect([a.intent, a.complexity]).toEqual([intent, complexity]);
  });
}

test('complexity comes from visible signals: several asks, length, depth words', () => {
  expect(analyze('What is Kafka? Why is it fast? Where is it used?', YEAR).complexity).toBe('complex'); // 3 asks
  expect(analyze('What is Kafka? Why is it fast?', YEAR).complexity).toBe('medium'); // 2 asks
  expect(analyze('Compare Kafka and RabbitMQ. What are the trade-offs? Which should I pick?', YEAR).complexity).toBe('complex');
  const long = `Please look at my plan: ${'we will move the service and keep the old one running for a while '.repeat(5)}`;
  expect(analyze(long, YEAR).complexity).toBe('medium');
  expect(analyze(`Summarize: ${'Kafka stores records in topics. '.repeat(60)}`, YEAR).complexity).toBe('simple'); // one task
});

test('every decision records the word that caused it', () => {
  expect(analyze('Write a Python function', YEAR).signals).toContain('coding:python');
  expect(analyze('Explain Kafka in detail', YEAR).signals).toEqual(['explain:explain', 'depth:in detail']);
  expect(analyze('Bitcoin price', YEAR).signals).toEqual(['current:bitcoin price']);
});

test('a past year is ordinary knowledge; this year or later needs current information', () => {
  expect(analyze('When was Diwali 2020?', YEAR).intent).toBe('question');
  expect(analyze('Who will win the 2027 election?', YEAR).intent).toBe('current_info');
});

test('empty input is general and simple', () => {
  expect(analyze('   ', YEAR)).toEqual({ intent: 'general', complexity: 'simple', signals: [] });
});
