"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import PdfViewer from "@/components/PdfViewer";
import ExtractionForm from "@/components/ExtractionForm";

export default function ReviewPage() {
  const params = useParams();
  const id = params.id as string;
  const [study, setStudy] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [highlightPage, setHighlightPage] = useState<number>(1);
  const [highlightText, setHighlightText] = useState<string>("");

  useEffect(() => {
    const fetchStudy = async () => {
      if (!id) return;
      try {
        const docRef = doc(db, "studies", id);
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
          setStudy(docSnap.data());
        } else {
          console.error("No such document!");
        }
      } catch (error) {
        console.error("Error fetching study:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchStudy();
  }, [id]);

  const handleFieldFocus = (page: number, text: string) => {
    setHighlightPage(page);
    setHighlightText(text);
  };

  if (loading) return <div className="p-8 text-center">Loading study data...</div>;
  if (!study) return <div className="p-8 text-center text-red-500">Study not found</div>;

  // TODO: Get real PDF URL from storage or metadata
  // For demo, we might need a placeholder or local file mapping
  const pdfUrl = study.pdfUrl || "/sample.pdf"; 

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Left Panel: PDF Viewer */}
      <div className="w-1/2 border-r border-gray-300 bg-gray-100">
        <PdfViewer 
            url={pdfUrl} 
            highlightPage={highlightPage} 
            highlightText={highlightText} 
        />
      </div>

      {/* Right Panel: Extraction Form */}
      <div className="w-1/2 bg-white">
        <ExtractionForm 
            data={study} 
            onFieldFocus={handleFieldFocus} 
        />
      </div>
    </div>
  );
}
