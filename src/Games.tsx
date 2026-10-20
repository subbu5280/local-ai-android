/**
 * Phase 13: built-in games besides Tic-Tac-Toe (Rock Paper Scissors, Number Guessing, Memory Match) and the
 * game menu. Same contract as src/TicTacToe.tsx: the backend sends an allow-listed spec, this reviewed code runs.
 * Everything happens on the phone: no model call per move, no network, works offline.
 * Game rules are pure functions (randomness injected) so they can be tested without rendering.
 */
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Celebration, haptic, Pop, useBest } from './GameFX';
import { TicTacToe } from './TicTacToe';

type Colors = { text: string; muted: string; accent: string; card: string };
type Rng = () => number; // [0, 1), like Math.random

// ---------------------------------------------------------------- Rock Paper Scissors
export type Hand = 'rock' | 'paper' | 'scissors';
export type Outcome = 'win' | 'lose' | 'draw';
export type Score = { wins: number; losses: number; draws: number };
export const HANDS: Hand[] = ['rock', 'paper', 'scissors'];
const BEATS: Record<Hand, Hand> = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
const HAND_ICON: Record<Hand, string> = { rock: '✊', paper: '✋', scissors: '✌️' };

/** Result for the player. */
export function rpsOutcome(player: Hand, computer: Hand): Outcome {
  if (player === computer) return 'draw';
  return BEATS[player] === computer ? 'win' : 'lose';
}

/** The computer's uniformly random hand. */
export function computerHand(rng: Rng = Math.random): Hand {
  return HANDS[Math.min(2, Math.floor(rng() * 3))];
}

/** Score after one round. */
export function addToScore(score: Score, outcome: Outcome): Score {
  return {
    wins: score.wins + (outcome === 'win' ? 1 : 0),
    losses: score.losses + (outcome === 'lose' ? 1 : 0),
    draws: score.draws + (outcome === 'draw' ? 1 : 0),
  };
}

const ZERO: Score = { wins: 0, losses: 0, draws: 0 };
const OUTCOME_TEXT: Record<Outcome, string> = { win: 'You win!', lose: 'Computer wins!', draw: 'Draw!' };

/** How long the "Rock… Paper… Scissors…" countdown runs before the hands are shown. */
export const RPS_COUNTDOWN_MS = 900;
const COUNTDOWN = ['Rock…', 'Paper…', 'Scissors…'];

export function RockPaperScissors({ spec, color }: { spec: { title?: string }; color: Colors }) {
  const [score, setScore] = useState<Score>(ZERO);
  const [round, setRound] = useState<{ player: Hand; computer: Hand; outcome: Outcome } | null>(null);
  const [beat, setBeat] = useState<number | null>(null); // countdown step while the hands are hidden
  useEffect(() => {
    if (beat === null || !round) return;
    if (beat >= COUNTDOWN.length) {
      setBeat(null);
      setScore(sc => addToScore(sc, round.outcome));
      haptic(round.outcome === 'win' ? 'win' : round.outcome === 'lose' ? 'lose' : 'tap');
      return;
    }
    const t = setTimeout(() => setBeat(b => (b === null ? null : b + 1)), RPS_COUNTDOWN_MS / COUNTDOWN.length);
    return () => clearTimeout(t);
  }, [beat, round]);
  const choose = (player: Hand) => {
    const computer = computerHand();
    haptic('tap');
    setRound({ player, computer, outcome: rpsOutcome(player, computer) });
    setBeat(0);
  };
  const revealed = round && beat === null;
  return (
    <View style={[styles.box, { borderColor: color.muted }]}>
      <Text style={[styles.title, { color: color.text }]}>{spec.title || 'Rock Paper Scissors'}</Text>
      {round && beat !== null ? (
        <Text style={[styles.countdown, { color: color.accent }]} accessibilityLiveRegion="polite">{COUNTDOWN[Math.min(beat, 2)]}</Text>
      ) : revealed ? (
        <View style={styles.faceoff}>
          <Pop><Text style={styles.bigHand}>{HAND_ICON[round.player]}</Text></Pop>
          <Text style={[styles.vs, { color: color.muted }]}>vs</Text>
          <Pop><Text style={styles.bigHand}>{HAND_ICON[round.computer]}</Text></Pop>
        </View>
      ) : (
        <Text style={[styles.status, { color: color.text }]}>Choose rock, paper or scissors</Text>
      )}
      {revealed && (
        <Text style={[styles.status, { color: color.accent }]} accessibilityLiveRegion="polite">
          {`You: ${round.player} · Computer: ${round.computer} → ${OUTCOME_TEXT[round.outcome]}`}
        </Text>
      )}
      <View style={styles.row}>
        {HANDS.map(h => (
          <Pressable
            key={h}
            testID={`rps-${h}`}
            accessibilityRole="button"
            accessibilityLabel={h}
            disabled={!!round}
            onPress={() => choose(h)}
            style={[styles.choice, { borderColor: color.muted }, round ? styles.dim : null]}
          >
            <Text style={styles.icon}>{HAND_ICON[h]}</Text>
            <Text style={{ color: color.text }}>{h}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={{ color: color.text }}>{`Score · You ${score.wins} · Computer ${score.losses} · Draws ${score.draws}`}</Text>
      <View style={styles.row}>
        <Pressable testID="rps-again" accessibilityRole="button" disabled={!revealed} onPress={() => setRound(null)}>
          <Text style={[styles.action, { color: revealed ? color.accent : color.muted }]}>Play Again</Text>
        </Pressable>
        <Pressable testID="rps-reset" accessibilityRole="button" onPress={() => { setRound(null); setBeat(null); setScore(ZERO); }}>
          <Text style={[styles.action, { color: color.accent }]}>Reset</Text>
        </Pressable>
      </View>
      <Celebration show={!!revealed && round.outcome === 'win'} text="You win!" color={color.accent} />
    </View>
  );
}

// ---------------------------------------------------------------- Number Guessing
export type GuessGame = { secret: number; min: number; max: number; attempts: number; done: boolean; message: string };

/** A new round with a random whole number in [min, max]. */
export function newGuessGame(min = 1, max = 20, rng: Rng = Math.random): GuessGame {
  const secret = min + Math.min(max - min, Math.floor(rng() * (max - min + 1)));
  return { secret, min, max, attempts: 0, done: false, message: `Guess a number from ${min} to ${max}` };
}

/** The game after the user's raw input. Invalid input is explained and does not count as an attempt. */
export function guess(game: GuessGame, input: string): GuessGame {
  if (game.done) return game;
  const text = input.trim();
  const n = Number(text);
  if (!/^-?\d+$/.test(text) || n < game.min || n > game.max) {
    return { ...game, message: `"${text.slice(0, 12)}" isn't valid: enter a whole number from ${game.min} to ${game.max}` };
  }
  const attempts = game.attempts + 1;
  if (n === game.secret) {
    return { ...game, attempts, done: true, message: `Correct! It was ${n}. You got it in ${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}.` };
  }
  return { ...game, attempts, message: `${n > game.secret ? `${n} is too high` : `${n} is too low`} · ${warmth(n, game)}` };
}

/** How close a wrong guess is, as a share of the range: 🔥 hot (within 10 %), ☀️ warm (25 %), 🧊 cold. */
export function warmth(n: number, game: Pick<GuessGame, 'secret' | 'min' | 'max'>): string {
  const off = Math.abs(n - game.secret) / Math.max(1, game.max - game.min);
  return off <= 0.1 ? '🔥 hot' : off <= 0.25 ? '☀️ warm' : '🧊 cold';
}

export function NumberGuessing({ spec, color }: { spec: { title?: string; min?: number; max?: number }; color: Colors }) {
  const min = Number.isInteger(spec.min) ? (spec.min as number) : 1;
  const max = Number.isInteger(spec.max) && (spec.max as number) > min ? (spec.max as number) : 20;
  const [game, setGame] = useState(() => newGuessGame(min, max));
  const [input, setInput] = useState('');
  const [best, offerBest] = useBest('number_guessing');
  const [record, setRecord] = useState(false);
  const submit = () => {
    const next = guess(game, input);
    haptic(next.done ? 'win' : 'tap');
    if (next.done && !game.done) setRecord(offerBest(next.attempts));
    setGame(next);
    setInput('');
  };
  return (
    <View style={[styles.box, { borderColor: color.muted }]}>
      <Text style={[styles.title, { color: color.text }]}>{spec.title || 'Number Guessing'}</Text>
      <Text style={[styles.status, { color: game.done ? color.accent : color.text }]} accessibilityLiveRegion="polite">
        {game.message}
      </Text>
      <Text style={{ color: color.muted }}>{`Attempts: ${game.attempts}${best !== null ? ` · Best: ${best}` : ''}`}</Text>
      <View style={styles.row}>
        <TextInput
          testID="guess-input"
          accessibilityLabel="Your guess"
          style={[styles.guessInput, { color: color.text, borderColor: color.muted }]}
          value={input}
          onChangeText={setInput}
          onSubmitEditing={submit}
          keyboardType="number-pad"
          maxLength={4}
          editable={!game.done}
          placeholder={`${min}-${max}`}
          placeholderTextColor={color.muted}
        />
        <Pressable testID="guess-submit" accessibilityRole="button" disabled={game.done || !input.trim()} onPress={submit}>
          <Text style={[styles.action, { color: game.done || !input.trim() ? color.muted : color.accent }]}>Guess</Text>
        </Pressable>
      </View>
      <Pressable testID="guess-new" accessibilityRole="button" onPress={() => { setGame(newGuessGame(min, max)); setInput(''); setRecord(false); }}>
        <Text style={[styles.action, { color: color.accent }]}>New Game</Text>
      </Pressable>
      <Celebration show={game.done} text={record ? 'New best!' : 'Got it!'} color={color.accent} />
    </View>
  );
}

// ---------------------------------------------------------------- Memory Match
export type Card = { face: string; matched: boolean };
export type MemoryGame = { cards: Card[]; open: number[]; moves: number; locked: boolean };
export const FACES = ['🍎', '🐶', '⚽', '🚗', '🌙', '🎵', '🌵', '🍕'];

/** 16 face-down cards (8 pairs) in Fisher-Yates shuffled order. */
export function newMemoryGame(rng: Rng = Math.random, faces: string[] = FACES): MemoryGame {
  const deck = [...faces, ...faces];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return { cards: deck.map(face => ({ face, matched: false })), open: [], moves: 0, locked: false };
}

/** The game after tapping card `i`. Ignored while a mismatched pair is showing, or on an open/matched card. */
export function flip(game: MemoryGame, i: number): MemoryGame {
  const card = game.cards[i];
  if (game.locked || !card || card.matched || game.open.includes(i)) return game;
  if (game.open.length === 0) return { ...game, open: [i] };
  const a = game.open[0];
  const moves = game.moves + 1;
  if (game.cards[a].face === card.face) {
    const cards = game.cards.map((c, k) => (k === a || k === i ? { ...c, matched: true } : c));
    return { cards, open: [], moves, locked: false };
  }
  return { ...game, open: [a, i], moves, locked: true }; // caller shows the pair briefly, then calls hideMismatch
}

/** Turns a showing mismatched pair face down again and unlocks the board. */
export function hideMismatch(game: MemoryGame): MemoryGame {
  return game.locked ? { ...game, open: [], locked: false } : game;
}

export const isComplete = (game: MemoryGame) => game.cards.every(c => c.matched);
export const MISMATCH_MS = 800;

export function MemoryMatch({ spec, color }: { spec: { title?: string }; color: Colors }) {
  const [game, setGame] = useState(() => newMemoryGame());
  useEffect(() => {
    if (!game.locked) return;
    const t = setTimeout(() => setGame(hideMismatch), MISMATCH_MS);
    return () => clearTimeout(t);
  }, [game.locked]);
  const done = isComplete(game);
  const [best, offerBest] = useBest('memory_match');
  const [record, setRecord] = useState(false);
  useEffect(() => {
    if (!done) return;
    haptic('win');
    setRecord(offerBest(game.moves));
  }, [done]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <View style={[styles.box, { borderColor: color.muted }]}>
      <Text style={[styles.title, { color: color.text }]}>{spec.title || 'Memory Match'}</Text>
      <Text style={[styles.status, { color: done ? color.accent : color.text }]} accessibilityLiveRegion="polite">
        {done ? `All pairs found in ${game.moves} moves!` : `Moves: ${game.moves}${best !== null ? ` · Best: ${best}` : ''}`}
      </Text>
      <View style={styles.memoryBoard}>
        {game.cards.map((c, i) => {
          const up = c.matched || game.open.includes(i);
          return (
            <Pressable
              key={i}
              testID={`mem-${i}`}
              accessibilityRole="button"
              accessibilityLabel={`Card ${i + 1}, ${up ? c.face : 'hidden'}${c.matched ? ', matched' : ''}`}
              disabled={game.locked || c.matched}
              onPress={() => { haptic('tap'); setGame(g => flip(g, i)); }}
              style={[styles.card, { borderColor: color.muted, backgroundColor: up ? color.card : color.accent }]}
            >
              {up ? <Pop><Text style={[styles.cardFace, c.matched ? styles.matched : null]}>{c.face}</Text></Pop> : <Text style={styles.cardBack}>?</Text>}
            </Pressable>
          );
        })}
      </View>
      <Pressable testID="mem-new" accessibilityRole="button" onPress={() => { setGame(newMemoryGame()); setRecord(false); }}>
        <Text style={[styles.action, { color: color.accent }]}>{done ? 'Play Again' : 'New Game'}</Text>
      </Pressable>
      <Celebration show={done} text={record ? 'New best!' : 'All pairs found!'} color={color.accent} />
    </View>
  );
}

// ---------------------------------------------------------------- menu + dispatcher
export const GAME_KINDS = ['tic_tac_toe', 'rock_paper_scissors', 'number_guessing', 'memory_match'];
/** Names shown on the game menu. The original app's backend sent these; on the phone the app supplies them. */
export const GAME_TITLES: Record<string, string> = {
  tic_tac_toe: '❌⭕  Tic-Tac-Toe', rock_paper_scissors: '✊✋✌️  Rock Paper Scissors',
  number_guessing: '🔢  Number Guessing', memory_match: '🃏  Memory Match',
};

const GAME_NAMES: [RegExp, string][] = [
  [/\btic[\s-]*t[aoi]c[\s-]*t[oie]e?\b|\btictactoe\b|\bnoughts and crosses\b|\bx\s*(?:and|&)\s*o\b/i, 'tic_tac_toe'],
  [/\brock[\s,]*paper[\s,]*scissors?\b/i, 'rock_paper_scissors'],
  [/\b(?:number|guess(?:ing)?)[\s-]*(?:guess(?:ing)?|game|the number)\b/i, 'number_guessing'],
  [/\bmemory[\s-]*(?:match|game)\b|\bmatching game\b/i, 'memory_match'],
];
/**
 * The game a chat message asks for (the original app got this from its backend; here it is decided on the phone):
 * a named game ("Create game tic toc tie here") or a game menu ("let's play a game"). Null for questions about games
 * ("rules of chess", "history of tic tac toe" with no play/start word stays with the model).
 */
export function gameRequest(text: string): any | null {
  const t = text.trim();
  if (t.length > 120) return null;
  const play = /\b(play|start|create|open|launch|let'?s|game|want)\b/i.test(t);
  for (const [re, kind] of GAME_NAMES) if (re.test(t) && play && !/\b(history|rules?|who invented|strategy|explain|how to win)\b/i.test(t)) return { kind };
  if (/^(?:let'?s |can we |i want to |i'?d like to )?play (?:a |some )?games?\b|^(?:show|open) (?:me )?(?:the )?games\b/i.test(t)) {
    return { kind: 'game_menu', title: 'Pick a game', games: GAME_KINDS.map(kind => ({ kind })) };
  }
  return null;
}

/** Renders one allow-listed interactive spec; anything else renders nothing. */
export function Interactive({ spec, color }: { spec: any; color: Colors }) {
  switch (spec?.kind) {
    case 'tic_tac_toe':
      return <TicTacToe spec={spec} color={color} />;
    case 'rock_paper_scissors':
      return <RockPaperScissors spec={spec} color={color} />;
    case 'number_guessing':
      return <NumberGuessing spec={spec} color={color} />;
    case 'memory_match':
      return <MemoryMatch spec={spec} color={color} />;
    case 'game_menu':
      return <GameMenu spec={spec} color={color} />;
    default:
      return null;
  }
}

export function GameMenu({ spec, color }: { spec: { title?: string; games: any[] }; color: Colors }) {
  const [chosen, setChosen] = useState<any>(null);
  const games = (spec.games || []).filter(g => GAME_KINDS.includes(g?.kind));
  if (chosen) {
    return (
      <View>
        <Interactive spec={chosen} color={color} />
        <Pressable testID="menu-back" accessibilityRole="button" onPress={() => setChosen(null)}>
          <Text style={[styles.action, { color: color.accent }]}>Choose another game</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View style={[styles.box, { borderColor: color.muted }]}>
      <Text style={[styles.title, { color: color.text }]}>{spec.title || 'Pick a game'}</Text>
      {games.map(g => (
        <Pressable
          key={g.kind}
          testID={`menu-${g.kind}`}
          accessibilityRole="button"
          onPress={() => setChosen(g)}
          style={[styles.menuItem, { borderColor: color.muted }]}
        >
          <Text style={[styles.menuText, { color: color.accent }]}>{g.title || GAME_TITLES[g.kind]}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { marginTop: 8, padding: 14, borderWidth: 1, borderRadius: 16, alignItems: 'center', gap: 8 },
  title: { fontWeight: '800', fontSize: 24 },
  status: { fontWeight: '600', textAlign: 'center' },
  row: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  choice: { borderWidth: 1, borderRadius: 12, padding: 12, alignItems: 'center', width: 96 },
  dim: { opacity: 0.5 },
  icon: { fontSize: 40 },
  action: { fontWeight: '600', paddingVertical: 4 },
  guessInput: { borderWidth: 1, borderRadius: 8, width: 90, paddingHorizontal: 8, paddingVertical: 4, textAlign: 'center' },
  memoryBoard: { width: 304, flexDirection: 'row', flexWrap: 'wrap' },
  card: { width: 72, height: 72, margin: 2, borderWidth: 1, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  cardFace: { fontSize: 34 },
  cardBack: { fontSize: 28, fontWeight: '900', color: 'rgba(255,255,255,0.55)' },
  matched: { opacity: 0.55 },
  countdown: { fontSize: 34, fontWeight: '900', marginVertical: 18 },
  faceoff: { flexDirection: 'row', alignItems: 'center', gap: 18, marginVertical: 6 },
  bigHand: { fontSize: 64 },
  vs: { fontSize: 18, fontWeight: '700' },
  menuItem: { borderWidth: 1, borderRadius: 12, paddingVertical: 16, width: 280, alignItems: 'center' },
  menuText: { fontSize: 18, fontWeight: '600' },
});
