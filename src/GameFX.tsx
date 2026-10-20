/**
 * Shared game feel, with React Native's own Animated and Vibration and Android's ToneGenerator (no extra library):
 * vibration and sound, a pop-in for
 * marks and cards, a win celebration, and best scores kept on the phone (meta table, key "game_best").
 */
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, NativeModules, StyleSheet, Text, Vibration, View } from 'react-native';
import * as chat from './chatStore';

/**
 * Feedback for a game event: a vibration plus a matching system tone (android AiDeviceModule.playTone, which follows
 * the phone's silent mode). tap: a light tick; win: a short double buzz and a bright tone; lose: one longer buzz and a
 * low tone. Ignored where unsupported.
 */
export function haptic(kind: 'tap' | 'win' | 'lose') {
  try { Vibration.vibrate(kind === 'tap' ? 12 : kind === 'win' ? [0, 40, 60, 80] : 120); } catch {}
  try { NativeModules.AiDevice?.playTone?.(kind); } catch {}
}

/** Its children scale in with a little overshoot when they first appear (a mark placed, a card turned). */
export function Pop({ children, style }: { children: React.ReactNode; style?: any }) {
  const s = useRef(new Animated.Value(0.3)).current;
  useEffect(() => { Animated.spring(s, { toValue: 1, friction: 4, tension: 160, useNativeDriver: true }).start(); }, [s]);
  return <Animated.View style={[style, { transform: [{ scale: s }] }]}>{children}</Animated.View>;
}

const BURST = ['🎉', '✨', '🏆', '🎊', '⭐', '🥳', '🎉', '✨'];

/** A banner that springs in with confetti emoji flying outward. Renders nothing when `show` is false. */
export function Celebration({ show, text, color }: { show: boolean; text: string; color: string }) {
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!show) { t.setValue(0); return; }
    Animated.timing(t, { toValue: 1, duration: 900, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [show, t]);
  if (!show) return null;
  return (
    <View pointerEvents="none" style={styles.wrap} accessibilityLiveRegion="assertive">
      {BURST.map((e, i) => {
        const angle = (i / BURST.length) * Math.PI * 2;
        return (
          <Animated.Text key={i} style={[styles.burst, {
            opacity: t.interpolate({ inputRange: [0, 0.7, 1], outputRange: [1, 1, 0] }),
            transform: [
              { translateX: t.interpolate({ inputRange: [0, 1], outputRange: [0, Math.cos(angle) * 140] }) },
              { translateY: t.interpolate({ inputRange: [0, 1], outputRange: [0, Math.sin(angle) * 140] }) },
              { scale: t.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.4, 1.4, 1] }) },
            ],
          }]}>{e}</Animated.Text>
        );
      })}
      <Animated.View style={{ transform: [{ scale: t.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0.2, 1.15, 1] }) }] }}>
        <Text style={[styles.banner, { color }]}>{text}</Text>
      </Animated.View>
    </View>
  );
}

type Best = Record<string, number>;
const KEY = 'game_best';
/** All saved bests; {} when there is no storage (db() throws synchronously then, which .catch alone would miss). */
async function readBest(): Promise<Best> {
  try {
    const rows = await chat.db().query('SELECT value FROM meta WHERE key = ?', [KEY]);
    return rows[0] ? JSON.parse(rows[0].value) : {};
  } catch { return {}; }
}
async function writeBest(all: Best) {
  try { await chat.db().execute('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [KEY, JSON.stringify(all)]); } catch {}
}

/** The best (lowest) score saved for `game`, and a function to offer a new result. Survives app restarts. */
export function useBest(game: string): [number | null, (score: number) => boolean] {
  const [best, setBest] = useState<number | null>(null);
  useEffect(() => { readBest().then(all => setBest(all[game] ?? null)); }, [game]);
  const offer = (score: number) => {
    if (best !== null && score >= best) return false;
    setBest(score);
    readBest().then(all => writeBest({ ...all, [game]: score }));
    return true; // a new record
  };
  return [best, offer];
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', zIndex: 5 },
  burst: { position: 'absolute', fontSize: 34 },
  banner: { fontSize: 30, fontWeight: '900', textAlign: 'center', textShadowColor: 'rgba(0,0,0,0.35)', textShadowRadius: 6 },
});
