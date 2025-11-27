
import "dotenv/config";
import * as fs from "fs";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, addDoc, serverTimestamp } from "firebase/firestore";
import { extractStudyData } from "./src/genkit";
import { genkit } from "genkit";
import { googleAI } from "@genkit-ai/googleai";

// Initialize Genkit (needed for the flow to run)
const ai = genkit({
  plugins: [googleAI()],
});

// Firebase Client Config (from web/.env.local)
const firebaseConfig = {
  apiKey: "AIzaSyAMr_rIvuAvRyvAcAsLTBOLrKiw8ikvQFQ",
  authDomain: "cerebellar-extraction.firebaseapp.com",
  projectId: "cerebellar-extraction",
  storageBucket: "cerebellar-extraction.firebasestorage.app",
  messagingSenderId: "1019192870442",
  appId: "1:1019192870442:web:0bea61ff2c9435c63c6553"
};

// Initialize Firebase Client
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function run() {
  console.log("🚀 Starting Extraction & Upload...");

  const pdfPath = "./pdfs/Kim2016.pdf";
  if (!fs.existsSync(pdfPath)) {
    console.error(`❌ PDF not found: ${pdfPath}`);
    process.exit(1);
  }

  console.log(`📄 Reading PDF: ${pdfPath}`);
  const pdfBuffer = fs.readFileSync(pdfPath);
  
  // We need to parse the PDF text first because extractStudyData expects text
  // We can use a simple mock parser or import the one from genkit.ts if exported
  // But genkit.ts doesn't export parsePdf. 
  // Let's use pdf-parse directly here.
  const pdfParse = await import("pdf-parse");
  const data = await pdfParse.default(pdfBuffer);
  const pdfText = data.text;

  console.log(`✅ PDF Parsed (${pdfText.length} chars). Running Genkit Extraction...`);

  try {
    // Run the extraction flow
    const result = await extractStudyData({ pdfText });
    
    console.log("✅ Extraction Complete!");
    console.log(`   Title: ${result.metadata.title}`);
    console.log(`   Author: ${result.metadata.firstAuthor}`);
    
    // Save to Firestore
    console.log("💾 Uploading to Firestore...");
    
    const docRef = await addDoc(collection(db, "studies"), {
      ...result,
      createdAt: serverTimestamp(),
      status: "completed"
    });

    console.log(`🎉 Success! Study saved with ID: ${docRef.id}`);
    console.log("👉 Check your dashboard at http://localhost:3000");
    
    process.exit(0);
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

run();
