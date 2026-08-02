"""Python schema declarations for an Interocitor mesh.

Schemas describe a mesh's logical collections, merge policy, and optional
manifest compatibility version.  They are local client configuration: only the
numeric version is written to the manifest.  Field descriptors deliberately do
not validate row values, matching ``@interocitor/core``.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field as dataclass_field
from types import MappingProxyType
from typing import TYPE_CHECKING, Any, Literal, TypeAlias

if TYPE_CHECKING:
    from .types import ColumnEntry


BuiltinMergeStrategy: TypeAlias = Literal["lww", "local-wins", "remote-wins"]
MergeFunction: TypeAlias = Callable[["ColumnEntry", "ColumnEntry", Mapping[str, str]], "ColumnEntry"]
MergeStrategy: TypeAlias = BuiltinMergeStrategy | MergeFunction
SchemaFieldKind: TypeAlias = Literal["string", "number", "boolean", "date", "json", "enum"]

_FIELD_KINDS = frozenset({"string", "number", "boolean", "date", "json", "enum"})
_INDEXABLE_FIELD_KINDS = _FIELD_KINDS - {"json"}
_BUILTIN_MERGE_STRATEGIES = frozenset({"lww", "local-wins", "remote-wins"})


class SchemaError(ValueError):
    """Raised when a Python schema declaration is malformed.

    This validates the local declaration only. It does not mean that other
    clients have the same field definitions or merge policy.
    """


def _require_name(value: object, description: str) -> str:
    if not isinstance(value, str) or not value:
        raise SchemaError(f"{description} must be a non-empty string")
    return value


def _require_bool(value: object, description: str) -> bool:
    if type(value) is not bool:
        raise SchemaError(f"{description} must be a boolean")
    return value


def _require_merge_strategy(value: object, description: str) -> MergeStrategy:
    if callable(value):
        return value
    if isinstance(value, str) and value in _BUILTIN_MERGE_STRATEGIES:
        return value
    raise SchemaError(
        f"{description} must be one of 'lww', 'local-wins', 'remote-wins', or a callable"
    )


@dataclass(frozen=True, slots=True, init=False)
class SchemaField:
    """A core-compatible field descriptor.

    The descriptor documents an expected field kind and optional index intent.
    It does not validate values passed to :meth:`Interocitor.put` or enforce a
    unique constraint. Use application validation for those responsibilities.
    """

    kind: SchemaFieldKind
    index: bool
    unique: bool
    _optional: bool

    def __init__(
        self,
        kind: SchemaFieldKind,
        *,
        optional: bool = False,
        index: bool = False,
        unique: bool = False,
    ) -> None:
        if kind not in _FIELD_KINDS:
            allowed = ", ".join(sorted(_FIELD_KINDS))
            raise SchemaError(f"Schema field kind must be one of: {allowed}")
        optional = _require_bool(optional, "Schema field optional")
        index = _require_bool(index, "Schema field index")
        unique = _require_bool(unique, "Schema field unique")
        if kind not in _INDEXABLE_FIELD_KINDS and (index or unique):
            raise SchemaError(f"Schema field kind '{kind}' cannot be indexed or unique")
        if optional and (index or unique):
            raise SchemaError("Optional schema fields cannot be indexed or unique")
        object.__setattr__(self, "kind", kind)
        object.__setattr__(self, "index", index or unique)
        object.__setattr__(self, "unique", unique)
        object.__setattr__(self, "_optional", optional)

    @property
    def optional(self) -> "SchemaField":
        """Return the optional form of this field, like core's ``.optional``."""

        if self._optional:
            return self
        return SchemaField(self.kind, optional=True, index=self.index, unique=self.unique)

    @property
    def is_optional(self) -> bool:
        """Whether this descriptor marks the application field optional."""

        return self._optional

    def to_dict(self) -> dict[str, object]:
        """Return the field's core-compatible structural representation."""

        value: dict[str, object] = {"kind": self.kind}
        if self.index:
            value["index"] = True
        if self.unique:
            value["unique"] = True
        if self._optional:
            value["optional"] = True
        return value

    @classmethod
    def from_mapping(cls, value: Mapping[str, object]) -> "SchemaField":
        """Build a descriptor from the structural form used by core schemas."""

        kind = value.get("kind")
        if not isinstance(kind, str):
            raise SchemaError("Schema field kind must be a string")
        optional = value.get("optional", False)
        index = value.get("index", False)
        unique = value.get("unique", False)
        return cls(kind, optional=optional, index=index, unique=unique)  # type: ignore[arg-type]


class _SchemaTypes:
    """Convenience descriptors that mirror ``@interocitor/core``'s ``types``."""

    string = SchemaField("string")
    number = SchemaField("number")
    boolean = SchemaField("boolean")
    date = SchemaField("date")
    Date = date
    json = SchemaField("json")

    def typed(self, kind: Literal["json"]) -> SchemaField:
        """Return a JSON descriptor for application-managed typed values."""

        if kind != "json":
            raise SchemaError("types.typed only accepts 'json'")
        return SchemaField("json")

    def enum(self, *values: str) -> SchemaField:
        """Return an enum descriptor without imposing runtime value validation."""

        if any(not isinstance(value, str) for value in values):
            raise SchemaError("types.enum values must be strings")
        # Core's runtime descriptor records only ``kind``. The values exist for
        # TypeScript inference there, so retaining them in Python would falsely
        # suggest that this client validates them.
        return SchemaField("enum")

    def index(self, descriptor: SchemaField) -> SchemaField:
        """Mark a required, indexable field as indexed."""

        if not isinstance(descriptor, SchemaField):
            raise SchemaError("types.index expects a SchemaField")
        return SchemaField(
            descriptor.kind,
            optional=descriptor.is_optional,
            index=True,
            unique=descriptor.unique,
        )

    def unique(self, descriptor: SchemaField) -> SchemaField:
        """Mark a required, indexable field as unique and indexed in metadata."""

        if not isinstance(descriptor, SchemaField):
            raise SchemaError("types.unique expects a SchemaField")
        return SchemaField(
            descriptor.kind,
            optional=descriptor.is_optional,
            index=True,
            unique=True,
        )


types = _SchemaTypes()


@dataclass(frozen=True, slots=True)
class TableIndex:
    """Legacy explicit index metadata, retained for core-shaped schemas."""

    name: str
    field: str
    unique: bool = False

    def __post_init__(self) -> None:
        _require_name(self.name, "Index name")
        _require_name(self.field, "Index field")
        _require_bool(self.unique, "Index unique")

    def to_dict(self) -> dict[str, object]:
        value: dict[str, object] = {"name": self.name, "field": self.field}
        if self.unique:
            value["unique"] = True
        return value

    @classmethod
    def from_mapping(cls, value: Mapping[str, object]) -> "TableIndex":
        return cls(
            name=_require_name(value.get("name"), "Index name"),
            field=_require_name(value.get("field"), "Index field"),
            unique=_require_bool(value.get("unique", False), "Index unique"),
        )


@dataclass(frozen=True, slots=True)
class TableMergeConfig:
    """A table default plus per-field merge overrides."""

    strategy: MergeStrategy | None = None
    fields: Mapping[str, MergeStrategy] = dataclass_field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.strategy is not None:
            _require_merge_strategy(self.strategy, "Table merge strategy")
        if not isinstance(self.fields, Mapping):
            raise SchemaError("Table merge fields must be a mapping")
        normalized: dict[str, MergeStrategy] = {}
        for name, strategy in self.fields.items():
            normalized[_require_name(name, "Merge field name")] = _require_merge_strategy(
                strategy, f"Merge strategy for field '{name}'"
            )
        object.__setattr__(self, "fields", MappingProxyType(normalized))

    def to_dict(self) -> dict[str, object]:
        value: dict[str, object] = {}
        if self.strategy is not None:
            value["strategy"] = self.strategy
        if self.fields:
            value["fields"] = dict(self.fields)
        return value

    @classmethod
    def from_mapping(cls, value: Mapping[str, object]) -> "TableMergeConfig":
        fields = value.get("fields", {})
        if not isinstance(fields, Mapping):
            raise SchemaError("Table merge fields must be a mapping")
        return cls(strategy=value.get("strategy"), fields=fields)  # type: ignore[arg-type]


@dataclass(frozen=True, slots=True)
class TableSchema:
    """Local schema metadata for one logical CRDT collection."""

    fields: Mapping[str, SchemaField | Mapping[str, object]] = dataclass_field(default_factory=dict)
    indexes: Sequence[TableIndex | Mapping[str, object]] = ()
    merge: MergeStrategy | TableMergeConfig | Mapping[str, object] | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.fields, Mapping):
            raise SchemaError("Table schema fields must be a mapping")
        normalized_fields: dict[str, SchemaField] = {}
        for name, descriptor in self.fields.items():
            field_name = _require_name(name, "Schema field name")
            if isinstance(descriptor, SchemaField):
                normalized_fields[field_name] = descriptor
            elif isinstance(descriptor, Mapping):
                normalized_fields[field_name] = SchemaField.from_mapping(descriptor)
            else:
                raise SchemaError(f"Schema field '{field_name}' must be a SchemaField or mapping")
        object.__setattr__(self, "fields", MappingProxyType(normalized_fields))

        if isinstance(self.indexes, (str, bytes)) or not isinstance(self.indexes, Sequence):
            raise SchemaError("Table schema indexes must be a sequence")
        normalized_indexes: list[TableIndex] = []
        for index in self.indexes:
            if isinstance(index, TableIndex):
                normalized_indexes.append(index)
            elif isinstance(index, Mapping):
                normalized_indexes.append(TableIndex.from_mapping(index))
            else:
                raise SchemaError("Table schema indexes must contain TableIndex values or mappings")
        object.__setattr__(self, "indexes", tuple(normalized_indexes))

        merge = self.merge
        if isinstance(merge, Mapping):
            if "fields" not in merge and "strategy" not in merge:
                raise SchemaError("Table merge mappings must contain 'strategy' or 'fields'")
            merge = TableMergeConfig.from_mapping(merge)
            object.__setattr__(self, "merge", merge)
        if merge is not None and not isinstance(merge, TableMergeConfig):
            _require_merge_strategy(merge, "Table merge strategy")

    def to_dict(self) -> dict[str, object]:
        value: dict[str, object] = {}
        if self.fields:
            value["fields"] = {name: descriptor.to_dict() for name, descriptor in self.fields.items()}
        if self.indexes:
            value["indexes"] = [index.to_dict() for index in self.indexes]
        if self.merge is not None:
            value["merge"] = self.merge.to_dict() if isinstance(self.merge, TableMergeConfig) else self.merge
        return value

    @classmethod
    def from_mapping(cls, value: Mapping[str, object]) -> "TableSchema":
        fields = value.get("fields", {})
        indexes = value.get("indexes", ())
        return cls(fields=fields, indexes=indexes, merge=value.get("merge"))  # type: ignore[arg-type]


@dataclass(frozen=True, slots=True)
class DatabaseSchema:
    """A local schema declaration compatible with the core schema shape.

    ``tables`` names logical CRDT collections. It does not create a remote
    database table. ``version`` is the optional manifest compatibility gate;
    fields and indexes remain local metadata.
    """

    tables: Mapping[str, TableSchema | Mapping[str, object]]
    version: int | None = None
    merge_strategy: MergeStrategy | None = None

    def __post_init__(self) -> None:
        if self.version is not None and type(self.version) is not int:
            raise SchemaError("Schema version must be an integer or None")
        if not isinstance(self.tables, Mapping):
            raise SchemaError("Schema tables must be a mapping")
        normalized_tables: dict[str, TableSchema] = {}
        for name, definition in self.tables.items():
            table_name = _require_name(name, "Schema table name")
            if isinstance(definition, TableSchema):
                normalized_tables[table_name] = definition
            elif isinstance(definition, Mapping):
                normalized_tables[table_name] = TableSchema.from_mapping(definition)
            else:
                raise SchemaError(f"Schema table '{table_name}' must be a TableSchema or mapping")
        object.__setattr__(self, "tables", MappingProxyType(normalized_tables))
        if self.merge_strategy is not None:
            _require_merge_strategy(self.merge_strategy, "Database merge strategy")

    def to_dict(self) -> dict[str, object]:
        value: dict[str, object] = {
            "tables": {name: definition.to_dict() for name, definition in self.tables.items()}
        }
        if self.version is not None:
            value["version"] = self.version
        if self.merge_strategy is not None:
            value["mergeStrategy"] = self.merge_strategy
        return value


# ``Schema`` is the concise spelling for application code. The longer name
# mirrors TypeScript's DatabaseSchemaDefinition and remains available for
# readers who compare the two packages.
Schema = DatabaseSchema
SchemaInput: TypeAlias = DatabaseSchema | Mapping[str, object] | None


def _normalize_merge(value: object) -> object:
    if isinstance(value, TableMergeConfig):
        return value.to_dict()
    if isinstance(value, Mapping) and ("fields" in value or "strategy" in value):
        # This is the structured shape understood by core. Let the public
        # class validate it while preserving raw, unrecognised mappings below:
        # core deliberately falls back to LWW for those values.
        return TableMergeConfig.from_mapping(value).to_dict()
    return value


def normalize_schema(schema: SchemaInput) -> dict[str, object] | None:
    """Return a core-shaped schema mapping suitable for the engine.

    ``DatabaseSchema`` is the recommended public API. A raw core-shaped mapping
    remains accepted for applications that share configuration with JavaScript.
    The normalizer converts Python helper objects embedded in that mapping but
    otherwise preserves core's permissive merge fallback behavior.
    """

    if schema is None:
        return None
    if isinstance(schema, DatabaseSchema):
        return schema.to_dict()
    if not isinstance(schema, Mapping):
        raise SchemaError("schema must be a DatabaseSchema, mapping, or None")

    tables = schema.get("tables")
    if not isinstance(tables, Mapping):
        raise SchemaError("Schema mappings must contain a 'tables' mapping")
    version = schema.get("version")
    if version is not None and type(version) is not int:
        raise SchemaError("Schema version must be an integer when present")

    normalized: dict[str, object] = dict(schema)
    normalized_tables: dict[str, object] = {}
    for name, definition in tables.items():
        table_name = _require_name(name, "Schema table name")
        if isinstance(definition, TableSchema):
            normalized_tables[table_name] = definition.to_dict()
            continue
        if not isinstance(definition, Mapping):
            raise SchemaError(f"Schema table '{table_name}' must be a mapping or TableSchema")
        table = dict(definition)
        fields = table.get("fields")
        if fields is not None:
            if not isinstance(fields, Mapping):
                raise SchemaError(f"Fields for table '{table_name}' must be a mapping")
            normalized_fields: dict[str, object] = {}
            for field_name, descriptor in fields.items():
                normalized_name = _require_name(field_name, "Schema field name")
                if isinstance(descriptor, SchemaField):
                    normalized_fields[normalized_name] = descriptor.to_dict()
                elif isinstance(descriptor, Mapping):
                    normalized_fields[normalized_name] = SchemaField.from_mapping(descriptor).to_dict()
                else:
                    raise SchemaError(
                        f"Schema field '{table_name}.{normalized_name}' must be a SchemaField or mapping"
                    )
            table["fields"] = normalized_fields
        indexes = table.get("indexes")
        if indexes is not None:
            if isinstance(indexes, (str, bytes)) or not isinstance(indexes, Sequence):
                raise SchemaError(f"Indexes for table '{table_name}' must be a sequence")
            normalized_indexes: list[object] = []
            for index in indexes:
                if isinstance(index, TableIndex):
                    normalized_indexes.append(index.to_dict())
                elif isinstance(index, Mapping):
                    normalized_indexes.append(TableIndex.from_mapping(index).to_dict())
                else:
                    raise SchemaError(f"Indexes for table '{table_name}' must contain TableIndex values or mappings")
            table["indexes"] = normalized_indexes
        if "merge" in table:
            table["merge"] = _normalize_merge(table["merge"])
        normalized_tables[table_name] = table
    normalized["tables"] = normalized_tables
    if "mergeStrategy" in normalized:
        normalized["mergeStrategy"] = _normalize_merge(normalized["mergeStrategy"])
    return normalized


__all__ = [
    "BuiltinMergeStrategy",
    "DatabaseSchema",
    "MergeFunction",
    "MergeStrategy",
    "Schema",
    "SchemaError",
    "SchemaField",
    "SchemaFieldKind",
    "SchemaInput",
    "TableIndex",
    "TableMergeConfig",
    "TableSchema",
    "normalize_schema",
    "types",
]
