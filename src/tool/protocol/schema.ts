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

/**
 * Static validation of a tool input schema, run at registration time.
 *
 * A schema is a contract with the model: if it is silently malformed
 * (`required` naming a property that doesn't exist, `items` on a non-array,
 * an empty `enum`, a bogus `type`), every validation decision downstream is
 * wrong and the failure mode is "constraints silently don't apply" — the
 * hardest class of bug to diagnose. This mirrors the MCP requirement that
 * tool schemas MUST be valid JSON Schema; a tool with an invalid schema is
 * rejected at registration instead of poisoning the runtime.
 */
const ALLOWED_SCHEMA_TYPES = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

const MAX_SCHEMA_DEPTH = 32;

export function assertValidToolSchema(schema: unknown, toolName: string): void {
  validateSchemaNode(schema, toolName, "input", 0);
}

function validateSchemaNode(
  node: unknown,
  toolName: string,
  path: string,
  depth: number,
): void {
  if (depth > MAX_SCHEMA_DEPTH) {
    throw new Error(`Tool ${toolName} input schema exceeds the maximum nesting depth (${MAX_SCHEMA_DEPTH}).`);
  }
  if (!isSchemaRecord(node)) {
    throw new Error(`Tool ${toolName} input schema at ${path} must be an object.`);
  }
  const type = node.type;
  // `type` may be a single name or a union array (JSON Schema 2020-12),
  // e.g. ["string", "null"]. Every member must be a known type.
  const typeList = type === undefined ? [] : Array.isArray(type) ? type : [type];
  for (const entry of typeList) {
    if (!ALLOWED_SCHEMA_TYPES.has(String(entry))) {
      throw new Error(`Tool ${toolName} input schema at ${path} has invalid type "${String(entry)}".`);
    }
  }
  const isObjectType = typeList.includes("object");
  const isArrayType = typeList.includes("array");
  if (!isObjectType && node.properties !== undefined) {
    throw new Error(`Tool ${toolName} input schema at ${path}: properties only apply to object schemas.`);
  }
  if (!isArrayType && node.items !== undefined) {
    throw new Error(`Tool ${toolName} input schema at ${path}: items only applies to array schemas.`);
  }
  if (node.required !== undefined) {
    if (!Array.isArray(node.required) || node.required.some((name) => typeof name !== "string")) {
      throw new Error(`Tool ${toolName} input schema at ${path}: required must be an array of strings.`);
    }
    if (isObjectType && node.properties !== undefined) {
      for (const requiredName of node.required) {
        if (!Object.prototype.hasOwnProperty.call(node.properties, requiredName)) {
          throw new Error(
            `Tool ${toolName} input schema at ${path}: required property "${requiredName}" is not declared in properties.`,
          );
        }
      }
    }
  }
  if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length === 0)) {
    throw new Error(`Tool ${toolName} input schema at ${path}: enum must be a non-empty array.`);
  }
  if (node.properties !== undefined) {
    if (!isSchemaRecord(node.properties)) {
      throw new Error(`Tool ${toolName} input schema at ${path}: properties must be an object.`);
    }
    for (const [name, child] of Object.entries(node.properties)) {
      validateSchemaNode(child, toolName, `${path}.${name}`, depth + 1);
    }
  }
  if (node.items !== undefined) {
    validateSchemaNode(node.items, toolName, `${path}.items`, depth + 1);
  }
}

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
