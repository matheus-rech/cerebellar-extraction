# Legacy Frontend Archive

These files are archived versions of the original single-file React frontend.

## Files

| File | Description |
|------|-------------|
| `index-legacy-react-single-file.html` | Main legacy frontend (~2,735 lines, single-file React app) |
| `index.html.backup*` | Various backup versions during development |

## Why Archived

The legacy frontend has been replaced by a modern Next.js application in `web/`.

**Issues with legacy version:**
- Single 2,735+ line HTML file (difficult to maintain)
- Had hardcoded API keys (security risk)
- No proper component structure
- No TypeScript support

**New frontend (`web/`):**
- Next.js 14+ with App Router
- Proper component architecture
- Environment variables for secrets
- TypeScript support
- Better developer experience

## Restoration

If you need to restore the legacy frontend:

```bash
cp archive/legacy-frontend/index-legacy-react-single-file.html public/index.html
```

---
*Archived: 2024-11-28*
