import { initializeApp, getApps, FirebaseApp } from 'firebase/app';
import { getFirestore, Firestore } from 'firebase/firestore';
import { getStorage, FirebaseStorage } from 'firebase/storage';
import { getAI, getGenerativeModel, GoogleAIBackend } from 'firebase/ai';
import type { GenerativeModel, AI } from 'firebase/ai';

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

// Validate required config in development
if (process.env.NODE_ENV === 'development') {
  const missingKeys = Object.entries(firebaseConfig)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missingKeys.length > 0) {
    console.warn(
      `Missing Firebase config keys: ${missingKeys.join(', ')}. ` +
      'Create a .env.local file with the required NEXT_PUBLIC_FIREBASE_* variables.'
    );
  }
}

// Initialize Firebase (singleton pattern)
let app: FirebaseApp;
let db: Firestore;
let storage: FirebaseStorage;
let ai: AI;
let geminiModel: GenerativeModel;

if (getApps().length === 0) {
  app = initializeApp(firebaseConfig);
} else {
  app = getApps()[0];
}

db = getFirestore(app);
storage = getStorage(app);

// Initialize Firebase AI Logic with Gemini
// No API key needed - Firebase handles authentication automatically
ai = getAI(app, { backend: new GoogleAIBackend() });
geminiModel = getGenerativeModel(ai, { model: 'gemini-3-pro-preview' });

export { app, db, storage, ai, geminiModel };
