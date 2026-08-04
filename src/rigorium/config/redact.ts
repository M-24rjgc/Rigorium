// `encryptKey` (Feishu event encryption key) and `*Key`-suffixed fields
// (e.g. `accessKey`/`privateKey` style names in custom provider maps) must
// redact like the explicit secret names — a key *named* a key is a key.
const SECRET_KEY_PATTERN = /(apiKey|authorization|cookie|token|secret|password|credential|encryptKey|key)$/i;

export function redactConfig(value: unknown): unknown {
  return redactValue(value, undefined);
}

function redactValue(value: unknown, key: string | undefined): unknown {
  if (key && SECRET_KEY_PATTERN.test(key)) {
    return "<redacted>";
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, undefined));
  }

  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      output[entryKey] = redactValue(entryValue, entryKey);
    }
    return output;
  }

  return value;
}
