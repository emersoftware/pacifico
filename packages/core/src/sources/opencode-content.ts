import { asJsonString, type JsonObject } from '../extract-util';

/** Map OpenCode message parts to content blocks: text→text, reasoning→thinking, tool→tool, patch→patch. */
export function buildContent(parts: JsonObject[]): JsonObject[] {
  const blocks: JsonObject[] = [];
  for (const p of parts) {
    switch (p.type) {
      case 'text': {
        const text = asJsonString(p.text);
        if (text?.trim()) blocks.push({ type: 'text', text });
        break;
      }
      case 'reasoning': {
        const text = asJsonString(p.text);
        if (text?.trim()) blocks.push({ type: 'thinking', thinking: text });
        break;
      }
      case 'tool': {
        // Faithful to the source `state` (input/output/status/error) so the extractors read one shape.
        // Keys stay ABSENT when the source lacks them (undefined would vanish in JSON,
        // null would not - and the transcript byte-compares matter).
        const block: JsonObject = { type: 'tool' };
        if (p.tool !== undefined) block.tool = p.tool;
        if (p.state !== undefined) block.state = p.state;
        blocks.push(block);
        break;
      }
      case 'patch':
        if (Array.isArray(p.files)) blocks.push({ type: 'patch', files: p.files });
        break;
    }
  }
  return blocks;
}

/** Epoch-ms → ISO-8601, or '' for a missing/invalid time (parser skips '' timestamps). */
export function isoTime(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '';
  return new Date(ms).toISOString();
}
