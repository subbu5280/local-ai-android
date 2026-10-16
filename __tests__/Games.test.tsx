/**
 * Phase 13: Rock Paper Scissors, Number Guessing, Memory Match rules (pure functions) + rendered components,
 * and the game menu. Randomness is injected so every outcome is deterministic here.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { Text } from 'react-native';
import {
  addToScore, computerHand, flip, guess, hideMismatch, isComplete, newGuessGame, newMemoryGame, rpsOutcome,
  FACES, GameMenu, MemoryMatch, NumberGuessing, RockPaperScissors, type Hand, type MemoryGame,
} from '../src/Games';

const color = { text: '#111', muted: '#888', accent: '#4f46e5', card: '#eee' };

async function render(el: React.ReactElement) {
  let r!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    r = ReactTestRenderer.create(el);
  });
  const texts = () => r.root.findAllByType(Text).map(t => [].concat(t.props.children).join(''));
  const byId = (id: string) => r.root.findAll(n => n.props.testID === id && typeof n.props.onPress === 'function')[0];
  const press = (id: string) => ReactTestRenderer.act(() => byId(id).props.onPress());
  return { r, texts, byId, press };
}

// ---------------------------------------------------------------- Rock Paper Scissors
test('RPS: every outcome combination', () => {
  const table: [Hand, Hand, string][] = [
    ['rock', 'rock', 'draw'], ['rock', 'paper', 'lose'], ['rock', 'scissors', 'win'],
    ['paper', 'rock', 'win'], ['paper', 'paper', 'draw'], ['paper', 'scissors', 'lose'],
    ['scissors', 'rock', 'lose'], ['scissors', 'paper', 'win'], ['scissors', 'scissors', 'draw'],
  ];
  for (const [p, c, want] of table) expect(rpsOutcome(p, c)).toBe(want);
});

test('RPS: computer hand covers all three choices; score adds up', () => {
  expect([0, 0.34, 0.67, 0.9999].map(x => computerHand(() => x))).toEqual(['rock', 'paper', 'scissors', 'scissors']);
  let s = { wins: 0, losses: 0, draws: 0 };
  for (const o of ['win', 'win', 'lose', 'draw'] as const) s = addToScore(s, o);
  expect(s).toEqual({ wins: 2, losses: 1, draws: 1 });
});

test('RPS component: play, score, Play Again, Reset', async () => {
  const spy = jest.spyOn(Math, 'random').mockReturnValue(0.9); // computer: scissors
  const { texts, press, byId } = await render(<RockPaperScissors spec={{}} color={color} />);
  await press('rps-rock');
  expect(texts()).toContain('You: rock · Computer: scissors → You win!');
  expect(texts()).toContain('Score · You 1 · Computer 0 · Draws 0');
  expect(byId('rps-paper').props.disabled).toBe(true); // one choice per round
  await press('rps-again');
  await press('rps-paper');
  expect(texts()).toContain('Score · You 1 · Computer 1 · Draws 0');
  await press('rps-reset');
  expect(texts()).toContain('Score · You 0 · Computer 0 · Draws 0');
  expect(texts()).toContain('Choose rock, paper or scissors');
  spy.mockRestore();
});

// ---------------------------------------------------------------- Number Guessing
test('Number guessing: secret in 1-20, too high/low/correct, attempts', () => {
  expect(newGuessGame(1, 20, () => 0).secret).toBe(1);
  expect(newGuessGame(1, 20, () => 0.9999).secret).toBe(20);
  let g = newGuessGame(1, 20, () => 0.6); // secret 13
  expect(g.secret).toBe(13);
  g = guess(g, '18');
  expect(g.message).toBe('18 is too high');
  g = guess(g, '4');
  expect(g.message).toBe('4 is too low');
  g = guess(g, ' 13 ');
  expect(g.done).toBe(true);
  expect(g.message).toBe('Correct! It was 13. You got it in 3 attempts.');
  expect(guess(g, '5')).toBe(g); // finished: further guesses ignored
});

test('Number guessing: invalid input is explained and not counted', () => {
  const g = newGuessGame(1, 20, () => 0.6);
  for (const bad of ['abc', '', '0', '21', '7.5', '-3', '1e1']) {
    const after = guess(g, bad);
    expect(after.attempts).toBe(0);
    expect(after.message).toContain('enter a whole number from 1 to 20');
  }
});

test('Number guessing component: guess via input, then New Game resets', async () => {
  const spy = jest.spyOn(Math, 'random').mockReturnValue(0.6); // 13
  const { r, texts, press } = await render(<NumberGuessing spec={{ min: 1, max: 20 }} color={color} />);
  const input = () => r.root.findAll(n => n.props.testID === 'guess-input' && typeof n.props.onChangeText === 'function')[0];
  await ReactTestRenderer.act(() => input().props.onChangeText('19'));
  await press('guess-submit');
  expect(texts()).toContain('19 is too high');
  expect(texts()).toContain('Attempts: 1');
  await ReactTestRenderer.act(() => input().props.onChangeText('13'));
  await press('guess-submit');
  expect(texts()).toContain('Correct! It was 13. You got it in 2 attempts.');
  await press('guess-new');
  expect(texts()).toContain('Attempts: 0');
  expect(texts()).toContain('Guess a number from 1 to 20');
  spy.mockRestore();
});

// ---------------------------------------------------------------- Memory Match
const ordered = (): MemoryGame => ({
  cards: [...FACES, ...FACES].map(face => ({ face, matched: false })), open: [], moves: 0, locked: false,
}); // card i and i+8 are a pair

test('Memory: 16 cards, 8 pairs, all hidden at start', () => {
  const g = newMemoryGame(() => 0.5);
  expect(g.cards).toHaveLength(16);
  expect(new Set(g.cards.map(c => c.face)).size).toBe(8);
  expect(g.cards.every(c => !c.matched) && g.open.length === 0).toBe(true);
});

test('Memory: matching pair stays, mismatch flips back, moves count, rapid taps blocked', () => {
  let g = flip(flip(ordered(), 0), 8);
  expect(g.cards[0].matched && g.cards[8].matched).toBe(true);
  expect(g.moves).toBe(1);
  g = flip(flip(g, 1), 2); // mismatch
  expect(g.locked).toBe(true);
  expect(g.open).toEqual([1, 2]);
  expect(g.moves).toBe(2);
  expect(flip(g, 3)).toBe(g); // third card while the pair is showing: ignored
  g = hideMismatch(g);
  expect(g.open).toEqual([]);
  expect(g.locked).toBe(false);
  expect(flip(g, 0)).toBe(g); // matched card can't be reopened
  const one = flip(g, 4);
  expect(flip(one, 4)).toBe(one); // same card twice doesn't count
});

test('Memory: completion after all 8 pairs', () => {
  let g = ordered();
  for (let i = 0; i < 8; i++) g = flip(flip(g, i), i + 8);
  expect(isComplete(g)).toBe(true);
  expect(g.moves).toBe(8);
});

test('Memory component: mismatch flips back after the delay; New Game resets', async () => {
  jest.useFakeTimers();
  const { r, texts, press } = await render(<MemoryMatch spec={{}} color={color} />);
  const label = (i: number) => r.root.findAll(n => n.props.testID === `mem-${i}` && n.props.accessibilityLabel)[0].props.accessibilityLabel;
  const faces = r.root.findAll(n => /^mem-\d+$/.test(n.props.testID ?? '') && typeof n.props.onPress === 'function');
  expect(faces).toHaveLength(16);
  expect(label(0)).toBe('Card 1, hidden');
  // find two cards that do NOT match by reading faces after flipping (the deck is random here)
  await press('mem-0');
  await press('mem-1');
  const first = label(0), second = label(1);
  expect(texts()).toContain('Moves: 1');
  if (!first.endsWith('matched')) {
    await ReactTestRenderer.act(() => { jest.advanceTimersByTime(800); });
    expect(label(0)).toBe('Card 1, hidden');
    expect(second).not.toContain('hidden');
  }
  await press('mem-new');
  expect(texts()).toContain('Moves: 0');
  jest.useRealTimers();
});

// ---------------------------------------------------------------- menu
test('Game menu lists the four games and opens the chosen one', async () => {
  const games = [
    { kind: 'tic_tac_toe', title: 'Tic-Tac-Toe' }, { kind: 'rock_paper_scissors', title: 'Rock Paper Scissors' },
    { kind: 'number_guessing', title: 'Number Guessing', min: 1, max: 20 }, { kind: 'memory_match', title: 'Memory Match' },
    { kind: 'evil', title: 'Not allowed' },
  ];
  const { texts, press } = await render(<GameMenu spec={{ games }} color={color} />);
  expect(texts()).toEqual(expect.arrayContaining(['Tic-Tac-Toe', 'Rock Paper Scissors', 'Number Guessing', 'Memory Match']));
  expect(texts()).not.toContain('Not allowed');
  await press('menu-number_guessing');
  expect(texts()).toContain('Guess a number from 1 to 20');
  await press('menu-back');
  await press('menu-tic_tac_toe');
  expect(texts()).toContain("Player X's turn");
});
