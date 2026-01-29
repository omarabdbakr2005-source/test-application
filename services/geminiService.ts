
import { GoogleGenAI, Type, Modality } from "@google/genai";
import { Question, PersonalityType } from "../types";
import { PERSONALITIES } from "../constants";
import { decode, decodeAudioData } from "../utils/audio";

export const generateTriviaQuestions = async (category: string): Promise<Question[]> => {
  // Correctly initialize with API key from environment directly
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: `Generate 5 challenging trivia questions about ${category}. Use Google Search to find recent and accurate facts from 2024 or 2025 where possible.`,
    config: {
      tools: [{ googleSearch: {} }],
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.STRING },
            text: { type: Type.STRING },
            options: { type: Type.ARRAY, items: { type: Type.STRING } },
            correctAnswer: { type: Type.STRING },
            explanation: { type: Type.STRING }
          },
          required: ["id", "text", "options", "correctAnswer", "explanation"]
        }
      }
    }
  });

  // Extract grounding chunks for mandatory URL listing
  const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const sources = chunks
    .map((chunk: any) => chunk.web?.uri)
    .filter(Boolean);

  try {
    // Access .text property directly
    const questions: Question[] = JSON.parse(response.text || '[]');
    return questions.map(q => ({ ...q, sources }));
  } catch (e) {
    console.error("Failed to parse questions", e);
    return [];
  }
};

export const playTTS = async (text: string, personalityType: PersonalityType) => {
  const personality = PERSONALITIES[personalityType];
  // Correctly initialize with API key from environment directly
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-preview-tts",
    contents: [{ parts: [{ text: `Say this in character as ${personality.type}: ${text}` }] }],
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: personality.voice as any },
        },
      },
    },
  });

  // Extract audio data from response parts
  const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (base64Audio) {
    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    const audioBuffer = await decodeAudioData(decode(base64Audio), audioCtx, 24000, 1);
    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioCtx.destination);
    source.start();
  }
};