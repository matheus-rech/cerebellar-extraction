
import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const filePath = path.join(process.cwd(), 'data', 'studies.json');
    
    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ error: 'Study not found' }, { status: 404 });
    }

    const fileContents = fs.readFileSync(filePath, 'utf8');
    const studies = JSON.parse(fileContents);
    const study = studies.find((s: any) => s.id === params.id);

    if (!study) {
      return NextResponse.json({ error: 'Study not found' }, { status: 404 });
    }
    
    return NextResponse.json(study);
  } catch (error) {
    console.error('Error reading study:', error);
    return NextResponse.json({ error: 'Failed to fetch study' }, { status: 500 });
  }
}
