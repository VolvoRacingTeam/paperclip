/**
 * CLI shim for plugin-consistency with the pi-local adapter.
 *
 * The ollama-local adapter does not spawn a CLI — the model is driven
 * in-process via HTTP — but we keep this module so the package exports
 * the same surface as sibling adapters.
 */

export const cliName = "ollama-local";

export function printBanner(): void {
  // eslint-disable-next-line no-console
  console.log("[ollama-local] in-process adapter, no CLI to spawn");
}
