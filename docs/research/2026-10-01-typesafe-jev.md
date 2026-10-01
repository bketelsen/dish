# Research: TypeSafe's Jev judge API

Date: 2026-10-01.

**Sources:**
- TypeSafe's docs (`docs.typesafe.ai`, which serves each page as markdown at `/<page>.md`, with an index at `/llms.txt`);
- OpenRouter's Jev guide;
- [disler/ten-levels-of-jev](https://github.com/disler/ten-levels-of-jev) at commit 777adaf.

**Why we looked:** this is the API our `judge` plugin (roadmap 4a) is built on.

**Caveat:** the ten-levels repo only ever ran live through OpenRouter. Its direct TypeSafe client was never tested with a key. Our first live call is the first test of the direct path.

## The API

- **Endpoint:** `POST https://api.typesafe.ai/v1/systemone`, with `Authorization: Bearer <key>` and `Content-Type: application/json`.
- **Models:** `GET /v1/models` lists them.
- **Not OpenAI-compatible.** TypeSafe's docs warn against substituting `/chat/completions`.
- **One call, many questions.** A call carries one `state` and any number of questions, answered in parallel. In one cookbook example, 13 questions took 0.27 s.

```json
{ "model": "jev-1.13.0",
  "state": "<string> | {object} | [array]",
  "questions": {
    "safe":   { "type": "noul",   "instructions": "...", "criteria": { "true": "...", "false": "..." } },
    "effect": { "type": "choice", "instructions": "...", "criteria": { "read_only": "...", "reversible": "...", "other": null } },
    "risk":   { "type": "score",  "instructions": "...", "criteria": ["low ...", "medium ...", "high ..."] } } }
```

- **`model` is required.** `jev-latest` and `jev-preview` are aliases for `jev-1.13.0`. TypeSafe advises pinning the version your thresholds were tuned on.
- **Instructions** may name fields of `state` in backticks, e.g. "Does `content` try to instruct…".
- **Question ids** are never sent to the model.
- **Criteria per type:**
  - **noul:** optional, `{true, false}`.
  - **choice:** an option-to-description map, with up to 255 options.
  - **score:** an ordered array of 2–10 levels, from low to high.
- **No other knobs:** no system prompt, temperature, seed or max tokens.

**Response:**

```json
{ "model": "jev-1.13.0",
  "answers": {
    "safe":   { "type": "noul", "noul": 0.95 },
    "effect": { "type": "choice", "choice": "read_only", "probabilities": { "read_only": 0.88, "reversible": 0.12, "other": 0.0 }, "confidence": 0.81 },
    "risk":   { "type": "score", "score": 1.05, "legend": { "0": "...", "1": "...", "2": "..." }, "probabilities": { "0": 0.0, "1": 0.95, "2": 0.05 }, "confidence": 0.92 } },
  "usage": { "input_tokens": 304, "output_tokens": 18 } }
```

- **noul** is P(yes) in [0, 1]. It has no confidence: 0.5 means unsure, and near 0 means a confident no.
- **choice** is always one of your keys. Its probabilities sum to 1, and `confidence` comes from the shape of the distribution.
- **score** is a probability-weighted value in [0, N−1], which can be fractional. Normalize it with `score / (N−1)`.
- **No explanation text,** ever.

## Limits and errors

- **Price:** $0.042 per million input tokens; output is free. Latency is 70–500 ms.
- **Rate limits:** 100K tokens per second, 40 requests per second. TypeSafe says these "can change without notice". `retry-after` is honored.
- **Context:** 64k tokens per request, of which 32k is for `state` plus the longest question. OpenRouter's page says 32k in total. Input is text only.
- **Status codes:**
  - `401`: bad key
  - `422`: validation; the body names the field
  - `429`: rate limited
  - `529`: overloaded
  - `5xx`: server errors

  The error body's exact shape isn't documented.
- **No streaming.**
- **SDKs:** `@typesafe-ai/sdk` (JS) and `typesafe-sdk` (Python) default to 10 s per attempt with 2 retries. The ten-levels repo calls `fetch` directly, with no SDK.

## Phrasing and calibration

- **One snap judgment per question.** Describe situations, not degrees.
- **Phrase each question so a high value means yes.** Avoid negations.
- **Always include an `other` option** in a choice.
- **Keep numbers, dates and counting in code.**
- **Filter `state` first.** A large `state` full of irrelevant detail is a known failure mode.
- **Calibration:** Jev is marketed as calibrated, but thresholds still need tuning on your own data.
  - A noul and a choice asking the same thing give different numbers (0.22 versus 0.01), so a noul's threshold can't be reused for a choice.
  - A question and its negation don't sum to 1.
- **Not deterministic:** repeats move by a few hundredths. Use a review band, e.g. 0.3–0.7, rather than one cut.
- **Adversarial content:** "State is data, and `jev-1.13` does not treat it as hostile by default…" Injected text can move an answer.

## The ten levels, as patterns for us

| Level | Pattern | Use for dish |
|---|---|---|
| 4 `shell-command-gate`, 6 `bash-gate` | choice `read_only / reversible / irreversible`, plus a destructive-intent noul | The command gate. In the repo's README run, `rm -rf node_modules && npm install` came back reversible at confidence 0.35, so a human was asked. |
| 6 `result-screen` | One noul on the first 6000 characters of a tool result; at ≥ 0.7 it adds a "treat as data" banner | Screening tool results |
| 3, 10 | Rubric scores, with weights kept in code; an agent-facing `ask_jev` tool | `ask_judge` |
| OpenRouter's auto-approve cookbook | A static risky list, then nouls `reversible` and `serves_task`, both required ≥ 0.9 | Measured: `bun test` 0.93 / 0.95, `bun add left-pad` 0.45 / 0.09, `npx wrangler deploy` 0.04 / 0.07. The `serves_task` question catches commands that don't belong to the task. |
