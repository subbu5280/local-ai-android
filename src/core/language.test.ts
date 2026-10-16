// Cases ported from the reference POC's backend/tests/test_phase14.py (same inputs, same expected results),
// plus Malayalam, which is new here.
import { detect, instruction, type LangCode, type LangSource } from './language';

const cases: [string, LangCode, LangSource][] = [
  ['నాకు Kafka గురించి సింపుల్‌గా చెప్పండి', 'te', 'script'],
  ['ఈ Kafka architecture ని simple గా explain చేయండి', 'te', 'script'],
  ['Naaku Kafka gurinchi simple ga explain cheyyi', 'te', 'romanized'],
  ['Kafka को आसान भाषा में समझाइए', 'hi', 'script'],
  ['Kafka kya hai mujhe samjhao', 'hi', 'romanized'],
  ['Kafka ಬಗ್ಗೆ ಸರಳವಾಗಿ ಹೇಳಿ', 'kn', 'script'],
  ['Kafka பற்றி எளிமையாக சொல்லுங்கள்', 'ta', 'script'],
  ['Explain Kafka simply.', 'en', 'english'],
  ['Tell me in Telugu what Kafka is', 'te', 'explicit'],
  ['తెలుగులో చెప్పు', 'te', 'explicit'],
  // new: Malayalam
  ['Kafka എന്താണെന്ന് ലളിതമായി പറയൂ', 'ml', 'script'],
  ['Tell me in Malayalam what Kafka is', 'ml', 'explicit'],
  ['മലയാളത്തിൽ പറയൂ', 'ml', 'explicit'],
];

for (const [text, code, source] of cases) {
  test(`detect: ${text}`, () => {
    const d = detect(text);
    expect([d.code, d.source, d.bcp47]).toEqual([code, source, `${code}-IN`]);
  });
}

test('conversation language is kept and switched', () => {
  expect(detect('ok', 'te').code).toBe('te'); // short, no signal: stays Telugu
  expect(detect('2 + 2', 'ta').code).toBe('ta');
  expect(detect('ok', 'ml').code).toBe('ml');
  expect(detect('Explain this in English', 'te').code).toBe('en'); // explicit switch
  expect(detect('What is Python and why is it popular?', 'te').code).toBe('en'); // switched by writing English
  expect(detect('ఇంకా సింపుల్‌గా చెప్పు', 'en').code).toBe('te'); // back to Telugu
});

test('a single stray Indic character does not switch the language', () => {
  expect(detect('Price is 5 ₹ or ക').code).toBe('en');
});

test('instruction is one line and only when needed', () => {
  expect(instruction(detect('Explain Kafka simply.'))).toBe(''); // plain English chat: nothing extra
  const te = instruction(detect('నాకు Kafka గురించి చెప్పండి'));
  expect(te.includes('Telugu') && te.includes('Kafka') && !te.includes('\n')).toBe(true);
  expect(instruction(detect('Explain this in English', 'te'), 'te')).toBe('Respond in English.');
  expect(instruction(detect('Kafka എന്താണ്?')).includes('Malayalam script')).toBe(true);
  expect(instruction(detect('Kafka kya hai mujhe samjhao')).includes('in English letters')).toBe(true);
});
