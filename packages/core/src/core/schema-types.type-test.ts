import type {
  DatabaseSchemaDefinition,
  IndexableSchemaField,
  SchemaField,
  TableSchemaDefinition,
  InferSchemaType,
  InferTableType,
  InferFieldType,
  SyncConfig,
} from './types.ts';
import { types } from './schema-types.ts';
import type { SyncEngine } from './sync-engine.ts';

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

// ─── Generic DatabaseSchemaDefinition + InferSchemaType ─────────────

// Build a typed schema via `satisfies` — TS widens to the generic but keeps
// the phantom types intact for inference.
const typedSchema = {
  version: 1,
  tables: {
    tasks: {
      fields: {
        title:    types.string,
        status:   types.enum('open', 'done'),
        priority: types.number,
      },
    },
    notes: {
      fields: {
        content: types.string,
        pinned:  types.boolean,
      },
    },
  },
} satisfies DatabaseSchemaDefinition;

// InferSchemaType extracts { tasks: { title: string; ... }, notes: { ... } }
type DB = InferSchemaType<typeof typedSchema>;
type TaskRow = DB['tasks'];
type NoteRow = DB['notes'];

// InferTableType shorthand
type TaskRow2 = InferTableType<typeof typedSchema, 'tasks'>;

// Field types are correct
const _taskTitle:    TaskRow['title']    = 'hello';
const _taskStatus:  TaskRow['status']   = 'open';
const _taskPrio:    TaskRow['priority'] = 42;
const _noteContent: NoteRow['content']  = 'text';
const _notePinned:  NoteRow['pinned']   = true;
void _taskTitle; void _taskStatus; void _taskPrio; void _noteContent; void _notePinned;

// InferTableType matches direct extraction
const _same: TaskRow2 = {} as TaskRow;
void _same;

// @ts-expect-error — 'other' is not in the 'open'|'done' union
const _badStatus: TaskRow['status'] = 'other';
void _badStatus;

// @ts-expect-error — number is not string
const _badTitle: TaskRow['title'] = 42;
void _badTitle;

// ─── TableSchemaDefinition<T> typed fields ───────────────────────────

// Valid typed table schema compiles
const _validTableSchema: TableSchemaDefinition<{ title: string; priority: number }> = {
  fields: { title: types.string, priority: types.number },
};
void _validTableSchema;

// Field type mismatch — SchemaField<number> is not SchemaField<string>
const _mismatchedField: TableSchemaDefinition<{ title: string }> = {
  // @ts-expect-error — IndexableSchemaField<number> is not SchemaField<string>
  fields: { title: types.number },
};
void _mismatchedField;

// ─── SyncConfig<S> carries schema type ──────────────────────────────

// Config typed explicitly — schema must match S
const _config: SyncConfig<{ tasks: { title: string } }> = {
  remotePath: '/App',
  appName: 'App',
  schema: {
    version: 1,
    tables: { tasks: { fields: { title: types.string } } },
  },
};
void _config;

// Schema field type mismatch caught inline
const _badConfig: SyncConfig<{ tasks: { title: string } }> = {
  remotePath: '/App',
  appName: 'App',
  schema: {
    version: 1,
    tables: { tasks: { fields: {
      // @ts-expect-error — IndexableSchemaField<number> is not SchemaField<string>
      title: types.number,
    } } },
  },
};
void _badConfig;

// ─── SyncEngine<S> inferred from config ─────────────────────────────

// Declare engine typed via inferred schema — table() returns Table<TaskRow>
declare const typedEngine: SyncEngine<InferSchemaType<typeof typedSchema>>;

// table() with known key → Table<{ title: string; status: 'open'|'done'; priority: number }>
const tasksTable = typedEngine.table('tasks');
type _TasksGet = Awaited<ReturnType<typeof tasksTable.get>>;
// _TasksGet should be { title: string; ... } | undefined — not Record<string,unknown>
const _checkGet: _TasksGet = { title: 'x', status: 'open', priority: 1 };
void _checkGet;

// @ts-expect-error — 'nonexistent' is not keyof DB (no fallback overload)
typedEngine.table('nonexistent');



// ─── Regression: satisfies DatabaseSchemaDefinition infers correctly ─

const userSchema = {
  version: 1,
  tables: {
    weekPlans: {
      fields: {
        weekId: types.string,
        plan: types.json,
        createdAt: types.date,
      },
    },
    receipts: {
      fields: {
        id: types.string,
        weekId: types.index(types.string),
        totalActual: types.number,
      },
    },
  },
} satisfies DatabaseSchemaDefinition;

type UserDB = InferSchemaType<typeof userSchema>;
type WeekPlanRow = UserDB['weekPlans'];
type ReceiptRow = InferTableType<typeof userSchema, 'receipts'>;

const _wp: WeekPlanRow = { weekId: 'w1', plan: {}, createdAt: new Date() };
const _r: ReceiptRow = { id: 'r1', weekId: 'w1', totalActual: 42 };
void _wp; void _r;

// @ts-expect-error — number not assignable to string
const _badWp: WeekPlanRow = { weekId: 42, plan: {}, createdAt: new Date() };
void _badWp;

// ─── _type phantom: no undefined bleeding into field types ───────────

const _weekId: InferFieldType<typeof types.string> = 'hello';        // string not string|undefined
const _date:   InferFieldType<typeof types.date>   = new Date();     // Date not Date|undefined
const _num:    InferFieldType<typeof types.number> = 42;             // number

// @ts-expect-error — string is not number
const _badNum: InferFieldType<typeof types.number> = 'x';

void _weekId; void _date; void _num; void _badNum;
