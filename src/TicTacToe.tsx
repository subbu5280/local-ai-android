/**
 * Phase 12: built-in Tic-Tac-Toe for two players on the same device.
 *
 * The backend only sends an allow-listed spec ({kind: 'tic_tac_toe'}); this reviewed component is what runs.
 * Nothing generated is executed (no eval, no WebView, no network). Game rules are pure functions so they can be
 * tested without rendering.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

export type Player = 'X' | 'O';
export type Cell = Player | null;
export type Game = { board: Cell[]; turn: Player; winner: Player | null; draw: boolean; line: number[] | null };

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // columns
  [0, 4, 8], [2, 4, 6], // diagonals
];

/** A fresh 3×3 game; X moves first. */
export function newGame(first: Player = 'X'): Game {
  return { board: Array(9).fill(null), turn: first, winner: null, draw: false, line: null };
}

/** The winning player and line on `board`, or null. */
export function winnerOf(board: Cell[]): { player: Player; line: number[] } | null {
  const hit = LINES.find(([a, b, c]) => board[a] && board[a] === board[b] && board[a] === board[c]);
  return hit ? { player: board[hit[0]] as Player, line: hit } : null;
}

/** The game after the current player takes `cell`. Illegal moves (taken cell, finished game) change nothing. */
export function play(game: Game, cell: number): Game {
  if (game.winner || game.draw || cell < 0 || cell > 8 || game.board[cell]) return game;
  const board = game.board.slice();
  board[cell] = game.turn;
  const w = winnerOf(board);
  return {
    board,
    turn: game.turn === 'X' ? 'O' : 'X',
    winner: w?.player ?? null,
    line: w?.line ?? null,
    draw: !w && board.every(Boolean),
  };
}

/** The status line shown above the board. */
export function statusText(game: Game): string {
  if (game.winner) return `Player ${game.winner} wins!`;
  if (game.draw) return 'Draw!';
  return `Player ${game.turn}'s turn`;
}

type Colors = { text: string; muted: string; accent: string; card: string };

export function TicTacToe({ spec, color }: { spec: { title?: string; first_player?: Player }; color: Colors }) {
  const first: Player = spec.first_player === 'O' ? 'O' : 'X';
  const [game, setGame] = useState(() => newGame(first));
  const over = !!game.winner || game.draw;
  return (
    <View style={[styles.box, { borderColor: color.muted }]}>
      <Text style={[styles.title, { color: color.text }]}>{spec.title || 'Tic-Tac-Toe'}</Text>
      <Text style={[styles.status, { color: over ? color.accent : color.text }]} accessibilityLiveRegion="polite">
        {statusText(game)}
      </Text>
      <View style={styles.board}>
        {game.board.map((cell, i) => (
          <Pressable
            key={i}
            testID={`ttt-cell-${i}`}
            accessibilityRole="button"
            accessibilityLabel={`Row ${Math.floor(i / 3) + 1}, column ${(i % 3) + 1}, ${cell ?? 'empty'}`}
            disabled={over || !!cell}
            onPress={() => setGame(g => play(g, i))}
            style={[
              styles.cell,
              { borderColor: color.muted },
              game.line?.includes(i) ? { backgroundColor: color.accent } : null,
            ]}
          >
            <Text style={[styles.mark, game.line?.includes(i) ? styles.winMark : { color: color.text }]}>
              {cell ?? ''}
            </Text>
          </Pressable>
        ))}
      </View>
      <Pressable testID="ttt-again" accessibilityRole="button" onPress={() => setGame(newGame(first))}>
        <Text style={[styles.again, { color: color.accent }]}>{over ? 'Play Again' : 'Restart'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { marginTop: 8, padding: 10, borderWidth: 1, borderRadius: 10, alignItems: 'center' },
  title: { fontWeight: '700', fontSize: 16 },
  status: { marginVertical: 6, fontWeight: '600' },
  board: { width: 216, flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: 72, height: 72, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  mark: { fontSize: 34, fontWeight: '700' },
  winMark: { color: '#fff' },
  again: { marginTop: 8, fontWeight: '600' },
});
