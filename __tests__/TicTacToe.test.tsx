/**
 * Phase 12: Tic-Tac-Toe rules (pure functions) + the rendered component, tapped like a user would.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { Text } from 'react-native';
import { newGame, phoneMove, play, statusText, winnerOf, TicTacToe, type Cell, type Game } from '../src/TicTacToe';

const moves = (cells: number[]) => cells.reduce(play, newGame());

test('players alternate, X first', () => {
  const g = moves([4]);
  expect(g.board[4]).toBe('X');
  expect(g.turn).toBe('O');
  expect(statusText(newGame())).toBe("Player X's turn");
  expect(statusText(g)).toBe("Player O's turn");
});

test('winner is detected on rows, columns and diagonals', () => {
  expect(statusText(moves([0, 3, 1, 4, 2]))).toBe('Player X wins!'); // top row
  expect(statusText(moves([0, 1, 3, 2, 6]))).toBe('Player X wins!'); // left column
  expect(statusText(moves([1, 0, 2, 4, 3, 8]))).toBe('Player O wins!'); // diagonal
  expect(winnerOf(moves([2, 0, 4, 1, 6]).board)?.line).toEqual([2, 4, 6]);
});

test('draw when the board fills with no winner', () => {
  const g = moves([0, 1, 2, 4, 3, 5, 7, 6, 8]);
  expect(g.winner).toBeNull();
  expect(g.draw).toBe(true);
  expect(statusText(g)).toBe('Draw!');
});

test('illegal moves change nothing: taken cell, game over, out of range', () => {
  const g = moves([4]);
  expect(play(g, 4)).toBe(g);
  const won = moves([0, 3, 1, 4, 2]);
  expect(play(won, 8)).toBe(won);
  expect(play(g, 9)).toBe(g);
});

test('component: tap cells, win, then Play Again resets', async () => {
  const color = { text: '#111', muted: '#888', accent: '#4f46e5', card: '#eee' };
  let r!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    r = ReactTestRenderer.create(<TicTacToe spec={{ title: 'Tic-Tac-Toe', opponent: 'friend' }} color={color} />);
  });
  const texts = () => r.root.findAllByType(Text).map(t => [].concat(t.props.children).join(''));
  const byId = (id: string) => r.root.findAll(n => n.props.testID === id && typeof n.props.onPress === 'function')[0];
  const cells = () => Array.from({ length: 9 }, (_, i) => byId(`ttt-cell-${i}`));
  const tap = async (i: number) => ReactTestRenderer.act(() => cells()[i].props.onPress());
  expect(texts()).toContain("Player X's turn");
  for (const i of [0, 3, 1, 4, 2]) await tap(i);
  expect(texts()).toContain('Player X wins!');
  expect(cells()[8].props.disabled).toBe(true); // no moves after the game ends
  const again = byId('ttt-again');
  expect(texts()).toContain('Play Again');
  await ReactTestRenderer.act(() => again.props.onPress());
  expect(texts()).toContain("Player X's turn");
  expect(cells().every(c => !c.props.disabled)).toBe(true);
});

test('Hard never loses: every possible sequence of your moves ends in a phone win or a draw', () => {
  let games = 0;
  const explore = (g: Game) => {
    if (g.winner || g.draw) { games++; expect(g.winner).not.toBe('X'); return; }
    if (g.turn === 'O') { explore(play(g, phoneMove(g.board, 'O', 'hard'))); return; }
    g.board.forEach((c, i) => { if (!c) explore(play(g, i)); });
  };
  explore(newGame('X'));
  expect(games).toBeGreaterThan(50); // all of your choices were tried
});

test('Easy takes a winning move, blocks yours, and otherwise picks a free cell', () => {
  const b = (s: string): Cell[] => s.split('').map(ch => (ch === '.' ? null : (ch as Cell)));
  expect(phoneMove(b('OO.XX....'), 'O', 'easy')).toBe(2); // win
  expect(phoneMove(b('XX.O.....'), 'O', 'easy')).toBe(2); // block
  expect(phoneMove(b('XOXOXOOX.'), 'O', 'easy', () => 0)).toBe(8);
  expect(phoneMove(b('XOXOXOOXO'), 'O', 'easy')).toBe(-1);
});

test('against the phone: it answers your move after a short pause', async () => {
  jest.useFakeTimers();
  const color = { text: '#111', muted: '#888', accent: '#4f46e5', card: '#eee' };
  let r!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => { r = ReactTestRenderer.create(<TicTacToe spec={{}} color={color} />); });
  const cell = (i: number) => r.root.findAll(n => n.props.testID === `ttt-cell-${i}` && typeof n.props.onPress === 'function')[0];
  await ReactTestRenderer.act(() => cell(4).props.onPress());
  expect(cell(0).props.disabled).toBe(true); // the phone's turn: your taps wait
  await ReactTestRenderer.act(() => { jest.advanceTimersByTime(500); });
  const marks = r.root.findAll(n => n.props.testID?.startsWith?.('ttt-cell-') && typeof n.props.onPress === 'function')
    .filter(n => /column \d+, O$/.test(n.props.accessibilityLabel));
  expect(marks.length).toBe(1);
  jest.useRealTimers();
});
