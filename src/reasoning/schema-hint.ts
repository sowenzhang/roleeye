import { z } from 'zod';

/**
 * Renders a zod schema as a compact shape a model can follow.
 *
 * Providers that support native structured output can be handed the schema
 * directly. The ones we actually use cannot: the OpenAI-compatible path runs in
 * `json_object` mode, which guarantees valid JSON but says nothing about the
 * fields, and an agent CLI has no structured-output mechanism at all.
 *
 * Without this the model invents its own reasonable field names — verified
 * against a live agent, which returned `company` / `responsibilities` /
 * `required_qualifications` where the schema wanted `primary_mission` /
 * `seniority` / `required_skills`. Naming the schema is not describing it.
 */
export function schemaHint(schema: z.ZodTypeAny, depth = 0): string {
  const def = schema._def as { typeName?: string; [key: string]: unknown };

  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const pad = '  '.repeat(depth + 1);
      const entries = Object.entries(shape).map(([key, value]) => {
        const optional = value.isOptional() ? '?' : '';
        return `${pad}"${key}"${optional}: ${schemaHint(value as z.ZodTypeAny, depth + 1)}`;
      });
      return `{\n${entries.join(',\n')}\n${'  '.repeat(depth)}}`;
    }

    case z.ZodFirstPartyTypeKind.ZodArray:
      return `[${schemaHint((schema as z.ZodArray<z.ZodTypeAny>).element, depth)}, ...]`;

    case z.ZodFirstPartyTypeKind.ZodEnum:
      return (def['values'] as string[]).map((value) => JSON.stringify(value)).join(' | ');

    case z.ZodFirstPartyTypeKind.ZodLiteral:
      return JSON.stringify(def['value']);

    case z.ZodFirstPartyTypeKind.ZodUnion:
      return (def['options'] as z.ZodTypeAny[]).map((option) => schemaHint(option, depth)).join(' | ');

    case z.ZodFirstPartyTypeKind.ZodOptional:
    case z.ZodFirstPartyTypeKind.ZodNullable:
    case z.ZodFirstPartyTypeKind.ZodDefault:
      return schemaHint(def['innerType'] as z.ZodTypeAny, depth);

    case z.ZodFirstPartyTypeKind.ZodEffects:
      return schemaHint(def['schema'] as z.ZodTypeAny, depth);

    case z.ZodFirstPartyTypeKind.ZodNumber: {
      const checks = (def['checks'] as Array<{ kind: string; value?: number }>) ?? [];
      const min = checks.find((check) => check.kind === 'min')?.value;
      const max = checks.find((check) => check.kind === 'max')?.value;
      const range = [min === undefined ? '' : `min ${min}`, max === undefined ? '' : `max ${max}`].filter(Boolean);
      return range.length > 0 ? `number (${range.join(', ')})` : 'number';
    }

    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return 'boolean';

    case z.ZodFirstPartyTypeKind.ZodString: {
      // A live agent produced correct field names and over-long values. A limit
      // the model is never told about is a limit it cannot respect.
      const max = ((def['checks'] as Array<{ kind: string; value?: number }>) ?? []).find(
        (check) => check.kind === 'max',
      )?.value;
      return max === undefined ? 'string' : `string (max ${max} chars)`;
    }

    case z.ZodFirstPartyTypeKind.ZodRecord:
      return '{ "key": ' + schemaHint(def['valueType'] as z.ZodTypeAny, depth) + ' }';

    default:
      return 'value';
  }
}

/** The instruction appended to every prompt, for providers without structured output. */
export function schemaInstruction(schemaName: string, schema: z.ZodTypeAny): string {
  return [
    `Reply with a single JSON object named ${schemaName} using exactly these keys.`,
    'Do not add keys. Do not rename keys. Keys marked ? may be omitted.',
    '',
    schemaHint(schema),
  ].join('\n');
}
