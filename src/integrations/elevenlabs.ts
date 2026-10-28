/**
 * ElevenLabs text-to-speech on `fetch`. One operation: narrate a script and
 * return the audio with per-word timings, which is what times a video's
 * scenes and captions to the voice. Credential: `ELEVENLABS_API_KEY`.
 */
import { optionalEnv, requireEnv } from './env.ts';

const API = 'https://api.elevenlabs.io';

/** ElevenLabs' stock "Brian" voice; override with `ELEVENLABS_VOICE_ID`. */
const DEFAULT_VOICE_ID = 'nPczCjzI2devNBz1zQrb';
/** Supports the timestamps endpoint; override with `ELEVENLABS_MODEL_ID`. */
const DEFAULT_MODEL_ID = 'eleven_multilingual_v2';

export type SpokenWord = { text: string; start: number; end: number };

export type Narration = {
	/** MP3, 44.1 kHz, 128 kbps. */
	audio: Uint8Array;
	words: SpokenWord[];
	/** End of the last spoken character, in seconds. */
	durationSeconds: number;
	voiceId: string;
	modelId: string;
};

export class ElevenLabsClient {
	readonly #apiKey: string;
	readonly voiceId: string;
	readonly modelId: string;

	constructor() {
		this.#apiKey = requireEnv('ELEVENLABS_API_KEY');
		this.voiceId = optionalEnv('ELEVENLABS_VOICE_ID') ?? DEFAULT_VOICE_ID;
		this.modelId = optionalEnv('ELEVENLABS_MODEL_ID') ?? DEFAULT_MODEL_ID;
	}

	async narrate(text: string): Promise<Narration> {
		const response = await fetch(
			`${API}/v1/text-to-speech/${this.voiceId}/with-timestamps?output_format=mp3_44100_128`,
			{
				method: 'POST',
				headers: { 'xi-api-key': this.#apiKey, 'content-type': 'application/json' },
				body: JSON.stringify({ text, model_id: this.modelId }),
			},
		);
		if (!response.ok) {
			const detail = await response.text().catch(() => '');
			throw new Error(`ElevenLabs text-to-speech failed: ${response.status} ${detail.slice(0, 300)}`);
		}
		const payload = (await response.json()) as TimestampsResponse;
		const alignment = payload.alignment ?? payload.normalized_alignment;
		if (!alignment)
			throw new Error('ElevenLabs returned no alignment data; pick a model that supports timestamps.');
		const words = wordsFromAlignment(alignment);
		const durationSeconds = alignment.character_end_times_seconds.at(-1) ?? 0;
		return {
			audio: decodeBase64(payload.audio_base64),
			words,
			durationSeconds,
			voiceId: this.voiceId,
			modelId: this.modelId,
		};
	}
}

type Alignment = {
	characters: string[];
	character_start_times_seconds: number[];
	character_end_times_seconds: number[];
};

type TimestampsResponse = {
	audio_base64: string;
	alignment: Alignment | null;
	normalized_alignment: Alignment | null;
};

/** Groups character timings into words at whitespace; punctuation stays attached to its word. */
export function wordsFromAlignment(alignment: Alignment): SpokenWord[] {
	const words: SpokenWord[] = [];
	let current: SpokenWord | null = null;
	alignment.characters.forEach((ch, i) => {
		const start = alignment.character_start_times_seconds[i] ?? 0;
		const end = alignment.character_end_times_seconds[i] ?? start;
		if (/\s/.test(ch)) {
			if (current) words.push(current);
			current = null;
			return;
		}
		if (current) {
			current.text += ch;
			current.end = end;
		} else {
			current = { text: ch, start, end };
		}
	});
	if (current) words.push(current);
	return words.map((w) => ({ text: w.text, start: round(w.start), end: round(w.end) }));
}

function round(seconds: number): number {
	return Math.round(seconds * 1000) / 1000;
}

function decodeBase64(data: string): Uint8Array {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
