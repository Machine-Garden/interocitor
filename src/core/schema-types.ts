import type { IndexableSchemaField, SchemaField } from './types.ts';

export const types = {
  string:  { kind: 'string'  } as IndexableSchemaField<string>,
  number:  { kind: 'number'  } as IndexableSchemaField<number>,
  boolean: { kind: 'boolean' } as IndexableSchemaField<boolean>,
  date:    { kind: 'date'    } as IndexableSchemaField<Date>,
  Date:    { kind: 'date'    } as IndexableSchemaField<Date>,
  json:    { kind: 'json'    } as SchemaField<unknown>,

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

