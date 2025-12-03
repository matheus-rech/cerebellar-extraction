#!/usr/bin/env python3
"""
Local Python server for PDF processing functions.
Run this when developing locally to enable table and figure extraction.

Usage: python local_server.py
Server runs on http://localhost:5003
"""

from http.server import HTTPServer, BaseHTTPRequestHandler
import json
import base64
import io
import pdfplumber
import re

class PDFHandler(BaseHTTPRequestHandler):
    def _set_headers(self, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_OPTIONS(self):
        self._set_headers()

    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        post_data = self.rfile.read(content_length)

        try:
            data = json.loads(post_data.decode('utf-8'))
            pdf_base64 = data.get('pdf_base64')

            if not pdf_base64:
                self._set_headers(400)
                self.wfile.write(json.dumps({"error": "pdf_base64 required"}).encode())
                return

            pdf_bytes = base64.b64decode(pdf_base64)

            if self.path == '/extract_tables':
                result = self.extract_tables(pdf_bytes)
            elif self.path == '/extract_figures':
                result = self.extract_figures(pdf_bytes)
            elif self.path == '/extract_text_with_layout':
                result = self.extract_text_with_layout(pdf_bytes)
            elif self.path == '/detect_sections':
                result = self.detect_sections(pdf_bytes)
            elif self.path == '/extract_text_with_positions':
                result = self.extract_text_with_positions(pdf_bytes)
            else:
                self._set_headers(404)
                self.wfile.write(json.dumps({"error": f"Unknown endpoint: {self.path}"}).encode())
                return

            self._set_headers(200)
            self.wfile.write(json.dumps(result).encode())

        except Exception as e:
            print(f"Error: {e}")
            self._set_headers(500)
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def extract_tables(self, pdf_bytes):
        """Extract tables from PDF as structured data."""
        tables_result = []

        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for i, page in enumerate(pdf.pages):
                page_tables = page.extract_tables()
                for j, table in enumerate(page_tables):
                    if table:
                        cleaned_table = [
                            [cell if cell else "" for cell in row]
                            for row in table
                        ]
                        tables_result.append({
                            "page": i + 1,
                            "table_index": j,
                            "headers": cleaned_table[0] if cleaned_table else [],
                            "rows": cleaned_table[1:] if len(cleaned_table) > 1 else [],
                            "raw": cleaned_table
                        })

        return {
            "success": True,
            "tables": tables_result,
            "table_count": len(tables_result)
        }

    def extract_figures(self, pdf_bytes):
        """Extract figures/images from PDF."""
        figures = []

        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for i, page in enumerate(pdf.pages):
                for img_idx, image in enumerate(page.images):
                    try:
                        # Get image bounding box
                        bbox = (image['x0'], image['top'], image['x1'], image['bottom'])

                        # Crop image from page
                        cropped = page.crop(bbox)
                        img_obj = cropped.to_image(resolution=150)

                        # Convert to base64
                        img_byte_arr = io.BytesIO()
                        img_obj.save(img_byte_arr, format='PNG')
                        img_base64 = base64.b64encode(img_byte_arr.getvalue()).decode('utf-8')

                        figures.append({
                            "page": i + 1,
                            "image_base64": img_base64,
                            "bbox": list(bbox),
                            "width": image.get('width', 0),
                            "height": image.get('height', 0)
                        })
                    except Exception as e:
                        print(f"Error extracting image {img_idx} from page {i+1}: {e}")
                        continue

        return {
            "success": True,
            "figures": figures,
            "figure_count": len(figures)
        }

    def extract_text_with_layout(self, pdf_bytes):
        """Extract text from PDF with layout preservation."""
        pages_text = []
        full_text = ""

        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for i, page in enumerate(pdf.pages):
                page_text = page.extract_text() or ""
                pages_text.append({
                    "page": i + 1,
                    "text": page_text,
                    "width": page.width,
                    "height": page.height
                })
                full_text += f"\n\n--- Page {i + 1} ---\n\n{page_text}"

        return {
            "success": True,
            "text": full_text.strip(),
            "pages": pages_text,
            "page_count": len(pages_text)
        }

    def detect_sections(self, pdf_bytes):
        """Detect document sections."""
        SECTION_PATTERNS = [
            (r'^abstract$', 'abstract'),
            (r'^(introduction|background)$', 'introduction'),
            (r'^(methods|patients|materials|study design|subjects)$', 'methods'),
            (r'^(patients and methods|materials and methods)$', 'methods'),
            (r'^results$', 'results'),
            (r'^discussion$', 'discussion'),
            (r'^(conclusion|conclusions)$', 'conclusion'),
            (r'^(references|bibliography)$', 'references'),
            (r'^table\s*\d', 'table'),
            (r'^(figure|fig\.?)\s*\d', 'figure'),
        ]

        sections = []
        current_section = "unknown"
        section_start = 0
        global_char_index = 0

        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for page_num, page in enumerate(pdf.pages, 1):
                page_text = page.extract_text() or ""
                lines = page_text.split('\n')

                for line in lines:
                    line_lower = line.strip().lower()

                    for pattern, section_name in SECTION_PATTERNS:
                        if re.match(pattern, line_lower, re.IGNORECASE):
                            if current_section != "unknown":
                                sections.append({
                                    "name": current_section,
                                    "start_char": section_start,
                                    "end_char": global_char_index,
                                    "page": page_num
                                })

                            current_section = section_name
                            section_start = global_char_index
                            break

                    global_char_index += len(line) + 1

        if current_section != "unknown":
            sections.append({
                "name": current_section,
                "start_char": section_start,
                "end_char": global_char_index,
                "page": page_num
            })

        return {
            "success": True,
            "sections": sections,
            "section_count": len(sections)
        }

    def extract_text_with_positions(self, pdf_bytes):
        """Extract text with word-level position tracking."""
        positions = []
        full_text = ""
        global_char_index = 0
        page_num = 1

        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for page_num, page in enumerate(pdf.pages, 1):
                words = page.extract_words()

                for word in words:
                    text = word['text']
                    start_char = global_char_index
                    end_char = global_char_index + len(text)

                    positions.append({
                        "text": text,
                        "startChar": start_char,
                        "endChar": end_char,
                        "x": word['x0'],
                        "y": word['top'],
                        "width": word['x1'] - word['x0'],
                        "height": word['bottom'] - word['top'],
                        "page": page_num
                    })

                    full_text += text + " "
                    global_char_index = len(full_text)

                full_text += "\n\n"
                global_char_index = len(full_text)

        return {
            "success": True,
            "text": full_text.strip(),
            "positions": positions,
            "page_count": page_num
        }

    def log_message(self, format, *args):
        print(f"[PDF Server] {args[0]}")


def run_server(port=5003):
    server_address = ('', port)
    httpd = HTTPServer(server_address, PDFHandler)
    print(f"PDF Processing Server running on http://localhost:{port}")
    print("Available endpoints:")
    print("  POST /extract_tables - Extract tables from PDF")
    print("  POST /extract_figures - Extract figures/images from PDF")
    print("  POST /extract_text_with_layout - Extract text with layout")
    print("  POST /detect_sections - Detect document sections")
    print("  POST /extract_text_with_positions - Extract text with word positions")
    print("\nRequest body: { \"pdf_base64\": \"...\" }")
    httpd.serve_forever()


if __name__ == '__main__':
    run_server()
