/**
 * Phase 12: built-in Tic-Tac-Toe, against the phone (Easy / Hard) or for two players on the same device.
 *
 * The backend only sends an allow-listed spec ({kind: 'tic_tac_toe'}); this reviewed component is what runs.
 * Nothing generated is executed (no eval, no WebView, no network). Game rules are pure functions so they can be
 * tested without rendering.
 */
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Celebration, haptic, Pop } from './GameFX';

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

export type Level = 'easy' | 'hard';

/** Minimax score of `board` for `me` with `turn` to move: +10 win, -10 loss, 0 draw (sooner wins score higher). */
function score(board: Cell[], me: Player, turn: Player, depth: number): number {
  const w = winnerOf(board);
  if (w) return w.player === me ? 10 - depth : depth - 10;
  if (board.every(Boolean)) return 0;
  const scores: number[] = [];
  board.forEach((c, i) => {
    if (c) return;
    const next = board.slice();
    next[i] = turn;
    scores.push(score(next, me, turn === 'X' ? 'O' : 'X', depth + 1));
  });
  return turn === me ? Math.max(...scores) : Math.min(...scores);
}

/**
 * The phone's move on `board` as `me`. Hard: perfect play (minimax), it never loses. Easy: takes a winning move or
 * blocks yours when it sees one, otherwise plays a random free cell, so it can be beaten. -1 when no move is left.
 */
export function phoneMove(board: Cell[], me: Player, level: Level, rng: () => number = Math.random): number {
  const free = board.map((c, i) => (c ? -1 : i)).filter(i => i >= 0);
  if (!free.length) return -1;
  const them: Player = me === 'X' ? 'O' : 'X';
  const wins = (who: Player) => free.find(i => { const b = board.slice(); b[i] = who; return winnerOf(b)?.player === who; });
  if (level === 'easy') return wins(me) ?? wins(them) ?? free[Math.floor(rng() * free.length)];
  let best = free[0];
  let bestScore = -Infinity;
  for (const i of free) {
    const b = board.slice();
    b[i] = me;
    const sc = score(b, me, them, 1);
    if (sc > bestScore) { bestScore = sc; best = i; }
  }
  return best;
}

export type Tally = { you: number; phone: number; draws: number };

type Colors = { text: string; muted: string; accent: string; card: string };

type Opponent = 'phone' | 'friend';

export function TicTacToe({ spec, color }: { spec: { title?: string; first_player?: Player; opponent?: Opponent }; color: Colors }) {
  const first: Player = spec.first_player === 'O' ? 'O' : 'X';
  const [opponent, setOpponent] = useState<Opponent>(spec.opponent === 'friend' ? 'friend' : 'phone');
  const [level, setLevel] = useState<Level>('easy');
  const [game, setGame] = useState(() => newGame(first));
  const [tally, setTally] = useState<Tally>({ you: 0, phone: 0, draws: 0 });
  const over = !!game.winner || game.draw;
  const phoneTurn = opponent === 'phone' && !over && game.turn === 'O';

  // The phone answers after a short "thinking" pause, so its move lands as its own beat.
  useEffect(() => {
    if (!phoneTurn) return;
    const t = setTimeout(() => setGame(g => play(g, phoneMove(g.board, 'O', level))), 450);
    return () => clearTimeout(t);
  }, [phoneTurn, game.board, level]);

  // Feel and score when a game ends.
  useEffect(() => {
    if (!over) return;
    if (opponent === 'phone') {
      setTally(t => (game.winner === 'X' ? { ...t, you: t.you + 1 } : game.winner === 'O' ? { ...t, phone: t.phone + 1 } : { ...t, draws: t.draws + 1 }));
      haptic(game.winner === 'O' ? 'lose' : 'win');
    } else {
      haptic('win');
    }
  }, [over]); // eslint-disable-line react-hooks/exhaustive-deps

  const restart = (o: Opponent = opponent) => { setOpponent(o); setGame(newGame(first)); };
  const status = opponent === 'phone'
    ? game.winner === 'X' ? 'You win!' : game.winner === 'O' ? 'The phone wins' : game.draw ? 'Draw!' : phoneTurn ? 'Phone is thinking…' : 'Your turn (X)'
    : statusText(game);
  const won = opponent === 'phone' ? game.winner === 'X' : !!game.winner;

  return (
    <View style={[styles.box, { borderColor: color.muted }]}>
      <Text style={[styles.title, { color: color.text }]}>{spec.title || 'Tic-Tac-Toe'}</Text>
      <View style={styles.row}>
        {(['phone', 'friend'] as Opponent[]).map(o => (
          <Pressable key={o} testID={`ttt-mode-${o}`} accessibilityRole="button" accessibilityState={{ selected: opponent === o }}
            onPress={() => restart(o)} style={[styles.chip, { borderColor: opponent === o ? color.accent : color.muted }]}>
            <Text style={{ color: opponent === o ? color.accent : color.text, fontWeight: '600' }}>{o === 'phone' ? '📱 vs Phone' : '👥 2 players'}</Text>
          </Pressable>
        ))}
        {opponent === 'phone' && (
          <Pressable testID="ttt-level" accessibilityRole="button" accessibilityLabel={`Difficulty ${level}`}
            onPress={() => { setLevel(l => (l === 'easy' ? 'hard' : 'easy')); setGame(newGame(first)); }}
            style={[styles.chip, { borderColor: color.muted }]}>
            <Text style={{ color: color.text, fontWeight: '600' }}>{level === 'easy' ? '🙂 Easy' : '😈 Hard'}</Text>
          </Pressable>
        )}
      </View>
      {opponent === 'phone' && <Text style={{ color: color.muted }}>{`You ${tally.you} · Phone ${tally.phone} · Draws ${tally.draws}`}</Text>}
      <Text style={[styles.status, { color: over ? color.accent : color.text }]} accessibilityLiveRegion="polite">{status}</Text>
      <View style={styles.board}>
        {game.board.map((cell, i) => (
          <Pressable
            key={i}
            testID={`ttt-cell-${i}`}
            accessibilityRole="button"
            accessibilityLabel={`Row ${Math.floor(i / 3) + 1}, column ${(i % 3) + 1}, ${cell ?? 'empty'}`}
            disabled={over || !!cell || phoneTurn}
            onPress={() => { haptic('tap'); setGame(g => play(g, i)); }}
            style={[styles.cell, { borderColor: color.muted }, game.line?.includes(i) ? { backgroundColor: color.accent } : null]}
          >
            {cell ? (
              <Pop><Text style={[styles.mark, game.line?.includes(i) ? styles.winMark : { color: cell === 'X' ? color.accent : color.text }]}>{cell}</Text></Pop>
            ) : null}
          </Pressable>
        ))}
        <Celebration show={won} text={opponent === 'phone' ? 'You beat the phone!' : `Player ${game.winner} wins!`} color={color.accent} />
      </View>
      <Pressable testID="ttt-again" accessibilityRole="button" onPress={() => restart()}>
        <Text style={[styles.again, { color: color.accent }]}>{over ? 'Play Again' : 'Restart'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { marginTop: 8, padding: 14, borderWidth: 1, borderRadius: 16, alignItems: 'center', gap: 8 },
  title: { fontWeight: '800', fontSize: 24 },
  status: { marginVertical: 6, fontWeight: '600' },
  board: { width: 300, flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: 100, height: 100, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  mark: { fontSize: 54, fontWeight: '800' },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', justifyContent: 'center' },
  chip: { borderWidth: 1.5, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 8 },
  winMark: { color: '#1a1530' }, // dark ink on the marigold winning line (readable in both modes)
  again: { marginTop: 8, fontWeight: '600' },
});
