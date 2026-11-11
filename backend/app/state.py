"""Dependencies for app-wide singletons created in the lifespan handler."""
from typing import Annotated

from fastapi import Depends, Request

from .security import SecretBox
from .services.daraja import DarajaClient
from .services.push import PushSender
from .services.storage import MediaStorage


def _daraja(request: Request) -> DarajaClient:
    return request.app.state.daraja


def _box(request: Request) -> SecretBox:
    return request.app.state.secret_box


def _storage(request: Request) -> MediaStorage:
    return request.app.state.storage



def _push(request: Request) -> PushSender:
    return request.app.state.push


DarajaDep = Annotated[DarajaClient, Depends(_daraja)]
BoxDep = Annotated[SecretBox, Depends(_box)]
StorageDep = Annotated[MediaStorage, Depends(_storage)]
PushDep = Annotated[PushSender, Depends(_push)]
