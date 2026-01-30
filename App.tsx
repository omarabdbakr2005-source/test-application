
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { PersonalityType, GameState, Question, Message } from './types';
import { PERSONALITIES, CATEGORIES } from './constants';
import { generateTriviaQuestions, playTTS } from './services/geminiService';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { encode, decode, decodeAudioData } from './utils/audio';

// Fix: Augment the existing global AIStudio interface instead of redeclaring the window property with a conflicting type.
declare global {
  interface AIStudio {
    hasSelectedApiKey: () => Promise<boolean>;
    openSelectKey: () => Promise<void>;
  }
}

const tg = typeof window !== 'undefined' ? (window as any).Telegram?.WebApp : null;

const Header = () => (
  <header className="py-4 px-6 flex justify-between items-center border-b border-white/10 glass sticky top-0 z-50 safe-pt">
    <div className="flex items-center gap-3">
      <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center font-bold text-lg shadow-lg shadow-indigo-500/20">G</div>
      <h1 className="text-lg font-bungee tracking-wider">GEMINI TRIVIA</h1>
    </div>
    {tg?.initDataUnsafe?.user && (
      <div className="text-[10px] font-bold text-indigo-400 bg-indigo-500/10 px-2 py-1 rounded">
        @{tg.initDataUnsafe.user.username || 'PLAYER'}
      </div>
    )}
  </header>
);

const App: React.FC = () => {
  const [gameState, setGameState] = useState<GameState>({
    status: 'setup',
    score: 0,
    currentQuestionIndex: 0,
    questions: [],
    personality: PersonalityType.SHOWMAN,
    isShowingFeedback: false,
    lastAnswerCorrect: undefined
  });

  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [selectedCategory, setSelectedCategory] = useState(CATEGORIES[0]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [isLiveMode, setIsLiveMode] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<any>(null);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef(0);

  useEffect(() => {
    const checkKeyStatus = async () => {
      // @ts-ignore - access global aistudio
      const studio = window.aistudio;
      if (studio) {
        const hasKey = await studio.hasSelectedApiKey();
        setHasApiKey(hasKey || !!process.env.API_KEY);
      } else {
        setHasApiKey(!!process.env.API_KEY);
      }
    };
    checkKeyStatus();

    if (tg) {
      tg.ready();
      tg.expand();
      try {
        tg.enableClosingConfirmation?.();
        tg.setHeaderColor?.('#1e1b4b');
        tg.setBackgroundColor?.('#020617');
      } catch (e) {}
    }
  }, []);

  const handleSelectKey = async () => {
    // @ts-ignore - access global aistudio
    const studio = window.aistudio;
    if (studio) {
      await studio.openSelectKey();
      setHasApiKey(true); // Assume success per rules
    }
  };

  const resumeAudio = async () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
    }
    if (!outputAudioContextRef.current) {
      outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    }
    if (audioContextRef.current.state === 'suspended') await audioContextRef.current.resume();
    if (outputAudioContextRef.current.state === 'suspended') await outputAudioContextRef.current.resume();
  };

  const stopLiveSession = useCallback(() => {
    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch(e) {}
      sessionRef.current = null;
    }
    setIsRecording(false);
    sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
  }, []);

  const startLiveSession = async () => {
    await resumeAudio();
    tg?.HapticFeedback?.impactOccurred('medium');
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const personality = PERSONALITIES[gameState.personality];

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            setIsRecording(true);
            const source = audioContextRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = audioContextRef.current!.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (event) => {
              const inputData = event.inputBuffer.getChannelData(0);
              const int16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) int16[i] = inputData[i] * 32768;
              const pcmBlob = { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' };
              sessionPromise.then(session => session.sendRealtimeInput({ media: pcmBlob }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            const parts = message.serverContent?.modelTurn?.parts || [];
            for (const part of parts) {
              if (part.inlineData?.data) {
                const base64 = part.inlineData.data;
                const ctx = outputAudioContextRef.current!;
                nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
                const buffer = await decodeAudioData(decode(base64), ctx, 24000, 1);
                const source = ctx.createBufferSource();
                source.buffer = buffer;
                source.connect(ctx.destination);
                source.start(nextStartTimeRef.current);
                nextStartTimeRef.current += buffer.duration;
                sourcesRef.current.add(source);
                source.onended = () => sourcesRef.current.delete(source);
              }
            }
          },
          onerror: (e) => console.error(e),
          onclose: () => setIsRecording(false)
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: personality.voice as any } } },
          systemInstruction: personality.systemInstruction
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      console.error(err);
      if (err.message?.includes("Requested entity was not found")) handleSelectKey();
      setIsRecording(false);
    }
  };

  const startGame = useCallback(async () => {
    if (isLoading) return;
    if (!hasApiKey) {
      handleSelectKey();
      return;
    }

    setIsLoading(true);
    setLoadingMessage('Consulting the Host...');
    
    await resumeAudio();
    tg?.HapticFeedback?.notificationOccurred('success');
    
    try {
      setLoadingMessage('Researching questions...');
      const questions = await generateTriviaQuestions(selectedCategory);
      
      setGameState(prev => ({
        ...prev,
        status: 'playing',
        questions,
        currentQuestionIndex: 0,
        score: 0,
        isShowingFeedback: false,
        lastAnswerCorrect: undefined
      }));
      
      setIsLoading(false);
      const host = PERSONALITIES[gameState.personality];
      playTTS(`Welcome to Gemini Trivia! I'm your host, ${host.type}. Let's get started!`, gameState.personality);
    } catch (e: any) {
      console.error("Game Start Error:", e);
      setIsLoading(false);
      setLoadingMessage('');
      if (e.message?.includes("Requested entity was not found")) {
        handleSelectKey();
      } else {
        tg?.showAlert?.(e.message || "Failed to start. Check your connection.");
      }
    }
  }, [selectedCategory, gameState.personality, isLoading, hasApiKey]);

  const handleAnswer = async (answer: string) => {
    if (gameState.isShowingFeedback) return;
    await resumeAudio();
    const currentQ = gameState.questions[gameState.currentQuestionIndex];
    const isCorrect = answer === currentQ.correctAnswer;
    tg?.HapticFeedback?.notificationOccurred(isCorrect ? 'success' : 'error');
    
    playTTS(isCorrect ? "Spot on!" : "Not quite right.", gameState.personality);
    
    setGameState(prev => ({ 
      ...prev, 
      score: isCorrect ? prev.score + 1 : prev.score, 
      isShowingFeedback: true, 
      lastAnswerCorrect: isCorrect 
    }));
  };

  const handleNextQuestion = useCallback(() => {
    tg?.HapticFeedback?.impactOccurred('light');
    if (gameState.currentQuestionIndex < gameState.questions.length - 1) {
      setGameState(prev => ({ ...prev, currentQuestionIndex: prev.currentQuestionIndex + 1, isShowingFeedback: false }));
    } else {
      setGameState(prev => ({ ...prev, status: 'ended' }));
      playTTS(`Finished! Score: ${gameState.score}/${gameState.questions.length}.`, gameState.personality);
    }
  }, [gameState.currentQuestionIndex, gameState.questions.length, gameState.score, gameState.personality]);

  const shareResult = () => {
    tg?.HapticFeedback?.impactOccurred('medium');
    const text = `I just scored ${gameState.score}/${gameState.questions.length} on Gemini Trivia! 🏆`;
    tg?.switchInlineQuery?.(text);
  };

  useEffect(() => {
    if (!tg) return;
    const btn = tg.MainButton;
    const cleanup = () => {
      btn.offClick(startGame);
      btn.offClick(handleNextQuestion);
    };

    if (isLoading) {
      btn.setText('LOADING...').show().disable();
    } else if (!hasApiKey) {
      btn.setText('SETUP API KEY').show().enable().onClick(handleSelectKey);
    } else if (gameState.status === 'setup') {
      btn.setText('START GAME').show().enable().onClick(startGame);
    } else if (gameState.status === 'playing' && gameState.isShowingFeedback) {
      btn.setText('NEXT').show().enable().onClick(handleNextQuestion);
    } else {
      btn.hide();
    }

    return cleanup;
  }, [gameState.status, gameState.isShowingFeedback, gameState.currentQuestionIndex, startGame, handleNextQuestion, isLoading, hasApiKey]);

  const currentQ = gameState.questions[gameState.currentQuestionIndex];

  return (
    <div className="min-h-screen flex flex-col max-w-lg mx-auto safe-pb overflow-x-hidden">
      <Header />
      <main className="flex-1 flex flex-col items-center justify-start p-4 pb-24">
        {gameState.status === 'setup' && (
          <div className="w-full space-y-6 py-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="text-center space-y-1">
              <h2 className="text-2xl font-bungee text-white">Trivia Host</h2>
              <p className="text-xs text-indigo-200 opacity-60 uppercase tracking-widest">Select personality & topic</p>
            </div>
            
            <div className="grid grid-cols-2 gap-3">
              {(Object.keys(PERSONALITIES) as PersonalityType[]).map(type => {
                const p = PERSONALITIES[type];
                const isSelected = gameState.personality === type;
                return (
                  <button 
                    key={type}
                    onClick={() => { tg?.HapticFeedback?.impactOccurred('light'); setGameState(prev => ({ ...prev, personality: type })); }}
                    className={`p-4 rounded-2xl transition-all duration-300 text-left border-2 ${
                      isSelected ? `bg-gradient-to-br ${p.color} border-white shadow-xl scale-[1.02]` : 'bg-white/5 border-white/10'
                    }`}
                  >
                    <div className="text-3xl mb-2">{p.icon}</div>
                    <h3 className="text-base font-bold mb-1 text-white">{p.type}</h3>
                    <p className="text-[11px] text-white/70 leading-tight">{p.description}</p>
                  </button>
                );
              })}
            </div>

            <div className="space-y-4 glass p-5 rounded-3xl">
              <div className="space-y-2">
                <label className="text-[10px] font-bold uppercase tracking-widest text-indigo-300 opacity-60">Category</label>
                <div className="flex flex-wrap gap-2">
                  {CATEGORIES.map(cat => (
                    <button 
                      key={cat} 
                      onClick={() => { tg?.HapticFeedback?.selectionChanged(); setSelectedCategory(cat); }} 
                      className={`px-3 py-1.5 rounded-full text-[10px] font-bold transition-all border ${selectedCategory === cat ? 'bg-indigo-600 border-indigo-400 text-white' : 'bg-white/5 border-white/10 text-white/60'}`}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
              </div>
              
              <div className="pt-4 space-y-3">
                {hasApiKey === false && (
                  <div className="p-4 bg-amber-500/10 border border-amber-500/30 rounded-xl space-y-2">
                    <p className="text-[10px] text-amber-200 uppercase font-bold tracking-widest">Action Required</p>
                    <p className="text-xs text-white/80 leading-relaxed">To use Gemini AI, you must select an API key from a paid GCP project.</p>
                    <a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" rel="noopener" className="text-[10px] text-indigo-400 underline font-bold">Learn about billing</a>
                    <button onClick={handleSelectKey} className="w-full py-3 bg-amber-500 text-black font-bungee rounded-xl text-xs">CONFIG API KEY</button>
                  </div>
                )}

                {hasApiKey !== false && (
                  <button 
                    onClick={startGame} 
                    disabled={isLoading} 
                    className={`w-full py-4 bg-indigo-600 rounded-2xl font-bungee text-lg text-white shadow-lg shadow-indigo-500/40 active:scale-95 transition-all disabled:opacity-50 flex items-center justify-center gap-3`}
                  >
                    {isLoading ? (
                      <><div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div><span className="text-sm">{loadingMessage}</span></>
                    ) : (
                      'START GAME'
                    )}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {gameState.status === 'playing' && currentQ && (
          <div className="w-full grid grid-cols-1 gap-5 animate-in zoom-in duration-300">
            <div className="flex flex-col items-center gap-3">
              <div className={`w-20 h-20 rounded-full bg-gradient-to-br ${PERSONALITIES[gameState.personality].color} flex items-center justify-center text-4xl shadow-2xl ring-4 ring-white/10 ${isRecording ? 'pulse' : ''}`}>
                {PERSONALITIES[gameState.personality].icon}
              </div>
              <div className="text-center px-4">
                <div className="text-[9px] font-bold text-indigo-400 uppercase tracking-widest mb-1 opacity-60">Question {gameState.currentQuestionIndex + 1}/{gameState.questions.length}</div>
                <h3 className="text-xl font-bold leading-tight text-white">{currentQ.text}</h3>
              </div>
            </div>
            
            <div className="grid grid-cols-1 gap-2.5">
              {currentQ.options.map((option, idx) => (
                <button 
                  key={idx} 
                  onClick={() => handleAnswer(option)} 
                  disabled={gameState.isShowingFeedback} 
                  className={`p-4 border rounded-xl text-left text-sm font-semibold transition-all relative overflow-hidden active:scale-[0.99] ${gameState.isShowingFeedback ? (option === currentQ.correctAnswer ? 'bg-emerald-500/20 border-emerald-500' : 'bg-white/5 border-white/10 opacity-40') : 'bg-white/5 border-white/10'}`}
                >
                  <span className={`absolute left-0 top-0 bottom-0 w-1 ${gameState.isShowingFeedback && option === currentQ.correctAnswer ? 'bg-emerald-500' : 'bg-indigo-500'}`}></span>
                  <span className="text-white">{option}</span>
                </button>
              ))}
            </div>

            {gameState.isShowingFeedback && (
              <div className={`p-5 rounded-2xl border glass space-y-2 animate-in fade-in duration-300 ${gameState.lastAnswerCorrect ? 'border-emerald-500/30' : 'border-rose-500/30'}`}>
                <h4 className={`text-xs font-bold uppercase tracking-widest ${gameState.lastAnswerCorrect ? 'text-emerald-400' : 'text-rose-400'}`}>{gameState.lastAnswerCorrect ? 'Correct!' : 'Incorrect!'}</h4>
                <p className="text-[11px] text-indigo-100 italic opacity-90 leading-relaxed">{currentQ.explanation}</p>
                
                {/* Always display sources from Google Search grounding as required */}
                {currentQ.sources && currentQ.sources.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-white/10">
                    <p className="text-[8px] font-bold uppercase text-white/30 tracking-widest mb-1">Sources</p>
                    <div className="flex flex-wrap gap-2">
                      {currentQ.sources.map((url, i) => (
                        <a 
                          key={i} 
                          href={url} 
                          target="_blank" 
                          rel="noopener noreferrer" 
                          className="text-[9px] text-indigo-400 underline hover:text-indigo-300 transition-colors"
                        >
                          {new URL(url).hostname}
                        </a>
                      ))}
                    </div>
                  </div>
                )}

                <button onClick={handleNextQuestion} className="w-full mt-2 py-3 bg-white/10 rounded-xl text-[10px] text-white font-bold uppercase tracking-widest hover:bg-white/20 transition-all">Next</button>
              </div>
            )}

            <div className="glass p-4 rounded-2xl flex items-center justify-between mt-2">
              <div className="flex flex-col"><span className="text-[8px] font-bold text-white/30 uppercase">Score</span><span className="text-xl font-bungee text-indigo-400">{gameState.score}</span></div>
              <div className="flex gap-2">
                <button onClick={() => { setIsLiveMode(!isLiveMode); if(isLiveMode) stopLiveSession(); }} className={`px-3 py-2 rounded-lg text-[9px] font-bold border transition-all text-white ${isLiveMode ? 'bg-indigo-600 border-indigo-400' : 'bg-white/5 border-white/10'}`}>
                  VOICE {isLiveMode ? 'ON' : 'OFF'}
                </button>
                {isLiveMode && (
                  <button onMouseDown={startLiveSession} onMouseUp={stopLiveSession} onTouchStart={(e) => { e.preventDefault(); startLiveSession(); }} onTouchEnd={(e) => { e.preventDefault(); stopLiveSession(); }} className={`px-4 py-2 rounded-lg text-[9px] text-white font-bold shadow-lg transition-colors ${isRecording ? 'bg-red-600' : 'bg-green-600'}`}>
                    {isRecording ? "TALKING..." : "HOLD TO TALK"}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {gameState.status === 'ended' && (
          <div className="text-center space-y-6 py-10 w-full animate-in zoom-in duration-500">
            <div className="text-6xl">🏆</div>
            <h2 className="text-3xl font-bungee text-white">Final Results</h2>
            <div className="glass p-8 rounded-3xl w-full max-w-xs mx-auto">
              <div className="text-5xl font-bungee text-indigo-400">{gameState.score}<span className="text-xl text-white/20 ml-1">/{gameState.questions.length}</span></div>
            </div>
            <div className="flex flex-col gap-3">
              <button onClick={() => setGameState(prev => ({ ...prev, status: 'setup', score: 0, currentQuestionIndex: 0, isShowingFeedback: false }))} className="w-full py-4 bg-white text-black font-bold rounded-full active:scale-95 transition-all">REPLAY</button>
              <button onClick={shareResult} className="w-full py-4 bg-indigo-600 text-white font-bold rounded-full active:scale-95 transition-all">CHALLENGE</button>
            </div>
          </div>
        )}
      </main>
      <footer className="py-6 px-4 text-center text-[8px] text-white/20 uppercase tracking-[0.4em]">Powered by Gemini AI</footer>
    </div>
  );
};

export default App;
