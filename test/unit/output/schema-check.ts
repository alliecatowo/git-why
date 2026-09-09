/**
 * A small, purpose-built structural validator for the two envelope schemas
 * in `schema/`. Not a general JSON Schema implementation: it supports
 * exactly the subset those two schemas use (type, const, enum, oneOf,
 * required, properties, additionalProperties, items). Good enough to catch
 * a rendered envelope drifting from its documented shape, without adding a
 * JSON Schema validator as a dependency.
 */

type Schema = Record<string, unknown>;

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function validateNode(value: unknown, schema: Schema, path: string, errors: string[]): void {
  if ('const' in schema) {
    if (value !== schema.const)
      errors.push(
        `${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`,
      );
    return;
  }
  if ('enum' in schema) {
    const allowed = schema.enum as unknown[];
    if (!allowed.includes(value))
      errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(allowed)}`);
    return;
  }
  if ('oneOf' in schema) {
    const options = schema.oneOf as Schema[];
    const matches = options.filter((opt) => {
      const sub: string[] = [];
      validateNode(value, opt, path, sub);
      return sub.length === 0;
    });
    if (matches.length !== 1)
      errors.push(`${path}: expected exactly one oneOf branch to match, got ${matches.length}`);
    return;
  }

  const type = schema.type as string | string[] | undefined;
  if (type !== undefined) {
    const allowedTypes = Array.isArray(type) ? type : [type];
    const actual = typeOf(value);
    const numberOk = allowedTypes.includes('number') && actual === 'number';
    if (!allowedTypes.includes(actual) && !numberOk) {
      errors.push(`${path}: expected type ${allowedTypes.join('|')}, got ${actual}`);
      return;
    }
  }

  if (
    schema.type === 'object' &&
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  ) {
    const obj = value as Record<string, unknown>;
    const required = (schema.required as string[] | undefined) ?? [];
    for (const key of required) {
      if (!(key in obj)) errors.push(`${path}: missing required property "${key}"`);
    }
    const properties = (schema.properties as Record<string, Schema> | undefined) ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in properties)) errors.push(`${path}: unexpected property "${key}"`);
      }
    }
    for (const [key, subSchema] of Object.entries(properties)) {
      if (key in obj) validateNode(obj[key], subSchema, `${path}.${key}`, errors);
    }
  }

  if (schema.type === 'array' && Array.isArray(value)) {
    const itemSchema = schema.items as Schema | undefined;
    if (itemSchema) {
      value.forEach((item, i) => validateNode(item, itemSchema, `${path}[${i}]`, errors));
    }
  }
}

export function validateAgainstSchema(value: unknown, schema: Schema): ValidationResult {
  const errors: string[] = [];
  validateNode(value, schema, '$', errors);
  return { valid: errors.length === 0, errors };
}
