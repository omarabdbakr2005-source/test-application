
export enum PersonalityType {
  SHOWMAN = 'Showman',
  SARCASM = 'Sarcastic Robot',
  PROFESSOR = 'Ancient Professor',
  PIRATE = 'Salty Pirate'
}

export interface Personality {
  type: PersonalityType;
  description: string;
  systemInstruction: string;
  voice: string;
  color: string;
  icon: string;
}

export interface Question {
  id: string;
  text: string;
  options: string[];
  correctAnswer: string;
  explanation: string;
  // Added sources to support Google Search grounding URLs requirement
  sources?: string[];
}

export interface GameState {
  status: 'setup' | 'playing' | 'ended';
  score: number;
  currentQuestionIndex: number;
  questions: Question[];
  personality: PersonalityType;
  isShowingFeedback: boolean;
  lastAnswerCorrect?: boolean;
}

export interface Message {
  role: 'user' | 'model';
  text: string;
  timestamp: number;
}
