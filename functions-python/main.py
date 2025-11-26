"""
Python Cloud Functions for PDF Processing

Uses pdfplumber for superior text and table extraction with layout preservation.
Complements the Node.js Claude citation functions.
"""

from firebase_functions import https_fn, options
from firebase_admin import initialize_app
import pdfplumber
import io
import json
import base64

initialize_app()

# Set memory and timeout for PDF processing
pdf_options = options.MemoryOption.GB_1
timeout_options = options.SupportedRegion.US_CENTRAL1


@https_fn.on_request(
    memory=options.MemoryOption.MB_512,
    timeout_sec=120,
    cors=options.CorsOptions(cors_origins="*", cors_methods=["POST"])
)
def extract_text_with_layout(req: https_fn.Request) -> https_fn.Response:
    """
    Extract text from PDF with layout preservation.
    Better for section detection and structured data.

    Request body: { "pdf_base64": "..." } or multipart file upload
    Response: { "text": "...", "pages": [...], "page_count": N }
    """
    try:
        # Get PDF data
        if req.content_type and 'multipart' in req.content_type:
            pdf_file = req.files.get('file')
            if not pdf_file:
                return https_fn.Response(
                    json.dumps({"error": "No file provided"}),
                    status=400,
                    mimetype="application/json"
                )
            pdf_bytes = pdf_file.read()
        else:
            data = req.get_json()
            if not data or 'pdf_base64' not in data:
                return https_fn.Response(
                    json.dumps({"error": "pdf_base64 required"}),
                    status=400,
                    mimetype="application/json"
                )
            pdf_bytes = base64.b64decode(data['pdf_base64'])

        # Extract with pdfplumber
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

        return https_fn.Response(
            json.dumps({
                "success": True,
                "text": full_text.strip(),
                "pages": pages_text,
                "page_count": len(pages_text)
            }),
            mimetype="application/json"
        )

    except Exception as e:
        return https_fn.Response(
            json.dumps({"error": str(e)}),
            status=500,
            mimetype="application/json"
        )


@https_fn.on_request(
    memory=options.MemoryOption.MB_512,
    timeout_sec=120,
    cors=options.CorsOptions(cors_origins="*", cors_methods=["POST"])
)
def extract_tables(req: https_fn.Request) -> https_fn.Response:
    """
    Extract tables from PDF as structured data.
    Critical for medical papers with demographic and outcome tables.

    Request body: { "pdf_base64": "..." }
    Response: { "tables": [{"page": 1, "data": [[...], [...]]}, ...] }
    """
    try:
        data = req.get_json()
        if not data or 'pdf_base64' not in data:
            return https_fn.Response(
                json.dumps({"error": "pdf_base64 required"}),
                status=400,
                mimetype="application/json"
            )

        pdf_bytes = base64.b64decode(data['pdf_base64'])
        tables_result = []

        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for i, page in enumerate(pdf.pages):
                page_tables = page.extract_tables()
                for j, table in enumerate(page_tables):
                    if table:  # Skip empty tables
                        # Clean None values
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

        return https_fn.Response(
            json.dumps({
                "success": True,
                "tables": tables_result,
                "table_count": len(tables_result)
            }),
            mimetype="application/json"
        )

    except Exception as e:
        return https_fn.Response(
            json.dumps({"error": str(e)}),
            status=500,
            mimetype="application/json"
        )


@https_fn.on_request(
    memory=options.MemoryOption.GB_1,
    timeout_sec=180,
    cors=options.CorsOptions(cors_origins="*", cors_methods=["POST"])
)
def extract_text_with_positions(req: https_fn.Request) -> https_fn.Response:
    """
    Extract text with character-level position tracking.
    Enables mapping Claude citation indices to PDF coordinates.

    Request body: { "pdf_base64": "..." }
    Response: {
        "text": "...",
        "positions": [{"text": "...", "x": N, "y": N, "page": N, ...}],
        "page_count": N
    }
    """
    try:
        data = req.get_json()
        if not data or 'pdf_base64' not in data:
            return https_fn.Response(
                json.dumps({"error": "pdf_base64 required"}),
                status=400,
                mimetype="application/json"
            )

        pdf_bytes = base64.b64decode(data['pdf_base64'])
        positions = []
        full_text = ""
        global_char_index = 0

        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for page_num, page in enumerate(pdf.pages, 1):
                # Get words with bounding boxes
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

                # Page separator
                full_text += "\n\n"
                global_char_index = len(full_text)

        return https_fn.Response(
            json.dumps({
                "success": True,
                "text": full_text.strip(),
                "positions": positions,
                "page_count": page_num
            }),
            mimetype="application/json"
        )

    except Exception as e:
        return https_fn.Response(
            json.dumps({"error": str(e)}),
            status=500,
            mimetype="application/json"
        )


@https_fn.on_request(
    memory=options.MemoryOption.MB_512,
    timeout_sec=60,
    cors=options.CorsOptions(cors_origins="*", cors_methods=["POST"])
)
def detect_sections(req: https_fn.Request) -> https_fn.Response:
    """
    Detect document sections (Abstract, Methods, Results, Discussion, etc.)
    Returns section boundaries with character indices.

    Request body: { "pdf_base64": "..." }
    Response: { "sections": [{"name": "Results", "start_char": N, "end_char": N, "page": N}] }
    """
    import re

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

    try:
        data = req.get_json()
        if not data or 'pdf_base64' not in data:
            return https_fn.Response(
                json.dumps({"error": "pdf_base64 required"}),
                status=400,
                mimetype="application/json"
            )

        pdf_bytes = base64.b64decode(data['pdf_base64'])
        sections = []
        current_section = "unknown"
        section_start = 0
        global_char_index = 0

        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for page_num, page in enumerate(pdf.pages, 1):
                words = page.extract_words()
                page_text = page.extract_text() or ""
                lines = page_text.split('\n')

                for line in lines:
                    line_lower = line.strip().lower()

                    for pattern, section_name in SECTION_PATTERNS:
                        if re.match(pattern, line_lower, re.IGNORECASE):
                            # Save previous section
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

        # Add final section
        if current_section != "unknown":
            sections.append({
                "name": current_section,
                "start_char": section_start,
                "end_char": global_char_index,
                "page": page_num
            })

        return https_fn.Response(
            json.dumps({
                "success": True,
                "sections": sections,
                "section_count": len(sections)
            }),
            mimetype="application/json"
        )

    except Exception as e:
        return https_fn.Response(
            json.dumps({"error": str(e)}),
            status=500,
            mimetype="application/json"
        )
