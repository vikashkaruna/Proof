"""String enums retain the qualified text used by existing logs and signatures."""

from enum import Enum, StrEnum


class QualifiedStringEnum(StrEnum):
    __str__ = Enum.__str__
    __format__ = Enum.__format__
