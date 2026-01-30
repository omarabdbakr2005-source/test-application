
import { GoogleGenAI, Type, Modality } from "@google/genai";
import { Question, PersonalityType } from "../types";
import { PERSONALITIES } from "../constants";
import { decode, decodeAudioData } from "../utils/audio";

let sharedAudioCtx: AudioContext | null = null;

const getSharedAudioCtx = () => {
  if (!sharedAudioCtx) {
    sharedAudioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
  }
  return sharedAudioCtx;
};

export const generateTriviaQuestions = async (category: string): Promise<Question[]> => {
  // CRITICAL: Always create a new instance right before use to catch the latest API key
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  const prompt = `Generate 5 challenging trivia questions about ${category}. 
  Use Google Search to ensure facts are up-to-date (2024-2025).
  
  Return ONLY a JSON array with this structure:
  [{ "id": "1", "text": "...", "options": ["...", "..."], "correctAnswer": "...", "explanation": "..." }]
  
  Do not include markdown formatting like \`\`\`json. Just the raw array string.`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
      }
    });

    const text = response.text || '';
    const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    const sources = chunks
      .map((chunk: any) => chunk.web?.uri)
      .filter(Boolean);

    const jsonMatch = text.match(/\[\s*\{.*\}\s*\]/s);
    const jsonString = jsonMatch ? jsonMatch[0] : text;
    const questions: Question[] = JSON.parse(jsonString);
    
    return questions.map(q => ({ 
      ...q, 
      sources: sources.length > 0 ? sources : (q.sources || []) 
    }));
  } catch (e: any) {
    console.error("Gemini Error:", e);
    // Propagate for App.tsx to handle key re-selection
    throw e;
  }
};

export const playTTS = async (text: string, personalityType: PersonalityType) => {
  const personality = PERSONALITIES[personalityType];
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text: `In character as ${personality.type}, say: ${text}` }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: personality.voice as any },
          },
        },
      },
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (base64Audio) {
      const audioCtx = getSharedAudioCtx();
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      
      const audioBuffer = await decodeAudioData(decode(base64Audio), audioCtx, 24000, 1);
      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioCtx.destination);
      source.start();
    }
  } catch (e) {
    console.warn("TTS Failed", e);
  }
};
