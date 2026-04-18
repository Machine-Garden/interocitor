import type { IndexableSchemaField, SchemaField } from './types.ts';

export const types = {
  string:  { kind: 'string'  } as IndexableSchemaField<string>,
  number:  { kind: 'number'  } as IndexableSchemaField<number>,
  boolean: { kind: 'boolean' } as IndexableSchemaField<boolean>,
  date:    { kind: 'date'    } as IndexableSchemaField<Date>,
  Date:    { kind: 'date'    } as IndexableSchemaField<Date>,
  json:    { kind: 'json'    } as SchemaField<unknown>,

  /** Type a JSON field explicitly: `types.typed<MyType[]>('json')` */
  typed<T>(kind: 'json'): SchemaField<T> {
    return { kind } as SchemaField<T>;
  },

  enum<const T extends string>(..._values: T[]): IndexableSchemaField<T> {
    return { kind: 'enum' } as IndexableSchemaField<T>;
  },

  index<T>(field: IndexableSchemaField<T>): IndexableSchemaField<T> {
    return { ...field, index: true };
  },

  unique<T>(field: IndexableSchemaField<T>): IndexableSchemaField<T> {
    return { ...field, index: true, unique: true };
  },
};

