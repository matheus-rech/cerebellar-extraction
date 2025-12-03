#!/usr/bin/env node

/**
 * Bulk Upload PDFs to Firebase Storage
 *
 * This script uploads all PDFs from the pdfs/ directory to Firebase Storage
 * and creates corresponding Firestore documents.
 *
 * Usage:
 *   node scripts/bulk-upload-pdfs.js [--dry-run] [--emulator]
 *
 * Options:
 *   --dry-run    Show what would be uploaded without actually uploading
 *   --emulator   Use Firebase emulators (Storage: 9199, Firestore: 8080)
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// Configuration
const PDF_DIR = path.join(__dirname, '..', 'pdfs');
const PROJECT_ID = 'cerebellar-extraction';
const STORAGE_BUCKET = 'cerebellar-extraction.firebasestorage.app';

// Parse command line arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const useEmulator = args.includes('--emulator');

// Initialize Firebase Admin
let app;

if (useEmulator) {
  // Use emulator configuration
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
  process.env.FIREBASE_STORAGE_EMULATOR_HOST = '127.0.0.1:9199';

  app = initializeApp({
    projectId: PROJECT_ID,
    storageBucket: STORAGE_BUCKET,
  });

  console.log('🔧 Using Firebase Emulators');
  console.log('   Firestore: 127.0.0.1:8080');
  console.log('   Storage: 127.0.0.1:9199');
} else {
  // Use service account for production
  const serviceAccountPath = path.join(__dirname, '..', 'serviceAccountKey.json');

  if (!fs.existsSync(serviceAccountPath)) {
    console.error('❌ Service account key not found at:', serviceAccountPath);
    console.error('   For production, download from Firebase Console > Project Settings > Service Accounts');
    console.error('   Or use --emulator flag to use local emulators');
    process.exit(1);
  }

  const serviceAccount = require(serviceAccountPath);

  app = initializeApp({
    credential: cert(serviceAccount),
    storageBucket: STORAGE_BUCKET,
  });

  console.log('🔥 Using Firebase Production');
}

const storage = getStorage(app);
const db = getFirestore(app);

/**
 * Generate a unique paper ID from filename
 */
function generatePaperId(filename) {
  const baseName = path.basename(filename, '.pdf');
  // Clean up the filename to create a valid ID
  const cleanName = baseName
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .toLowerCase();
  return `paper_${cleanName}_${Date.now().toString(36)}`;
}

/**
 * Upload a single PDF to Firebase Storage and create Firestore document
 */
async function uploadPDF(filePath) {
  const filename = path.basename(filePath);
  const paperId = generatePaperId(filename);
  const fileSize = fs.statSync(filePath).size;
  const storagePath = `papers/${paperId}/${filename}`;

  console.log(`\n📄 ${filename}`);
  console.log(`   Size: ${(fileSize / 1024).toFixed(1)} KB`);
  console.log(`   ID: ${paperId}`);

  if (dryRun) {
    console.log(`   [DRY RUN] Would upload to: ${storagePath}`);
    return { paperId, filename, status: 'dry-run' };
  }

  try {
    // Upload to Storage
    const bucket = storage.bucket();
    const file = bucket.file(storagePath);

    await file.save(fs.readFileSync(filePath), {
      metadata: {
        contentType: 'application/pdf',
        metadata: {
          originalFileName: filename,
          uploadSource: 'bulk_upload_script',
        }
      }
    });

    // Make the file publicly accessible (for emulator) or generate signed URL
    let downloadURL;
    if (useEmulator) {
      // Emulator URL format
      downloadURL = `http://127.0.0.1:9199/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(storagePath)}?alt=media`;
    } else {
      // Production: make file public and get public URL
      await file.makePublic();
      downloadURL = `https://storage.googleapis.com/${STORAGE_BUCKET}/${storagePath}`;
    }

    // Create Firestore document
    await db.collection('papers').doc(paperId).set({
      paperId,
      fileName: filename,
      fileSize,
      storagePath,
      downloadURL,
      uploadedAt: FieldValue.serverTimestamp(),
      status: 'uploaded', // uploaded → processing → processed → error
      extractedText: null,
      chunks: null,
      metadata: {
        originalFileName: filename,
        uploadSource: 'bulk_upload_script',
      },
    });

    console.log(`   ✅ Uploaded successfully`);
    return { paperId, filename, status: 'success' };

  } catch (error) {
    console.error(`   ❌ Error: ${error.message}`);
    return { paperId, filename, status: 'error', error: error.message };
  }
}

/**
 * Main function
 */
async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Bulk Upload PDFs to Firebase Storage');
  console.log('═══════════════════════════════════════════════════════════');

  // Check if PDF directory exists
  if (!fs.existsSync(PDF_DIR)) {
    console.error(`❌ PDF directory not found: ${PDF_DIR}`);
    process.exit(1);
  }

  // Get list of PDF files
  const pdfFiles = fs.readdirSync(PDF_DIR)
    .filter(f => f.toLowerCase().endsWith('.pdf'))
    .map(f => path.join(PDF_DIR, f));

  if (pdfFiles.length === 0) {
    console.log('No PDF files found in:', PDF_DIR);
    process.exit(0);
  }

  console.log(`\nFound ${pdfFiles.length} PDF files in: ${PDF_DIR}`);

  if (dryRun) {
    console.log('\n🔍 DRY RUN MODE - No files will be uploaded\n');
  }

  // Check for existing papers to avoid duplicates
  let existingPapers = new Set();
  try {
    const snapshot = await db.collection('papers').get();
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.fileName) {
        existingPapers.add(data.fileName);
      }
    });
    console.log(`\nExisting papers in database: ${existingPapers.size}`);
  } catch (error) {
    console.warn('Could not check existing papers:', error.message);
  }

  // Upload each PDF
  const results = [];
  for (const filePath of pdfFiles) {
    const filename = path.basename(filePath);

    // Skip if already exists
    if (existingPapers.has(filename)) {
      console.log(`\n⏭️  ${filename} - Already exists, skipping`);
      results.push({ filename, status: 'skipped' });
      continue;
    }

    const result = await uploadPDF(filePath);
    results.push(result);
  }

  // Summary
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Summary');
  console.log('═══════════════════════════════════════════════════════════');

  const success = results.filter(r => r.status === 'success').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const errors = results.filter(r => r.status === 'error').length;
  const dryRunCount = results.filter(r => r.status === 'dry-run').length;

  console.log(`  Total files: ${pdfFiles.length}`);
  console.log(`  ✅ Uploaded: ${success}`);
  console.log(`  ⏭️  Skipped: ${skipped}`);
  console.log(`  ❌ Errors: ${errors}`);

  if (dryRun) {
    console.log(`  🔍 Dry run: ${dryRunCount}`);
  }

  if (errors > 0) {
    console.log('\n  Errors:');
    results.filter(r => r.status === 'error').forEach(r => {
      console.log(`    - ${r.filename}: ${r.error}`);
    });
  }

  console.log('\n═══════════════════════════════════════════════════════════\n');

  process.exit(errors > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
