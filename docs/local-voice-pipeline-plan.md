# Local Voice Pipeline — Design & Hardware Presets (planning)

> Status: **planning** (uncommitted working doc). This is the "local voice mode" project that
> comes *after* the built-in llama.cpp release. It replaces the all-in-one Gemini Live API with a
> fully local **STT → LLM → TTS** pipeline, kept **optional** so Gemini Live stays the default.
> Model facts below were verified online May 2026 (sources at bottom) — re-check before building.

## Why an LLM is mandatory here
STT and TTS don't reason. Gemini Live currently does ear + brain + mouth in one stream. Split the
ear/mouth out to local models and Shadow must supply the brain itself. So **the built-in llama.cpp
is force-enabled whenever local STT/TTS is selected** (greyed "on" in Settings). Bonus: Qwen3-TTS
*itself* runs its LM half on llama.cpp, so the dependency is doubly true.

## The two choices per stage (user-selectable)

### STT
| Model | Params | Languages | Speed | VRAM | Notes |
|---|---|---|---|---|---|
| **NVIDIA Parakeet-TDT-0.6B-v3** | 0.6B | **25** (EN, NL, DE, FR, ES, IT, …) | **~26–30× realtime on CPU** | ~1 GB (or CPU) | FastConformer-TDT, auto language ID, 6.34% avg WER. The *fast* option. |
| **Whisper large-v3-turbo** (faster-whisper / CT2) | ~0.8B | **~99** | ~129× RTF on GPU; int8 fits 2 GB | **~1.5 GB int8** | More languages, tiny. 4-layer decoder → weaker on low-resource langs (then use full large-v3). The *broad-language* option. |

*Default pairing:* Parakeet for speed (covers EN + Dutch + major EU langs); Whisper-turbo when the
user needs a language Parakeet doesn't cover.

### TTS
| Model | Base | Languages | Speed | VRAM | Notes |
|---|---|---|---|---|---|
| **Qwen3-TTS** | dual-track LM + 2 tokenizers | **10** | streaming; 12.5 Hz tokenizer = immediate first packet; ~0.6 RTF | **~2–3 GB** (Q4 GGUF; 1.7B finetune) | **Best quality**, 3-sec voice cloning, description control. Runs on **llama.cpp (CPU/CUDA/Vulkan) + ONNX decode**. The *quality* option. |
| **OmniVoice** (k2-fsa) | finetuned **Qwen3-0.6B** + diffusion-LM | **600+** | **RTF ~0.025 (≈40× realtime)** | ~1–2 GB | **Apache-2.0**, zero-shot cloning, voice *design* (gender/age/pitch/accent/whisper), `[laughter]` tags, pinyin/phoneme correction. The *many-languages + fastest* option. |

*Default pairing:* Qwen3-TTS for English/major-language quality; OmniVoice for exotic languages or
the lowest-end hardware (it's the fastest and lightest).

## Runtime / integration architecture (native, no Python — like Persona Engine)
- **STT:** **sherpa-onnx** (k2-fsa) runs Parakeet *and* Whisper from ONNX, streaming, with built-in
  **Silero VAD** for endpointing. Execution providers: **CPU / CUDA / DirectML**. No Python, no NeMo.
- **Brain:** the bundled **llama.cpp** server (CUDA / ROCm / Vulkan / CPU). Same component as the
  llama.cpp release — reused here as the voice brain.
- **TTS:** Qwen3-TTS = llama.cpp (LM) + ONNX Runtime (audio decode); OmniVoice = its own runtime
  (has community OpenAI-compatible + streaming forks). Both expose/can-wrap a local HTTP API.

### Cross-vendor coverage (the CPU / NVIDIA / AMD-ROCm requirement)
| Backend | NVIDIA | AMD | Intel | CPU |
|---|---|---|---|---|
| llama.cpp | CUDA | **ROCm/HIP** + **Vulkan** | Vulkan | ✅ |
| ONNX Runtime (STT + TTS decode) | CUDA | **DirectML** (Win) / ROCm EP (Linux) | DirectML | ✅ |

→ On **Windows**, **DirectML** gives clean AMD/Intel GPU support for the ONNX parts; **Vulkan/ROCm**
do it for llama.cpp. Ship/detect the right build per machine (same per-backend packaging the
llama.cpp release already needs).

## Pipeline design (from the Reddit thread, incl. LadyQuacklin's advice)
1. **Mic → VAD → chunked STT.** Stream audio in fixed chunks; VAD decides end-of-turn. faster-whisper
   turbo ≈ 40× realtime makes chunked transcription effectively free.
2. **Endpointing with a grace timeout.** Don't cut a slow/pausing speaker mid-thought; wait a tunable
   gap, then commit. (Both posters flagged premature cut-off as the #1 STT-UX problem.)
3. **Stream LLM tokens → TTS sentence-by-sentence.** Don't wait for the full reply.
4. **Mask first-audio latency with pre-generated filler.** Keep a small bank of short, pre-synthesized
   acknowledgements ("hmm", "got it", "one sec") and play one while the first real TTS packet renders.
   Qwen3-TTS's 12.5 Hz tokenizer / OmniVoice's 0.025 RTF keep that gap to ~0.4–1 s.
5. **Barge-in that trims context.** On interruption: stop TTS + cancel LLM generation, *and* remove the
   not-yet-spoken portion from the LLM context so the model knows what the user actually heard.
6. **Two-stage TTS / streaming** so prosody stays coherent across chunks (Qwen3-TTS's sliding-window
   decoder is built for this).

All of the above is machinery Gemini Live gives for free today — this is the hard part and the reason
local voice is its own project, not a feature bolt-on.

## Hardware-intensity combo presets
Shared-VRAM reality: STT is tiny (≤1.5 GB or CPU), TTS is ~1–3 GB, so the **brain dominates** the budget.
Presets pick a sensible STT + llama.cpp brain + TTS per tier; each stage is still individually overridable.

| Preset | Target hardware | STT | Brain (llama.cpp) | TTS | ~Total VRAM |
|---|---|---|---|---|---|
| **Featherweight** | CPU-only / iGPU / <6 GB | Parakeet v3 (CPU) | Qwen3.5-4B or Phi-4-mini, Q4_K_M | **OmniVoice** (0.6B) | CPU-capable / ≤4 GB |
| **Balanced** *(your 4070 Ti)* | 8–12 GB (3060/4060Ti/4070Ti) | Parakeet v3 (GPU) | Qwen3 8B Q4_K_M **or** Qwen3.6-35B-A3B MoE | Qwen3-TTS **or** OmniVoice | ~8–11 GB |
| **Quality** | 16–24 GB (4080/4090/3090/7900XTX) | Whisper large-v3 (99 langs) or Parakeet | Qwen3 14B or 35B-A3B (full) | Qwen3-TTS 1.7B + voice cloning | ~16–22 GB |
| **Max** | 24 GB+ (5090 / multi-GPU) | Whisper-v3 / Parakeet | Qwen3 30B+ / larger MoE | Qwen3-TTS 1.7B finetuned + cloning | 24 GB+ |

Notes:
- **MoE is the cheat code at 8–12 GB:** Qwen3.6-35B-**A3B** (3B active) reportedly runs on ~6 GB via
  llama.cpp at ~30 tps — a much smarter brain than a dense 8B at similar VRAM. Good default for Balanced.
- **Language drives TTS choice more than hardware:** OmniVoice (600+ langs, Apache-2.0) for anything
  outside Qwen3-TTS's 10; Qwen3-TTS when quality in a supported language matters.
- Presets are starting points; expose per-stage model + quant + context-size overrides (the llama.cpp
  release already needs a working context-size control + Gemini-Live-style auto-compaction; reuse here).

## Licensing (verify before bundling — repo is AGPL-3.0)
- Whisper: **MIT** (safe). OmniVoice: **Apache-2.0** (safe, confirmed).
- Parakeet-TDT-0.6B-v3: NVIDIA model — **verify** (NVIDIA open models are often CC-BY-4.0).
- Qwen3-TTS: Qwen family — **verify** (Qwen weights are commonly Apache-2.0, but confirm the TTS card).
- Consider download-on-demand (like the llama.cpp model manager) rather than bundling weights, to
  sidestep redistribution-license questions and installer bloat.

## Open questions / risks
- **VAD + turn-taking tuning** is where local voice usually feels worse than Gemini Live — budget real
  time for it.
- **Voice cloning consent / safety** — gate it; don't ship arbitrary-voice cloning without a notice.
- **Avatar/lip-sync** (Persona Engine's headline feature) is explicitly **out of scope** for v1.
- **Echo cancellation** in speaker mode (Shadow already has an "echo gate" setting — reuse the concept).

## References
- Persona Engine (native .NET, ONNX + llama.cpp, Qwen3-TTS GGUF): https://github.com/fagenorn/handcrafted-persona-engine
- Parakeet-TDT-0.6B-v3: https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3
- sherpa-onnx (Parakeet + Whisper via ONNX, CUDA/DirectML): https://github.com/k2-fsa/sherpa-onnx
- faster-whisper (CTranslate2): https://github.com/SYSTRAN/faster-whisper
- Qwen3-TTS GGUF / technical report: https://github.com/HaujetZhao/Qwen3-TTS-GGUF
- OmniVoice: https://huggingface.co/k2-fsa/OmniVoice
- Source threads: the two r/LocalLLaMA posts saved in `context tts and stt from 2 reddit posts.txt`.
