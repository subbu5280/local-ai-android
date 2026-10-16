/**
 * Games from the original app (src/Games.tsx, src/TicTacToe.tsx): Tic-Tac-Toe, Rock Paper Scissors, Number Guessing
 * and Memory Match. Reviewed code that runs entirely on the phone: no model, no network, works offline.
 */
import { useEffect } from 'react';
import { NativeModules, Pressable, ScrollView, Text, View } from 'react-native';
import { styles } from './CodeScreen';
import { GameMenu } from './Games';
import type { Colors } from './theme';

const ALL_GAMES = [{ kind: 'tic_tac_toe' }, { kind: 'rock_paper_scissors' }, { kind: 'number_guessing' }, { kind: 'memory_match' }];

export function GamesScreen({ colors: c, onBack }: { colors: Colors; onBack: () => void }) {
  // Full screen while playing: the status and navigation bars hide, and come back when you leave Games.
  useEffect(() => {
    NativeModules.AiDevice?.setImmersive?.(true);
    return () => NativeModules.AiDevice?.setImmersive?.(false);
  }, []);
  return (
    <View style={[styles.flex, { backgroundColor: c.bg }]}>
      <View style={[styles.header, { borderColor: c.border }]}>
        <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Back" onPress={onBack}>
          <Text style={{ color: c.text }}>‹ Back</Text>
        </Pressable>
        <Text style={[styles.title, styles.flex, { color: c.text }]} accessibilityRole="header">Games</Text>
      </View>
      <ScrollView contentContainerStyle={[styles.pad, { flexGrow: 1, justifyContent: 'center' }]} keyboardShouldPersistTaps="handled">
        <GameMenu spec={{ title: 'Pick a game', games: ALL_GAMES }} color={{ text: c.text, muted: c.muted, accent: c.accent, card: c.bubble }} />
      </ScrollView>
    </View>
  );
}
