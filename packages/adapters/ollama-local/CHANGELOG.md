# @paperclipai/adapter-ollama-local

## 0.0.1

### Initial Release

- Initial implementation of the ollama-local adapter driving llama.cpp via
  OpenAI-compatible `/v1/chat/completions` with grammar-constrained JSON
  tool-calling (`response_format: { type: "json_object" }`).
- Bypasses Ollama tool-parser bug #15315 by owning JSON parsing end-to-end.
- Targets `gemma4-26b` served by llama.cpp server-cuda on
  `http://192.168.68.82:11435/v1`.
