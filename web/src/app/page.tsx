"use client";

import { useEffect, useState } from "react";
import { collection, getDocs, orderBy, query } from "firebase/firestore";
import { db } from "@/lib/firebase";
import Link from "next/link";

export default function Dashboard() {
  const [studies, setStudies] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchStudies = async () => {
      try {
        const q = query(collection(db, "studies"), orderBy("createdAt", "desc"));
        const querySnapshot = await getDocs(q);
        const studiesData = querySnapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }));
        setStudies(studiesData);
      } catch (error) {
        console.error("Error fetching studies:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchStudies();
  }, []);

  if (loading) return <div className="p-8 text-center">Loading studies...</div>;

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-3xl font-bold text-gray-900 mb-8">Cerebellar Extraction Dashboard</h1>
        
        <div className="bg-white shadow rounded-lg overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Study</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Year</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Center</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Sample Size</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {studies.map((study) => (
                <tr key={study.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm font-medium text-gray-900">{study.metadata?.firstAuthor || "Unknown"}</div>
                    <div className="text-sm text-gray-500 truncate max-w-xs">{study.metadata?.title}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {study.metadata?.publicationYear}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {study.metadata?.hospitalCenter}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {study.population?.sampleSize}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-green-100 text-green-800">
                      Extracted
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <Link href={`/review/${study.id}`} className="text-indigo-600 hover:text-indigo-900">
                      Review
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {studies.length === 0 && (
            <div className="p-8 text-center text-gray-500">
              No studies found. Run the extraction agent to populate data.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
