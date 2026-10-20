/**
 * Local AI: offline chat with an on-device model.
 *
 * Every answer comes from the phone's own model (src/localModel.ts, llama.rn); there is no backend. Conversations are
 * saved in the phone's SQLite (src/chatStore.ts) and the most recent one reopens on launch. The model's prompt is
 * built on the phone (src/core/prompt.ts): the user's text unchanged, plus at most a language line and a task line.
 * Saved chats can be reopened or deleted from the history screen (src/HistoryScreen.tsx).
 * Documents (src/knowledge/, src/KnowledgeScreen.tsx) are imported, indexed and searched on the phone; in "Docs"
 * mode a question is answered from retrieved passages only, with their sources, or honestly not answered.
 * Code (src/code/, M7): a coding assistant over project folders the user picks; it reads bounded excerpts, answers with
 * file references, and proposes changes that are applied only after the user reviews and approves them.
 * The only network use is the model download, which happens only after the user confirms it.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  BackHandler,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  NativeModules,
  ToastAndroid,
  Linking,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as chat from './src/chatStore';
import * as local from './src/localModel';
import { detect, type LangCode } from './src/core/language';
import { ambiguity, buildPrompt, previousLanguage, translationCaution } from './src/core/prompt';
import { connectivity, keepScreenOn } from './src/device';
import { HistoryScreen } from './src/HistoryScreen';
import { darkColors, lightColors } from './src/theme';
import { metric } from './src/metrics';
import { DocumentScreen } from './src/DocumentScreen';
import { KnowledgeScreen } from './src/KnowledgeScreen';
import * as docStore from './src/knowledge/docStore';
import { retrievePassages } from './src/knowledge/hybrid';
import * as semantic from './src/knowledge/semantic';
import { buildKnowledgePrompt, citedSources, conflictNote, findConflicts, noEvidenceReply, selectPassages, sourceLabel, type Source } from './src/knowledge/knowledgePrompt';
import { AgentsScreen } from './src/AgentsScreen';
import { AgentEditScreen } from './src/AgentEditScreen';
import { AgentRunScreen, sampleTaskFor } from './src/AgentRunScreen';
import * as agentStore from './src/agents/agentStore';
import { EvalScreen } from './src/EvalScreen';
import type { DefKind } from './src/LibraryPanels';
import { DefinitionEditScreen } from './src/DefinitionEditScreen';
import { DefinitionRunScreen } from './src/DefinitionRunScreen';
import { DraftScreen } from './src/DraftScreen';
import * as live from './src/liveData';
import * as voice from './src/voice';
import { pickImage, type Attachment } from './src/imageAttach';
import * as vision from './src/visionCapability';
import * as memory from './src/memoryCommands';
import * as schedule from './src/schedule';
import * as learning from './src/learning';
import { GamesScreen } from './src/GamesScreen';
import { Markdown } from './src/Markdown';
import { imageRequest } from './src/imageGen';
import { deviceAnswer, deviceAsk, type DeviceAsk } from './src/deviceInfo';
import { classifyNeed, worthClassifying, type Need } from './src/needClassifier';
import { loadInstructions, MemoryScreen } from './src/MemoryScreen';
import { welcomeSeen, WelcomeScreen } from './src/WelcomeScreen';
import { answerTableQuestion } from './src/knowledge/tables';
import { gameRequest, Interactive } from './src/Games';
import { McpScreen } from './src/McpScreen';
import { ModelScreen } from './src/ModelScreen';
import * as location from './src/location';
import { CodeScreen } from './src/CodeScreen';
import { WorkspaceScreen, type TaskMode } from './src/WorkspaceScreen';
import { CodeFileScreen } from './src/CodeFileScreen';
import { CodeTaskScreen } from './src/CodeTaskScreen';
import { ProposalScreen } from './src/ProposalScreen';
import { recoverInterruptedProposals } from './src/code/apply';
import { DataScreen } from './src/DataScreen';
import { BackupScreen } from './src/BackupScreen';
import { cleanupTemp } from './src/backup/backup';
import { recoverInterruptedRestores } from './src/backup/restore';
import { applyProposalRetention } from './src/storage';

type Msg = {
  id: string; role: 'user' | 'assistant' | 'error'; text: string; lang?: LangCode;
  sources?: Source[]; // a Docs answer: the passages it is based on (from retrieval, not from the model)
  note?: string; // a short line under the bubble, e.g. "From your documents"
  prompt?: string; // M12: what the model received for this user message, when it differs from the text
  links?: live.LiveSource[]; // a live answer (weather, news, prices): the web pages it came from
  game?: any; // an allow-listed game spec shown inside the chat (Games.tsx), like the original app
  speed?: string; // "⚡ 10.6 tok/s" under a model answer (shown, not stored)
  picture?: string; // a generated image file (on this phone), shown in the bubble
  guessed?: string; // routed by the model's guess (needClassifier): the question, for "Ask the model instead"
};
/** Screens opened over the chat; the chat is underneath (an empty stack). */
type Screen = { name: 'history' } | { name: 'knowledge'; select?: boolean } | { name: 'document'; id: string; ordinal?: number }
  | { name: 'agents' } | { name: 'agentEdit'; id: string | null; copyOf?: string }
  | { name: 'agentRun'; agentId: string; runId?: string; sampleTask?: string } | { name: 'eval' }
  | { name: 'defEdit'; kind: DefKind; id: string | null; initial?: string } | { name: 'defRun'; kind: DefKind; id: string; sample?: boolean }
  | { name: 'draft' } | { name: 'code' } | { name: 'workspace'; id: string } | { name: 'codeFile'; workspaceId: string; path: string; line?: number }
  | { name: 'codeTask'; workspaceId: string; taskId: string; start?: { mode: TaskMode; question: string; errorText: string } } | { name: 'proposal'; id: string; workspaceId: string }
  | { name: 'data' } | { name: 'backup' } | { name: 'games' } | { name: 'model' } | { name: 'mcp' } | { name: 'memory' };
/** Docs mode: questions are answered from documents; scope null = all documents. */
type DocsMode = { on: boolean; scope: string[] | null };
// checking | missing | downloading 42% | verifying | loading | ready | failed
type ModelStatus = string;

/** Answer length limit (tokens); chatStore's context budget assumes at most this much. */
export const ANSWER_TOKENS = 256;

const DOC_NOTE = { grounded: 'From your documents', uncited: 'Passages given to the model (it cited none)', none: 'Not found in your documents' };
const toMsg = (r: chat.StoredMessage): Msg => ({
  id: r.id, role: r.role, text: r.content, lang: (r.meta.lang as LangCode | undefined) ?? undefined,
  sources: Array.isArray(r.meta.sources) && r.meta.sources.length ? r.meta.sources as Source[] : undefined,
  note: r.meta.docs?.status ? DOC_NOTE[r.meta.docs.status as keyof typeof DOC_NOTE] : undefined,
  links: Array.isArray(r.meta.links) && r.meta.links.length ? r.meta.links as live.LiveSource[] : undefined,
  prompt: typeof r.meta.prompt === 'string' ? r.meta.prompt : undefined,
  game: r.meta.interactive ?? undefined, // Interactive renders only allow-listed game kinds
  picture: typeof r.meta.picture === 'string' ? r.meta.picture : undefined,
});

/** The voice status line shown above the composer ('' = nothing to show). From the original app (Phase 14). */
export function voiceStatus(v: { state: string; lang: string; partial?: string; error?: string }): string {
  switch (v.state) {
    case 'listening':
      return `🎙 Listening (${v.lang})… tap 🎙 to stop${v.partial ? `\n“${v.partial}”` : ''}`;
    case 'processing':
      return `⏳ Processing speech (${v.lang})…`;
    case 'ready':
      return '✓ Transcription ready: edit it if needed, then tap Send';
    case 'error':
      return `⚠ ${v.error ?? 'Speech recognition failed'}`;
    default:
      return '';
  }
}

export default function App() {
  const dark = useColorScheme() === 'dark';
  return (
    <SafeAreaProvider>
      <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} />
      <Chat dark={dark} />
    </SafeAreaProvider>
  );
}

function Chat({ dark }: { dark: boolean }) {
  const c = dark ? darkColors : lightColors;
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [generating, setGenerating] = useState(false);
  const [status, setStatus] = useState<ModelStatus>('checking');
  const [stack, setStack] = useState<Screen[]>([]);
  const screen = stack[stack.length - 1] ?? null;
  const push = (s: Screen) => setStack(prev => [...prev, s]);
  const pop = () => setStack(prev => prev.slice(0, -1));
  const toChat = () => setStack([]);
  const [docs, setDocs] = useState<DocsMode>({ on: false, scope: null });
  // Docs mode and its scope survive Android closing the app (seen on the M35): kept in the meta table. Removed
  // documents are dropped from a restored scope; an empty scope means all documents.
  const [welcome, setWelcome] = useState(false); // first-run welcome pages, shown once
  const docsLoaded = useRef(false);
  useEffect(() => {
    (async () => {
      await chat.open();
      if (!(await welcomeSeen())) setWelcome(true);
      await loadInstructions();
      const row = (await chat.db().query("SELECT value FROM meta WHERE key = 'docs_mode'"))[0];
      if (row) {
        const saved: DocsMode = JSON.parse(row.value);
        const ready = new Set((await docStore.listDocuments()).map(d => d.id));
        const scope = saved.scope?.filter(id => ready.has(id)) ?? null;
        setDocs({ on: !!saved.on, scope: scope?.length ? scope : null });
      }
    })().catch(() => undefined).finally(() => { docsLoaded.current = true; });
  }, []);
  useEffect(() => {
    if (!docsLoaded.current) return;
    chat.db().execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('docs_mode', ?)", [JSON.stringify(docs)]).catch(() => undefined);
  }, [docs]);
  const convRef = useRef<string | null>(null); // the open conversation (created with its first message)
  const [openId, setOpenId] = useState<string | null>(null); // convRef for rendering (marks it in the history list)
  // Changes whenever the user starts, opens or deletes a chat, so the launch-time restore (which finishes later)
  // never replaces a chat the user already moved on to.
  const viewToken = useRef(0);
  // Refs, not state: two taps inside one render must not both start a send or a download.
  const sending = useRef(false);
  const downloading = useRef(false);
  const stopRequested = useRef(false); // the running answer was stopped by the user (reported in its metric)
  const listRef = useRef<FlatList<Msg>>(null);

  const add = (m: Omit<Msg, 'id'>, id = chat.newId()) => {
    setMsgs(prev => [...prev, { ...m, id }]);
    return id;
  };
  /** The measured generation speed under an answer, like the live badge in other on-device AI apps. */
  const showSpeed = (id: string, r: { tokPerSec: number; tokens: number }) => {
    if (r.tokens > 0) setMsgs(prev => prev.map(m => (m.id === id ? { ...m, speed: `⚡ ${r.tokPerSec.toFixed(1)} tok/s · ${r.tokens} tokens` } : m)));
  };
  const patch = (id: string, text: string) => setMsgs(prev => prev.map(m => (m.id === id ? { ...m, text } : m)));

  // Android Back closes the screen on top (History, Documents, a document) and returns towards the same chat instead
  // of leaving the app. On the chat itself no listener is registered, so Back keeps Android's default behavior.
  const hasScreen = stack.length > 0;
  useEffect(() => {
    if (!hasScreen) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      pop();
      return true; // handled: Android must not also close the app
    });
    return () => sub.remove();
  }, [hasScreen]);

  // Scheduled tasks (M14): re-arm alarms (lost on reboot/update), and a tapped task notification puts its prompt in
  // the input box. It is never sent automatically: any app can open a localai:// link, so the user taps Send.
  useEffect(() => {
    schedule.rearmAll().catch(() => undefined);
    const open = async (url?: string | null) => {
      const id = schedule.taskIdFromUrl(url);
      const task = id && (await schedule.listTasks()).find(t => t.id === id);
      if (!task) return;
      setInput(task.prompt);
      await schedule.completeTask(task.id);
    };
    Linking.getInitialURL().then(open).catch(() => undefined);
    const sub = Linking.addEventListener('url', e => { open(e.url).catch(() => undefined); });
    return () => sub.remove();
  }, []);

  // Launch: reopen the most recent conversation, and load the model if it is already downloaded. Never downloads.
  useEffect(() => {
    const token = viewToken.current;
    chat.listConversations(1)
      .then(async ([latest]) => {
        if (!latest) return;
        const rows = await chat.recentMessages(latest.id);
        if (viewToken.current !== token) return; // the user already started or opened another chat
        show(latest.id, rows);
      })
      .catch(() => {}); // storage unavailable: start empty; saving reports its own error per message
    local.activeModel()
      .then(m => local.refreshState(m))
      .then(st => {
        metric('model_state', { state: st });
        return st === 'installed' ? loadAndTest() : setStatus(st === 'unsupported' ? 'unsupported' : 'missing');
      })
      .catch(() => setStatus('missing'));
    // Documents: imports cut off by a closed app become retryable failures; report which search engine is in use.
    docStore.recoverInterrupted()
      .then(() => docStore.ensureIndex())
      .then(engine => metric('docs_ready', { engine }))
      .catch(() => undefined); // the Documents screen reports storage errors itself
    // Meaning search (M5): if it is on, continue building vectors for passages that have none (in the background).
    semantic.startBuild();
    // Agent tasks cut off by a closed app are marked interrupted (they never resume on their own).
    agentStore.recoverInterruptedRuns().catch(() => undefined);
    // Change proposals cut off while being applied are marked interrupted, with each file's known outcome (M7).
    recoverInterruptedProposals().catch(() => undefined);
    // M8: a restore cut off by the app closing is marked interrupted (shown under Data); abandoned backup temporary
    // files are removed; finished code proposals past the user's chosen retention are deleted (off by default).
    recoverInterruptedRestores().catch(() => undefined);
    cleanupTemp().catch(() => undefined);
    applyProposalRetention().catch(() => undefined);
    // Launch-time only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------- voice in / voice out (from the original app)
  // Android's own speech recognizer and text-to-speech (android/.../VoiceModule.kt). A transcription is put in the
  // message box for editing and is never sent automatically.
  const [voiceLang, setVoiceLang] = useState<voice.Lang>(voice.LANGS[0]); // restored from the last choice below
  const pickVoiceLang = (l: voice.Lang) => { setVoiceLang(l); voice.saveVoiceLang(l); };
  useEffect(() => { voice.loadVoiceLang().then(l => l && setVoiceLang(l)).catch(() => undefined); }, []);
  const [voiceState, setVoiceState] = useState<{ state: string; partial?: string; error?: string; settings?: boolean }>({ state: 'idle' });
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  useEffect(() => voice.onVoiceEvent(e => {
    if (e.type === 'partial') setVoiceState(v => (v.state === 'listening' ? { ...v, partial: e.text } : v));
    else if (e.type === 'processing') setVoiceState(v => (v.state === 'listening' ? { ...v, state: 'processing' } : v));
    // Only the message being spoken resets its button: the replaced message's late "stop" must not.
    else if (e.type === 'tts_done' || e.type === 'tts_stop' || e.type === 'tts_error') setSpeakingId(cur => (!e.text || e.text === cur ? null : cur));
  }), []);

  async function micTap() {
    if (voiceState.state === 'listening' || voiceState.state === 'processing') return voice.stopListening();
    const perm = await voice.ensureMicPermission().catch(() => 'denied' as const);
    if (perm !== 'granted') {
      return setVoiceState({
        state: 'error', settings: perm === 'never_ask_again',
        error: perm === 'never_ask_again' ? 'Microphone permission is blocked. Open Settings to allow it (you can still type).'
          : 'Microphone permission denied. Tap 🎙 again to retry, or type your message.',
      });
    }
    setVoiceState({ state: 'listening' });
    try {
      const text = await voice.listen(voiceLang);
      setInput(prev => (prev ? `${prev.trimEnd()} ${text}` : text)); // shown for editing; never auto-sent
      setVoiceState({ state: 'ready' });
    } catch (e: any) {
      setVoiceState(e?.code === 'cancelled' ? { state: 'idle' } : { state: 'error', error: voice.voiceError(e?.code, voiceLang) });
    }
  }

  // Android dialogs show at most 3 buttons, so the language picker is a small Modal (as in the original app).
  const [langPicker, setLangPicker] = useState<{ lines: string[] } | null>(null);
  async function chooseVoiceLang() {
    const [rec, tts] = await Promise.all([voice.recognitionSupport().catch(() => null), voice.ttsLanguages().catch(() => null)]);
    setLangPicker({ lines: voice.supportSummary(rec, tts).split('\n') });
  }

  async function speakMessage(m: Msg) {
    if (speakingId === m.id) { voice.stopSpeaking(); return setSpeakingId(null); }
    const lang = voice.langByCode(m.lang);
    try {
      setSpeakingId(m.id); // native speak() replaces current speech (QUEUE_FLUSH): no separate stop() first
      await voice.speak(voice.speechText(m.text), lang, m.id);
    } catch (e: any) {
      setSpeakingId(cur => (cur === m.id ? null : cur));
      ToastAndroid.show(e?.code === 'voice_unavailable' ? `No ${lang.name} voice is installed on this phone. The text answer is unaffected.`
        : `Couldn't speak this message (${e?.code ?? 'error'}).`, ToastAndroid.LONG);
    }
  }

  // ---------------------------------------------------------------- photos (camera / gallery), from the original app
  // A photo is understood only by the phone's own image model (this app has no laptop). The model is offered for
  // download (size shown, verified) the first time; only one large model fits in RAM, so the text model is loaded
  // again after an image answer.
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  // Reply (carried over from the original app): the message being replied to, quoted to the model with the next send.
  const [replyingTo, setReplyingTo] = useState<{ role: Msg['role']; text: string } | null>(null);
  const replyRef = useRef<typeof replyingTo>(null);
  replyRef.current = replyingTo;
  const attachBusy = useRef(false);
  function askVisionDownload(): Promise<'download' | 'later'> {
    const gb = (local.VISION_BYTES / 1e9).toFixed(2);
    return new Promise(resolve => Alert.alert('Photos need the image model',
      `To understand photos on this phone, it needs an image model: ${local.VISION_MODEL.name}, ${gb} GB download (use Wi-Fi). ` +
      'It is downloaded only now, verified, and used offline afterwards.',
      [{ text: 'Not now', style: 'cancel', onPress: () => resolve('later') }, { text: 'Download', onPress: () => resolve('download') }],
      { cancelable: true, onDismiss: () => resolve('later') }));
  }
  function chooseImageSource() {
    Alert.alert('Add a photo', 'Ask about a photo, e.g. "What is this?"', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Gallery', onPress: () => { attach('gallery').catch(() => undefined); } },
      { text: 'Camera', onPress: () => { attach('camera').catch(() => undefined); } },
    ]);
  }
  async function attach(source: 'camera' | 'gallery') {
    if (attachBusy.current) return;
    attachBusy.current = true;
    try {
      const online = (await connectivity()) !== 'offline';
      const state = await vision.ensureReady({
        askDownload: askVisionDownload, online: () => online,
        report: (text, id) => (id ? (patch(id, text), id) : add({ role: text.startsWith('⚠') ? 'error' : 'assistant', text })),
      });
      if (state !== 'ready') {
        if (!local.isLoaded() && status === 'ready') loadAndTest().catch(() => undefined); // put the text model back
        return;
      }
      const r = await pickImage(source).catch((e: any) => ({ error: String(e?.message ?? e) }) as const);
      if ('attachment' in r && r.attachment) setAttachment(r.attachment);
      else if ('error' in r && r.error) add({ role: 'error', text: `Image: ${r.error}` });
    } finally { attachBusy.current = false; }
  }
  /** Answer about the attached photo with the image model, then reload the text model in the background. */
  async function askImage(text: string, img: Attachment) {
    const lang = detect(text, previousLanguage(msgs)).code;
    const userId = add({ role: 'user', text: `🖼 ${text}`, lang });
    await save('user', text, lang, userId, { image: true }); // the photo itself is never stored
    const answerId = add({ role: 'assistant', text: '🖼 Looking at the photo on this phone…', lang });
    try {
      if (!local.isVisionLoaded()) await local.loadVision();
      const r = await local.describeImage(text, img.preview, t => patch(answerId, t));
      patch(answerId, r.text || '(no answer)');
      metric('image_answer', { totalMs: r.totalMs, tokens: r.tokens, tokPerSec: Number(r.tokPerSec.toFixed(2)) });
      showSpeed(answerId, r);
      if (r.text) await save('assistant', r.text, lang, answerId);
    } catch (e: any) {
      const why = `The image model couldn't look at this photo (${e?.message ?? e}).`;
      setMsgs(prev => prev.map(m => (m.id === answerId ? { ...m, role: 'error', text: why } : m)));
      // Saved too: otherwise, after a restart, the question showed with no answer at all (seen on the M35).
      await save('assistant', why, lang, answerId).catch(() => undefined);
    } finally {
      restoreChatModel(); // only one large model fits in RAM: bring the text model back
    }
  }

  // ---------------------------------------------------------------- M12: inspect / edit the improved prompt
  // The app adds at most a language line and a task line to what you type (src/core/prompt.ts). Long-press Send to see
  // exactly what the model will get and change it; the chat shows your original text either way.
  const [promptDraft, setPromptDraft] = useState<string | null>(null);
  function reviewPrompt() {
    const text = input.trim();
    if (!text || docs.on || attachment) return; // Docs, photos and live questions build their own inputs
    setPromptDraft(buildPrompt(text, previousLanguage(msgs)).prompt);
  }

  /** Load the model and run one tiny answer; the model counts as ready only if both work. */
  /** After the photo or picture model used the memory: reload the chat model, but only if it is downloaded (a phone
   *  that only has the image model showed "Model failed to start" after every picture). */
  function restoreChatModel() {
    local.isInstalled().then(ok => (ok ? loadAndTest() : setStatus('missing'))).catch(() => undefined);
  }

  async function loadAndTest() {
    setStatus('loading');
    try {
      const model = await local.activeModel();
      const info = await local.load(model);
      const t = await local.generate('Say hi in three words.', undefined, 16);
      if (!t.text) throw new Error('the test answer was empty');
      metric('model_loaded', { model: model.id, loadMs: info.loadMs, gpu: info.gpu, lib: info.lib ?? null,
        testTokPerSec: Number(t.tokPerSec.toFixed(2)) });
      setStatus('ready');
    } catch (e: any) {
      metric('model_load_failed', { error: String(e?.message ?? e).slice(0, 120) });
      setStatus('failed');
      add({ role: 'error', text: `The on-device model could not start: ${e?.message ?? e}` });
    }
  }

  /** Show a conversation in the chat screen (null = a new, unsaved chat). */
  function show(id: string | null, rows: chat.StoredMessage[]) {
    convRef.current = id;
    setOpenId(id);
    setMsgs(rows.map(toMsg));
  }

  /** History: open a saved conversation; its messages load in order (seq), with their saved language. */
  async function openConversation(conv: chat.Conversation) {
    if (sending.current) return;
    const rows = await chat.recentMessages(conv.id); // rejects on a database error: the history screen shows it
    viewToken.current++;
    show(conv.id, rows);
    toChat();
  }

  /** History: a deleted conversation that is open in the chat screen is closed (a new chat starts). */
  function onDeleted(id: string) {
    viewToken.current++;
    if (convRef.current === id) show(null, []);
  }

  /** Download is offered only with a connection; Android can say "connected but no internet" (captive portal). */
  async function getModel() {
    if (downloading.current) return;
    const net = await connectivity();
    if (net === 'offline') {
      Alert.alert('No internet connection', 'Downloading the model needs an internet connection (Wi-Fi recommended). ' +
        'Nothing was downloaded. Saved chats stay available offline.');
      return;
    }
    if (net === 'no_internet') {
      Alert.alert('Internet not confirmed', "This phone is connected, but Android can't confirm internet access " +
        '(for example a Wi-Fi sign-in page). The download may fail.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Try anyway', onPress: () => { confirmDownload().catch(() => undefined); } },
      ]);
      return;
    }
    await confirmDownload();
  }

  async function confirmDownload() {
    const target = await local.activeModel();
    const gb = (target.bytes / 1e9).toFixed(2);
    Alert.alert(
      'Download the on-device model?',
      `${target.name}\n${target.paramsB}B parameters · ${gb} GB download · license ${target.license}.\n` +
        `Use Wi-Fi: this uses ${gb} GB of data. It continues in the background with a progress notification. ` +
        'After this, chat works offline.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Download',
          onPress: async () => {
            if (downloading.current) return;
            downloading.current = true;
            keepScreenOn(true); // screen-off (with battery saver) cut the download's connection on the M35
            try {
              // Checked again: the connection may have dropped while the dialog was open.
              const online = (await connectivity()) !== 'offline';
              setStatus('downloading 0%');
              const t0 = Date.now();
              await local.download(target, f => setStatus(f >= 1 ? 'verifying' : `downloading ${Math.floor(f * 100)}%`), online);
              metric('download', { result: 'ok', model: target.id, ms: Date.now() - t0 });
              await loadAndTest();
            } catch (e: any) {
              // Any failure (offline, network drop, HTTP error, checksum) returns the button: never stuck "downloading".
              metric('download', { result: 'failed', error: String(e?.message ?? e).slice(0, 120) });
              setStatus((await local.isInstalled(target).catch(() => false)) ? 'failed' : 'missing');
              add({ role: 'error', text: `Model download failed: ${e?.message ?? e}. Nothing was installed.` });
            } finally {
              keepScreenOn(false);
              downloading.current = false;
            }
          },
        },
      ],
    );
  }

  function newChat() {
    if (sending.current) return;
    viewToken.current++;
    show(null, []);
  }

  /** Save a message; a database failure is shown, never silently lost. */
  async function save(role: chat.Role, content: string, lang: LangCode, id: string, meta: chat.MessageMeta = {}) {
    try {
      if (!convRef.current) {
        convRef.current = (await chat.createConversation(content)).id;
        setOpenId(convRef.current);
      }
      await chat.addMessage(convRef.current, role, content, { lang, ...meta }, id);
    } catch (e: any) {
      add({ role: 'error', text: `⚠ This message couldn't be saved on the phone (${e?.message ?? e}).` });
    }
  }

  async function send(editedPrompt?: string) {
    const text = input.trim();
    if ((!text && !attachment) || sending.current) return;
    // The "transcription ready" hint is about the text just sent; on the M35 it stayed up after Send.
    setVoiceState(v => (v.state === 'ready' ? { state: 'idle' } : v));
    // Routing order (M12, checked in __tests__/combinations.test.tsx): an attached photo → a memory command (any mode)
    // → Docs mode → a live question → the model. Each branch below says why it comes where it does.
    // 1. A photo is the question's subject, whatever the text says.
    if (attachment) {
      const img = attachment;
      sending.current = true;
      viewToken.current++;
      setInput('');
      setAttachment(null);
      setGenerating(true);
      try { await askImage(text || 'Describe this image.', img); } finally { sending.current = false; setGenerating(false); }
      return;
    }
    // 2a. Schedule commands ("Schedule daily 08:00 …", "Scheduled tasks", "Cancel task 2") are explicit and never
    // reach the model.
    const sc = schedule.parseScheduleCommand(text);
    if (sc) {
      setInput('');
      add({ role: 'user', text });
      add({ role: 'assistant', text: await scheduleReply(sc) });
      return;
    }
    // 2a'. "Draw a fox in snow" / "/image …": a picture made on this phone (stable-diffusion.cpp), never by a web service.
    const picture = imageRequest(text);
    if (picture && !sending.current) {
      sending.current = true;
      setInput('');
      setGenerating(true);
      try { await askImageGen(text, picture); } finally { sending.current = false; setGenerating(false); }
      return;
    }
    // 2b. "Play tic tac toe" opens the game right in the chat (the original app's in-chat games); no model needed.
    const game = gameRequest(text);
    if (game) {
      setInput('');
      const lang = detect(text, previousLanguage(msgs)).code;
      const reply = game.kind === 'game_menu' ? 'Pick a game to play here:' : "Here's the game — play right here in the chat.";
      const userId = add({ role: 'user', text, lang });
      await save('user', text, lang, userId);
      const answerId = add({ role: 'assistant', text: reply, lang, game });
      await save('assistant', reply, lang, answerId, { interactive: game }); // reopened later as a fresh game
      return;
    }
    // 2. Memory commands ("Remember my name is …", "What is my name?", "Forget …") are explicit, so they work in Docs
    // mode too; answered by the phone's own memory without the model. A credential is refused and stored redacted.
    if (memory.looksLikeMemoryCommand(text)) {
      sending.current = true;
      viewToken.current++;
      setInput('');
      try { if (await askMemory(text)) return; } finally { sending.current = false; }
    }
    // 2c. Questions about the phone itself (the time, the date, "where am I") are answered from the phone, never by the
    // model, which can't know them. Not in Docs mode, where questions are about your documents.
    const dev = docs.on ? null : deviceAsk(text);
    if (dev) { await askDevice(text, dev); return; }
    // 3./4. Live questions (weather, news, prices, time) come from live services, not the model (a 1.5B model can't
    // know today's weather). In Docs mode the question is about your documents, so live lookups are off there.
    const lookup = docs.on ? null : liveLookup(text);
    // A rule match that only guesses "news" is the weakest kind ("which area am I currently in" has "currently"): when
    // the model is ready it decides instead (step 5). Weather, prices and world time go straight to their service.
    const weakGuess = !!lookup && status === 'ready' && live.plan(lookup).tool === 'news'
      && !/\b(news|headlines?|breaking|latest|updates?|score|scores|results?|election)\b/i.test(lookup);
    if (lookup && !weakGuess) {
      sending.current = true;
      viewToken.current++;
      setInput('');
      setGenerating(true);
      try { await askLive(text, lookup); } finally { sending.current = false; setGenerating(false); }
      return;
    }
    // 5. No word rule matched: a short question is classified by the model, which picks a label only (time, date,
    // location, weather, news, price, none). The answer then comes from the phone or a live service, not the model,
    // so "Where am I right now?" or "Is it raining outside?" work however they're worded.
    if (!docs.on && status === 'ready' && (weakGuess || worthClassifying(text))) {
      sending.current = true;
      setInput('');
      setGenerating(true);
      let need: Need = 'none';
      try { need = await classifyNeed(text); } finally { sending.current = false; setGenerating(false); }
      metric('need_classified', { need });
      if (need === 'time' || need === 'date' || need === 'location') { await askDevice(text, need, true); return; }
      if (need === 'weather' || need === 'news' || need === 'price') {
        sending.current = true;
        setGenerating(true);
        // Steer the live planner to the chosen service: "weather …" picks the weather tool; others search the news.
        try { await askLive(text, need === 'weather' && live.plan(text).tool !== 'weather' ? `weather ${text}` : text, true); }
        finally { sending.current = false; setGenerating(false); }
        return;
      }
    }
    if (status !== 'ready') {
      add({ role: 'error', text: 'The on-device model is not ready yet. Tap "Get model" to download it once.' });
      return;
    }
    sending.current = true;
    viewToken.current++;
    setInput('');
    setGenerating(true);
    stopRequested.current = false;
    try {
      if (docs.on) await askDocuments(text);
      else await askModel(text, editedPrompt);
    } finally {
      sending.current = false;
      setGenerating(false);
    }
  }

  /** Carry out a schedule command and say what happened. */
  async function scheduleReply(sc: schedule.ScheduleCommand): Promise<string> {
    try {
      if (sc.kind === 'list') {
        const tasks = await schedule.listTasks();
        return tasks.length ? `Scheduled tasks:\n${tasks.map(schedule.describeTask).join('\n')}` : 'No scheduled tasks.';
      }
      if (sc.kind === 'cancel') {
        const t = await schedule.cancelTask(sc.n);
        return t ? `Cancelled: ${t.prompt}` : `There is no task ${sc.n}. Say "Scheduled tasks" to see the list.`;
      }
      const t = await schedule.addTask(sc);
      const when = new Date(schedule.nextRun(t)).toLocaleString();
      return `Scheduled${t.daily ? ' every day' : ''}: "${t.prompt}". You'll get a notification around ${when} (Android may delay it ` +
        'by a few minutes); tap it to put the prompt in the chat.';
    } catch (e: any) {
      return String(e?.message ?? e);
    }
  }

  /**
   * Make a picture on the phone. First use asks before downloading the image model (2 GB, license shown); the chat
   * model is released while drawing and loaded again afterwards (both don't fit in memory together).
   */
  async function askImageGen(text: string, prompt: string) {
    const lang = detect(text, previousLanguage(msgs)).code;
    const userId = add({ role: 'user', text, lang });
    await save('user', text, lang, userId);
    const answerId = add({ role: 'assistant', text: '🎨 Getting ready…', lang });
    // Every outcome is saved, so a restart never shows the request without an answer.
    const finish = (reply: string) => { patch(answerId, reply); return save('assistant', reply, lang, answerId).catch(() => undefined); };
    if (!(await local.imageGenAvailable())) {
      await finish('Image generation is not included in this build of the app.');
      return;
    }
    if (!(await local.isImageGenInstalled())) {
      const gb = (local.IMAGE_GEN_BYTES / 1e9).toFixed(1);
      const ok = await new Promise<boolean>(res => Alert.alert('Download the image model?',
        `${gb} GB, once (Wi-Fi recommended). Pictures are then made on this phone; your words are never sent anywhere.

${local.IMAGE_GEN_LICENSE}`,
        [{ text: 'Not now', style: 'cancel', onPress: () => res(false) }, { text: 'Download', onPress: () => res(true) }]));
      if (!ok) { await finish('No picture made: the image model was not downloaded. Ask again any time.'); return; }
      try {
        await local.downloadImageGen(f => patch(answerId, `⬇️ Downloading the image model… ${Math.floor(f * 100)}%`), (await connectivity()) !== 'offline');
      } catch (e: any) { await finish(`The image model could not be downloaded: ${e?.message ?? e}`); return; }
    }
    patch(answerId, '🎨 Drawing on this phone… (this can take a minute)');
    try {
      const r = await local.generateImage(prompt);
      const reply = `Here's "${prompt}", made on this phone in ${Math.round(r.ms / 1000)} s.`;
      setMsgs(prev => prev.map(m => (m.id === answerId ? { ...m, text: reply, picture: r.path } : m)));
      metric('image_generated', { ms: Math.round(r.ms) });
      await save('assistant', reply, lang, answerId, { picture: r.path });
    } catch (e: any) {
      await finish(`The picture could not be made: ${e?.message ?? e}`);
    } finally {
      restoreChatModel(); // bring the chat model back
    }
  }

  /** The model's guess sent a question to the clock, location or a live service, but the user meant a general question. */
  async function askModelInstead(text: string) {
    if (sending.current || status !== 'ready') return;
    sending.current = true;
    viewToken.current++;
    setGenerating(true);
    stopRequested.current = false;
    try { await askModel(text); } finally { sending.current = false; setGenerating(false); }
  }

  /** A question about the phone itself (time, date, where am I), answered from the clock or location, never the model. */
  async function askDevice(text: string, dev: DeviceAsk, guessed = false) {
    sending.current = true;
    setInput('');
    try {
      const lang = detect(text, previousLanguage(msgs)).code;
      const userId = add({ role: 'user', text, lang });
      await save('user', text, lang, userId);
      const answerId = add({ role: 'assistant', text: dev === 'location' ? '📍 Finding where you are…' : '…', lang, guessed: guessed ? text : undefined });
      const reply = await deviceAnswer(dev);
      patch(answerId, reply);
      metric('device_answer', { ask: dev });
      await save('assistant', reply, lang, answerId);
    } finally { sending.current = false; }
  }

  /** Answer a memory command; false when the text wasn't one after all (then it goes on as a normal message). */
  async function askMemory(text: string): Promise<boolean> {
    const first = await memory.classifySafely(text, convRef.current);
    if (!first) { setInput(text); return false; }
    const lang = detect(text, previousLanguage(msgs)).code;
    const stored = first.credential ? memory.REDACTED : text;
    const userId = add({ role: 'user', text: stored, lang });
    const hadChat = !!convRef.current;
    await save('user', stored, lang, userId);
    // A project memory belongs to this chat: classify again once the chat exists.
    const cmd = !hadChat && convRef.current ? (await memory.classifySafely(text, convRef.current)) ?? first : first;
    let answer: string;
    try { answer = await memory.execute(cmd, userId); } catch (e: any) {
      answer = `I couldn't update saved memory on this phone (${e?.message ?? e}), so nothing was saved or changed.`;
    }
    const answerId = add({ role: 'assistant', text: answer, lang });
    await save('assistant', answer, lang, answerId);
    return true;
  }

  /** This chat's earlier questions, oldest first, with weather follow-ups ("What about Chennai?") resolved. */
  function earlierAsks(): string[] {
    // Memory commands are side commands, not a change of topic: they don't break a weather follow-up chain.
    const asks = msgs.filter(m => m.role === 'user' && !memory.looksLikeMemoryCommand(m.text)).map(m => m.text);
    return asks.map((q, i) => live.resolveFollowUp(q, asks.slice(0, i)) ?? q);
  }

  /** The live question to look up, or null: a follow-up of an earlier live question, or a live question itself. */
  function liveLookup(text: string): string | null {
    if (live.isFollowUp(text)) {
      // "What about tomorrow?" continues the latest live question; if there is none to continue, it is ordinary chat
      // (found by the combination tests: it used to search the news for the literal words "What about tomorrow").
      const resolved = live.resolveFollowUp(text, earlierAsks());
      if (resolved) return resolved;
      // An unresolved "What about …?" is still live when it names its own topic ("What about Chennai news?"), but not
      // when all it adds is a time or place word.
      const rest = text.replace(/^\s*(what|how)\s+about\s+|^\s*and\s+/i, '');
      return /^(the\s+)?(today|tomorrow|tonight|yesterday|now|then|there|that|it)\W*$/i.test(rest) ? null : (live.liveSignal(text) ? text : null);
    }
    return live.liveSignal(text) ? text : null;
  }

  /**
   * Live answer from free keyless services (Open-Meteo, CoinGecko, Google News RSS), built from the retrieved data only
   * (no model writes it) with its source links. Offline or failed lookups say so and never guess. The phone's
   * approximate location is used only for "weather here", after asking permission once (src/location.ts).
   */
  async function askLive(text: string, lookup: string, guessed = false) {
    const lang = detect(text, previousLanguage(msgs)).code;
    const userId = add({ role: 'user', text, lang });
    await save('user', text, lang, userId);
    const answerId = add({ role: 'assistant', text: '🔎 Looking it up…', lang, guessed: guessed ? text : undefined });
    const contextCity = earlierAsks().reverse().map(q => live.plan(q)).find(p => p.tool === 'weather' && p.city);
    const a = await live.answer(lookup, (await connectivity()) !== 'offline', fetch, {
      contextCity: contextCity && 'city' in contextCity ? contextCity.city : null,
      device: async () => {
        const r = await location.currentPlace();
        return 'place' in r ? r : { problem: r.problem, text: location.problemText(r.problem) };
      },
    });
    metric('live_answer', { tool: a.tool, ok: a.ok, sources: a.sources.length });
    setMsgs(prev => prev.map(m => (m.id === answerId ? { ...m, text: a.text, links: a.sources.length ? a.sources : undefined, note: a.ok ? 'Live information' : undefined } : m)));
    await save('assistant', a.text, lang, answerId, a.sources.length ? { links: a.sources } : {});
  }

  /** Ordinary chat: the model answers with this conversation's recent turns as context (unchanged since M2.2). */
  async function askModel(text: string, editedPrompt?: string) {
    const built = buildPrompt(text, previousLanguage(msgs));
    const { lang, intent, complexity } = built;
    const reply = replyRef.current;
    setReplyingTo(null);
    const prompt = replyPrompt(editedPrompt ?? built.prompt, reply);
    const earlier = msgs.filter((m): m is Msg & { role: chat.Role } => m.role !== 'error')
      .map(m => ({ role: m.role, content: m.text }));
    // M12: what the model receives is kept with the message when it differs from what was typed (tap to inspect).
    const userId = add({ role: 'user', text, lang, prompt: prompt !== text ? prompt : undefined });
    await save('user', text, lang, userId, prompt !== text ? { prompt } : {});
    // M12: a request that can only refer to something earlier, in a chat with nothing earlier, is asked about first.
    const unclear = editedPrompt ? null : ambiguity(text, earlier.length > 0);
    if (unclear) {
      const id = add({ role: 'assistant', text: unclear, lang, note: 'Asked by the app (the request was unclear)' });
      await save('assistant', unclear, lang, id);
      return;
    }
    // From the original app: quietly learn useful first-person facts ("I'm learning Kafka"), and give the model only
    // the remembered facts relevant to this question (bounded; '' when nothing applies). Never blocks the chat.
    await learning.learnFrom(text, convRef.current, userId).catch(() => undefined);
    const knowledge = await learning.relevantKnowledge(text, convRef.current).catch(() => '');
    const answerId = add({ role: 'assistant', text: '…', lang });
    try {
      const r = await local.generate(prompt, s => patch(answerId, s), ANSWER_TOKENS,
        chat.recentContext(earlier, knowledge ? `${knowledge}\n${prompt}` : prompt), knowledge);
      const caution = r.text ? translationCaution(text, intent) : null; // display only; history keeps the model's text
      patch(answerId, caution ? `${r.text}

${caution}` : r.text || '(no answer)');
      metric('answer', { lang, intent, complexity, promptMs: Math.round(r.promptMs), firstTokenMs: r.firstTokenMs,
        totalMs: r.totalMs, tokens: r.tokens, tokPerSec: Number(r.tokPerSec.toFixed(2)), stopped: stopRequested.current });
      showSpeed(answerId, r);
      if (r.text) await save('assistant', r.text, lang, answerId);
      // Follow the conversation's language for the mic only when it is certain (native script or an explicit request).
      const lg = detect(text, previousLanguage(msgs));
      if (lg.source === 'script' || lg.source === 'explicit') pickVoiceLang(voice.langByCode(lg.code));
    } catch (e: any) {
      metric('answer_failed', { error: String(e?.message ?? e).slice(0, 120) });
      setMsgs(prev => prev.map(m => (m.id === answerId ? { ...m, role: 'error', text: `Failed: ${e?.message ?? e}` } : m)));
    }
  }

  /**
   * Docs mode: retrieve passages; with none, the app says so itself (the model is not asked, so nothing is made up);
   * otherwise the model answers from those passages only, and the passages are listed as sources.
   * The question is standalone: earlier chat turns are not sent, to leave the context for the passages.
   */
  async function askDocuments(text: string) {
    const previous = previousLanguage(msgs);
    const lang = detect(text, previous).code;
    const scope = docs.scope;
    const userId = add({ role: 'user', text, lang });
    await save('user', text, lang, userId, { docs: { scope } });
    const answerId = add({ role: 'assistant', text: 'Searching your documents…', lang });
    const update = (m: Partial<Msg>) => setMsgs(prev => prev.map(x => (x.id === answerId ? { ...x, ...m } : x)));
    try {
      const t0 = Date.now();
      // Keyword search, plus meaning search when it is on and built (M5); only evidence passages reach the model.
      const found = await retrievePassages(text, { documentIds: scope, limit: 12, embedder: await semantic.activeEmbedder() });
      const chosen = selectPassages(found.evidence);
      metric('doc_search', { engine: found.engine, mode: found.mode, terms: found.terms.length, results: found.passages.length,
        evidence: found.evidence.length, used: chosen.length, ms: Date.now() - t0 });
      if (chosen.length === 0) {
        const reply = found.engine === 'none'
          ? "Document search isn't available on this phone (its SQLite has no full-text index), so I can't answer from your documents."
          : noEvidenceReply((await docStore.listDocuments()).filter(d => d.status === 'ready' && (!scope || scope.includes(d.id))).length, !!scope);
        update({ text: reply, note: DOC_NOTE.none });
        metric('knowledge_answer', { status: 'no_evidence', lang });
        await save('assistant', reply, lang, answerId, { docs: { status: 'none' } });
        return;
      }
      // Totals, averages, counts over a spreadsheet are calculated exactly by the app; a 1.5B model adds rows wrongly.
      const exact = await answerTableQuestion(text, [...new Set(chosen.map(c => c.passage.documentId))]);
      if (exact) {
        const p = chosen.find(c => c.passage.documentId === exact.documentId)!.passage;
        update({ text: exact.text, note: 'Calculated from your spreadsheet', sources: [{ n: 1, documentId: p.documentId, name: p.name, page: p.page, ordinal: p.ordinal, chunkId: p.chunkId }] });
        metric('knowledge_answer', { status: 'table_exact', lang });
        await save('assistant', exact.text, lang, answerId, { docs: { status: 'grounded' } });
        return;
      }
      const kp = buildKnowledgePrompt(text, chosen, previous);
      update({ text: '…' });
      const r = await local.generate(kp.prompt, s => patch(answerId, s), ANSWER_TOKENS, []);
      const cited = citedSources(r.text, kp.sources);
      const answerStatus = cited.length ? 'grounded' : 'uncited';
      const sources = cited.length ? cited : kp.sources;
      // M11: different documents giving different amounts (30 vs 14 days) are flagged by the app, not left to the model.
      const conflict = conflictNote(findConflicts(chosen, kp.sources));
      update({ text: r.text || '(no answer)', sources, note: conflict ? `${DOC_NOTE[answerStatus]}. ${conflict}` : DOC_NOTE[answerStatus] });
      metric('knowledge_answer', { status: answerStatus, lang, passages: chosen.length, cited: cited.length, firstTokenMs: r.firstTokenMs,
        totalMs: r.totalMs, tokens: r.tokens, tokPerSec: Number(r.tokPerSec.toFixed(2)), stopped: stopRequested.current });
      showSpeed(answerId, r);
      if (r.text) await save('assistant', r.text, lang, answerId, { sources, docs: { status: answerStatus } });
    } catch (e: any) {
      metric('answer_failed', { error: String(e?.message ?? e).slice(0, 120) });
      update({ role: 'error', text: `Failed: ${e?.message ?? e}` });
    }
  }

  /** Docs mode on, answering from these documents (null = all), and back to the chat. */
  function applyDocsScope(scope: string[] | null) {
    setDocs({ on: true, scope });
    toChat();
  }
  const scopeText = docs.scope ? `${docs.scope.length} selected document${docs.scope.length === 1 ? '' : 's'}` : 'all documents';

  /** A document was removed: it can no longer be part of the Docs scope. */
  function onDocumentRemoved(id: string) {
    setDocs(d => (d.scope ? { ...d, scope: d.scope.filter(x => x !== id).length ? d.scope.filter(x => x !== id) : null } : d));
    pop();
  }

  const statusText = status === 'ready' ? 'On-device · offline ready' : status === 'missing' ? 'No model yet'
    : status === 'failed' ? 'Model failed to start' : status === 'unsupported' ? 'Model not supported' : `Model ${status}…`;

  if (screen) {
    // Every screen in the stack stays mounted (only the top one is shown), so going Back to Documents keeps its search.
    return (
      <SafeAreaView style={[styles.flex, { backgroundColor: c.bg }]}>
        {stack.map((s, i) => (
          <View key={i} style={i === stack.length - 1 ? styles.flex : styles.hidden}>
            {s.name === 'history' && (
              <HistoryScreen colors={c} currentId={openId} onOpen={openConversation} onDeleted={onDeleted} onBack={pop} />
            )}
            {s.name === 'knowledge' && (
              <KnowledgeScreen colors={c} select={!!s.select} scope={docs.scope} focused={i === stack.length - 1} onBack={pop}
                onOpenDocument={(id, ordinal) => push({ name: 'document', id, ordinal })} onUseScope={applyDocsScope} />
            )}
            {s.name === 'agents' && (
              <AgentsScreen colors={c} focused={i === stack.length - 1} onBack={pop}
                onEdit={id => push({ name: 'agentEdit', id })} onRun={(agentId, runId) => push({ name: 'agentRun', agentId, runId })}
                onEval={() => push({ name: 'eval' })}
                onDefEdit={(kind, id) => push({ name: 'defEdit', kind, id })} onDefRun={(kind, id) => push({ name: 'defRun', kind, id })}
                onDraft={() => push({ name: 'draft' })} />
            )}
            {s.name === 'agentEdit' && (
              <AgentEditScreen colors={c} id={s.id} copyOf={s.copyOf} onBack={pop} onSaved={() => undefined}
                onDuplicate={id => push({ name: 'agentEdit', id: null, copyOf: id })}
                onTest={id => { agentStore.getAgent(id).then(a => a && push({ name: 'agentRun', agentId: id, sampleTask: sampleTaskFor(a) })); }} />
            )}
            {s.name === 'eval' && <EvalScreen colors={c} modelReady={status === 'ready'} onBack={pop} />}
            {s.name === 'defEdit' && (
              <DefinitionEditScreen kind={s.kind} id={s.id} initial={s.initial} colors={c} onBack={pop} onSaved={() => undefined}
                onTest={id => push({ name: 'defRun', kind: s.kind, id, sample: true })} />
            )}
            {s.name === 'defRun' && (
              <DefinitionRunScreen kind={s.kind} id={s.id} sample={s.sample} modelReady={status === 'ready'} colors={c} onBack={pop}
                onOpenSource={(id, ordinal) => push({ name: 'document', id, ordinal })} />
            )}
            {s.name === 'draft' && (
              <DraftScreen colors={c} modelReady={status === 'ready'} onBack={pop}
                onSaved={id => { pop(); push({ name: 'defRun', kind: 'workflow', id }); }}
                onEdit={json => { pop(); push({ name: 'defEdit', kind: 'workflow', id: null, initial: json }); }} />
            )}
            {s.name === 'agentRun' && (
              <AgentRunScreen colors={c} agentId={s.agentId} runId={s.runId} sampleTask={s.sampleTask} modelReady={status === 'ready'}
                onBack={pop} onOpenSource={(id, ordinal) => push({ name: 'document', id, ordinal })} />
            )}
            {s.name === 'code' && (
              <CodeScreen colors={c} focused={i === stack.length - 1} onBack={pop} onOpen={id => push({ name: 'workspace', id })} />
            )}
            {s.name === 'workspace' && (
              <WorkspaceScreen id={s.id} colors={c} focused={i === stack.length - 1} onBack={pop}
                onOpenFile={(path, line) => push({ name: 'codeFile', workspaceId: s.id, path, line })}
                onTask={(taskId, start) => push({ name: 'codeTask', workspaceId: s.id, taskId, start })}
                onProposal={id => push({ name: 'proposal', id, workspaceId: s.id })} />
            )}
            {s.name === 'codeFile' && <CodeFileScreen workspaceId={s.workspaceId} path={s.path} line={s.line} colors={c} onBack={pop} />}
            {s.name === 'codeTask' && (
              <CodeTaskScreen workspaceId={s.workspaceId} taskId={s.taskId} start={s.start} modelReady={status === 'ready'} colors={c} onBack={pop}
                onOpenFile={(path, line) => push({ name: 'codeFile', workspaceId: s.workspaceId, path, line })}
                onProposal={id => push({ name: 'proposal', id, workspaceId: s.workspaceId })} />
            )}
            {s.name === 'proposal' && (
              <ProposalScreen id={s.id} colors={c} onBack={pop} onOpenFile={(path, line) => push({ name: 'codeFile', workspaceId: s.workspaceId, path, line })} />
            )}
            {s.name === 'data' && (
              <DataScreen colors={c} focused={i === stack.length - 1} onBack={pop} onBackup={() => push({ name: 'backup' })}
                onHistory={() => push({ name: 'history' })} onDocuments={() => push({ name: 'knowledge' })} onCode={() => push({ name: 'code' })} />
            )}
            {s.name === 'backup' && <BackupScreen colors={c} onBack={pop} />}
            {s.name === 'games' && <GamesScreen colors={c} onBack={pop} />}
            {s.name === 'memory' && <MemoryScreen colors={c} onBack={pop} />}
            {s.name === 'mcp' && <McpScreen colors={c} onBack={pop} onUseText={t => { setInput(t); pop(); }} />}
            {s.name === 'model' && <ModelScreen colors={c} focused={i === stack.length - 1} onBack={pop} onSwitched={() => { loadAndTest().catch(() => undefined); }} />}
            {s.name === 'document' && (
              <DocumentScreen colors={c} id={s.id} ordinal={s.ordinal}
                onBack={pop} onAsk={id => applyDocsScope([id])} onRemoved={onDocumentRemoved} />
            )}
          </View>
        ))}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: c.bg }]}>
      <KeyboardAvoidingView style={styles.flex} behavior="padding">
        <View style={[styles.header, { borderColor: c.border }]}>
          <View style={styles.titleRow}>
            <View style={styles.flex}>
              <Text style={[styles.title, { color: c.text }]} numberOfLines={1}>Local <Text style={{ color: c.accent }}>AI</Text></Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Model" accessibilityHint="Choose the on-device model" onPress={() => push({ name: 'model' })} disabled={generating}>
                <Text style={[styles.status, { color: c.muted }]} numberOfLines={1} accessibilityLiveRegion="polite">
                  <Text style={{ color: status === 'ready' ? c.ok : c.muted }}>● </Text>{statusText} ›
                </Text>
              </Pressable>
            </View>
            {(status === 'missing' || status === 'failed') && (
              <Pressable style={[styles.chip, { backgroundColor: c.accent, borderColor: c.accent }]} accessibilityRole="button"
                accessibilityLabel={status === 'missing' ? 'Get model' : 'Retry loading the model'}
                onPress={status === 'missing' ? getModel : loadAndTest}>
                <Text style={{ color: c.onAccent, fontWeight: '600' }}>{status === 'missing' ? 'Get model' : 'Retry'}</Text>
              </Pressable>
            )}
            <Pressable style={[styles.iconButton, { backgroundColor: c.bubble }]} accessibilityRole="button" accessibilityLabel="Saved chats"
              onPress={() => push({ name: 'history' })} disabled={generating}>
              <Text style={[styles.iconText, { color: c.text }]}>🕘</Text>
            </Pressable>
            <Pressable style={[styles.iconButton, { backgroundColor: c.bubble }]} accessibilityRole="button" accessibilityLabel="New chat" onPress={newChat}
              disabled={generating}>
              <Text style={[styles.iconText, { color: c.accent }]}>＋</Text>
            </Pressable>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.featureRow}>
            {([['Documents', '📄', 'Docs', 'knowledge'], ['Agents', '🤖', 'Agents', 'agents'], ['Code', '⌨️', 'Code', 'code'],
              ['Games', '🎮', 'Games', 'games'], ['Memory', '🧠', 'Memory', 'memory'], ['Connections', '🔌', 'Connect', 'mcp'], ['Privacy and data', '🛡️', 'Data', 'data']] as const)
              .map(([label, icon, text, name]) => (
                <Pressable key={name} style={[styles.feature, { backgroundColor: c.bubble, borderColor: c.border }]} accessibilityRole="button"
                  accessibilityLabel={label} onPress={() => push({ name } as Screen)} disabled={generating}>
                  <Text style={{ color: c.text, fontWeight: '500' }}>{icon}  {text}</Text>
                </Pressable>
              ))}
          </ScrollView>
        </View>
        <FlatList
          ref={listRef}
          style={styles.flex}
          contentContainerStyle={styles.list}
          data={msgs}
          keyExtractor={m => m.id}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
          renderItem={({ item }) => (
            <View style={[styles.bubble, item.role === 'user' ? [styles.mine, { backgroundColor: c.mine }]
              : { backgroundColor: item.role === 'error' ? c.errorBg : c.bubble }]}>
              {item.role === 'assistant'
                ? <Markdown text={item.text} colors={c} onCopy={code => copyText(code, 'Code copied')} />
                : <Text selectable style={{ color: item.role === 'user' ? '#fff' : c.text }}>{item.text}</Text>}
              {item.speed ? <Text style={[styles.speed, { color: c.muted }]}>{item.speed}</Text> : null}
              {item.guessed && (
                <Pressable accessibilityRole="button" accessibilityLabel="Ask the model instead" hitSlop={8} disabled={generating}
                  onPress={() => { askModelInstead(item.guessed!).catch(() => undefined); }}>
                  <Text style={[styles.note, { color: c.accent }]}>Not what you asked? Ask the model instead</Text>
                </Pressable>
              )}
              {item.picture && (
                <Image source={{ uri: `file://${item.picture}` }} style={styles.picture} accessibilityLabel={item.text} resizeMode="cover" />
              )}
              {item.game && <Interactive spec={item.game} color={{ text: c.text, muted: c.muted, accent: c.accent, card: c.bg }} />}
              {item.note ? <Text style={[styles.note, { color: c.muted }]}>{item.note}</Text> : null}
              {item.prompt && (
                <Pressable accessibilityRole="button" accessibilityLabel="Show what the model received"
                  onPress={() => Alert.alert('What the model received', item.prompt)}>
                  <Text style={[styles.note, { color: '#ffffff' }]}>ⓘ Prompt sent to the model</Text>
                </Pressable>
              )}
              {item.sources?.map(s => (
                <Pressable key={s.n} accessibilityRole="link" accessibilityLabel={`Open source ${s.n}: ${sourceLabel(s)}`}
                  onPress={() => push({ name: 'document', id: s.documentId, ordinal: s.ordinal })}>
                  <Text style={[styles.source, { color: c.accent }]}>[{s.n}] {sourceLabel(s)}</Text>
                </Pressable>
              ))}
              {item.role === 'assistant' && voice.voiceAvailable() && (
                <Pressable accessibilityRole="button" hitSlop={10} accessibilityLabel={speakingId === item.id ? 'Stop speaking' : 'Speak this message'}
                  onPress={() => speakMessage(item)}>
                  <Text style={[styles.source, { color: c.accent }]}>{speakingId === item.id ? '■ Stop' : '🔊 Speak'}</Text>
                </Pressable>
              )}
              {item.role !== 'error' && !!item.text.trim() && (
                <View style={styles.actions}>
                  <Pressable accessibilityRole="button" hitSlop={10} accessibilityLabel="Copy this message" onPress={() => copyText(item.text)}>
                    <Text style={[styles.source, { color: item.role === 'user' ? '#ffffff' : c.accent }]}>⧉ Copy</Text>
                  </Pressable>
                  <Pressable accessibilityRole="button" hitSlop={10} accessibilityLabel="Reply to this message" onPress={() => setReplyingTo({ role: item.role, text: item.text })}>
                    <Text style={[styles.source, { color: item.role === 'user' ? '#ffffff' : c.accent }]}>↩ Reply</Text>
                  </Pressable>
                </View>
              )}
              {item.links?.map(s => (
                <Pressable key={`l${s.n}`} accessibilityRole="link" accessibilityLabel={`Open web source ${s.n}: ${s.title}`}
                  onPress={() => { Linking.openURL(s.url).catch(() => undefined); }}>
                  <Text style={[styles.source, { color: c.accent }]}>[{s.n}] {s.title}{s.source ? ` — ${s.source}` : ''}</Text>
                </Pressable>
              ))}
            </View>
          )}
        />
        {docs.on && (
          <View style={[styles.docsBar, { backgroundColor: c.bubble }]} accessibilityLiveRegion="polite">
            <Text style={[styles.flex, { color: c.text }]}>Answering from {scopeText}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Change documents" disabled={generating}
              onPress={() => push({ name: 'knowledge', select: true })}>
              <Text style={[styles.link, { color: c.accent }]}>Change</Text>
            </Pressable>
          </View>
        )}
        {voiceStatus({ ...voiceState, lang: voiceLang.name }) !== '' && (
          <View style={[styles.docsBar, { backgroundColor: c.bubble }]}>
            <Text style={[styles.flex, { color: voiceState.state === 'error' ? c.text : c.muted }]} accessibilityLiveRegion="polite">
              {voiceStatus({ ...voiceState, lang: voiceLang.name })}
            </Text>
            {voiceState.settings && (
              <Pressable accessibilityRole="button" accessibilityLabel="Open settings" onPress={() => Linking.openSettings()}>
                <Text style={[styles.link, { color: c.accent }]}>Settings</Text>
              </Pressable>
            )}
            {(voiceState.state === 'listening' || voiceState.state === 'processing') ? (
              <Pressable accessibilityRole="button" accessibilityLabel="Cancel listening" hitSlop={10} onPress={() => voice.cancelListening()}>
                <Text style={[styles.link, { color: c.accent }]}>✕</Text>
              </Pressable>
            ) : (
              <Pressable accessibilityRole="button" accessibilityLabel="Dismiss voice status" hitSlop={10} onPress={() => setVoiceState({ state: 'idle' })}>
                <Text style={[styles.link, { color: c.muted }]}>✕</Text>
              </Pressable>
            )}
          </View>
        )}
        {replyingTo && (
          <View style={[styles.docsBar, { backgroundColor: c.bubble }]}>
            <Text style={[styles.flex, { color: c.text }]} numberOfLines={2}>↩ Replying to {replyingTo.role === 'user' ? 'your message' : 'the answer'}: {previewText(replyingTo.text)}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Cancel reply" onPress={() => setReplyingTo(null)}>
              <Text style={[styles.link, { color: c.accent }]}>✕</Text>
            </Pressable>
          </View>
        )}
        {attachment && (
          <View style={[styles.docsBar, { backgroundColor: c.bubble }]}>
            <Image source={{ uri: attachment.preview }} style={styles.thumb} accessibilityLabel="Attached photo" />
            <Text style={[styles.flex, { color: c.text }]}>Photo attached ({Math.round(attachment.bytes / 1024)} KB). Ask about it, then Send.</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Remove photo" onPress={() => setAttachment(null)}>
              <Text style={[styles.link, { color: c.accent }]}>✕</Text>
            </Pressable>
          </View>
        )}
        <View style={[styles.inputRow, { borderColor: c.border }]}>
          <Pressable style={[styles.toggle, { borderColor: docs.on ? c.accent : c.border, backgroundColor: docs.on ? c.accent : 'transparent' }]}
            accessibilityRole="switch" accessibilityState={{ checked: docs.on }} accessibilityLabel="Ask documents"
            disabled={generating} onPress={() => setDocs(d => ({ ...d, on: !d.on }))}>
            <Text style={{ color: docs.on ? c.onAccent : c.text, fontWeight: '600' }}>Docs</Text>
          </Pressable>
          <Pressable style={styles.mic} accessibilityRole="button" accessibilityLabel="Add a photo" disabled={generating} onPress={chooseImageSource}>
            <Text style={[styles.micIcon, { color: c.accent }]}>📷</Text>
          </Pressable>
          {voice.voiceAvailable() && (
            <Pressable style={styles.mic} accessibilityRole="button"
              accessibilityLabel={voiceState.state === 'listening' ? 'Stop listening' : `Speak a message in ${voiceLang.name}`}
              accessibilityHint="Long-press to choose the speech language" disabled={generating} onPress={micTap} onLongPress={chooseVoiceLang}>
              <Text style={[styles.micIcon, { color: voiceState.state === 'listening' ? c.stop : c.accent }]}>🎙</Text>
              <Text style={[styles.micLang, { color: c.muted }]}>{voiceLang.label}</Text>
            </Pressable>
          )}
          <TextInput
            style={[styles.input, { color: c.text, borderColor: c.border }]}
            value={input}
            onChangeText={setInput}
            placeholder={docs.on ? 'Ask your documents' : 'Message'}
            placeholderTextColor={c.muted}
            multiline
            accessibilityLabel="Message"
          />
          {generating ? (
            <Pressable style={[styles.send, { backgroundColor: c.stop }]} accessibilityRole="button"
              accessibilityLabel="Stop answer" onPress={() => { stopRequested.current = true; local.stop(); }}>
              <Text style={[styles.sendText, { color: '#ffffff' }]}>Stop</Text>
            </Pressable>
          ) : (
            <Pressable style={[styles.send, { backgroundColor: c.accent }]} accessibilityRole="button"
              accessibilityLabel="Send" accessibilityHint="Long-press to review and edit the prompt the model will get"
              onPress={() => { send().catch(() => undefined); }} onLongPress={reviewPrompt}>
              <Text style={[styles.sendText, { color: c.onAccent }]}>Send</Text>
            </Pressable>
          )}
        </View>
      </KeyboardAvoidingView>
      <Modal visible={promptDraft !== null} transparent animationType="fade" onRequestClose={() => setPromptDraft(null)}>
        <View style={styles.backdrop}>
          <View style={[styles.picker, { backgroundColor: c.bg }]}>
            <Text style={[styles.title, { color: c.text }]}>Prompt for the model</Text>
            <Text style={[styles.note, { color: c.muted }]}>Your message plus what the app added (language and task lines). Edit it if you like.</Text>
            <TextInput style={[styles.input, styles.promptBox, { color: c.text, borderColor: c.border }]} value={promptDraft ?? ''}
              onChangeText={setPromptDraft} multiline accessibilityLabel="Prompt for the model" />
            <View style={styles.header}>
              <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Cancel prompt" onPress={() => setPromptDraft(null)}>
                <Text style={{ color: c.text }}>Cancel</Text>
              </Pressable>
              <Pressable style={[styles.chip, { borderColor: c.accent }]} accessibilityRole="button" accessibilityLabel="Send this prompt"
                disabled={!promptDraft?.trim()} onPress={() => { const p = promptDraft!.trim(); setPromptDraft(null); send(p).catch(() => undefined); }}>
                <Text style={{ color: c.accent }}>Send this prompt</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
      <Modal visible={!!langPicker} transparent animationType="fade" onRequestClose={() => setLangPicker(null)}>
        <View style={styles.backdrop}>
          <View style={[styles.picker, { backgroundColor: c.bg }]}>
            <Text style={[styles.title, { color: c.text }]}>Which language will you speak?</Text>
            {voice.LANGS.map((l, i) => (
              <Pressable key={l.code} accessibilityRole="button" accessibilityLabel={`Speak in ${l.name}`}
                onPress={() => { pickVoiceLang(l); setLangPicker(null); }} style={styles.pickerRow}>
                <Text style={{ color: l.code === voiceLang.code ? c.accent : c.text }}>{`${l.label}  ${l.name}`}</Text>
                <Text style={[styles.note, { color: c.muted }]}>{langPicker?.lines[i]?.replace(`${l.name}: `, '') ?? ''}</Text>
              </Pressable>
            ))}
            <Pressable accessibilityRole="button" onPress={() => setLangPicker(null)}>
              <Text style={[styles.link, { color: c.accent }]}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
      {welcome && <WelcomeScreen colors={c} needsModel={status === 'missing'} onDone={get => { setWelcome(false); if (get) getModel(); }} />}
    </SafeAreaView>
  );
}

/** One-line, length-limited version of a message for the reply preview (from the original app). */
export function previewText(text: string, max = 90): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** The bodies of fenced ``` code blocks in a message, for "Copy code" (from the original app). */
export function codeBlocks(text: string): string[] {
  return [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(m => m[1].replace(/\n$/, ''));
}

/** The model's prompt for a reply: the quoted message travels with it, so the model knows what "this" refers to. */
export function replyPrompt(prompt: string, replyTo: { role: string; text: string } | null): string {
  if (!replyTo) return prompt;
  const who = replyTo.role === 'user' ? 'my earlier message' : 'your earlier answer';
  return `I'm replying to ${who}: "${previewText(replyTo.text, 600)}"\n\n${prompt}`;
}

/** Copy to the clipboard and confirm with a toast. Only ever called from a user tap. */
export function copyText(text: string, label = 'Copied') {
  NativeModules.AiDevice?.copyText(text);
  ToastAndroid.show(label, ToastAndroid.SHORT);
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  hidden: { display: 'none' },
  header: { paddingTop: 10, paddingBottom: 10, gap: 10, borderBottomWidth: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16 },
  title: { fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
  status: { fontSize: 13, marginTop: 2 },
  iconButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  iconText: { fontSize: 20, fontWeight: '700' },
  featureRow: { gap: 8, paddingHorizontal: 16 },
  feature: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10 },
  chip: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8, minHeight: 36, justifyContent: 'center' },
  list: { padding: 14, gap: 10 },
  bubble: { maxWidth: '86%', borderRadius: 18, borderTopLeftRadius: 6, paddingHorizontal: 14, paddingVertical: 10, alignSelf: 'flex-start' },
  mine: { alignSelf: 'flex-end', borderTopLeftRadius: 18, borderTopRightRadius: 6 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 8, borderTopWidth: 1 },
  input: { flex: 1, borderWidth: 1, borderRadius: 22, paddingHorizontal: 14, paddingVertical: 8, maxHeight: 120 },
  send: { borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, minHeight: 44, justifyContent: 'center' },
  sendText: { fontWeight: '700' },
  note: { fontSize: 12, marginTop: 6 },
  source: { fontSize: 13, marginTop: 4 },
  actions: { flexDirection: 'row', gap: 16 },
  speed: { fontSize: 11, alignSelf: 'flex-end', marginTop: 4 },
  docsBar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  link: { fontWeight: '600' },
  promptBox: { minHeight: 140, maxHeight: 320, borderRadius: 8, textAlignVertical: 'top' },
  thumb: { width: 40, height: 40, borderRadius: 6 },
  picture: { width: 280, height: 280, borderRadius: 12, marginTop: 8 },
  mic: { alignItems: 'center', justifyContent: 'center', minHeight: 44, paddingHorizontal: 4 },
  micIcon: { fontSize: 20 },
  micLang: { fontSize: 10 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: 24 },
  picker: { borderRadius: 12, padding: 16, gap: 8 },
  pickerRow: { paddingVertical: 6 },
  toggle: { borderWidth: 1, borderRadius: 20, paddingHorizontal: 12, minHeight: 44, justifyContent: 'center' },
});
