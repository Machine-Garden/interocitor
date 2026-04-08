import type {
  DatabaseSchemaDefinition,
  IndexableSchemaField,
  SchemaField,
} from './types.ts';
import { types } from './schema-types.ts';

// ─── Scalar types carry their generic ────────────────────────────────

const _s: IndexableSchemaField<string>  = types.string;
const _n: IndexableSchemaField<number>  = types.number;
const _b: IndexableSchemaField<boolean> = types.boolean;
const _d: IndexableSchemaField<Date>    = types.date;
const _D: IndexableSchemaField<Date>    = types.Date;
const _j: SchemaField<unknown>          = types.json;
void _s; void _n; void _b; void _d; void _D; void _j;

// ─── enum() infers literal union from const generic ─────────────────

const statusType: IndexableSchemaField<'open' | 'done' | 'archived'> = types.enum('open', 'done', 'archived');
void statusType;

const indexedStatus: IndexableSchemaField<'open' | 'done' | 'archived'> = types.index(types.enum('open', 'done', 'archived'));
const uniqueRole: IndexableSchemaField<'admin' | 'viewer'> = types.unique(types.enum('admin', 'viewer'));
void indexedStatus; void uniqueRole;

// @ts-expect-error — 'open'|'done'|'other' is wider than the target 'open'|'done'
const _wrongEnum: IndexableSchemaField<'open' | 'done'> = types.enum('open', 'done', 'other');
void _wrongEnum;

// @ts-expect-error — string is wider than 'open'|'done'
const _enumNotString: IndexableSchemaField<'open' | 'done'> = types.index(types.string);
void _enumNotString;

// ─── index() and unique() return the same flat shape with flags set ──

const indexedString: IndexableSchemaField<string>  = types.index(types.string);
const uniqueNumber:  IndexableSchemaField<number>  = types.unique(types.number);
const indexedDate:   IndexableSchemaField<Date>    = types.index(types.Date);
void indexedString; void uniqueNumber; void indexedDate;

// @ts-expect-error — IndexableSchemaField<string> is not IndexableSchemaField<number>
const _wrongGeneric: IndexableSchemaField<number> = types.index(types.string);
void _wrongGeneric;

// ─── json is not indexable ──────────────────────────────────────────

// @ts-expect-error — SchemaField<unknown> (json) is not IndexableSchemaField
types.index(types.json);

// @ts-expect-error — SchemaField<unknown> (json) is not IndexableSchemaField
types.unique(types.json);

// ─── Can't pass an already-indexed field back into index/unique ──────
// (IndexableSchemaField is still IndexableSchemaField — nesting compiles,
//  but index/unique are idempotent by design; the flag just stays true)

// ─── Bare string literal is not a valid field descriptor ─────────────

// @ts-expect-error — 'string' is not IndexableSchemaField
types.index('string');

// ─── Full schema definition compiles ────────────────────────────────

const schema: DatabaseSchemaDefinition = {
  version: 1,
  tables: {
    tasks: {
      fields: {
        status:   types.index(types.enum('open', 'done', 'archived')),
        assignee: types.unique(types.string),
        priority: types.index(types.number),
        dueDate:  types.Date,
        payload:  types.json,
      },
    },
  },
};
void schema;


