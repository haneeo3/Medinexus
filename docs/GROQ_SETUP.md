# Groq medicine search setup

The assistant extracts fields from a facility user's search text. It does not prescribe, decide medicine equivalence, check stock, or create a request. The user reviews the suggested fields and explicitly selects a formulation from the catalogue. Only the search text is sent to Groq: do not include patient information. Groq usage may incur charges; monitor the account and set provider spending limits as appropriate.

## Local development

1. Create a Groq API key in the Groq console.
2. Add `GROQ_API_KEY=your-key` to the existing `.env.local` on your own computer. Do not share the key in chat. This file is ignored by Git.
3. Restart `npm run dev`. Vite runs the authenticated, server-side function locally.
4. Sign into MediNexus, open Find medicine, and use the optional AI-assisted search.

The optional `GROQ_MODEL` environment variable changes the model; the default `openai/gpt-oss-20b` must support Groq strict structured outputs. The existing Vite Supabase URL and publishable key are also used on the server to validate the user's session and active facility.

## Netlify

Set `GROQ_API_KEY`, `VITE_SUPABASE_URL`, and `VITE_SUPABASE_PUBLISHABLE_KEY` as Netlify environment variables available to Functions and redeploy. `GROQ_MODEL` is optional. Never use a `VITE_` prefix for the Groq key, a Supabase service-role key in the browser, or commit any key. Without Groq configuration, the normal catalogue search continues to work.

The API authenticates the user and active facility before calling Groq. It validates the output, but has no durable distributed rate limit. Set appropriate usage controls before making the endpoint publicly available. Mocked tests are not a live Groq or Netlify integration test.
