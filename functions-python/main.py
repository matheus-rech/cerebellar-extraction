"""
Python Cloud Functions for PDF Processing

Uses pdfplumber for superior text and table extraction with layout preservation.
Complements the Node.js Claude citation functions.

SECURITY NOTES:
---------------
These functions use `invoker="public"` to allow unauthenticated access. This is
intentional for this research extraction tool because:

1. CORS Restrictions: All functions have CORS configured via `get_cors_origins()`
   which limits requests to specific allowed origins (localhost ports for dev,
   production domain for deployment).

2. Read-Only Operations: These functions only extract/analyze PDF content - they
   don't modify any persistent state or access sensitive user data.

3. Input Validation: All functions validate input and handle errors gracefully.

4. Rate Limiting: Firebase Cloud Functions have built-in rate limiting and
   billing controls that prevent abuse.

For production deployments with sensitive data, consider:
- Adding Firebase Authentication and changing to `invoker="private"`
- Implementing additional rate limiting via Firebase App Check
- Adding request signing/API key validation
"""

from firebase_functions import https_fn, options
from firebase_admin import initialize_app
import pdfplumber
import io
import json
import base64
import os

initialize_app()


def get_cors_origins():
    """Get CORS allowed origins from environment or use defaults for local dev."""
    origins_env = os.environ.get('CORS_ALLOWED_ORIGINS', '')
    if origins_env:
        return [origin.strip() for origin in origins_env.split(',')]
    # Default to localhost for development
    return ["http://localhost:3000", "http://localhost:5000", "http://localhost:5002"]

# Set memory and timeout for PDF processing
pdf_options = options.MemoryOption.GB_1
timeout_options = options.SupportedRegion.US_CENTRAL1


@https_fn.on_request(
    memory=options.MemoryOption.MB_512,
    timeout_sec=120,
    cors=options.CorsOptions(cors_origins=get_cors_origins(), cors_methods=["POST", "OPTIONS"]),
    invoker="public"  # Allow unauthenticated access
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
    cors=options.CorsOptions(cors_origins=get_cors_origins(), cors_methods=["POST", "OPTIONS"]),
    invoker="public"  # Allow unauthenticated access
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
    cors=options.CorsOptions(cors_origins=get_cors_origins(), cors_methods=["POST", "OPTIONS"]),
    invoker="public"  # Allow unauthenticated access
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
    cors=options.CorsOptions(cors_origins=get_cors_origins(), cors_methods=["POST", "OPTIONS"]),
    invoker="public"  # Allow unauthenticated access
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


@https_fn.on_request(
    memory=options.MemoryOption.MB_512,
    timeout_sec=120,
    cors=options.CorsOptions(cors_origins=get_cors_origins(), cors_methods=["POST", "OPTIONS"]),
    invoker="public"  # Allow unauthenticated access
)
def extract_figures(req: https_fn.Request) -> https_fn.Response:
    """
    Extract figures/images from PDF.
    Returns base64 encoded images and their metadata.

    Request body: { "pdf_base64": "..." }
    Response: { "figures": [{"page": N, "image_base64": "...", "bbox": [...]}] }
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
        figures = []

        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for i, page in enumerate(pdf.pages):
                for image in page.images:
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
                        "bbox": bbox,
                        "width": image['width'],
                        "height": image['height']
                    })

        return https_fn.Response(
            json.dumps({
                "success": True,
                "figures": figures,
                "figure_count": len(figures)
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
    cors=options.CorsOptions(cors_origins=get_cors_origins(), cors_methods=["POST", "OPTIONS"]),
    invoker="public"
)
def capture_highlights(req: https_fn.Request) -> https_fn.Response:
    """
    Capture screenshots of PDF regions with yellow highlighting.
    Used to create visual evidence for extracted data points.

    Request body: {
        "pdf_base64": "...",
        "highlights": [
            {
                "page": 1,
                "text": "mortality rate was 15.3%",
                "x0": 100, "y0": 200, "x1": 300, "y1": 220,
                "label": "Mortality Rate"
            }
        ],
        "dpi": 200,
        "padding": 15
    }
    Response: {
        "screenshots": [
            {
                "page": 1,
                "label": "Mortality Rate",
                "text": "...",
                "image_base64": "...",
                "width": N,
                "height": N
            }
        ]
    }
    """
    from PIL import Image, ImageDraw
    import fitz  # PyMuPDF

    try:
        data = req.get_json()
        if not data or 'pdf_base64' not in data:
            return https_fn.Response(
                json.dumps({"error": "pdf_base64 required"}),
                status=400,
                mimetype="application/json"
            )

        pdf_bytes = base64.b64decode(data['pdf_base64'])
        highlights = data.get('highlights', [])
        dpi = data.get('dpi', 200)
        padding = data.get('padding', 15)

        if not highlights:
            return https_fn.Response(
                json.dumps({"error": "highlights array required"}),
                status=400,
                mimetype="application/json"
            )

        screenshots = []

        # Open PDF with PyMuPDF for better rendering
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")

        for highlight in highlights:
            page_num = highlight.get('page', 1) - 1  # Convert to 0-based
            if page_num < 0 or page_num >= len(doc):
                continue

            page = doc[page_num]

            # Calculate scaling factor for DPI
            scale = dpi / 72.0
            mat = fitz.Matrix(scale, scale)

            # Render page to image
            pix = page.get_pixmap(matrix=mat)
            img_data = pix.tobytes("png")
            img = Image.open(io.BytesIO(img_data))

            # Get highlight coordinates and scale them
            x0 = highlight.get('x0', 0) * scale
            y0 = highlight.get('y0', 0) * scale
            x1 = highlight.get('x1', 100) * scale
            y1 = highlight.get('y1', 50) * scale

            # Add padding
            x0 = max(0, x0 - padding)
            y0 = max(0, y0 - padding)
            x1 = min(img.width, x1 + padding)
            y1 = min(img.height, y1 + padding)

            # Draw yellow highlight rectangle
            draw = ImageDraw.Draw(img, 'RGBA')
            highlight_color = (255, 255, 0, 100)  # Yellow with transparency
            draw.rectangle([x0, y0, x1, y1], fill=highlight_color)

            # Crop to highlight region with context
            context_padding = padding * 3
            crop_x0 = max(0, x0 - context_padding)
            crop_y0 = max(0, y0 - context_padding)
            crop_x1 = min(img.width, x1 + context_padding)
            crop_y1 = min(img.height, y1 + context_padding)

            cropped = img.crop((crop_x0, crop_y0, crop_x1, crop_y1))

            # Convert to base64
            img_byte_arr = io.BytesIO()
            cropped.save(img_byte_arr, format='PNG')
            img_base64 = base64.b64encode(img_byte_arr.getvalue()).decode('utf-8')

            screenshots.append({
                "page": highlight.get('page', 1),
                "label": highlight.get('label', ''),
                "text": highlight.get('text', ''),
                "image_base64": img_base64,
                "width": cropped.width,
                "height": cropped.height
            })

        doc.close()

        return https_fn.Response(
            json.dumps({
                "success": True,
                "screenshots": screenshots,
                "screenshot_count": len(screenshots)
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
    timeout_sec=300,
    cors=options.CorsOptions(cors_origins=get_cors_origins(), cors_methods=["POST", "OPTIONS"]),
    invoker="public"
)
def generate_html_report(req: https_fn.Request) -> https_fn.Response:
    """
    Generate an HTML report with extraction data and embedded screenshots.
    Creates a self-contained HTML file with visual evidence.

    Request body: {
        "pdf_base64": "...",
        "extraction_data": { ... },  # CerebellarSDCSchema format
        "highlights": [...],
        "title": "Report Title",
        "dpi": 150,
        "padding": 20
    }
    Response: {
        "html": "<!DOCTYPE html>...",
        "screenshots": N,
        "timestamp": "..."
    }
    """
    from datetime import datetime
    import fitz
    from PIL import Image, ImageDraw

    try:
        data = req.get_json()
        if not data or 'pdf_base64' not in data:
            return https_fn.Response(
                json.dumps({"error": "pdf_base64 required"}),
                status=400,
                mimetype="application/json"
            )

        pdf_bytes = base64.b64decode(data['pdf_base64'])
        extraction_data = data.get('extraction_data', {})
        highlights = data.get('highlights', [])
        title = data.get('title', 'Cerebellar Extraction Report')
        dpi = data.get('dpi', 150)
        padding = data.get('padding', 20)

        # Generate screenshots for highlights
        screenshots = []
        if highlights:
            doc = fitz.open(stream=pdf_bytes, filetype="pdf")

            for highlight in highlights:
                page_num = highlight.get('page', 1) - 1
                if page_num < 0 or page_num >= len(doc):
                    continue

                page = doc[page_num]
                scale = dpi / 72.0
                mat = fitz.Matrix(scale, scale)
                pix = page.get_pixmap(matrix=mat)
                img_data = pix.tobytes("png")
                img = Image.open(io.BytesIO(img_data))

                x0 = highlight.get('x0', 0) * scale
                y0 = highlight.get('y0', 0) * scale
                x1 = highlight.get('x1', 100) * scale
                y1 = highlight.get('y1', 50) * scale

                x0 = max(0, x0 - padding)
                y0 = max(0, y0 - padding)
                x1 = min(img.width, x1 + padding)
                y1 = min(img.height, y1 + padding)

                draw = ImageDraw.Draw(img, 'RGBA')
                draw.rectangle([x0, y0, x1, y1], fill=(255, 255, 0, 100))

                context_padding = padding * 2
                crop_x0 = max(0, x0 - context_padding)
                crop_y0 = max(0, y0 - context_padding)
                crop_x1 = min(img.width, x1 + context_padding)
                crop_y1 = min(img.height, y1 + context_padding)

                cropped = img.crop((crop_x0, crop_y0, crop_x1, crop_y1))

                img_byte_arr = io.BytesIO()
                cropped.save(img_byte_arr, format='PNG')
                img_base64 = base64.b64encode(img_byte_arr.getvalue()).decode('utf-8')

                screenshots.append({
                    "label": highlight.get('label', ''),
                    "text": highlight.get('text', ''),
                    "image_base64": img_base64,
                    "page": highlight.get('page', 1)
                })

            doc.close()

        # Generate HTML report
        timestamp = datetime.now().isoformat()

        # Build evidence HTML
        evidence_html = ""
        for i, shot in enumerate(screenshots):
            evidence_html += f'''
            <div class="evidence-card">
                <h3>{shot['label']}</h3>
                <p class="source-text">"{shot['text']}"</p>
                <p class="page-ref">Page {shot['page']}</p>
                <img src="data:image/png;base64,{shot['image_base64']}" alt="{shot['label']}" />
            </div>
            '''

        # Build extraction data HTML
        def render_field(name, field):
            if isinstance(field, dict):
                if 'value' in field:
                    source = field.get('sourceText', 'N/A')
                    return f'''
                    <tr>
                        <td><strong>{name}</strong></td>
                        <td>{field.get('value', 'N/A')}</td>
                        <td class="source-cell">{source}</td>
                    </tr>
                    '''
                else:
                    rows = ""
                    for k, v in field.items():
                        rows += render_field(f"{name}.{k}", v)
                    return rows
            else:
                return f'''
                <tr>
                    <td><strong>{name}</strong></td>
                    <td colspan="2">{field}</td>
                </tr>
                '''

        extraction_rows = ""
        for section_name, section_data in extraction_data.items():
            if isinstance(section_data, dict):
                for field_name, field_value in section_data.items():
                    extraction_rows += render_field(f"{section_name}.{field_name}", field_value)

        html = f'''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{title}</title>
    <style>
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            background: #f5f5f5;
        }}
        header {{
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 30px;
            border-radius: 10px;
            margin-bottom: 30px;
        }}
        h1 {{ font-size: 2rem; margin-bottom: 10px; }}
        .timestamp {{ opacity: 0.8; font-size: 0.9rem; }}
        h2 {{
            color: #667eea;
            border-bottom: 2px solid #667eea;
            padding-bottom: 10px;
            margin: 30px 0 20px;
        }}
        .extraction-table {{
            width: 100%;
            border-collapse: collapse;
            background: white;
            border-radius: 8px;
            overflow: hidden;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }}
        .extraction-table th, .extraction-table td {{
            padding: 12px 15px;
            text-align: left;
            border-bottom: 1px solid #eee;
        }}
        .extraction-table th {{
            background: #667eea;
            color: white;
        }}
        .source-cell {{
            font-size: 0.85rem;
            color: #666;
            font-style: italic;
            max-width: 300px;
        }}
        .evidence-section {{
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
            gap: 20px;
            margin-top: 20px;
        }}
        .evidence-card {{
            background: white;
            border-radius: 8px;
            padding: 20px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }}
        .evidence-card h3 {{
            color: #667eea;
            margin-bottom: 10px;
        }}
        .evidence-card img {{
            max-width: 100%;
            border: 1px solid #ddd;
            border-radius: 4px;
            margin-top: 10px;
        }}
        .source-text {{
            background: #fff9c4;
            padding: 10px;
            border-radius: 4px;
            font-style: italic;
            margin-bottom: 5px;
        }}
        .page-ref {{
            color: #888;
            font-size: 0.85rem;
        }}
        footer {{
            text-align: center;
            padding: 20px;
            color: #888;
            font-size: 0.85rem;
        }}
    </style>
</head>
<body>
    <header>
        <h1>{title}</h1>
        <p class="timestamp">Generated: {timestamp}</p>
    </header>

    <section>
        <h2>Extracted Data</h2>
        <table class="extraction-table">
            <thead>
                <tr>
                    <th>Field</th>
                    <th>Value</th>
                    <th>Source Text</th>
                </tr>
            </thead>
            <tbody>
                {extraction_rows}
            </tbody>
        </table>
    </section>

    <section>
        <h2>Visual Evidence ({len(screenshots)} screenshots)</h2>
        <div class="evidence-section">
            {evidence_html}
        </div>
    </section>

    <footer>
        <p>Cerebellar SDC Extraction System | Report generated automatically</p>
    </footer>
</body>
</html>'''

        return https_fn.Response(
            json.dumps({
                "success": True,
                "html": html,
                "screenshots": len(screenshots),
                "timestamp": timestamp
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
    cors=options.CorsOptions(cors_origins=get_cors_origins(), cors_methods=["POST", "OPTIONS"]),
    invoker="public"
)
def extract_tables_enhanced(req: https_fn.Request) -> https_fn.Response:
    """
    Enhanced table extraction with structure preservation and caption detection.
    Better handling of merged cells and complex table layouts.

    Request body: { "pdf_base64": "...", "detect_captions": true }
    Response: {
        "tables": [{
            "page": 1,
            "table_index": 0,
            "caption": "Table 1. Patient demographics",
            "headers": [...],
            "rows": [...],
            "raw": [...],
            "column_count": N,
            "row_count": N
        }]
    }
    """
    import re

    try:
        data = req.get_json()
        if not data or 'pdf_base64' not in data:
            return https_fn.Response(
                json.dumps({"error": "pdf_base64 required"}),
                status=400,
                mimetype="application/json"
            )

        pdf_bytes = base64.b64decode(data['pdf_base64'])
        detect_captions = data.get('detect_captions', True)
        tables_result = []

        # Caption patterns for medical papers
        caption_patterns = [
            r'^Table\s*\d+[\.:]\s*(.+)$',
            r'^Tab\s*\d+[\.:]\s*(.+)$',
            r'^TABLE\s*\d+[\.:]\s*(.+)$',
        ]

        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for page_num, page in enumerate(pdf.pages):
                page_text = page.extract_text() or ""
                page_lines = page_text.split('\n')

                # Find table captions on this page
                captions = []
                if detect_captions:
                    for line in page_lines:
                        for pattern in caption_patterns:
                            match = re.match(pattern, line.strip(), re.IGNORECASE)
                            if match:
                                captions.append(line.strip())
                                break

                # Extract tables with settings for better structure
                table_settings = {
                    "vertical_strategy": "lines",
                    "horizontal_strategy": "lines",
                    "snap_tolerance": 3,
                    "join_tolerance": 3,
                }

                page_tables = page.extract_tables(table_settings)

                # Also try text-based extraction for tables without lines
                if not page_tables:
                    table_settings_text = {
                        "vertical_strategy": "text",
                        "horizontal_strategy": "text",
                    }
                    page_tables = page.extract_tables(table_settings_text)

                for j, table in enumerate(page_tables):
                    if table and len(table) > 0:
                        # Clean None values and normalize
                        cleaned_table = []
                        for row in table:
                            cleaned_row = []
                            for cell in row:
                                if cell:
                                    # Clean whitespace and normalize
                                    cleaned_cell = ' '.join(str(cell).split())
                                else:
                                    cleaned_cell = ""
                                cleaned_row.append(cleaned_cell)
                            cleaned_table.append(cleaned_row)

                        # Determine headers (first non-empty row)
                        headers = []
                        data_rows = []
                        for i, row in enumerate(cleaned_table):
                            if any(cell.strip() for cell in row):
                                if not headers:
                                    headers = row
                                else:
                                    data_rows.append(row)

                        # Match caption to table
                        caption = ""
                        if j < len(captions):
                            caption = captions[j]

                        tables_result.append({
                            "page": page_num + 1,
                            "table_index": j,
                            "caption": caption,
                            "headers": headers,
                            "rows": data_rows,
                            "raw": cleaned_table,
                            "column_count": len(headers) if headers else 0,
                            "row_count": len(cleaned_table)
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
    cors=options.CorsOptions(cors_origins=get_cors_origins(), cors_methods=["POST", "OPTIONS"]),
    invoker="public"
)
def extract_figures_enhanced(req: https_fn.Request) -> https_fn.Response:
    """
    Enhanced figure extraction with caption detection.
    Extracts images and attempts to match them with nearby captions.

    Request body: { "pdf_base64": "...", "min_size": 50, "dpi": 150 }
    Response: {
        "figures": [{
            "page": 1,
            "figure_index": 0,
            "caption": "Figure 1. CT scan showing...",
            "image_base64": "...",
            "bbox": [x0, y0, x1, y1],
            "width": N,
            "height": N
        }]
    }
    """
    import re
    import fitz

    try:
        data = req.get_json()
        if not data or 'pdf_base64' not in data:
            return https_fn.Response(
                json.dumps({"error": "pdf_base64 required"}),
                status=400,
                mimetype="application/json"
            )

        pdf_bytes = base64.b64decode(data['pdf_base64'])
        min_size = data.get('min_size', 50)
        dpi = data.get('dpi', 150)

        figures_result = []

        # Caption patterns for figures
        caption_patterns = [
            r'^Figure\s*\d+[\.:]\s*(.+)',
            r'^Fig\s*\.?\s*\d+[\.:]\s*(.+)',
            r'^FIGURE\s*\d+[\.:]\s*(.+)',
        ]

        doc = fitz.open(stream=pdf_bytes, filetype="pdf")

        for page_num in range(len(doc)):
            page = doc[page_num]
            page_text = page.get_text()

            # Find figure captions
            captions = []
            for line in page_text.split('\n'):
                for pattern in caption_patterns:
                    match = re.match(pattern, line.strip(), re.IGNORECASE)
                    if match:
                        captions.append(line.strip())
                        break

            # Extract images
            image_list = page.get_images(full=True)

            for img_idx, img in enumerate(image_list):
                xref = img[0]

                try:
                    base_image = doc.extract_image(xref)
                    image_bytes = base_image["image"]

                    # Get image dimensions
                    from PIL import Image
                    pil_img = Image.open(io.BytesIO(image_bytes))
                    width, height = pil_img.size

                    # Skip small images (likely icons/logos)
                    if width < min_size or height < min_size:
                        continue

                    # Convert to PNG
                    img_byte_arr = io.BytesIO()
                    pil_img.save(img_byte_arr, format='PNG')
                    img_base64 = base64.b64encode(img_byte_arr.getvalue()).decode('utf-8')

                    # Try to get image position on page
                    bbox = None
                    for item in page.get_image_info():
                        if item.get('xref') == xref:
                            bbox = item.get('bbox')
                            break

                    # Match caption to image based on proximity
                    caption = ""
                    if img_idx < len(captions):
                        caption = captions[img_idx]

                    figures_result.append({
                        "page": page_num + 1,
                        "figure_index": img_idx,
                        "caption": caption,
                        "image_base64": img_base64,
                        "bbox": list(bbox) if bbox else None,
                        "width": width,
                        "height": height,
                        "format": base_image.get("ext", "unknown")
                    })

                except Exception as img_error:
                    # Skip problematic images
                    continue

        doc.close()

        return https_fn.Response(
            json.dumps({
                "success": True,
                "figures": figures_result,
                "figure_count": len(figures_result)
            }),
            mimetype="application/json"
        )

    except Exception as e:
        return https_fn.Response(
            json.dumps({"error": str(e)}),
            status=500,
            mimetype="application/json"
        )
