import { aiClient } from './client';

export type SupportedLanguage = 'en' | 'hi' | 'hi-Latn' | 'si';

export interface TranslationResult {
  detectedLanguage: SupportedLanguage;
  englishText: string;
}

const DETECT_AND_TRANSLATE_TOOL = 'submit_translation';

const DETECT_AND_TRANSLATE_SCHEMA = {
  type: 'object',
  properties: {
    detected_language: {
      type: 'string',
      enum: ['en', 'hi', 'hi-Latn', 'si'],
      description:
        'en = English. hi = Hindi in Devanagari script. hi-Latn = Hindi written in Latin/romanized script, including Hinglish (Hindi-English code-mixed). si = Sinhala.',
    },
    english_text: {
      type: 'string',
      description:
        'The message translated into plain, natural English. If detected_language is already en, return the text unchanged (do not paraphrase or "clean up" English text).',
    },
  },
  required: ['detected_language', 'english_text'],
} as const;

const TRANSLATE_TO_LANGUAGE_TOOL = 'submit_localized_message';

const TRANSLATE_TO_LANGUAGE_SCHEMA = {
  type: 'object',
  properties: {
    localized_text: {
      type: 'string',
      description: 'The message translated into the target language, preserving tone, meaning, and every factual detail exactly.',
    },
  },
  required: ['localized_text'],
} as const;

const DETECT_TRANSLATE_SYSTEM_PROMPT = `
You are a translation and language-detection layer for a customer support system. You will be given one customer message, which may be in English, Hindi (Devanagari script), Hindi written in Latin/romanized script (including Hinglish, i.e. Hindi and English mixed together informally), or Sinhala.

Your job:
1. Detect which of these the message is actually written in.
2. Translate it into plain, natural English.

Rules:
- Never omit or invent factual details: amounts, currencies, dates, reference numbers, account details, or specific complaints must be preserved exactly.
- Preserve the customer's tone (frustrated, confused, urgent, calm) — do not flatten emotional language into something overly formal.
- If the message is already in English, detected_language is "en" and english_text is the original text unchanged — do not rephrase or "improve" it.
- If the message mixes languages (e.g. Hinglish), still produce one coherent English translation of the whole message.
- Do not add commentary, explanation, or anything not present in the original message.
- You must respond by calling the provided tool. Do not write a plain-text reply.
`.trim();

function localizeSystemPrompt(targetLanguage: SupportedLanguage): string {
  const languageNames: Record<SupportedLanguage, string> = {
    en: 'English',
    hi: 'Hindi, written in Devanagari script',
    'hi-Latn': 'Hindi written in Latin/romanized script (Hinglish style — natural informal romanized Hindi, not overly formal or textbook Hindi)',
    si: 'Sinhala',
  };

  return `
You are a translation layer for a customer support system. You will be given one customer-facing support message, written in English, and must translate it into ${languageNames[targetLanguage]}.

Rules:
- Preserve every factual detail exactly: amounts, currencies, dates, reference numbers, timeframes, and instructions. Never round, omit, or alter these.
- Preserve tone: if the English is calm and direct, the translation should be too. Do not add extra warmth, apology, or formality that isn't in the original.
- Never use exclamation marks, matching the source style.
- Write the way a fluent native speaker actually talks in customer support, not a stiff or overly literal word-for-word translation.
- Do not add commentary or anything not present in the original message.
- You must respond by calling the provided tool. Do not write a plain-text reply.
`.trim();
}

/**
 * Detects the language of an incoming customer message and translates it to
 * English. If the message is already English, this still round-trips through
 * the model (to confirm detection), but the returned text is guaranteed
 * unchanged in that case.
 *
 * Used before a customer message is added to conversation history / passed
 * to draftAgentMessage, so the withdrawal-agent prompt only ever reasons
 * over English text.
 */
export async function detectAndTranslateToEnglish(customerMessage: string): Promise<TranslationResult> {
  const trimmed = customerMessage.trim();
  if (trimmed === '') {
    return { detectedLanguage: 'en', englishText: '' };
  }

  const result = await aiClient.completeStructured<{ detected_language: SupportedLanguage; english_text: string }>(
    [
      { role: 'system', content: DETECT_TRANSLATE_SYSTEM_PROMPT },
      { role: 'user', content: trimmed },
    ],
    DETECT_AND_TRANSLATE_TOOL,
    DETECT_AND_TRANSLATE_SCHEMA,
    { maxTokens: 400, temperature: 0.2 }
  );

  return {
    detectedLanguage: result.detected_language,
    englishText: result.english_text,
  };
}

/**
 * Translates an already-drafted English agent message into the customer's
 * detected language. Called after draftAgentMessage returns, only when
 * targetLanguage !== 'en'.
 */
export async function translateFromEnglish(englishMessage: string, targetLanguage: SupportedLanguage): Promise<string> {
  if (targetLanguage === 'en' || englishMessage.trim() === '') {
    return englishMessage;
  }

  const result = await aiClient.completeStructured<{ localized_text: string }>(
    [
      { role: 'system', content: localizeSystemPrompt(targetLanguage) },
      { role: 'user', content: englishMessage.trim() },
    ],
    TRANSLATE_TO_LANGUAGE_TOOL,
    TRANSLATE_TO_LANGUAGE_SCHEMA,
    { maxTokens: 400, temperature: 0.2 }
  );

  return result.localized_text;
}