/** Injected by vite.config.ts from package.json at build time. */
declare const __POWERLINE_VERSION__: string;

// The Web Speech API is not in lib.dom; only the members the demo host uses are declared.
interface SpeechRecognitionAlternative { transcript: string; confidence: number }
interface SpeechRecognitionResult { readonly length: number; [index: number]: SpeechRecognitionAlternative; isFinal: boolean }
interface SpeechRecognitionResultList { readonly length: number; [index: number]: SpeechRecognitionResult }
interface SpeechRecognitionEvent extends Event { readonly results: SpeechRecognitionResultList }
interface SpeechRecognition extends EventTarget {
  lang: string; interimResults: boolean; continuous: boolean;
  onresult: ((ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onend: ((ev: Event) => void) | null;
  start(): void; stop(): void; abort(): void;
}
