export type RigoriumToolInputSchema = {
  type: "object";
  properties?: Record<string, RigoriumJsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
};

export type RigoriumJsonSchema = {
  type?: string | string[];
  properties?: Record<string, RigoriumJsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: RigoriumJsonSchema;
  enum?: unknown[];
  [key: string]: unknown;
};

export type RigoriumToolValidationIssue = {
  path: string;
  code: "required" | "unknown_property" | "invalid_type" | "invalid_enum" | "invalid_schema";
  message: string;
};

export type RigoriumToolValidationResult =
  | { ok: true; input: unknown }
  | { ok: false; issues: RigoriumToolValidationIssue[] };
