/**
 * Configuration file for cerebellar-extraction
 *
 * SETUP:
 * 1. Copy this file to config.js: cp config.example.js config.js
 * 2. Replace the placeholder values with your actual API keys
 * 3. config.js is gitignored - never commit your actual keys
 *
 * For Firebase: Get your config from Firebase Console > Project Settings
 * For Gemini: Get your key from Google AI Studio (https://aistudio.google.com)
 */

// Firebase API Key
window.__FIREBASE_API_KEY__ = "YOUR_FIREBASE_API_KEY_HERE";

// Gemini API Key (for AI chat features)
window.__GEMINI_API_KEY__ = "YOUR_GEMINI_API_KEY_HERE";

// Optional: CORS allowed origins for Cloud Functions (comma-separated)
window.__CORS_ALLOWED_ORIGINS__ = "http://localhost:3000,http://localhost:5000";
