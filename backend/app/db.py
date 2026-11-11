"""asyncpg pool + transaction helper that sets the per-transaction context the
database triggers read (app.current_user_id / app.change_reason / app.client_ip)."""
from __future__ import annotations

import json
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Iterable, Mapping
from uuid import UUID

import asyncpg
from fastapi import HTTPException


def _json_dumps(value: Any) -> str:
    return json.dumps(value, default=str)


async def _init_connection(conn: asyncpg.Connection) -> None:
    for pg_type in ("json", "jsonb"):
        await conn.set_type_codec(pg_type, encoder=_json_dumps, decoder=json.loads, schema="pg_catalog")


class Database:
    def __init__(self) -> None:
        self.pool: asyncpg.Pool | None = None
        self.dsn: str | None = None

    async def connect(self, dsn: str, min_size: int = 2, max_size: int = 20) -> None:
        self.dsn = dsn
        self.pool = await asyncpg.create_pool(
            dsn,
            min_size=min_size,
            max_size=max_size,
            init=_init_connection,
            command_timeout=30,
            server_settings={"application_name": "kodi-api"},
        )

    async def close(self) -> None:
        if self.pool is not None:
            await self.pool.close()
            self.pool = None

    def _require_pool(self) -> asyncpg.Pool:
        if self.pool is None:
            raise RuntimeError("Database pool is not initialised")
        return self.pool

    @asynccontextmanager
    async def tx(
        self,
        *,
        user_id: UUID | None = None,
        reason: str | None = None,
        client_ip: str | None = None,
    ) -> AsyncIterator[asyncpg.Connection]:
        """Acquire a connection, open a transaction and set audit context."""
        async with self._require_pool().acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    "SELECT set_config('app.current_user_id', $1, true),"
                    "       set_config('app.change_reason',   $2, true),"
                    "       set_config('app.client_ip',       $3, true)",
                    str(user_id) if user_id else "",
                    reason or "",
                    client_ip or "",
                )
                yield conn

    # Convenience read helpers (autocommit, no audit context needed).
    async def fetch(self, query: str, *args: Any) -> list[asyncpg.Record]:
        return await self._require_pool().fetch(query, *args)

    async def fetchrow(self, query: str, *args: Any) -> asyncpg.Record | None:
        return await self._require_pool().fetchrow(query, *args)

    async def fetchval(self, query: str, *args: Any) -> Any:
        return await self._require_pool().fetchval(query, *args)

    async def execute(self, query: str, *args: Any) -> str:
        return await self._require_pool().execute(query, *args)


db = Database()


def as_dict(record: Mapping[str, Any] | None) -> dict[str, Any] | None:
    return dict(record) if record is not None else None


def as_dicts(records: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    return [dict(r) for r in records]


def or_404(record: Mapping[str, Any] | None, what: str = "Resource") -> dict[str, Any]:
    if record is None:
        raise HTTPException(status_code=404, detail=f"{what} not found")
    return dict(record)


def build_update(
    table: str,
    changes: Mapping[str, Any],
    where: Mapping[str, Any],
    returning: str,
) -> tuple[str, list[Any]]:
    """Build a parameterised UPDATE. Column names must come from Pydantic model
    fields (a fixed whitelist), never from raw user input."""
    if not changes:
        raise HTTPException(status_code=400, detail="No fields to update")
    args: list[Any] = []
    sets = []
    for column, value in changes.items():
        args.append(value)
        sets.append(f'"{column}" = ${len(args)}')
    conditions = []
    for column, value in where.items():
        args.append(value)
        conditions.append(f'"{column}" = ${len(args)}')
    sql = f"UPDATE {table} SET {', '.join(sets)} WHERE {' AND '.join(conditions)} RETURNING {returning}"
    return sql, args
