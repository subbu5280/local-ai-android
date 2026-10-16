/** Original-app features restored: in-chat games from a chat message, Reply (quoted to the model) and Copy code. */
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('@dr.pogodin/react-native-fs', () => require('../testUtils/fakeBackupEnv').fakeFs());
jest.mock('llama.rn', () => ({ releaseAllLlama: jest.fn(async () => undefined), initLlama: jest.fn() }));

import { gameRequest } from '../src/Games';
import { codeBlocks, previewText, replyPrompt } from '../App';

test('game requests open the game in chat; questions about games stay with the model', () => {
  expect(gameRequest('Create game tic toc tie here')).toEqual({ kind: 'tic_tac_toe' }); // the phone's real message
  expect(gameRequest("Let's play tic-tac-toe")).toEqual({ kind: 'tic_tac_toe' });
  expect(gameRequest('play rock paper scissors')).toEqual({ kind: 'rock_paper_scissors' });
  expect(gameRequest('start a number guessing game')).toEqual({ kind: 'number_guessing' });
  expect(gameRequest('open memory match')).toEqual({ kind: 'memory_match' });
  expect(gameRequest("let's play a game")).toMatchObject({ kind: 'game_menu' });
  for (const t of ['What are the rules of tic tac toe?', 'Explain the history of rock paper scissors', 'What is game theory?',
    'Write a tic tac toe program in Python with minimax and explain each part of the algorithm in detail for a beginner please']) {
    expect([t, gameRequest(t)]).toEqual([t, null]);
  }
});

test('reply quotes the earlier message to the model; copy code takes only fenced code', () => {
  expect(replyPrompt('Make it shorter', { role: 'assistant', text: 'Kafka stores   records\nin topics.' }))
    .toBe('I\'m replying to your earlier answer: "Kafka stores records in topics."\n\nMake it shorter');
  expect(replyPrompt('hi', null)).toBe('hi');
  expect(previewText('x'.repeat(200)).length).toBe(90);
  expect(codeBlocks('Run:\n```js\nconst a = 1;\n```\nand\n```\nls\n```')).toEqual(['const a = 1;', 'ls']);
});

test('table questions in Docs mode are calculated exactly (the M35 sheet where the model said North = 1200)', () => {
  const { tableQuestion, analyze } = require('../src/knowledge/tables');
  const t = { name: 'Sales', header: ['Region', 'Amount'], rows: [['North', '1200'], ['South', '800'], ['North', '300']] };
  const plan = tableQuestion('What is the total amount for North?', t);
  expect(plan).toEqual({ op: 'sum', column: 'Amount', where: { column: 'Region', equals: 'North' } });
  expect(analyze(t, plan.op, plan).text).toMatch(/1500/);
  expect(tableQuestion('What is the average amount?', t)).toEqual({ op: 'average', column: 'Amount', where: undefined });
  expect(tableQuestion('highest amount in South', t)).toMatchObject({ op: 'max', where: { equals: 'South' } });
  expect(tableQuestion('Which region sells more?', t)).toBeNull(); // no operation word: the model answers
  expect(tableQuestion('total of Region', t)).toBeNull(); // not a numeric column
});
