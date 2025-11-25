# CEREBELLAR-EXTRACT

A web-based data extraction tool for systematic reviews of cerebellar stroke research. Extract structured PICO data from medical research PDFs using AI-powered analysis.

![TypeScript](https://img.shields.io/badge/TypeScript-74.8%25-blue)
![Firebase](https://img.shields.io/badge/Firebase-Hosting-orange)
![Gemini](https://img.shields.io/badge/AI-Gemini%202.5-purple)

## Features

- **PDF Viewer** - View and navigate research papers directly in the browser
- **AI-Powered Extraction** - Automatically extract study data using Gemini 2.5 Flash
- **Structured Data** - PICO format (Population, Intervention, Comparator, Outcomes)
- **Text Selection** - Highlight and annotate specific passages
- **Cloud Sync** - Save extractions to Firebase with Google authentication
- **Chat Interface** - Ask AI questions about the loaded paper
- **Export Options** - Download as JSON or sync to Google Sheets

## Tech Stack

| Component | Technology |
|-----------|------------|
| Frontend | React 18 (CDN) |
| PDF Rendering | PDF.js |
| AI Engine | Google Gemini 2.5 Flash |
| Hosting | Firebase Hosting |
| Database | Cloud Firestore |
| Auth | Firebase Auth (Google) |
| CI/CD | GitHub Actions |

## Quick Start

### Prerequisites

- Node.js 18+
- Firebase CLI (`npm install -g firebase-tools`)
- Google Cloud account with Gemini API access

### Local Development

```bash
# Clone the repository
git clone https://github.com/matheus-rech/cerebellar-extraction.git
cd cerebellar-extraction

# Serve locally (static files)
npx serve public

# Or use Firebase emulator
firebase emulators:start
```

Open `http://localhost:5000` in your browser.

## Firebase Setup

### 1. Create Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Click "Add project" and name it (e.g., `cerebellar-extraction`)
3. Enable Google Analytics (optional)
4. Wait for project creation

### 2. Enable Services

**Authentication:**
1. Go to Authentication → Sign-in method
2. Enable "Google" provider
3. Add your domain to authorized domains

**Firestore:**
1. Go to Firestore Database → Create database
2. Choose "Start in production mode"
3. Select a region close to your users

**Hosting:**
1. Go to Hosting → Get started
2. Follow the setup wizard

### 3. Get Configuration

1. Go to Project Settings → General
2. Scroll to "Your apps" → Web app
3. Click "Add app" if none exists
4. Copy the Firebase config object

### 4. Update Configuration

Edit `public/index.html` and update the Firebase config:

```javascript
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
  measurementId: "YOUR_MEASUREMENT_ID"
};
```

### 5. Get Gemini API Key

1. Go to [Google AI Studio](https://aistudio.google.com/)
2. Create an API key
3. Update in `public/index.html`:

```javascript
const apiKey = "YOUR_GEMINI_API_KEY";
```

### 6. Deploy

```bash
# Login to Firebase
firebase login

# Initialize (if not already done)
firebase init

# Deploy
firebase deploy
```

## Project Structure

```
cerebellar-extraction/
├── .github/
│   └── workflows/
│       └── firebase-hosting-merge.yml  # Auto-deploy on push
├── public/
│   └── index.html          # Main React application (single-file)
├── .firebaserc             # Firebase project alias
├── firebase.json           # Hosting & Firestore config
├── firestore.rules         # Security rules
├── firestore.indexes.json  # Database indexes
└── README.md
```

## Firestore Security Rules

The app uses user-isolated data storage:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /artifacts/{appId}/users/{userId}/data/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

Each user can only access their own extractions.

## Data Schema

Extracted data follows the PICO format for systematic reviews:

```typescript
interface ExtractionData {
  study_id: string;           // e.g., "Smith2023"
  authors: string;            // e.g., "Smith et al."
  year: string;
  title: string;

  population: {
    sample_size: string;
    mean_age: string;
    diagnosis: string;
    inclusion_criteria: string;
  };

  intervention: {
    procedure: string;        // e.g., "Suboccipital decompressive craniectomy"
    timing_hours: string;
    technique: string;
  };

  comparator: string;

  outcomes: {
    mortality: string;
    mRS_favorable: string;    // Modified Rankin Scale 0-3
    complications: string;
    length_of_stay: string;
  };

  timing: {
    follow_up_duration: string;
  };

  study_design: string;
  newcastle_ottawa_score: string;
}
```

## Usage

1. **Upload PDF** - Click "Upload PDF" and select a research paper
2. **Auto-Extract** - Click the magic wand to extract all fields with AI
3. **Manual Edit** - Click any field to edit or use AI suggestions
4. **Annotate** - Enable selection mode to highlight text passages
5. **Chat** - Switch to Chat tab to ask questions about the paper
6. **Export** - Download as JSON or sync to cloud

## Environment Variables

For GitHub Actions deployment, add these secrets:

| Secret | Description |
|--------|-------------|
| `FIREBASE_SERVICE_ACCOUNT_CEREBELLAR_EXTRACTION` | Firebase service account JSON |

## Related Projects

- [TheAgent](https://github.com/matheus-rech/TheAgent) - CLI/backend tool for medical research extraction using Claude Agent SDK

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

- [Firebase](https://firebase.google.com/) for hosting and backend services
- [Google Gemini](https://ai.google.dev/) for AI-powered extraction
- [PDF.js](https://mozilla.github.io/pdf.js/) for PDF rendering
- [React](https://reactjs.org/) for UI framework
