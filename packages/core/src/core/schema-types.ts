import type { IndexableSchemaField, OptionalSchemaField, SchemaField } from "./types.ts";

type BaseField<T, K extends import("./types.ts").SchemaFieldKind> = SchemaField<T, K> & {
  readonly optional: OptionalSchemaField<T, K>;
};

type BaseIndexableField<T> = IndexableSchemaField<T> & {
  readonly optional: OptionalSchemaField<T, import("./types.ts").IndexableSchemaFieldKind>;
};

function withOptional<T, K extends import("./types.ts").SchemaFieldKind>(
  field: SchemaField<T, K>,
): BaseField<T, K> {
  const base = field as BaseField<T, K>;
  Object.defineProperty(base, "optional", {
    value: { ...field, optional: true as const, __optional: true as const },
    enumerable: true,
    configurable: false,
    writable: false,
  });
  return base;
}

export const types = {
  string: withOptional({
    kind: "string",
  } as IndexableSchemaField<string>) as BaseIndexableField<string>,
  number: withOptional({
    kind: "number",
  } as IndexableSchemaField<number>) as BaseIndexableField<number>,
  boolean: withOptional({
    kind: "boolean",
  } as IndexableSchemaField<boolean>) as BaseIndexableField<boolean>,
  date: withOptional({ kind: "date" } as IndexableSchemaField<Date>) as BaseIndexableField<Date>,
  Date: withOptional({ kind: "date" } as IndexableSchemaField<Date>) as BaseIndexableField<Date>,
  json: withOptional({ kind: "json" } as SchemaField<unknown>) as BaseField<unknown, "json">,

  /** Type a JSON field explicitly: `types.typed<MyType[]>('json')` */
  typed<T>(kind: "json"): BaseField<T, "json"> {
    return withOptional({ kind } as SchemaField<T, "json">);
  },

  enum<const T extends string>(..._values: T[]): BaseIndexableField<T> {
    return withOptional({ kind: "enum" } as IndexableSchemaField<T>) as BaseIndexableField<T>;
  },

  index<T>(field: IndexableSchemaField<T> & { __optional?: never }): IndexableSchemaField<T> {
    return { ...field, index: true };
  },

  unique<T>(field: IndexableSchemaField<T> & { __optional?: never }): IndexableSchemaField<T> {
    return { ...field, index: true, unique: true };
  },
};
